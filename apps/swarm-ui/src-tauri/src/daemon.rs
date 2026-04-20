use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use swarm_protocol::errors::ErrorPayload;
use swarm_protocol::frames::{Frame, SubscribeFrame};
use swarm_protocol::rpc::{
    Ack, CancelPairingSessionResponse, ClosePtyRequest, CreatePairingSessionRequest, DeviceInfo,
    DevicesResponse, LeaseResponse, PairingSessionInfo, ReleaseLeaseRequest, RequestLeaseRequest,
    ResizePtyRequest, RevokeRequest, RevokeResponse, SpawnPtyRequest, SpawnPtyResponse,
    WritePtyRequest,
};
use swarm_protocol::{FramePayload, PROTOCOL_VERSION, SwarmSnapshot, TableCursors};
use swarm_state::swarm_db_path;
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{WebSocketStream, client_async};

pub type DaemonWebSocket = WebSocketStream<UnixStream>;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub fn socket_path() -> Result<PathBuf, String> {
    let base = swarm_db_path()?
        .parent()
        .map_or_else(|| PathBuf::from(".swarm-mcp"), Path::to_path_buf);
    Ok(base.join("server").join("swarm-server.sock"))
}

pub fn ensure_running() -> Result<(), String> {
    if daemon_socket_available() {
        return Ok(());
    }

    let launch = server_launch_plan().ok_or_else(manual_start_hint)?;
    launch.spawn()?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if daemon_socket_available() {
            return Ok(());
        }
        thread::sleep(STARTUP_POLL_INTERVAL);
    }

    Err(format!(
        "swarm-server did not become ready within {} seconds after launching {}. {}",
        STARTUP_TIMEOUT.as_secs(),
        launch.describe(),
        manual_start_hint()
    ))
}

fn daemon_socket_available() -> bool {
    let Ok(path) = socket_path() else {
        return false;
    };
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerLaunchPlan {
    Binary(PathBuf),
    Cargo { manifest_path: PathBuf },
}

impl ServerLaunchPlan {
    fn describe(&self) -> String {
        match self {
            Self::Binary(path) => path.display().to_string(),
            Self::Cargo { manifest_path } => {
                format!("cargo run --manifest-path {}", manifest_path.display())
            }
        }
    }

    fn spawn(&self) -> Result<(), String> {
        let mut command = match self {
            Self::Binary(path) => Command::new(path),
            Self::Cargo { manifest_path } => {
                let mut command = Command::new(cargo_binary());
                command
                    .arg("run")
                    .arg("--manifest-path")
                    .arg(manifest_path);
                command
            }
        };

        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        command
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to launch {}: {err}", self.describe()))
    }
}

fn server_launch_plan() -> Option<ServerLaunchPlan> {
    server_launch_plan_with(
        std::env::var_os("SWARM_SERVER_BIN").map(PathBuf::from),
        current_exe_server_path(),
        workspace_server_binary_candidates(),
        workspace_manifest_path(),
        cfg!(debug_assertions),
    )
}

fn current_exe_server_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("swarm-server"))
}

fn workspace_server_binary_candidates() -> Vec<PathBuf> {
    let Some(root) = workspace_root() else {
        return Vec::new();
    };

    vec![
        root.join("target").join("debug").join("swarm-server"),
        root.join("target").join("release").join("swarm-server"),
    ]
}

fn workspace_manifest_path() -> Option<PathBuf> {
    workspace_root()
        .map(|root| root.join("apps").join("swarm-server").join("Cargo.toml"))
}

fn server_launch_plan_with(
    env_override: Option<PathBuf>,
    current_exe_server: Option<PathBuf>,
    workspace_binary_candidates: Vec<PathBuf>,
    workspace_manifest: Option<PathBuf>,
    prefer_cargo_manifest: bool,
) -> Option<ServerLaunchPlan> {
    if let Some(path) = env_override.filter(|path| path.is_file()) {
        return Some(ServerLaunchPlan::Binary(path));
    }

    let workspace_manifest = workspace_manifest.filter(|path| path.is_file());
    if prefer_cargo_manifest {
        if let Some(manifest_path) = workspace_manifest.clone() {
            return Some(ServerLaunchPlan::Cargo { manifest_path });
        }
    }

    if let Some(path) = current_exe_server.filter(|path| path.is_file()) {
        return Some(ServerLaunchPlan::Binary(path));
    }

    for path in workspace_binary_candidates {
        if path.is_file() {
            return Some(ServerLaunchPlan::Binary(path));
        }
    }

    workspace_manifest.map(|manifest_path| ServerLaunchPlan::Cargo { manifest_path })
}

fn workspace_root() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .filter(|path| path.is_dir())
}

fn cargo_binary() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".cargo").join("bin").join("cargo"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("cargo"))
}

fn manual_start_hint() -> String {
    let socket = socket_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "~/.swarm-mcp/server/swarm-server.sock".to_owned());

    if let Some(manifest_path) = workspace_root()
        .map(|root| root.join("apps").join("swarm-server").join("Cargo.toml"))
        .filter(|path| path.is_file())
    {
        format!(
            "Run `cargo run --manifest-path {}` to start it manually. Expected socket: {}",
            manifest_path.display(),
            socket
        )
    } else {
        format!("Expected socket: {socket}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "swarm-ui-daemon-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn server_launch_plan_prefers_cargo_manifest_for_debug_builds() {
        let current_bin = temp_path("current-bin");
        let manifest_path = temp_path("manifest");
        std::fs::write(&current_bin, "").expect("current binary stub should be created");
        std::fs::write(&manifest_path, "").expect("manifest stub should be created");

        let plan = server_launch_plan_with(
            None,
            Some(current_bin.clone()),
            vec![],
            Some(manifest_path.clone()),
            true,
        );

        assert_eq!(
            plan,
            Some(ServerLaunchPlan::Cargo {
                manifest_path: manifest_path.clone(),
            })
        );

        let _ = std::fs::remove_file(current_bin);
        let _ = std::fs::remove_file(manifest_path);
    }

    #[test]
    fn server_launch_plan_respects_explicit_binary_override() {
        let override_bin = temp_path("override-bin");
        let manifest_path = temp_path("manifest");
        std::fs::write(&override_bin, "").expect("override binary stub should be created");
        std::fs::write(&manifest_path, "").expect("manifest stub should be created");

        let plan = server_launch_plan_with(
            Some(override_bin.clone()),
            None,
            vec![],
            Some(manifest_path.clone()),
            true,
        );

        assert_eq!(
            plan,
            Some(ServerLaunchPlan::Binary(override_bin.clone()))
        );

        let _ = std::fs::remove_file(override_bin);
        let _ = std::fs::remove_file(manifest_path);
    }
}

async fn send_request(
    method: Method,
    path: &str,
    body: Option<Vec<u8>>,
    accept: Option<&str>,
) -> Result<Bytes, String> {
    let stream = UnixStream::connect(socket_path()?)
        .await
        .map_err(|err| format!("failed to connect to swarm-server UDS: {err}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, connection) = http1::handshake(io)
        .await
        .map_err(|err| format!("failed to handshake UDS HTTP client: {err}"))?;

    tauri::async_runtime::spawn(async move {
        let _ = connection.await;
    });

    let body = body.unwrap_or_default();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HeaderValue::from_static("localhost"))
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
    if let Some(accept) = accept {
        request = request.header(
            header::ACCEPT,
            HeaderValue::from_str(accept)
                .map_err(|err| format!("invalid Accept header value {accept}: {err}"))?,
        );
    }

    let response = sender
        .send_request(
            request
                .body(Full::new(Bytes::from(body)))
                .map_err(|err| format!("failed to build daemon request: {err}"))?,
        )
        .await
        .map_err(|err| format!("daemon request failed: {err}"))?;

    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|err| format!("failed to read daemon response body: {err}"))?
        .to_bytes();

    if status.is_success() {
        Ok(bytes)
    } else if let Ok(payload) = serde_json::from_slice::<ErrorPayload>(&bytes) {
        Err(payload.message)
    } else {
        Err(format!(
            "daemon request to {path} failed with status {status}"
        ))
    }
}

async fn json_request<TReq: Serialize, TResp: serde::de::DeserializeOwned>(
    method: Method,
    path: &str,
    body: &TReq,
) -> Result<TResp, String> {
    let bytes = serde_json::to_vec(body)
        .map_err(|err| format!("failed to encode daemon request body: {err}"))?;
    let response = send_request(method, path, Some(bytes), Some("application/json")).await?;
    serde_json::from_slice(&response)
        .map_err(|err| format!("failed to decode daemon response body: {err}"))
}

async fn json_request_without_body<TResp: serde::de::DeserializeOwned>(
    method: Method,
    path: &str,
) -> Result<TResp, String> {
    let response = send_request(method, path, None, Some("application/json")).await?;
    serde_json::from_slice(&response)
        .map_err(|err| format!("failed to decode daemon response body: {err}"))
}

pub async fn fetch_state() -> Result<SwarmSnapshot, String> {
    let response = send_request(Method::GET, "/state", None, Some("application/json")).await?;
    serde_json::from_slice(&response)
        .map_err(|err| format!("failed to decode daemon state snapshot: {err}"))
}

pub async fn fetch_devices() -> Result<Vec<DeviceInfo>, String> {
    let response: DevicesResponse = json_request_without_body(Method::GET, "/auth/devices").await?;
    Ok(response.devices)
}

pub async fn create_pairing_session() -> Result<PairingSessionInfo, String> {
    let response: swarm_protocol::rpc::CreatePairingSessionResponse = json_request(
        Method::POST,
        "/auth/pairing-session",
        &CreatePairingSessionRequest {
            v: PROTOCOL_VERSION,
        },
    )
    .await?;
    Ok(response.session)
}

pub async fn cancel_pairing_session(session_id: &str) -> Result<(), String> {
    let _: CancelPairingSessionResponse = json_request_without_body(
        Method::DELETE,
        &format!("/auth/pairing-session/{session_id}"),
    )
    .await?;
    Ok(())
}

pub async fn revoke_device(device_id: &str) -> Result<(), String> {
    let _: RevokeResponse = json_request(
        Method::POST,
        "/auth/revoke",
        &RevokeRequest {
            v: PROTOCOL_VERSION,
            device_id: device_id.to_owned(),
        },
    )
    .await?;
    Ok(())
}

pub async fn spawn_pty(request: &SpawnPtyRequest) -> Result<SpawnPtyResponse, String> {
    json_request(Method::POST, "/pty", request).await
}

pub async fn write_pty(pty_id: &str, data: Vec<u8>) -> Result<(), String> {
    let request = WritePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: pty_id.to_owned(),
        data,
    };
    let _: Ack = json_request(Method::POST, &format!("/pty/{pty_id}/input"), &request).await?;
    Ok(())
}

pub async fn resize_pty(pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let request = ResizePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: pty_id.to_owned(),
        cols,
        rows,
    };
    let _: Ack = json_request(Method::POST, &format!("/pty/{pty_id}/resize"), &request).await?;
    Ok(())
}

pub async fn close_pty(pty_id: &str) -> Result<(), String> {
    let request = ClosePtyRequest {
        v: PROTOCOL_VERSION,
        pty_id: pty_id.to_owned(),
        force: false,
    };
    let _: Ack = json_request(Method::DELETE, &format!("/pty/{pty_id}"), &request).await?;
    Ok(())
}

pub async fn request_pty_lease(pty_id: &str, takeover: bool) -> Result<LeaseResponse, String> {
    let request = RequestLeaseRequest {
        v: PROTOCOL_VERSION,
        pty_id: pty_id.to_owned(),
        takeover,
    };
    json_request(Method::POST, &format!("/pty/{pty_id}/lease"), &request).await
}

pub async fn release_pty_lease(pty_id: &str) -> Result<(), String> {
    let request = ReleaseLeaseRequest {
        v: PROTOCOL_VERSION,
        pty_id: pty_id.to_owned(),
    };
    let _: Ack = json_request(Method::DELETE, &format!("/pty/{pty_id}/lease"), &request).await?;
    Ok(())
}

pub async fn open_stream() -> Result<DaemonWebSocket, String> {
    let stream = UnixStream::connect(socket_path()?)
        .await
        .map_err(|err| format!("failed to connect daemon stream socket: {err}"))?;
    let (socket, _) = client_async("ws://localhost/stream", stream)
        .await
        .map_err(|err| format!("failed to open daemon websocket stream: {err}"))?;
    Ok(socket)
}

pub async fn subscribe(socket: &mut DaemonWebSocket) -> Result<(), String> {
    subscribe_with_cursors(socket, TableCursors::default()).await
}

pub async fn subscribe_with_cursors(
    socket: &mut DaemonWebSocket,
    cursors: TableCursors,
) -> Result<(), String> {
    send_frame(
        socket,
        &Frame::new(FramePayload::Subscribe(SubscribeFrame {
            scope: None,
            cursors,
        })),
    )
    .await
}

pub async fn send_frame(socket: &mut DaemonWebSocket, frame: &Frame) -> Result<(), String> {
    let payload = serde_json::to_string(frame)
        .map_err(|err| format!("failed to encode daemon stream frame: {err}"))?;
    socket
        .send(Message::Text(payload))
        .await
        .map_err(|err| format!("failed to write daemon stream frame: {err}"))
}

pub async fn read_frame(socket: &mut DaemonWebSocket) -> Result<Option<Frame>, String> {
    let Some(message) = socket.next().await else {
        return Ok(None);
    };
    let message = message.map_err(|err| format!("failed to read daemon stream frame: {err}"))?;
    match message {
        Message::Binary(bytes) => rmp_serde::from_slice(&bytes)
            .map(Some)
            .map_err(|err| format!("failed to decode daemon msgpack frame: {err}")),
        Message::Text(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|err| format!("failed to decode daemon json frame: {err}")),
        Message::Close(_) => Ok(None),
        Message::Ping(_) | Message::Pong(_) => Ok(None),
        other => Err(format!("unsupported daemon websocket frame: {other:?}")),
    }
}
