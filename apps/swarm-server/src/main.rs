use std::collections::{BTreeSet, HashSet, VecDeque};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use hostname::get as hostname_get;
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use rand::RngCore;
use rcgen::generate_simple_self_signed;
use rusqlite::{Connection, OptionalExtension, params};
use rustls_pemfile as pemfile;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use swarm_protocol::errors::ErrorClass;
use swarm_protocol::frames::PongFrame;
use swarm_protocol::rpc::{
    CancelPairingSessionResponse, ClosePtyRequest, CreatePairingSessionRequest,
    CreatePairingSessionResponse, DeviceInfo, DevicesResponse, PairRequest, PairResponse,
    PairingSessionInfo, ReleaseLeaseRequest, RequestLeaseRequest, ResizePtyRequest, RevealRequest,
    RevealResponse, RevokeRequest, RevokeResponse, SpawnPtyRequest, WritePtyRequest,
};
use swarm_protocol::{
    ErrorPayload, Frame, FramePayload, PROTOCOL_VERSION, SwarmSnapshot, TableCursors,
};
use swarm_server::pty::PtyService;
use swarm_state::{
    RECENT_EVENT_LIMIT, diff_snapshots, load_snapshot, open_swarm_db, swarm_db_path,
};
use tokio::net::UnixListener;
use tokio::signal;
use tokio::sync::{Mutex, RwLock, broadcast};
use tracing::{info, warn};
use uuid::Uuid;

const DEFAULT_PORT: u16 = 5444;
const HISTORY_LIMIT: usize = 128;
const PAIRING_TTL_SECS: i64 = 120;
const RATE_LIMIT_PER_MINUTE: i64 = 240;
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Interval between runtime sweeps of unadopted instance rows whose heartbeat
/// has aged past `INSTANCE_OFFLINE_AFTER_SECS`. The startup sweep handles
/// orphans left by a previous process; this keeps long-running servers from
/// accumulating zombie rows when a harness never calls `swarm.register`.
const RECLAIM_INTERVAL: Duration = Duration::from_secs(30);
const SERVER_DB_SCHEMA: &str = include_str!("../migrations/0001_initial.sql");

#[derive(Clone)]
struct AppState {
    config: ServerConfig,
    auth_db: Arc<Mutex<Connection>>,
    history: Arc<RwLock<SnapshotHistory>>,
    pty_service: Arc<PtyService>,
    redaction: RedactionPolicy,
    fingerprint: String,
    broadcast_tx: broadcast::Sender<Frame>,
}

#[derive(Clone)]
struct EndpointState {
    app: AppState,
    transport: TransportKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransportKind {
    Remote,
    Local,
}

#[derive(Clone, Debug)]
struct ServerConfig {
    bind_addr: SocketAddr,
    pairing_host: String,
    swarm_db_path: PathBuf,
    server_db_path: PathBuf,
    cert_pem_path: PathBuf,
    key_pem_path: PathBuf,
    uds_path: PathBuf,
    log_dir: PathBuf,
}

#[derive(Clone, Debug)]
struct AuthSession {
    token_id: String,
    device_id: String,
    scopes: Vec<String>,
    local: bool,
}

#[derive(Clone, Debug)]
struct SnapshotBatch {
    before: TableCursors,
    #[allow(dead_code)]
    after: TableCursors,
    frames: Vec<Frame>,
}

#[derive(Clone, Debug, Default)]
struct SnapshotHistory {
    current: Option<SwarmSnapshot>,
    batches: VecDeque<SnapshotBatch>,
}

#[derive(Clone, Debug)]
struct RedactionPolicy {
    allowed_kv_prefixes: Vec<&'static str>,
    denied_key_fragments: Vec<&'static str>,
}

#[derive(Deserialize)]
struct StateQuery {
    #[allow(dead_code)]
    since: Option<String>,
    #[allow(dead_code)]
    cursors: Option<String>,
}

#[derive(Debug, Clone)]
struct SpawnBinding {
    instance_id: Option<String>,
    created_pending: bool,
}

#[derive(Debug)]
struct PendingInstance {
    id: String,
    scope: String,
}

#[derive(Debug, Clone)]
struct InstanceInfo {
    id: String,
    scope: String,
    directory: String,
    label: Option<String>,
    heartbeat: i64,
}

impl AuthSession {
    fn local(scopes: Vec<String>) -> Self {
        Self {
            token_id: "local".to_owned(),
            device_id: "local:swarm-ui".to_owned(),
            scopes,
            local: true,
        }
    }

    fn lease_holder(&self) -> String {
        if self.local {
            "local:swarm-ui".to_owned()
        } else {
            format!("device:{}", self.device_id)
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = ServerConfig::load()?;
    init_logging(&config)?;

    let (fingerprint, cert_pem, key_pem) = load_or_create_certificate(&config)?;
    let mut auth_db = open_server_db(&config.server_db_path)?;
    cancel_active_pairing_sessions(&mut auth_db, None, "server_startup")
        .map_err(|response| std::io::Error::other(response_error_message(response)))?;
    expire_pairing_sessions(&mut auth_db)
        .map_err(|response| std::io::Error::other(response_error_message(response)))?;
    open_swarm_rw(&config.swarm_db_path)
        .map(drop)
        .map_err(|response| std::io::Error::other(response_error_message(response)))?;

    let (broadcast_tx, _) = broadcast::channel(512);
    let pty_service = Arc::new(PtyService::default());
    let state = AppState {
        config: config.clone(),
        auth_db: Arc::new(Mutex::new(auth_db)),
        history: Arc::new(RwLock::new(SnapshotHistory::default())),
        pty_service: pty_service.clone(),
        redaction: RedactionPolicy::default(),
        fingerprint: fingerprint.clone(),
        broadcast_tx,
    };

    if let Err(err) = reclaim_stale_pending_instances(&state.config.swarm_db_path) {
        warn!(status = %err.status(), "failed to reclaim stale pending instances on startup");
    }

    seed_snapshot_history(&state).await;

    info!(
        bind = %config.bind_addr,
        swarm_db = %config.swarm_db_path.display(),
        server_db = %config.server_db_path.display(),
        fingerprint = %fingerprint,
        "swarm-server starting"
    );

    if bonjour_advertisement_enabled() {
        if let Err(err) = spawn_bonjour_advertisement(&config, &fingerprint) {
            warn!(%err, "failed to advertise swarm-server over bonjour");
        }
    } else {
        info!("bonjour advertisement disabled for this build");
    }

    tokio::spawn(pty_frame_forwarder(state.clone()));
    tokio::spawn(snapshot_poller(state.clone()));
    tokio::spawn(unadopted_instance_reclaimer(state.clone()));

    let remote_app = build_router(EndpointState {
        app: state.clone(),
        transport: TransportKind::Remote,
    });
    let local_app = build_router(EndpointState {
        app: state.clone(),
        transport: TransportKind::Local,
    });
    let uds_path = config.uds_path.clone();

    tokio::spawn(async move {
        if let Err(err) = serve_uds(local_app, uds_path).await {
            warn!(%err, "local UDS server exited");
        }
    });

    let rustls_config = axum_server::tls_rustls::RustlsConfig::from_pem(cert_pem, key_pem).await?;

    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        info!("swarm-server shutdown signal received");
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(5)));
    });

    axum_server::bind_rustls(config.bind_addr, rustls_config)
        .handle(handle)
        .serve(remote_app.into_make_service())
        .await?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "v": PROTOCOL_VERSION }))
}

fn build_router(state: EndpointState) -> Router {
    let mut router = Router::new()
        .route("/health", get(health))
        .route("/pair", post(pair))
        .route("/auth/revoke", post(revoke))
        .route("/state", get(state_snapshot))
        .route("/stream", get(stream))
        .route("/reveal", post(reveal))
        .route("/pty", post(spawn_pty))
        .route("/pty/:id/input", post(write_pty))
        .route("/pty/:id/resize", post(resize_pty))
        .route("/pty/:id", delete(close_pty))
        .route("/pty/:id/lease", post(request_lease).delete(release_lease));

    if state.transport == TransportKind::Local {
        router = router
            .route("/auth/devices", get(fetch_devices))
            .route("/auth/pairing-session", post(create_pairing_session))
            .route("/auth/pairing-session/:id", delete(cancel_pairing_session));
    }

    router.with_state(state)
}

async fn serve_uds(app: Router, path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.exists() {
        fs::remove_file(&path)?;
    }

    let listener = UnixListener::bind(&path)?;
    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let service = TowerToHyperService::new(app.clone());
        tokio::spawn(async move {
            if let Err(err) = http1::Builder::new()
                .serve_connection(io, service)
                .with_upgrades()
                .await
            {
                warn!(%err, "uds client connection failed");
            }
        });
    }
}

async fn authenticate_request(
    state: &EndpointState,
    headers: &HeaderMap,
) -> Result<AuthSession, Response> {
    match state.transport {
        TransportKind::Local => Ok(AuthSession::local(current_scopes(&state.app).await)),
        TransportKind::Remote => authenticate(&state.app, headers).await,
    }
}

fn enforce_rate_limit(
    state: &EndpointState,
    auth: &AuthSession,
    bucket: &str,
) -> Result<(), Response> {
    if state.transport == TransportKind::Local || auth.local {
        Ok(())
    } else {
        check_rate_limit(&state.app, auth, bucket)
    }
}

fn server_error_response(err: swarm_server::ServerError) -> Response {
    let payload = err.into_payload();
    let status = match payload.class {
        ErrorClass::Auth => StatusCode::UNAUTHORIZED,
        ErrorClass::RateLimited => StatusCode::TOO_MANY_REQUESTS,
        ErrorClass::NotFound => StatusCode::NOT_FOUND,
        ErrorClass::LeaseConflict => StatusCode::CONFLICT,
        ErrorClass::Redacted | ErrorClass::Validation | ErrorClass::VersionMismatch => {
            StatusCode::BAD_REQUEST
        }
        ErrorClass::NotImplemented => StatusCode::NOT_IMPLEMENTED,
        ErrorClass::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error_response(status, payload)
}

async fn fetch_devices(State(state): State<EndpointState>) -> Result<Response, Response> {
    let mut db = state.app.auth_db.lock().await;
    expire_pairing_sessions(&mut db)?;
    let devices = load_devices(&db)?;

    Ok(Json(DevicesResponse {
        v: PROTOCOL_VERSION,
        devices,
    })
    .into_response())
}

async fn create_pairing_session(
    State(state): State<EndpointState>,
    Json(request): Json<CreatePairingSessionRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;

    let mut db = state.app.auth_db.lock().await;
    let session = create_pairing_session_record(&mut db, &state.app)?;

    Ok(Json(CreatePairingSessionResponse {
        v: PROTOCOL_VERSION,
        session,
    })
    .into_response())
}

async fn cancel_pairing_session(
    State(state): State<EndpointState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, Response> {
    let mut db = state.app.auth_db.lock().await;
    expire_pairing_sessions(&mut db)?;
    let canceled = cancel_pairing_session_record(&mut db, &id, "operator_closed")?;

    Ok(Json(CancelPairingSessionResponse {
        v: PROTOCOL_VERSION,
        canceled,
    })
    .into_response())
}

async fn pair(
    State(state): State<EndpointState>,
    Json(request): Json<PairRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;

    let scopes = current_scopes(&state.app).await;
    let mut db = state.app.auth_db.lock().await;
    expire_pairing_sessions(&mut db)?;
    let (token, device_id) =
        consume_pairing_code_and_issue_token(&mut db, &state.app.fingerprint, &request, &scopes)?;

    Ok(Json(PairResponse {
        v: PROTOCOL_VERSION,
        token,
        cert_fingerprint: state.app.fingerprint.clone(),
        device_id,
        scopes,
    })
    .into_response())
}

async fn revoke(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    Json(request): Json<RevokeRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "revoke")?;

    let mut db = state.app.auth_db.lock().await;
    expire_pairing_sessions(&mut db)?;
    revoke_device(&mut db, &auth.device_id, &request.device_id)?;

    Ok(Json(RevokeResponse {
        v: PROTOCOL_VERSION,
        revoked: true,
    })
    .into_response())
}

async fn state_snapshot(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    Query(query): Query<StateQuery>,
) -> Result<Response, Response> {
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "state")?;

    let snapshot = current_snapshot(&state.app).await?;
    let snapshot = if let Some(cursors) = parse_state_cursors(&query)? {
        filter_snapshot_since(snapshot, &cursors)
    } else {
        snapshot
    };
    let redacted = state.app.redaction.redact_snapshot(snapshot, &auth.scopes);
    encode_snapshot(&headers, &redacted)
}

async fn stream(
    ws: WebSocketUpgrade,
    State(state): State<EndpointState>,
    headers: HeaderMap,
) -> Result<Response, Response> {
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "stream")?;
    Ok(ws
        .on_upgrade(move |socket| stream_session(socket, state.app, auth))
        .into_response())
}

async fn reveal(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    Json(request): Json<RevealRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "reveal")?;

    let value = resolve_reveal_subject(&state.app, &request.subject).await?;
    let mut db = state.app.auth_db.lock().await;
    insert_audit(
        &mut db,
        Some(&auth.device_id),
        "reveal",
        Some(&request.subject),
        Some(json!({ "scope_count": auth.scopes.len() })),
    )?;

    Ok(Json(RevealResponse {
        v: PROTOCOL_VERSION,
        value,
    })
    .into_response())
}

async fn spawn_pty(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    Json(mut request): Json<SpawnPtyRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.spawn")?;
    spawn_pty_impl(&state.app, &auth, &mut request)
}

async fn write_pty(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    AxumPath(_id): AxumPath<String>,
    Json(request): Json<WritePtyRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.write")?;
    let ack = state
        .app
        .pty_service
        .write(request, &auth.lease_holder())
        .map_err(server_error_response)?;
    Ok(Json(ack).into_response())
}

async fn resize_pty(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    AxumPath(_id): AxumPath<String>,
    Json(request): Json<ResizePtyRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.resize")?;
    let ack = state
        .app
        .pty_service
        .resize(request, &auth.lease_holder())
        .map_err(server_error_response)?;
    Ok(Json(ack).into_response())
}

async fn close_pty(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, Response> {
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.close")?;
    let request = ClosePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: id,
        force: false,
    };
    let ack = state
        .app
        .pty_service
        .close(request, &auth.lease_holder())
        .map_err(server_error_response)?;
    Ok(Json(ack).into_response())
}

async fn request_lease(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<RequestLeaseRequest>,
) -> Result<Response, Response> {
    require_version(request.v)?;
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.lease")?;
    let lease = state
        .app
        .pty_service
        .request_lease(
            RequestLeaseRequest {
                v: request.v,
                pty_id: id,
                takeover: request.takeover,
            },
            &auth.lease_holder(),
        )
        .map_err(server_error_response)?;
    if request.takeover {
        let mut db = state.app.auth_db.lock().await;
        insert_audit(
            &mut db,
            (!auth.local).then_some(auth.device_id.as_str()),
            "pty.takeover_requested",
            Some(&lease.pty_id),
            None,
        )?;
    }
    Ok(Json(lease).into_response())
}

async fn release_lease(
    State(state): State<EndpointState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, Response> {
    let auth = authenticate_request(&state, &headers).await?;
    enforce_rate_limit(&state, &auth, "pty.lease.release")?;
    let ack = state
        .app
        .pty_service
        .release_lease(
            ReleaseLeaseRequest {
                v: PROTOCOL_VERSION,
                pty_id: id,
            },
            &auth.lease_holder(),
        )
        .map_err(server_error_response)?;
    Ok(Json(ack).into_response())
}

async fn stream_session(mut socket: WebSocket, state: AppState, auth: AuthSession) {
    let mut receiver = state.broadcast_tx.subscribe();
    let mut attached_ptys = HashSet::new();

    let Some(Ok(initial_message)) = socket.recv().await else {
        return;
    };

    let initial_frame = match decode_ws_frame(initial_message) {
        Ok(frame) => frame,
        Err(response) => {
            let _ = socket
                .send(WsMessage::Text(response_error_message(response).into()))
                .await;
            return;
        }
    };

    let replay_cursors = match initial_frame.payload {
        FramePayload::Subscribe(frame) => frame.cursors,
        FramePayload::Ping(frame) => {
            let _ = send_frame(
                &mut socket,
                &Frame::new(FramePayload::Pong(PongFrame {
                    echo: frame.echo,
                    server_time: now_secs(),
                })),
            )
            .await;
            TableCursors::default()
        }
        _ => {
            let _ = send_frame(
                &mut socket,
                &Frame::new(FramePayload::Error(ErrorPayload::new(
                    ErrorClass::Validation,
                    "first websocket frame must be subscribe or ping",
                ))),
            )
            .await;
            return;
        }
    };

    match replay_frames(&state, &replay_cursors).await {
        Ok(frames) => {
            for frame in &frames {
                if send_frame(&mut socket, frame).await.is_err() {
                    return;
                }
            }
        }
        Err(payload) => {
            let _ = send_frame(&mut socket, &Frame::new(FramePayload::Error(payload))).await;
            return;
        }
    }

    loop {
        tokio::select! {
            maybe_message = socket.recv() => {
                let Some(Ok(message)) = maybe_message else {
                    return;
                };
                match decode_ws_frame(message) {
                    Ok(frame) => {
                        match frame.payload {
                            FramePayload::Ping(frame) => {
                                if send_frame(&mut socket, &Frame::new(FramePayload::Pong(PongFrame {
                                    echo: frame.echo,
                                    server_time: now_secs(),
                                }))).await.is_err() {
                                    return;
                                }
                            }
                            FramePayload::PtyAttach(frame) => {
                                match state.pty_service.replay(&frame.pty_id, frame.since_seq) {
                                    Ok(frames) => {
                                        attached_ptys.insert(frame.pty_id);
                                        for replay in &frames {
                                            if send_frame(&mut socket, replay).await.is_err() {
                                                return;
                                            }
                                        }
                                    }
                                    Err(rejected) => {
                                        if send_frame(
                                            &mut socket,
                                            &Frame::new(FramePayload::PtyAttachRejected(rejected)),
                                        )
                                        .await
                                        .is_err()
                                        {
                                            return;
                                        }
                                    }
                                }
                            }
                            FramePayload::PtyDetach(frame) => {
                                attached_ptys.remove(&frame.pty_id);
                            }
                            FramePayload::PtyInput(frame) => {
                                let request = WritePtyRequest {
                                    v: PROTOCOL_VERSION,
                                    pty_id: frame.pty_id,
                                    data: frame.data,
                                };
                                if let Err(err) = state
                                    .pty_service
                                    .write(request, &auth.lease_holder())
                                {
                                    let payload =
                                        ErrorPayload::new(ErrorClass::Validation, err.to_string());
                                    let _ = send_frame(
                                        &mut socket,
                                        &Frame::new(FramePayload::Error(payload)),
                                    )
                                    .await;
                                    return;
                                }
                            }
                            FramePayload::PtyResize(frame) => {
                                let request = ResizePtyRequest {
                                    v: PROTOCOL_VERSION,
                                    pty_id: frame.pty_id,
                                    cols: frame.cols,
                                    rows: frame.rows,
                                };
                                if let Err(err) = state
                                    .pty_service
                                    .resize(request, &auth.lease_holder())
                                {
                                    let payload =
                                        ErrorPayload::new(ErrorClass::Validation, err.to_string());
                                    let _ = send_frame(
                                        &mut socket,
                                        &Frame::new(FramePayload::Error(payload)),
                                    )
                                    .await;
                                    return;
                                }
                            }
                            FramePayload::Subscribe(frame) => {
                                match replay_frames(&state, &frame.cursors).await {
                                    Ok(frames) => {
                                        for replay in &frames {
                                            if send_frame(&mut socket, replay).await.is_err() {
                                                return;
                                            }
                                        }
                                    }
                                    Err(payload) => {
                                        let _ = send_frame(&mut socket, &Frame::new(FramePayload::Error(payload))).await;
                                        return;
                                    }
                                }
                            }
                            FramePayload::Unknown => {}
                            _ => {}
                        }
                    }
                    Err(_) => return,
                }
            }
            received = receiver.recv() => {
                match received {
                    Ok(frame) => {
                        if !should_forward_stream_frame(&frame, &attached_ptys) {
                            continue;
                        }
                        if send_frame(&mut socket, &frame).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(%skipped, device = %auth.device_id, "ws client lagged behind broadcast history");
                        let payload = ErrorPayload::new(
                            ErrorClass::Internal,
                            "stream replay window exceeded; refetch /state",
                        );
                        let _ = send_frame(&mut socket, &Frame::new(FramePayload::Error(payload))).await;
                        return;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

fn should_forward_stream_frame(frame: &Frame, attached_ptys: &HashSet<String>) -> bool {
    match &frame.payload {
        FramePayload::PtyData(payload) => attached_ptys.contains(&payload.pty_id),
        FramePayload::PtyExit(payload) => attached_ptys.contains(&payload.pty_id),
        _ => true,
    }
}

async fn send_frame(socket: &mut WebSocket, frame: &Frame) -> Result<(), String> {
    let bytes =
        rmp_serde::to_vec_named(frame).map_err(|err| format!("failed to encode frame: {err}"))?;
    socket
        .send(WsMessage::Binary(bytes))
        .await
        .map_err(|err| format!("failed to write websocket frame: {err}"))
}

async fn snapshot_poller(state: AppState) {
    let mut conn = None;

    loop {
        if conn.is_none() {
            match open_swarm_db(&state.config.swarm_db_path) {
                Ok(connection) => conn = Some(connection),
                Err(err) => {
                    warn!(%err, "failed to open swarm db for poller");
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
            }
        }

        let Some(connection) = conn.as_ref() else {
            tokio::time::sleep(POLL_INTERVAL).await;
            continue;
        };
        let ptys = match state.pty_service.snapshot() {
            Ok(snapshot) => snapshot.rows,
            Err(err) => {
                warn!(%err, "failed to snapshot daemon PTY catalog");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };

        match load_snapshot(connection, &ptys) {
            Ok(snapshot) => {
                let mut history = state.history.write().await;
                let previous = history.current.clone();
                if previous.as_ref() != Some(&snapshot) {
                    let frames = previous
                        .as_ref()
                        .map_or_else(Vec::new, |previous| diff_snapshots(previous, &snapshot));

                    if let Some(previous) = previous {
                        history.batches.push_back(SnapshotBatch {
                            before: previous.cursors,
                            after: snapshot.cursors.clone(),
                            frames: frames.clone(),
                        });
                        while history.batches.len() > HISTORY_LIMIT {
                            history.batches.pop_front();
                        }
                    }

                    history.current = Some(snapshot.clone());
                    drop(history);

                    for frame in frames {
                        let _ = state.broadcast_tx.send(frame);
                    }
                }
            }
            Err(err) => {
                warn!(%err, "snapshot poll failed");
                conn = None;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn seed_snapshot_history(state: &AppState) {
    match open_swarm_db(&state.config.swarm_db_path) {
        Ok(conn) => {
            let ptys = match state.pty_service.snapshot() {
                Ok(snapshot) => snapshot.rows,
                Err(err) => {
                    warn!(%err, "failed to seed PTY catalog snapshot");
                    Vec::new()
                }
            };
            match load_snapshot(&conn, &ptys) {
                Ok(snapshot) => {
                    state.history.write().await.current = Some(snapshot);
                }
                Err(err) => warn!(%err, "failed to seed initial snapshot history"),
            }
        }
        Err(err) => warn!(%err, "failed to open swarm db for initial snapshot seed"),
    }
}

async fn current_snapshot(state: &AppState) -> Result<SwarmSnapshot, Response> {
    if let Some(snapshot) = state.history.read().await.current.clone() {
        return Ok(snapshot);
    }

    let ptys = state
        .pty_service
        .snapshot()
        .map_err(server_error_response)?
        .rows;
    let conn = open_swarm_db(&state.config.swarm_db_path).map_err(internal_response)?;
    load_snapshot(&conn, &ptys).map_err(internal_response)
}

async fn replay_frames(
    state: &AppState,
    cursors: &TableCursors,
) -> Result<Vec<Frame>, ErrorPayload> {
    let history = state.history.read().await;
    let Some(current) = history.current.as_ref() else {
        return Ok(Vec::new());
    };

    if cursors == &TableCursors::default() {
        return Ok(Vec::new());
    }

    if &current.cursors == cursors {
        return Ok(Vec::new());
    }

    let mut replay = Vec::new();
    let mut matched = false;
    for batch in &history.batches {
        if !matched && &batch.before == cursors {
            matched = true;
        }
        if matched {
            replay.extend(batch.frames.clone());
        }
    }

    if matched {
        return Ok(replay);
    }

    Err(ErrorPayload::new(
        ErrorClass::Internal,
        "stream replay window exceeded; refetch /state",
    ))
}

fn decode_ws_frame(message: WsMessage) -> Result<Frame, Response> {
    match message {
        WsMessage::Binary(bytes) => rmp_serde::from_slice::<Frame>(&bytes).map_err(|err| {
            error_response(
                StatusCode::BAD_REQUEST,
                ErrorPayload::new(
                    ErrorClass::Validation,
                    format!("invalid msgpack websocket frame: {err}"),
                ),
            )
        }),
        WsMessage::Text(text) => serde_json::from_str::<Frame>(&text).map_err(|err| {
            error_response(
                StatusCode::BAD_REQUEST,
                ErrorPayload::new(
                    ErrorClass::Validation,
                    format!("invalid json websocket frame: {err}"),
                ),
            )
        }),
        _ => Err(error_response(
            StatusCode::BAD_REQUEST,
            ErrorPayload::new(ErrorClass::Validation, "unsupported websocket message type"),
        )),
    }
}

fn encode_snapshot(headers: &HeaderMap, snapshot: &SwarmSnapshot) -> Result<Response, Response> {
    if headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"))
    {
        return Ok(Json(snapshot).into_response());
    }

    let bytes = rmp_serde::to_vec_named(snapshot)
        .map_err(|err| internal_response(format!("failed to encode msgpack snapshot: {err}")))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/msgpack")
        .body(Body::from(bytes))
        .map_err(|err| internal_response(format!("failed to build snapshot response: {err}")))
}

fn parse_state_cursors(query: &StateQuery) -> Result<Option<TableCursors>, Response> {
    let Some(raw) = query.cursors.as_deref() else {
        return Ok(None);
    };

    serde_json::from_str(raw).map(Some).map_err(|err| {
        error_response(
            StatusCode::BAD_REQUEST,
            ErrorPayload::new(
                ErrorClass::Validation,
                format!("invalid state cursor payload: {err}"),
            ),
        )
    })
}

fn filter_snapshot_since(mut snapshot: SwarmSnapshot, cursors: &TableCursors) -> SwarmSnapshot {
    if cursors.messages >= snapshot.cursors.messages {
        snapshot.messages.clear();
    }
    if cursors.events >= snapshot.cursors.events {
        snapshot.events.clear();
    }
    if cursors.instances >= snapshot.cursors.instances {
        snapshot.instances.clear();
    }
    if cursors.tasks >= snapshot.cursors.tasks {
        snapshot.tasks.clear();
    }
    if cursors.locks >= snapshot.cursors.locks {
        snapshot.locks.clear();
    }
    if cursors.annotations >= snapshot.cursors.annotations {
        snapshot.annotations.clear();
    }
    if cursors.kv >= snapshot.cursors.kv {
        snapshot.kv.clear();
    }
    if cursors.ptys >= snapshot.cursors.ptys {
        snapshot.ptys.clear();
    }

    snapshot
}

async fn current_scopes(state: &AppState) -> Vec<String> {
    let snapshot = current_snapshot(state).await.unwrap_or_default();
    let mut scopes = BTreeSet::new();
    for scope in snapshot.instances.iter().map(|row| row.scope.clone()) {
        scopes.insert(scope);
    }
    if scopes.is_empty() {
        scopes.insert(String::new());
    }
    scopes.into_iter().collect()
}

async fn resolve_reveal_subject(state: &AppState, subject: &str) -> Result<String, Response> {
    let conn = open_swarm_db(&state.config.swarm_db_path).map_err(internal_response)?;

    if let Some(rest) = subject.strip_prefix("kv:") {
        let (scope, key) = split_kv_subject(rest)?;
        return conn
            .query_row(
                "SELECT value FROM kv WHERE scope = ? AND key = ?",
                params![scope, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| internal_response(format!("failed to read kv reveal subject: {err}")))?
            .ok_or_else(|| {
                error_response(
                    StatusCode::NOT_FOUND,
                    ErrorPayload::new(ErrorClass::NotFound, "unknown kv subject"),
                )
            });
    }

    if let Some(id) = subject.strip_prefix("message:") {
        let id = id.parse::<i64>().map_err(|_| {
            error_response(
                StatusCode::BAD_REQUEST,
                ErrorPayload::new(ErrorClass::Validation, "invalid message subject id"),
            )
        })?;
        return conn
            .query_row("SELECT content FROM messages WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|err| {
                internal_response(format!("failed to read message reveal subject: {err}"))
            })?
            .ok_or_else(|| {
                error_response(
                    StatusCode::NOT_FOUND,
                    ErrorPayload::new(ErrorClass::NotFound, "unknown message subject"),
                )
            });
    }

    if let Some(id) = subject.strip_prefix("annotation:") {
        return conn
            .query_row("SELECT content FROM context WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|err| {
                internal_response(format!("failed to read annotation reveal subject: {err}"))
            })?
            .ok_or_else(|| {
                error_response(
                    StatusCode::NOT_FOUND,
                    ErrorPayload::new(ErrorClass::NotFound, "unknown annotation subject"),
                )
            });
    }

    Err(error_response(
        StatusCode::BAD_REQUEST,
        ErrorPayload::new(ErrorClass::Validation, "unsupported reveal subject"),
    ))
}

fn split_kv_subject(value: &str) -> Result<(String, String), Response> {
    let Some((scope, key)) = value.split_once(':') else {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            ErrorPayload::new(ErrorClass::Validation, "invalid kv reveal subject"),
        ));
    };
    Ok((scope.to_string(), key.to_string()))
}

fn open_swarm_rw(path: &Path) -> Result<Connection, Response> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            internal_response(format!(
                "failed to create swarm db directory {}: {err}",
                parent.display()
            ))
        })?;
    }

    let conn = Connection::open(path).map_err(|err| {
        internal_response(format!(
            "failed to open swarm db at {}: {err}",
            path.display()
        ))
    })?;
    conn.busy_timeout(Duration::from_millis(3_000))
        .map_err(|err| internal_response(format!("failed to set swarm db busy timeout: {err}")))?;
    swarm_schema::ensure_schema(&conn)
        .map_err(|err| internal_response(format!("failed to ensure swarm db schema: {err}")))?;
    Ok(conn)
}

fn git_root(dir: &Path) -> PathBuf {
    let start = dir.to_path_buf();
    let mut current = start.clone();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return start,
        }
    }
}

fn build_instance_label(
    harness: &str,
    role: Option<&str>,
    name: Option<&str>,
    extra_tokens: Option<&str>,
) -> Option<String> {
    if harness == "shell" && role.is_none() && name.is_none() && extra_tokens.is_none() {
        return None;
    }

    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    let mut push_tokens = |value: &str| {
        for token in value.split_whitespace() {
            if seen.insert(token.to_owned()) {
                tokens.push(token.to_owned());
            }
        }
    };

    if let Some(name) = name {
        push_tokens(&format!("name:{name}"));
    }
    if let Some(role) = role {
        push_tokens(&format!("role:{role}"));
    }
    if harness != "shell" {
        push_tokens(&format!("provider:{harness}"));
    }
    if let Some(extra_tokens) = extra_tokens {
        push_tokens(extra_tokens);
    }

    (!tokens.is_empty()).then(|| tokens.join(" "))
}

fn create_pending_instance(
    conn: &Connection,
    directory: &str,
    explicit_scope: Option<&str>,
    label: Option<&str>,
) -> Result<PendingInstance, Response> {
    let directory_path = PathBuf::from(directory);
    let root = git_root(&directory_path);
    let scope = explicit_scope
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone())
        .to_string_lossy()
        .into_owned();
    let pending = PendingInstance {
        id: Uuid::new_v4().to_string(),
        scope,
    };

    conn.execute(
        "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0)",
        params![
            pending.id,
            pending.scope,
            directory,
            root.to_string_lossy(),
            directory_path.to_string_lossy(),
            label
        ],
    )
    .map_err(|err| internal_response(format!("failed to create pending instance: {err}")))?;

    Ok(pending)
}

fn delete_unadopted_instance(conn: &Connection, instance_id: &str) -> Result<(), Response> {
    conn.execute(
        "DELETE FROM instances WHERE id = ? AND COALESCE(adopted, 1) = 0",
        params![instance_id],
    )
    .map_err(|err| internal_response(format!("failed to delete unadopted instance: {err}")))?;
    Ok(())
}

fn load_instance_info(
    conn: &Connection,
    instance_id: &str,
) -> Result<Option<InstanceInfo>, Response> {
    conn.query_row(
        "SELECT id, scope, directory, label, heartbeat
         FROM instances
         WHERE id = ?",
        params![instance_id],
        |row| {
            Ok(InstanceInfo {
                id: row.get(0)?,
                scope: row.get(1)?,
                directory: row.get(2)?,
                label: row.get(3)?,
                heartbeat: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|err| internal_response(format!("failed to load instance info: {err}")))
}

fn reclaim_stale_pending_instances(path: &Path) -> Result<(), Response> {
    let conn = open_swarm_rw(path)?;
    let stale_before = now_secs().saturating_sub(swarm_protocol::state::INSTANCE_STALE_AFTER_SECS);
    conn.execute(
        "DELETE FROM instances WHERE COALESCE(adopted, 1) = 0 AND heartbeat < ?",
        params![stale_before],
    )
    .map_err(|err| {
        internal_response(format!("failed to reclaim stale pending instances: {err}"))
    })?;
    Ok(())
}

/// Delete unadopted instance rows whose heartbeat aged past the "offline"
/// threshold AND which have no live PTY still bound to them. The live-PTY
/// guard preserves rows whose harness is still running (ctrl-c back to the
/// shell, slow MCP init, etc.) so the user doesn't lose a node they can still
/// interact with.
fn reclaim_offline_unadopted_instances(
    path: &Path,
    live_bound_instance_ids: &HashSet<String>,
) -> Result<usize, Response> {
    let conn = open_swarm_rw(path)?;
    let cutoff = now_secs().saturating_sub(swarm_protocol::state::INSTANCE_OFFLINE_AFTER_SECS);
    let mut stmt = conn
        .prepare("SELECT id FROM instances WHERE COALESCE(adopted, 1) = 0 AND heartbeat < ?")
        .map_err(|err| internal_response(format!("failed to query unadopted instances: {err}")))?;
    let candidates: Vec<String> = stmt
        .query_map(params![cutoff], |row| row.get::<_, String>(0))
        .map_err(|err| {
            internal_response(format!("failed to enumerate unadopted instances: {err}"))
        })?
        .collect::<Result<_, _>>()
        .map_err(|err| {
            internal_response(format!("failed to read unadopted instance row: {err}"))
        })?;
    drop(stmt);

    let mut deleted = 0usize;
    for id in candidates {
        if live_bound_instance_ids.contains(&id) {
            continue;
        }
        let rows = conn
            .execute(
                "DELETE FROM instances WHERE id = ? AND COALESCE(adopted, 1) = 0",
                params![id],
            )
            .map_err(|err| {
                internal_response(format!("failed to delete unadopted instance: {err}"))
            })?;
        deleted += rows;
    }
    Ok(deleted)
}

async fn unadopted_instance_reclaimer(state: AppState) {
    loop {
        tokio::time::sleep(RECLAIM_INTERVAL).await;

        let live_bound = match state.pty_service.snapshot() {
            Ok(snapshot) => snapshot
                .rows
                .into_iter()
                .filter_map(|pty| pty.bound_instance_id)
                .collect::<HashSet<_>>(),
            Err(err) => {
                warn!(%err, "reclaimer failed to snapshot PTY catalog");
                continue;
            }
        };

        match reclaim_offline_unadopted_instances(&state.config.swarm_db_path, &live_bound) {
            Ok(0) => {}
            Ok(deleted) => info!(deleted, "reclaimed unadopted instance rows"),
            Err(response) => {
                warn!(status = %response.status(), "unadopted instance reclaim failed")
            }
        }
    }
}

fn spawn_pty_impl(
    state: &AppState,
    auth: &AuthSession,
    request: &mut SpawnPtyRequest,
) -> Result<Response, Response> {
    let mut binding = SpawnBinding {
        instance_id: None,
        created_pending: false,
    };

    if let Some(existing_id) = request
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    {
        let conn = open_swarm_rw(&state.config.swarm_db_path)?;
        let existing = load_instance_info(&conn, &existing_id)?.ok_or_else(|| {
            error_response(
                StatusCode::NOT_FOUND,
                ErrorPayload::new(
                    ErrorClass::NotFound,
                    format!("instance {existing_id} not found"),
                ),
            )
        })?;

        if swarm_protocol::InstanceStatus::from_heartbeat(now_secs(), existing.heartbeat)
            == swarm_protocol::InstanceStatus::Online
        {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                ErrorPayload::new(
                    ErrorClass::Validation,
                    format!(
                        "instance {} is still online and cannot be reattached",
                        existing.id
                    ),
                ),
            ));
        }

        request.cwd = existing.directory.clone();
        request.scope = Some(existing.scope.clone());
        request.label = existing.label.clone();
        request.instance_id = Some(existing.id.clone());
        binding.instance_id = Some(existing.id);
    } else if request.harness != "shell" {
        let conn = open_swarm_rw(&state.config.swarm_db_path)?;
        request.label = build_instance_label(
            &request.harness,
            request.role.as_deref(),
            request.name.as_deref(),
            request.label.as_deref(),
        );
        let pending = create_pending_instance(
            &conn,
            &request.cwd,
            request.scope.as_deref(),
            request.label.as_deref(),
        )?;
        request.scope = Some(pending.scope.clone());
        request.instance_id = Some(pending.id.clone());
        binding.instance_id = Some(pending.id);
        binding.created_pending = true;
    }

    let spawned = match state
        .pty_service
        .spawn(request.clone(), auth.lease_holder())
    {
        Ok(response) => response,
        Err(err) => {
            if binding.created_pending {
                if let Some(instance_id) = binding.instance_id.as_deref() {
                    if let Ok(conn) = open_swarm_rw(&state.config.swarm_db_path) {
                        let _ = delete_unadopted_instance(&conn, instance_id);
                    }
                }
            }
            return Err(server_error_response(err));
        }
    };

    let pty = match binding.instance_id.clone() {
        Some(instance_id) => state
            .pty_service
            .bind_instance(&spawned.pty.id, Some(instance_id))
            .map_err(server_error_response)?,
        None => spawned.pty,
    };

    Ok(Json(swarm_protocol::rpc::SpawnPtyResponse {
        v: PROTOCOL_VERSION,
        pty,
    })
    .into_response())
}

async fn pty_frame_forwarder(state: AppState) {
    let mut receiver = state.pty_service.subscribe();
    loop {
        match receiver.recv().await {
            Ok(frame) => {
                if let FramePayload::PtyExit(payload) = &frame.payload {
                    if let Ok(snapshot) = state.pty_service.snapshot() {
                        if let Some(instance_id) = snapshot
                            .rows
                            .iter()
                            .find(|pty| pty.id == payload.pty_id)
                            .and_then(|pty| pty.bound_instance_id.clone())
                        {
                            if let Ok(conn) = open_swarm_rw(&state.config.swarm_db_path) {
                                let _ = delete_unadopted_instance(&conn, &instance_id);
                            }
                        }
                    }
                }
                let _ = state.broadcast_tx.send(frame);
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(%skipped, "pty frame forwarder lagged behind PTY service broadcast");
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<AuthSession, Response> {
    let token = bearer_token(headers).ok_or_else(|| {
        error_response(
            StatusCode::UNAUTHORIZED,
            ErrorPayload::new(ErrorClass::Auth, "missing bearer token"),
        )
    })?;

    let token_hash = hash_token(token);
    let mut db = state.auth_db.lock().await;
    lookup_auth_session(&mut db, &token_hash)?.ok_or_else(|| {
        error_response(
            StatusCode::UNAUTHORIZED,
            ErrorPayload::new(ErrorClass::Auth, "invalid or revoked token"),
        )
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn require_version(version: u32) -> Result<(), Response> {
    if version == PROTOCOL_VERSION {
        return Ok(());
    }

    Err(error_response(
        StatusCode::BAD_REQUEST,
        ErrorPayload::new(ErrorClass::VersionMismatch, "unsupported protocol version"),
    ))
}

fn check_rate_limit(state: &AppState, auth: &AuthSession, bucket: &str) -> Result<(), Response> {
    let now = now_secs();
    let mut db = state
        .auth_db
        .try_lock()
        .map_err(|_| internal_response("server db lock contention"))?;
    let window_start = now - (now % 60);

    let tx = db.transaction().map_err(|err| {
        internal_response(format!("failed to start rate-limit transaction: {err}"))
    })?;
    let hits = tx
        .query_row(
            "SELECT hits FROM rate_limits WHERE token_id = ? AND bucket = ? AND window_start = ?",
            params![auth.token_id, bucket, window_start],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| internal_response(format!("failed to read rate limit: {err}")))?
        .unwrap_or_default();
    if hits >= RATE_LIMIT_PER_MINUTE {
        return Err(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorPayload::new(ErrorClass::RateLimited, "too many requests").with_retry_after(60),
        ));
    }

    tx.execute(
        "INSERT INTO rate_limits (token_id, bucket, window_start, hits, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(token_id, bucket, window_start)
         DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at",
        params![auth.token_id, bucket, window_start, now],
    )
    .map_err(|err| internal_response(format!("failed to update rate limit: {err}")))?;
    tx.commit().map_err(|err| {
        internal_response(format!("failed to commit rate limit transaction: {err}"))
    })?;
    Ok(())
}

fn open_server_db(path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_millis(3_000))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA auto_vacuum = INCREMENTAL;")?;
    conn.execute_batch(SERVER_DB_SCHEMA)?;
    if !server_column_exists(&conn, "pairing_codes", "pairing_secret")? {
        conn.execute(
            "ALTER TABLE pairing_codes ADD COLUMN pairing_secret TEXT",
            [],
        )?;
    }
    if !server_column_exists(&conn, "pairing_codes", "session_id")? {
        conn.execute("ALTER TABLE pairing_codes ADD COLUMN session_id TEXT", [])?;
    }
    if !server_column_exists(&conn, "pairing_codes", "canceled_at")? {
        conn.execute(
            "ALTER TABLE pairing_codes ADD COLUMN canceled_at INTEGER",
            [],
        )?;
    }
    if !server_column_exists(&conn, "pairing_codes", "expired_at")? {
        conn.execute(
            "ALTER TABLE pairing_codes ADD COLUMN expired_at INTEGER",
            [],
        )?;
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_codes_session_id
         ON pairing_codes(session_id)
         WHERE session_id IS NOT NULL;",
    )?;
    Ok(conn)
}

fn server_column_exists(
    conn: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn pairing_session_subject(session_id: Option<&str>, code: &str) -> String {
    session_id
        .map(std::borrow::ToOwned::to_owned)
        .unwrap_or_else(|| format!("legacy:{code}"))
}

fn load_devices(conn: &Connection) -> Result<Vec<DeviceInfo>, Response> {
    let mut stmt = conn
        .prepare(
            "SELECT id, device_name, platform, created_at, last_seen_at, revoked_at
             FROM devices
             ORDER BY
               CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
               last_seen_at DESC,
               created_at DESC",
        )
        .map_err(|err| internal_response(format!("failed to prepare devices query: {err}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DeviceInfo {
                device_id: row.get(0)?,
                device_name: row.get(1)?,
                platform: row.get(2)?,
                created_at: row.get(3)?,
                last_seen_at: row.get(4)?,
                revoked_at: row.get(5)?,
            })
        })
        .map_err(|err| internal_response(format!("failed to query devices: {err}")))?;

    let mut devices = Vec::new();
    for row in rows {
        devices.push(
            row.map_err(|err| internal_response(format!("failed to decode device row: {err}")))?,
        );
    }
    Ok(devices)
}

fn create_pairing_session_record(
    conn: &mut Connection,
    state: &AppState,
) -> Result<PairingSessionInfo, Response> {
    expire_pairing_sessions(conn)?;
    let _ = cancel_active_pairing_sessions(conn, Some("local:swarm-ui"), "superseded")?;

    let now = now_secs();
    let expires_at = now + PAIRING_TTL_SECS;
    let pairing_secret = random_token();
    let tx = conn.transaction().map_err(|err| {
        internal_response(format!(
            "failed to begin pairing-session transaction: {err}"
        ))
    })?;

    for _ in 0..16 {
        let code = format!("{:06}", random_u32() % 1_000_000);
        let in_use = tx
            .query_row(
                "SELECT 1 FROM pairing_codes WHERE code = ? LIMIT 1",
                [code.as_str()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|err| {
                internal_response(format!("failed to check pairing code collision: {err}"))
            })?
            .is_some();
        if in_use {
            continue;
        }

        let session_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO pairing_codes (
               code, session_id, cert_fingerprint, pairing_secret, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                &code,
                &session_id,
                &state.fingerprint,
                &pairing_secret,
                now,
                expires_at
            ],
        )
        .map_err(|err| internal_response(format!("failed to insert pairing session: {err}")))?;
        tx.execute(
            "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
             VALUES (NULL, 'pairing_session.created', ?, ?, ?)",
            params![
                session_id,
                json!({
                    "expires_at": expires_at,
                    "host": state.config.pairing_host,
                    "port": state.config.bind_addr.port(),
                })
                .to_string(),
                now
            ],
        )
        .map_err(|err| {
            internal_response(format!("failed to audit pairing session creation: {err}"))
        })?;
        tx.commit().map_err(|err| {
            internal_response(format!(
                "failed to commit pairing-session transaction: {err}"
            ))
        })?;

        return Ok(PairingSessionInfo {
            session_id,
            host: state.config.pairing_host.clone(),
            port: state.config.bind_addr.port(),
            cert_fingerprint: state.fingerprint.clone(),
            code,
            pairing_secret: pairing_secret.clone(),
            expires_at,
        });
    }

    Err(internal_response(
        "failed to allocate a unique pairing code after repeated attempts",
    ))
}

fn cancel_pairing_session_record(
    conn: &mut Connection,
    session_id: &str,
    reason: &str,
) -> Result<bool, Response> {
    let now = now_secs();
    let tx = conn.transaction().map_err(|err| {
        internal_response(format!(
            "failed to begin cancel pairing-session transaction: {err}"
        ))
    })?;
    let found = tx
        .query_row(
            "SELECT code FROM pairing_codes
             WHERE session_id = ?
               AND used_at IS NULL
               AND canceled_at IS NULL
               AND expired_at IS NULL
               AND expires_at > ?
             LIMIT 1",
            params![session_id, now],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| internal_response(format!("failed to lookup pairing session: {err}")))?;

    let Some(_code) = found else {
        tx.commit().map_err(|err| {
            internal_response(format!(
                "failed to finalize no-op pairing-session cancel: {err}"
            ))
        })?;
        return Ok(false);
    };

    tx.execute(
        "UPDATE pairing_codes SET canceled_at = ?
         WHERE session_id = ?
           AND used_at IS NULL
           AND canceled_at IS NULL
           AND expired_at IS NULL
           AND expires_at > ?",
        params![now, session_id, now],
    )
    .map_err(|err| internal_response(format!("failed to cancel pairing session: {err}")))?;
    tx.execute(
        "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
         VALUES ('local:swarm-ui', 'pairing_session.canceled', ?, ?, ?)",
        params![session_id, json!({ "reason": reason }).to_string(), now],
    )
    .map_err(|err| internal_response(format!("failed to audit pairing-session cancel: {err}")))?;
    tx.commit().map_err(|err| {
        internal_response(format!(
            "failed to commit pairing-session cancel transaction: {err}"
        ))
    })?;
    Ok(true)
}

fn cancel_active_pairing_sessions(
    conn: &mut Connection,
    actor_device_id: Option<&str>,
    reason: &str,
) -> Result<bool, Response> {
    let now = now_secs();
    let tx = conn.transaction().map_err(|err| {
        internal_response(format!(
            "failed to begin active pairing-session cleanup: {err}"
        ))
    })?;
    let active_sessions = {
        let mut stmt = tx
            .prepare(
                "SELECT session_id, code FROM pairing_codes
                 WHERE used_at IS NULL
                   AND canceled_at IS NULL
                   AND expired_at IS NULL
                   AND expires_at > ?",
            )
            .map_err(|err| {
                internal_response(format!(
                    "failed to prepare active pairing-session query: {err}"
                ))
            })?;
        let rows = stmt
            .query_map([now], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| {
                internal_response(format!("failed to query active pairing sessions: {err}"))
            })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row.map_err(|err| {
                internal_response(format!("failed to decode active pairing session: {err}"))
            })?);
        }
        sessions
    };

    if active_sessions.is_empty() {
        tx.commit().map_err(|err| {
            internal_response(format!(
                "failed to finish active pairing-session cleanup: {err}"
            ))
        })?;
        return Ok(false);
    }

    tx.execute(
        "UPDATE pairing_codes SET canceled_at = ?
         WHERE used_at IS NULL
           AND canceled_at IS NULL
           AND expired_at IS NULL
           AND expires_at > ?",
        params![now, now],
    )
    .map_err(|err| internal_response(format!("failed to cancel active pairing sessions: {err}")))?;

    for (session_id, code) in active_sessions {
        tx.execute(
            "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
             VALUES (?, 'pairing_session.canceled', ?, ?, ?)",
            params![
                actor_device_id,
                pairing_session_subject(session_id.as_deref(), &code),
                json!({ "reason": reason }).to_string(),
                now
            ],
        )
        .map_err(|err| {
            internal_response(format!(
                "failed to audit active pairing-session cancel: {err}"
            ))
        })?;
    }

    tx.commit().map_err(|err| {
        internal_response(format!(
            "failed to commit active pairing-session cleanup: {err}"
        ))
    })?;
    Ok(true)
}

fn expire_pairing_sessions(conn: &mut Connection) -> Result<(), Response> {
    let now = now_secs();
    let tx = conn.transaction().map_err(|err| {
        internal_response(format!(
            "failed to begin pairing-session expiry sweep: {err}"
        ))
    })?;
    let expired_sessions = {
        let mut stmt = tx
            .prepare(
                "SELECT session_id, code FROM pairing_codes
                 WHERE used_at IS NULL
                   AND canceled_at IS NULL
                   AND expired_at IS NULL
                   AND expires_at <= ?",
            )
            .map_err(|err| {
                internal_response(format!(
                    "failed to prepare expired pairing-session query: {err}"
                ))
            })?;
        let rows = stmt
            .query_map([now], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| {
                internal_response(format!("failed to query expired pairing sessions: {err}"))
            })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row.map_err(|err| {
                internal_response(format!("failed to decode expired pairing session: {err}"))
            })?);
        }
        sessions
    };

    if expired_sessions.is_empty() {
        tx.commit().map_err(|err| {
            internal_response(format!(
                "failed to finish pairing-session expiry sweep: {err}"
            ))
        })?;
        return Ok(());
    }

    tx.execute(
        "UPDATE pairing_codes SET expired_at = ?
         WHERE used_at IS NULL
           AND canceled_at IS NULL
           AND expired_at IS NULL
           AND expires_at <= ?",
        params![now, now],
    )
    .map_err(|err| internal_response(format!("failed to mark pairing sessions expired: {err}")))?;

    for (session_id, code) in expired_sessions {
        tx.execute(
            "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
             VALUES (NULL, 'pairing_session.expired', ?, NULL, ?)",
            params![pairing_session_subject(session_id.as_deref(), &code), now],
        )
        .map_err(|err| {
            internal_response(format!("failed to audit expired pairing session: {err}"))
        })?;
    }

    tx.commit().map_err(|err| {
        internal_response(format!(
            "failed to commit pairing-session expiry sweep: {err}"
        ))
    })?;
    Ok(())
}

fn active_device_ids_for_client(
    tx: &rusqlite::Transaction<'_>,
    client_device_id: &str,
) -> Result<Vec<String>, Response> {
    let mut stmt = tx
        .prepare(
            "SELECT id FROM devices
             WHERE client_device_id = ? AND revoked_at IS NULL
             ORDER BY last_seen_at DESC, created_at DESC, id DESC",
        )
        .map_err(|err| {
            internal_response(format!("failed to prepare active-device query: {err}"))
        })?;
    let rows = stmt
        .query_map([client_device_id], |row| row.get::<_, String>(0))
        .map_err(|err| internal_response(format!("failed to query active devices: {err}")))?;

    let mut ids = Vec::new();
    for row in rows {
        ids.push(
            row.map_err(|err| internal_response(format!("failed to decode active device: {err}")))?,
        );
    }
    Ok(ids)
}

fn revoke_active_tokens_for_device(
    tx: &rusqlite::Transaction<'_>,
    device_id: &str,
    now: i64,
) -> Result<(), Response> {
    tx.execute(
        "UPDATE tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        params![now, device_id],
    )
    .map_err(|err| internal_response(format!("failed to revoke previous device tokens: {err}")))?;
    Ok(())
}

fn revoke_superseded_device(
    tx: &rusqlite::Transaction<'_>,
    device_id: &str,
    now: i64,
) -> Result<(), Response> {
    tx.execute(
        "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        params![now, device_id],
    )
    .map_err(|err| internal_response(format!("failed to revoke superseded device: {err}")))?;
    revoke_active_tokens_for_device(tx, device_id, now)
}

fn consume_pairing_code_and_issue_token(
    conn: &mut Connection,
    fingerprint: &str,
    request: &PairRequest,
    scopes: &[String],
) -> Result<(String, String), Response> {
    let now = now_secs();
    let tx = conn
        .transaction()
        .map_err(|err| internal_response(format!("failed to begin pairing transaction: {err}")))?;

    let session_id = tx
        .query_row(
            "SELECT session_id FROM pairing_codes
             WHERE code = ? AND cert_fingerprint = ? AND pairing_secret = ?
               AND used_at IS NULL
               AND canceled_at IS NULL
               AND expired_at IS NULL
               AND expires_at > ?
             LIMIT 1",
            params![request.code, fingerprint, request.pairing_secret, now],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| internal_response(format!("failed to validate pairing code: {err}")))?;
    let Some(session_id) = session_id else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            ErrorPayload::new(ErrorClass::Auth, "invalid or expired pairing code"),
        ));
    };

    let token_id = Uuid::new_v4().to_string();
    let token = random_token();
    let scopes_json = serde_json::to_string(scopes)
        .map_err(|err| internal_response(format!("failed to encode scopes: {err}")))?;
    let active_device_ids = active_device_ids_for_client(&tx, &request.device_id)?;
    let superseded_device_ids = active_device_ids
        .iter()
        .skip(1)
        .cloned()
        .collect::<Vec<_>>();

    let (device_id, reused_device) = if let Some(existing_device_id) = active_device_ids.first() {
        tx.execute(
            "UPDATE devices
             SET device_name = ?, platform = ?, scopes = ?, last_seen_at = ?
             WHERE id = ?",
            params![
                request.device_name,
                request.platform.as_deref(),
                &scopes_json,
                now,
                existing_device_id
            ],
        )
        .map_err(|err| internal_response(format!("failed to update existing device: {err}")))?;
        revoke_active_tokens_for_device(&tx, existing_device_id, now)?;
        for stale_device_id in &superseded_device_ids {
            revoke_superseded_device(&tx, stale_device_id, now)?;
        }
        (existing_device_id.clone(), true)
    } else {
        let device_id = format!("dev-{}", &Uuid::new_v4().simple().to_string()[..12]);
        tx.execute(
            "INSERT INTO devices (id, client_device_id, device_name, platform, scopes, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                device_id,
                request.device_id,
                request.device_name,
                request.platform.as_deref(),
                &scopes_json,
                now,
                now
            ],
        )
        .map_err(|err| internal_response(format!("failed to insert device: {err}")))?;
        (device_id, false)
    };

    tx.execute(
        "UPDATE pairing_codes
         SET used_at = ?
         WHERE code = ?
           AND pairing_secret = ?
           AND used_at IS NULL
           AND canceled_at IS NULL
           AND expired_at IS NULL",
        params![now, request.code, request.pairing_secret],
    )
    .map_err(|err| internal_response(format!("failed to consume pairing code: {err}")))?;
    tx.execute(
        "INSERT INTO tokens (id, device_id, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)",
        params![token_id, device_id, hash_token(&token), now, now],
    )
    .map_err(|err| internal_response(format!("failed to insert token: {err}")))?;
    tx.execute(
        "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
         VALUES (?, 'device.paired', ?, ?, ?)",
        params![
            device_id,
            device_id,
            json!({
                "device_name": request.device_name,
                "client_device_id": request.device_id,
                "client_nonce": request.client_nonce,
                "pairing_session_id": session_id,
                "reused_device": reused_device,
                "superseded_device_ids": superseded_device_ids,
            })
            .to_string(),
            now
        ],
    )
    .map_err(|err| internal_response(format!("failed to insert pairing audit event: {err}")))?;
    tx.commit()
        .map_err(|err| internal_response(format!("failed to commit pairing transaction: {err}")))?;

    Ok((token, device_id))
}

fn revoke_device(
    conn: &mut Connection,
    actor_device_id: &str,
    device_id: &str,
) -> Result<(), Response> {
    let now = now_secs();
    let tx = conn
        .transaction()
        .map_err(|err| internal_response(format!("failed to begin revoke transaction: {err}")))?;
    let revoked_at = tx
        .query_row(
            "SELECT revoked_at FROM devices WHERE id = ? LIMIT 1",
            [device_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|err| internal_response(format!("failed to lookup device for revoke: {err}")))?;
    let Some(existing_revoked_at) = revoked_at else {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            ErrorPayload::new(ErrorClass::NotFound, format!("unknown device: {device_id}")),
        ));
    };
    if existing_revoked_at.is_some() {
        tx.commit().map_err(|err| {
            internal_response(format!("failed to finish no-op revoke transaction: {err}"))
        })?;
        return Ok(());
    }
    tx.execute(
        "UPDATE devices SET revoked_at = ? WHERE id = ?",
        params![now, device_id],
    )
    .map_err(|err| internal_response(format!("failed to revoke device: {err}")))?;
    tx.execute(
        "UPDATE tokens SET revoked_at = ? WHERE device_id = ?",
        params![now, device_id],
    )
    .map_err(|err| internal_response(format!("failed to revoke tokens: {err}")))?;
    tx.execute(
        "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
         VALUES (?, 'device.revoked', ?, NULL, ?)",
        params![actor_device_id, device_id, now],
    )
    .map_err(|err| internal_response(format!("failed to insert revoke audit event: {err}")))?;
    tx.commit()
        .map_err(|err| internal_response(format!("failed to commit revoke transaction: {err}")))?;
    Ok(())
}

fn insert_audit(
    conn: &mut Connection,
    actor_device_id: Option<&str>,
    kind: &str,
    subject: Option<&str>,
    payload: Option<serde_json::Value>,
) -> Result<(), Response> {
    conn.execute(
        "INSERT INTO audit_events (actor_device_id, kind, subject, payload, created_at)
         VALUES (?, ?, ?, ?, ?)",
        params![
            actor_device_id,
            kind,
            subject,
            payload.map(|value| value.to_string()),
            now_secs()
        ],
    )
    .map_err(|err| internal_response(format!("failed to insert audit event: {err}")))?;
    Ok(())
}

fn lookup_auth_session(
    conn: &mut Connection,
    token_hash: &str,
) -> Result<Option<AuthSession>, Response> {
    let now = now_secs();
    let row = conn
        .query_row(
            "SELECT tokens.id, devices.id, devices.scopes
             FROM tokens
             JOIN devices ON devices.id = tokens.device_id
             WHERE tokens.token_hash = ? AND tokens.revoked_at IS NULL AND devices.revoked_at IS NULL
             LIMIT 1",
            [token_hash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| internal_response(format!("failed to query auth token: {err}")))?;

    let Some((token_id, device_id, scopes_json)) = row else {
        return Ok(None);
    };

    conn.execute(
        "UPDATE tokens SET last_seen_at = ? WHERE id = ?",
        params![now, token_id],
    )
    .map_err(|err| internal_response(format!("failed to update token last_seen_at: {err}")))?;
    conn.execute(
        "UPDATE devices SET last_seen_at = ? WHERE id = ?",
        params![now, device_id],
    )
    .map_err(|err| internal_response(format!("failed to update device last_seen_at: {err}")))?;

    let scopes = serde_json::from_str::<Vec<String>>(&scopes_json)
        .map_err(|err| internal_response(format!("failed to decode auth scopes: {err}")))?;
    Ok(Some(AuthSession {
        token_id,
        device_id,
        scopes,
        local: false,
    }))
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn random_u32() -> u32 {
    let mut bytes = [0_u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    u32::from_le_bytes(bytes)
}

fn init_logging(config: &ServerConfig) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(&config.log_dir)?;
    let file_appender = tracing_appender::rolling::daily(&config.log_dir, "swarm-server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    let _ = Box::leak(Box::new(_guard));

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "swarm_server=info".into()),
        )
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();

    Ok(())
}

fn load_or_create_certificate(
    config: &ServerConfig,
) -> Result<(String, Vec<u8>, Vec<u8>), Box<dyn std::error::Error>> {
    if config.cert_pem_path.exists() && config.key_pem_path.exists() {
        let cert_pem = fs::read(&config.cert_pem_path)?;
        let key_pem = fs::read(&config.key_pem_path)?;
        let fingerprint = certificate_fingerprint(&cert_pem)?;
        return Ok((fingerprint, cert_pem, key_pem));
    }

    if let Some(parent) = config.cert_pem_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = config.key_pem_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let hostname = hostname_get()?.to_string_lossy().into_owned();
    let alt_names = vec![
        "localhost".to_string(),
        hostname.clone(),
        format!("{hostname}.local"),
    ];
    let certified = generate_simple_self_signed(alt_names)?;
    let cert_pem = certified.cert.pem().into_bytes();
    let key_pem = certified.key_pair.serialize_pem().into_bytes();
    let fingerprint = certificate_fingerprint(&cert_pem)?;

    fs::write(&config.cert_pem_path, &cert_pem)?;
    fs::write(&config.key_pem_path, &key_pem)?;
    Ok((fingerprint, cert_pem, key_pem))
}

fn certificate_fingerprint(cert_pem: &[u8]) -> Result<String, Box<dyn std::error::Error>> {
    let mut reader = std::io::BufReader::new(cert_pem);
    let mut certs = pemfile::certs(&mut reader);
    let Some(cert) = certs.next().transpose()? else {
        return Err("certificate PEM did not contain any certificates".into());
    };

    Ok(format!(
        "sha256:{}",
        hex::encode_upper(Sha256::digest(cert.as_ref()))
    ))
}

fn spawn_bonjour_advertisement(
    config: &ServerConfig,
    fingerprint: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use zeroconf::prelude::*;
    use zeroconf::{MdnsService, ServiceType, TxtRecord};

    let hostname = hostname_get()?.to_string_lossy().into_owned();
    let service_type = ServiceType::new("swarm", "tcp")?;
    let mut service = MdnsService::new(service_type, config.bind_addr.port());
    let mut txt = TxtRecord::new();

    txt.insert("v", &PROTOCOL_VERSION.to_string())?;
    txt.insert("fingerprint", fingerprint)?;
    txt.insert("port", &config.bind_addr.port().to_string())?;
    service.set_name(&hostname);
    service.set_txt_record(txt);

    let event_loop = service.register()?;
    std::thread::spawn(move || {
        loop {
            if let Err(err) = event_loop.poll(Duration::from_secs(1)) {
                warn!(%err, "bonjour event loop poll failed");
                std::thread::sleep(Duration::from_secs(5));
            }
        }
    });

    Ok(())
}

fn bonjour_advertisement_enabled() -> bool {
    std::env::var_os("SWARM_ENABLE_BONJOUR").is_some() || !cfg!(debug_assertions)
}

impl ServerConfig {
    fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let port = std::env::var("SWARM_SERVER_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let hostname = hostname_get()?.to_string_lossy().trim().to_owned();
        let pairing_host = if hostname.is_empty() {
            "localhost".to_owned()
        } else if hostname.contains('.') {
            hostname
        } else {
            format!("{hostname}.local")
        };
        let base = swarm_db_path()?
            .parent()
            .map_or_else(|| PathBuf::from(".swarm-mcp"), Path::to_path_buf);
        let server_dir = base.join("server");
        Ok(Self {
            bind_addr: SocketAddr::from(([0, 0, 0, 0], port)),
            pairing_host,
            swarm_db_path: swarm_db_path()?,
            server_db_path: server_dir.join("server.db"),
            cert_pem_path: server_dir.join("pinned.pem"),
            key_pem_path: server_dir.join("pinned-key.pem"),
            uds_path: server_dir.join("swarm-server.sock"),
            log_dir: server_dir.join("logs"),
        })
    }
}

impl Default for RedactionPolicy {
    fn default() -> Self {
        Self {
            allowed_kv_prefixes: vec!["progress/", "status/", "review/", "owner/", "queue/"],
            denied_key_fragments: vec!["token", "secret", "password", "apikey", "api_key"],
        }
    }
}

impl RedactionPolicy {
    fn redact_snapshot(&self, mut snapshot: SwarmSnapshot, scopes: &[String]) -> SwarmSnapshot {
        let scope_filter = scopes
            .iter()
            .filter(|scope| !scope.is_empty())
            .collect::<Vec<_>>();
        if !scope_filter.is_empty() {
            snapshot
                .instances
                .retain(|row| scope_filter.contains(&&row.scope));
            snapshot
                .tasks
                .retain(|row| scope_filter.contains(&&row.scope));
            snapshot
                .messages
                .retain(|row| scope_filter.contains(&&row.scope));
            snapshot
                .locks
                .retain(|row| scope_filter.contains(&&row.scope));
            snapshot
                .annotations
                .retain(|row| scope_filter.contains(&&row.scope));
            snapshot.kv.retain(|row| scope_filter.contains(&&row.scope));
            snapshot
                .events
                .retain(|row| scope_filter.contains(&&row.scope));
        }

        for entry in &mut snapshot.kv {
            if self.should_redact_kv(entry) {
                entry.value = "[redacted]".into();
            }
        }

        snapshot.events.truncate(RECENT_EVENT_LIMIT as usize);
        snapshot
    }

    fn should_redact_kv(&self, entry: &swarm_protocol::KvEntry) -> bool {
        if self
            .allowed_kv_prefixes
            .iter()
            .any(|prefix| entry.key.starts_with(prefix))
        {
            return false;
        }

        let lower = entry.key.to_ascii_lowercase();
        self.denied_key_fragments
            .iter()
            .any(|fragment| lower.contains(fragment))
            || !entry.value.trim_start().starts_with('{')
    }
}

fn error_response(status: StatusCode, payload: ErrorPayload) -> Response {
    (status, Json(payload)).into_response()
}

fn internal_response(message: impl Into<String>) -> Response {
    error_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        ErrorPayload::new(ErrorClass::Internal, message.into()),
    )
}

fn response_error_message(response: Response) -> String {
    format!("websocket rejected with status {}", response.status())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = signal::ctrl_c().await;
    };
    ctrl_c.await;
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("swarm-server-{name}-{}.db", Uuid::new_v4()))
    }

    fn open_test_db(name: &str) -> Connection {
        let path = test_db_path(name);
        open_server_db(&path).expect("test db should open")
    }

    fn count_rows(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("row count should succeed")
    }

    #[test]
    fn schema_bootstrap_is_idempotent() {
        let path = test_db_path("schema-bootstrap");

        let conn = open_server_db(&path).expect("first bootstrap should succeed");
        drop(conn);

        let conn = open_server_db(&path).expect("second bootstrap should succeed");
        let tables = [
            "devices",
            "tokens",
            "pairing_codes",
            "rate_limits",
            "audit_events",
        ];
        for table in tables {
            let exists = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [table],
                    |_| Ok(()),
                )
                .optional()
                .expect("table lookup should succeed")
                .is_some();
            assert!(exists, "{table} should exist after bootstrap");
        }

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn swarm_db_bootstrap_is_shared_and_versioned() {
        let path = test_db_path("swarm-db-schema");

        let conn = open_swarm_rw(&path)
            .unwrap_or_else(|response| panic!("swarm db bootstrap failed: {}", response.status()));

        assert_eq!(
            swarm_schema::user_version(&conn).expect("user_version should be readable"),
            swarm_schema::SWARM_DB_VERSION
        );
        for table in swarm_schema::EXPECTED_TABLES {
            let exists = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [*table],
                    |_| Ok(()),
                )
                .optional()
                .expect("table lookup should succeed")
                .is_some();
            assert!(exists, "{table} should exist after shared schema bootstrap");
        }

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pairing_transaction_rolls_back_on_token_insert_failure() {
        let mut conn = open_test_db("pair-rollback");
        let now = now_secs();
        conn.execute(
            "INSERT INTO pairing_codes (code, session_id, cert_fingerprint, pairing_secret, created_at, expires_at, used_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)",
            params![
                "123456",
                "sess-rollback",
                "fp-1",
                "pair-secret",
                now,
                now + 600
            ],
        )
        .expect("pairing code insert should succeed");
        conn.execute_batch(
            "CREATE TRIGGER fail_token_insert
             BEFORE INSERT ON tokens
             BEGIN
               SELECT RAISE(FAIL, 'boom');
             END;",
        )
        .expect("trigger install should succeed");

        let request = PairRequest {
            v: PROTOCOL_VERSION,
            code: "123456".into(),
            device_name: "Test Phone".into(),
            device_id: "ios-device-1".into(),
            platform: Some("iphone".into()),
            pairing_secret: "pair-secret".into(),
            client_nonce: "nonce-1".into(),
        };

        let result =
            consume_pairing_code_and_issue_token(&mut conn, "fp-1", &request, &["scope-a".into()]);
        assert!(
            result.is_err(),
            "pairing should fail when token insert fails"
        );

        let used_at = conn
            .query_row(
                "SELECT used_at FROM pairing_codes WHERE code = '123456'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("pairing code lookup should succeed");
        assert_eq!(used_at, None, "pairing code consumption should roll back");
        assert_eq!(
            count_rows(&conn, "devices"),
            0,
            "device insert should roll back"
        );
        assert_eq!(
            count_rows(&conn, "tokens"),
            0,
            "token insert should roll back"
        );
        assert_eq!(
            count_rows(&conn, "audit_events"),
            0,
            "pairing audit insert should roll back",
        );
    }

    #[test]
    fn pairing_reuses_active_client_device_and_rotates_token() {
        let mut conn = open_test_db("pair-reuse-device");
        let now = now_secs();
        for (code, session_id, secret) in [
            ("123456", "sess-1", "pair-secret-1"),
            ("654321", "sess-2", "pair-secret-2"),
        ] {
            conn.execute(
                "INSERT INTO pairing_codes (
                   code, session_id, cert_fingerprint, pairing_secret, created_at, expires_at
                 ) VALUES (?, ?, ?, ?, ?, ?)",
                params![code, session_id, "fp-1", secret, now, now + 600],
            )
            .expect("pairing code insert should succeed");
        }

        let first = PairRequest {
            v: PROTOCOL_VERSION,
            code: "123456".into(),
            device_name: "Test Phone".into(),
            device_id: "ios-device-1".into(),
            platform: Some("ios".into()),
            pairing_secret: "pair-secret-1".into(),
            client_nonce: "nonce-1".into(),
        };
        let (first_token, first_device_id) =
            consume_pairing_code_and_issue_token(&mut conn, "fp-1", &first, &["scope-a".into()])
                .expect("first pairing should succeed");

        let second = PairRequest {
            code: "654321".into(),
            device_name: "Renamed Phone".into(),
            pairing_secret: "pair-secret-2".into(),
            client_nonce: "nonce-2".into(),
            ..first
        };
        let (second_token, second_device_id) =
            consume_pairing_code_and_issue_token(&mut conn, "fp-1", &second, &["scope-b".into()])
                .expect("second pairing should succeed");

        assert_ne!(
            first_token, second_token,
            "re-pairing should rotate the bearer token"
        );
        assert_eq!(
            first_device_id, second_device_id,
            "same client_device_id should reuse the active server device row"
        );
        assert_eq!(
            count_rows(&conn, "devices"),
            1,
            "no duplicate active device row"
        );
        assert_eq!(
            count_rows(&conn, "tokens"),
            2,
            "token history should be retained"
        );

        let active_tokens = conn
            .query_row(
                "SELECT COUNT(*) FROM tokens WHERE device_id = ? AND revoked_at IS NULL",
                [second_device_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("active token count should succeed");
        assert_eq!(
            active_tokens, 1,
            "only the newest token should remain active"
        );

        let revoked_tokens = conn
            .query_row(
                "SELECT COUNT(*) FROM tokens WHERE device_id = ? AND revoked_at IS NOT NULL",
                [second_device_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("revoked token count should succeed");
        assert_eq!(revoked_tokens, 1, "previous token should be revoked");

        let stored_name = conn
            .query_row(
                "SELECT device_name FROM devices WHERE id = ?",
                [second_device_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .expect("device name lookup should succeed");
        assert_eq!(stored_name, "Renamed Phone");
    }

    #[test]
    fn revoke_transaction_rolls_back_on_audit_failure() {
        let mut conn = open_test_db("revoke-rollback");
        let now = now_secs();
        conn.execute(
            "INSERT INTO devices (id, client_device_id, device_name, platform, scopes, created_at, last_seen_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
            params!["dev-1", "client-1", "Phone", "iphone", "[]", now, now],
        )
        .expect("device insert should succeed");
        conn.execute(
            "INSERT INTO tokens (id, device_id, token_hash, created_at, last_seen_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, NULL)",
            params!["tok-1", "dev-1", "hash-1", now, now],
        )
        .expect("token insert should succeed");
        conn.execute_batch(
            "CREATE TRIGGER fail_audit_insert
             BEFORE INSERT ON audit_events
             BEGIN
               SELECT RAISE(FAIL, 'boom');
             END;",
        )
        .expect("trigger install should succeed");

        let result = revoke_device(&mut conn, "actor-1", "dev-1");
        assert!(
            result.is_err(),
            "revoke should fail when audit insert fails"
        );

        let revoked_at = conn
            .query_row(
                "SELECT revoked_at FROM devices WHERE id = 'dev-1'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("device lookup should succeed");
        assert_eq!(revoked_at, None, "device revoke should roll back");

        let token_revoked_at = conn
            .query_row(
                "SELECT revoked_at FROM tokens WHERE id = 'tok-1'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("token lookup should succeed");
        assert_eq!(token_revoked_at, None, "token revoke should roll back");
        assert_eq!(
            count_rows(&conn, "audit_events"),
            0,
            "revoke audit insert should roll back",
        );
    }

    #[test]
    fn cancel_active_pairing_sessions_marks_rows_and_audits() {
        let mut conn = open_test_db("cancel-pairing-session");
        let now = now_secs();
        conn.execute(
            "INSERT INTO pairing_codes (
               code, session_id, cert_fingerprint, pairing_secret, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
            params!["123456", "sess-1", "fp-1", "pair-secret", now, now + 120],
        )
        .expect("pairing session insert should succeed");

        let canceled = cancel_active_pairing_sessions(&mut conn, Some("local:swarm-ui"), "test")
            .expect("active pairing-session cancel should succeed");
        assert!(canceled, "expected one active pairing session to cancel");

        let canceled_at = conn
            .query_row(
                "SELECT canceled_at FROM pairing_codes WHERE session_id = 'sess-1'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("pairing session lookup should succeed");
        assert!(canceled_at.is_some(), "pairing session should be canceled");

        let audit_kind = conn
            .query_row(
                "SELECT kind FROM audit_events WHERE subject = 'sess-1' LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("pairing session audit lookup should succeed");
        assert_eq!(audit_kind, "pairing_session.canceled");
    }

    #[test]
    fn expire_pairing_sessions_marks_rows_and_audits() {
        let mut conn = open_test_db("expire-pairing-session");
        let now = now_secs();
        conn.execute(
            "INSERT INTO pairing_codes (
               code, session_id, cert_fingerprint, pairing_secret, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                "123456",
                "sess-1",
                "fp-1",
                "pair-secret",
                now - 300,
                now - 1
            ],
        )
        .expect("expired pairing session insert should succeed");

        expire_pairing_sessions(&mut conn).expect("pairing session expiry sweep should succeed");

        let expired_at = conn
            .query_row(
                "SELECT expired_at FROM pairing_codes WHERE session_id = 'sess-1'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("expired pairing session lookup should succeed");
        assert!(
            expired_at.is_some(),
            "pairing session should be marked expired"
        );

        let audit_kind = conn
            .query_row(
                "SELECT kind FROM audit_events WHERE subject = 'sess-1' LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("expired pairing session audit lookup should succeed");
        assert_eq!(audit_kind, "pairing_session.expired");
    }

    #[test]
    fn state_filter_prunes_unchanged_tables() {
        let snapshot = SwarmSnapshot {
            instances: vec![swarm_protocol::Instance {
                id: "inst-1".into(),
                scope: "scope-a".into(),
                directory: "/tmp".into(),
                root: "/tmp".into(),
                file_root: "/tmp".into(),
                pid: 42,
                label: Some("agent".into()),
                registered_at: 10,
                heartbeat: 10,
                status: swarm_protocol::InstanceStatus::Online,
                adopted: true,
            }],
            tasks: vec![swarm_protocol::Task {
                id: "task-1".into(),
                scope: "scope-a".into(),
                type_: swarm_protocol::TaskType::Review,
                title: "Review".into(),
                description: None,
                requester: "req".into(),
                assignee: None,
                status: swarm_protocol::TaskStatus::Open,
                files: vec![],
                result: None,
                created_at: 10,
                updated_at: 10,
                changed_at: 10,
                priority: 1,
                depends_on: vec![],
                parent_task_id: None,
            }],
            messages: vec![swarm_protocol::Message {
                id: 12,
                scope: "scope-a".into(),
                sender: "alice".into(),
                recipient: None,
                content: "hi".into(),
                created_at: 10,
                read: false,
            }],
            locks: vec![],
            annotations: vec![],
            kv: vec![],
            events: vec![],
            ptys: vec![],
            cursors: TableCursors {
                messages: Some(12),
                events: Some(0),
                instances: Some(swarm_protocol::ChangeCursor::new(10, "inst-1")),
                tasks: Some(swarm_protocol::ChangeCursor::new(10, "task-1")),
                locks: None,
                annotations: None,
                kv: None,
                ptys: None,
            },
            server_time: 10,
        };

        let filtered = filter_snapshot_since(
            snapshot,
            &TableCursors {
                messages: Some(12),
                events: None,
                instances: Some(swarm_protocol::ChangeCursor::new(10, "inst-1")),
                tasks: Some(swarm_protocol::ChangeCursor::new(9, "task-1")),
                locks: None,
                annotations: None,
                kv: None,
                ptys: None,
            },
        );

        assert!(
            filtered.messages.is_empty(),
            "unchanged messages should be pruned"
        );
        assert!(
            filtered.instances.is_empty(),
            "unchanged instances should be pruned"
        );
        assert_eq!(
            filtered.tasks.len(),
            1,
            "newer task data should be retained"
        );
    }

    #[test]
    fn certificate_fingerprint_matches_leaf_certificate_der() {
        let certified = generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("certificate generation should succeed");
        let cert_pem = certified.cert.pem().into_bytes();
        let expected = format!(
            "sha256:{}",
            hex::encode_upper(Sha256::digest(certified.cert.der().as_ref()))
        );

        let actual =
            certificate_fingerprint(&cert_pem).expect("fingerprint extraction should succeed");

        assert_eq!(actual, expected);
    }
}
