mod buffer;
mod lease;

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use swarm_protocol::cursors::{ChangeCursor, PtySeq};
use swarm_protocol::frames::{
    DeltaTableFrame, Frame, FramePayload, LeaseChangedFrame, PtyAttachRejectedFrame, PtyDataFrame,
    PtyExitFrame,
};
use swarm_protocol::rpc::{
    Ack, ClosePtyRequest, LeaseResponse, ReleaseLeaseRequest, RequestLeaseRequest,
    ResizePtyRequest, SpawnPtyRequest, SpawnPtyResponse, WritePtyRequest,
};
use swarm_protocol::state::{Lease, PtyInfo};
use tokio::sync::broadcast;
use tracing::{info, warn};
use uuid::Uuid;

use self::buffer::ReplayBuffer;
use self::lease::{LeaseMutation, LeaseState};
use crate::error::{ServerError, validate_protocol_version};
use crate::launch::{LaunchConfig, LaunchPlan, build_launch_plan};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 40;
const DEFAULT_BUFFER_CAPACITY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_BROADCAST_CAPACITY: usize = 512;
const DEFAULT_JOURNAL_CAPACITY: usize = 4096;
const TAKEOVER_GRACE_MS: u64 = 2_000;

type SessionMap = Arc<RwLock<HashMap<String, Arc<PtyHandle>>>>;

#[derive(Debug, Clone)]
pub struct PtyServiceConfig {
    pub buffer_capacity_bytes: usize,
    pub broadcast_capacity: usize,
    pub catalog_journal_capacity: usize,
    pub default_cols: u16,
    pub default_rows: u16,
    pub coalesce_window: Duration,
    pub exit_retention: Duration,
    pub takeover_grace: Duration,
    /// Grace delay after first PTY output before the asynchronous
    /// initial_input dispatcher writes its first byte, giving the harness TUI
    /// a chance to wire up stdin.
    pub initial_input_readiness: Duration,
    /// Upper bound on initial_input delivery; on expiry the child is killed
    /// and the PTY is torn down with a visible PtyExit.
    pub initial_input_timeout: Duration,
}

impl Default for PtyServiceConfig {
    fn default() -> Self {
        Self {
            buffer_capacity_bytes: DEFAULT_BUFFER_CAPACITY_BYTES,
            broadcast_capacity: DEFAULT_BROADCAST_CAPACITY,
            catalog_journal_capacity: DEFAULT_JOURNAL_CAPACITY,
            default_cols: DEFAULT_COLS,
            default_rows: DEFAULT_ROWS,
            coalesce_window: Duration::from_millis(16),
            exit_retention: Duration::from_secs(10),
            takeover_grace: Duration::from_millis(TAKEOVER_GRACE_MS),
            initial_input_readiness: Duration::from_millis(250),
            initial_input_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCatalogSnapshot {
    pub rows: Vec<PtyInfo>,
    pub cursor: Option<ChangeCursor>,
}

pub struct PtyService {
    sessions: SessionMap,
    frames: broadcast::Sender<Frame>,
    config: PtyServiceConfig,
    launch_config: LaunchConfig,
    journal: Arc<Mutex<CatalogJournal>>,
    change_counter: Arc<AtomicU64>,
}

struct PtyHandle {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    state: Mutex<SessionState>,
    buffer: Mutex<ReplayBuffer>,
    output_ready: (Mutex<bool>, Condvar),
    shutdown_requested: AtomicBool,
    cleaned_up: AtomicBool,
}

#[derive(Debug, Clone)]
struct SessionState {
    info: PtyInfo,
    exit_at: Option<i64>,
    bootstrap_command: Option<String>,
    catalog_cursor: ChangeCursor,
    lease_state: LeaseState,
}

#[derive(Debug, Clone)]
struct CatalogEntry {
    cursor: ChangeCursor,
    delta: CatalogDelta,
}

#[derive(Debug, Clone)]
enum CatalogDelta {
    Upsert(PtyInfo),
    Remove(String),
}

#[derive(Debug)]
struct CatalogJournal {
    entries: VecDeque<CatalogEntry>,
    max_entries: usize,
}

enum ReaderEvent {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

impl PtyService {
    #[must_use]
    pub fn new(config: PtyServiceConfig) -> Self {
        let (frames, _) = broadcast::channel(config.broadcast_capacity);
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            frames,
            launch_config: LaunchConfig::load(),
            journal: Arc::new(Mutex::new(CatalogJournal::new(
                config.catalog_journal_capacity,
            ))),
            change_counter: Arc::new(AtomicU64::new(0)),
            config,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.frames.subscribe()
    }

    pub fn spawn(
        &self,
        request: SpawnPtyRequest,
        holder: impl Into<String>,
    ) -> Result<SpawnPtyResponse, ServerError> {
        validate_protocol_version(request.v)?;
        let holder = holder.into();
        let plan = build_launch_plan(&request, &self.launch_config)?;
        let pty_id = Uuid::new_v4().to_string();
        let cols = request.cols.unwrap_or(self.config.default_cols);
        let rows = request.rows.unwrap_or(self.config.default_rows);
        let started_at = now_millis();
        let initial_cursor = self.next_catalog_cursor(&pty_id);
        let bound_instance_id = request
            .instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let info = PtyInfo {
            id: pty_id.clone(),
            command: plan.display_command.clone(),
            cwd: plan.cwd.clone(),
            started_at,
            exit_code: None,
            bound_instance_id,
            cols,
            rows,
            lease: Some(Lease {
                holder: holder.clone(),
                acquired_at: started_at,
                generation: 1,
            }),
        };

        let pty_pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| ServerError::internal("failed to open PTY"))?;

        let command_builder = command_builder(&plan);
        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|_| ServerError::internal("failed to clone PTY reader"))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|_| ServerError::internal("failed to take PTY writer"))?;
        let child = pty_pair
            .slave
            .spawn_command(command_builder)
            .map_err(|_| ServerError::internal("failed to spawn PTY child"))?;

        // Capture the initial_input bytes for asynchronous delivery. We do
        // NOT write them on the request thread: the master fd write can block
        // (PTY buffer full, slave not yet pumping stdin) and must never delay
        // catalog publication. See `spawn_initial_input_delivery` below.
        let pending_initial_input: Option<Vec<u8>> = plan
            .initial_input
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| value.as_bytes().to_vec());

        // The writer is ALWAYS parked in `handle.writer` from the start, even
        // when `pending_initial_input` is set. This is required so swarm-ui's
        // terminal-probe responder (which calls `pty_service.write` to answer
        // DSR/DA1 queries during codex/claude startup) doesn't hit NotFound
        // during the dispatcher's wait/readiness window. The dispatcher
        // acquires `handle.writer.lock()` only briefly for its own write,
        // and the `wait_for_output_ready` gate ensures the slave is already
        // pumping stdin before the dispatcher locks, so the held lock window
        // is short (microseconds for a few KB of bracketed-paste).
        let writer_slot = Some(writer);

        let handle = Arc::new(PtyHandle {
            master: Mutex::new(Some(pty_pair.master)),
            child: Mutex::new(Some(child)),
            writer: Mutex::new(writer_slot),
            state: Mutex::new(SessionState {
                info: info.clone(),
                exit_at: None,
                bootstrap_command: plan.bootstrap_command,
                catalog_cursor: initial_cursor.clone(),
                lease_state: LeaseState::new(info.lease.clone()),
            }),
            buffer: Mutex::new(ReplayBuffer::new(self.config.buffer_capacity_bytes)),
            output_ready: (Mutex::new(false), Condvar::new()),
            shutdown_requested: AtomicBool::new(false),
            cleaned_up: AtomicBool::new(false),
        });

        self.sessions
            .write()
            .map_err(|_| ServerError::internal("PTY session map lock poisoned"))?
            .insert(pty_id.clone(), handle.clone());

        // Catalog upsert MUST happen before any potentially-blocking I/O so
        // swarm-ui receives the Ptys frame immediately and the response to
        // /pty cannot be held up by a stuck initial_input write.
        self.record_catalog_upsert(info.clone(), initial_cursor.clone())?;
        self.spawn_output_threads(pty_id.clone(), handle.clone(), reader);

        if let Some(bytes) = pending_initial_input {
            self.spawn_initial_input_delivery(pty_id.clone(), handle, bytes);
        }

        Ok(SpawnPtyResponse {
            v: swarm_protocol::PROTOCOL_VERSION,
            pty: info,
        })
    }

    /// Deliver `initial_input` to the PTY master on a dedicated thread, after
    /// the catalog has been published. The dispatcher:
    ///
    /// 1. Waits for first PTY output, then sleeps `initial_input_readiness`
    ///    so the harness TUI can wire up its stdin handler before
    ///    bracketed-paste arrives.
    /// 2. Performs `write_all` + `flush` on a sub-thread, with a bounded
    ///    `recv_timeout`. If the write hangs, the child is killed so the
    ///    inner thread's write fails out and drops the writer.
    /// 3. On success, parks the writer back into `handle.writer` so future
    ///    `write()` API calls work normally.
    /// 4. On failure or timeout, broadcasts a `PtyExit` and tears down the
    ///    session through `cleanup_session` — which also informs
    ///    `pty_frame_forwarder` to delete the pending instance row.
    fn spawn_initial_input_delivery(&self, pty_id: String, handle: Arc<PtyHandle>, bytes: Vec<u8>) {
        let sessions = self.sessions.clone();
        let frames = self.frames.clone();
        let journal = self.journal.clone();
        let counter = self.change_counter.clone();
        let readiness = self.config.initial_input_readiness;
        let timeout = self.config.initial_input_timeout;
        let exit_retention = self.config.exit_retention;
        let len = bytes.len();

        thread::spawn(move || {
            let started = Instant::now();

            if !wait_for_output_ready(&handle, timeout) {
                warn!(
                    pty_id = %pty_id,
                    timeout_ms = timeout.as_millis() as u64,
                    "initial_input timed out waiting for PTY output; killing child and tearing down"
                );
                kill_child(&handle);
                tear_down_after_initial_input_failure(
                    &sessions,
                    &frames,
                    &journal,
                    counter.as_ref(),
                    &pty_id,
                    &handle,
                    exit_retention,
                );
                return;
            }

            let mut remaining = timeout
                .checked_sub(started.elapsed())
                .unwrap_or(Duration::ZERO);
            // Sleeping the readiness delay WITHOUT holding `handle.writer`
            // is intentional: out-of-band writes (e.g. swarm-ui's terminal
            // probe responder answering DSR/DA1 during codex/claude
            // startup) must be able to acquire the writer lock during
            // this window. The dispatcher only locks the writer briefly
            // for its own `write_all`, after the harness has had time to
            // wire up its stdin handler.
            if !readiness.is_zero() && !remaining.is_zero() {
                thread::sleep(readiness.min(remaining));
            }

            if handle.shutdown_requested.load(Ordering::Acquire)
                || handle.cleaned_up.load(Ordering::Acquire)
            {
                info!(
                    pty_id = %pty_id,
                    "initial_input aborted: pty already shutting down before delivery"
                );
                return;
            }

            info!(pty_id = %pty_id, len, "delivering initial_input");

            remaining = timeout
                .checked_sub(started.elapsed())
                .unwrap_or(Duration::ZERO);
            if remaining.is_zero() {
                warn!(
                    pty_id = %pty_id,
                    timeout_ms = timeout.as_millis() as u64,
                    "initial_input timed out before write; killing child and tearing down"
                );
                kill_child(&handle);
                tear_down_after_initial_input_failure(
                    &sessions,
                    &frames,
                    &journal,
                    counter.as_ref(),
                    &pty_id,
                    &handle,
                    exit_retention,
                );
                return;
            }

            // Run the write on a sub-thread that briefly locks
            // `handle.writer` only for the duration of `write_all` + `flush`.
            // The lock IS held across the syscall — but `wait_for_output_ready`
            // confirmed the slave is pumping stdin, so the write completes
            // in microseconds for typical bracketed-paste payloads. If the
            // slave somehow stops reading and the write blocks, the
            // recv_timeout below fires and we `kill_child`, which closes the
            // slave fd and unblocks the inner thread's write_all (it errors
            // out, releasing the lock).
            let (tx, rx) = mpsc::channel();
            let bytes_for_write = bytes;
            let handle_for_write = handle.clone();
            let pty_id_for_write = pty_id.clone();
            thread::spawn(move || {
                let result = (|| -> std::io::Result<()> {
                    let mut guard = handle_for_write.writer.lock().map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::Other, "PTY writer lock poisoned")
                    })?;
                    let writer = guard.as_mut().ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            format!("writer absent for pty {pty_id_for_write}"),
                        )
                    })?;
                    writer.write_all(&bytes_for_write)?;
                    writer.flush()
                })();
                let _ = tx.send(result);
            });

            match rx.recv_timeout(remaining) {
                Ok(Ok(())) => {
                    info!(pty_id = %pty_id, len, "initial_input delivered");
                }
                Ok(Err(err)) => {
                    warn!(
                        pty_id = %pty_id,
                        error = %err,
                        "initial_input write failed; tearing down PTY"
                    );
                    kill_child(&handle);
                    tear_down_after_initial_input_failure(
                        &sessions,
                        &frames,
                        &journal,
                        counter.as_ref(),
                        &pty_id,
                        &handle,
                        exit_retention,
                    );
                }
                Err(_) => {
                    warn!(
                        pty_id = %pty_id,
                        timeout_ms = timeout.as_millis() as u64,
                        "initial_input write timed out; killing child to unblock and tearing down"
                    );
                    kill_child(&handle);
                    tear_down_after_initial_input_failure(
                        &sessions,
                        &frames,
                        &journal,
                        counter.as_ref(),
                        &pty_id,
                        &handle,
                        exit_retention,
                    );
                }
            }
        });
    }

    pub fn write(&self, request: WritePtyRequest, holder: &str) -> Result<Ack, ServerError> {
        validate_protocol_version(request.v)?;
        let handle = self.session(&request.pty_id)?;
        self.refresh_pending_takeover(&request.pty_id, &handle)?;
        assert_holder(&handle, holder)?;

        let mut writer_slot = handle
            .writer
            .lock()
            .map_err(|_| ServerError::internal("PTY writer lock poisoned"))?;
        let writer = writer_slot.as_mut().ok_or_else(|| {
            ServerError::not_found(format!("unknown PTY session: {}", request.pty_id))
        })?;

        writer
            .write_all(&request.data)
            .map_err(|_| ServerError::internal("failed to write to PTY"))?;
        writer
            .flush()
            .map_err(|_| ServerError::internal("failed to flush PTY input"))?;
        Ok(Ack::ok())
    }

    pub fn resize(&self, request: ResizePtyRequest, holder: &str) -> Result<Ack, ServerError> {
        validate_protocol_version(request.v)?;
        let handle = self.session(&request.pty_id)?;
        self.refresh_pending_takeover(&request.pty_id, &handle)?;
        assert_holder(&handle, holder)?;

        {
            let mut master_slot = handle
                .master
                .lock()
                .map_err(|_| ServerError::internal("PTY master lock poisoned"))?;
            let master = master_slot.as_mut().ok_or_else(|| {
                ServerError::not_found(format!("unknown PTY session: {}", request.pty_id))
            })?;
            master
                .resize(PtySize {
                    rows: request.rows,
                    cols: request.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|_| ServerError::internal("failed to resize PTY"))?;
        }

        let info = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            state.info.cols = request.cols;
            state.info.rows = request.rows;
            state.catalog_cursor = self.next_catalog_cursor(&request.pty_id);
            state.info.clone()
        };
        let cursor = self.current_catalog_cursor(&handle)?;
        self.record_catalog_upsert(info, cursor)?;
        Ok(Ack::ok())
    }

    pub fn close(
        &self,
        request: ClosePtyRequest,
        holder: &str,
        privileged: bool,
    ) -> Result<Ack, ServerError> {
        validate_protocol_version(request.v)?;
        let handle = self.session(&request.pty_id)?;
        self.refresh_pending_takeover(&request.pty_id, &handle)?;
        if !(privileged && request.force) {
            assert_holder(&handle, holder)?;
        }

        if handle.shutdown_requested.swap(true, Ordering::AcqRel) {
            return Ok(Ack::ok());
        }

        if let Ok(mut writer) = handle.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = handle.master.lock() {
            master.take();
        }

        let mut immediate_exit_code = None;
        if request.force {
            let mut child_slot = handle
                .child
                .lock()
                .map_err(|_| ServerError::internal("PTY child lock poisoned"))?;
            if let Some(child) = child_slot.as_mut() {
                let _ = child.kill();
            }
            child_slot.take();
            immediate_exit_code = Some(None);
        } else {
            let mut child_slot = handle
                .child
                .lock()
                .map_err(|_| ServerError::internal("PTY child lock poisoned"))?;
            if let Some(child) = child_slot.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    immediate_exit_code = Some(normalize_exit_code(status.exit_code()));
                    child_slot.take();
                }
            } else {
                immediate_exit_code = Some(None);
            }
        }

        if let Some(exit_code) = immediate_exit_code {
            self.finalize_dead_session(&request.pty_id, &handle, exit_code);
        }

        Ok(Ack::ok())
    }

    pub fn request_lease(
        &self,
        request: RequestLeaseRequest,
        holder: &str,
    ) -> Result<LeaseResponse, ServerError> {
        validate_protocol_version(request.v)?;
        let handle = self.session(&request.pty_id)?;
        self.refresh_pending_takeover(&request.pty_id, &handle)?;

        let mutation = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            state.lease_state.request(
                holder,
                request.takeover,
                now_millis(),
                i64::try_from(self.config.takeover_grace.as_millis()).unwrap_or(i64::MAX),
            )
        }?;

        let lease = match mutation {
            LeaseMutation::Unchanged(lease) => lease,
            LeaseMutation::Changed(lease) => {
                self.apply_lease_change(&request.pty_id, &handle, lease.clone())?;
                lease
            }
            LeaseMutation::Pending { current, takeover } => {
                self.schedule_takeover(&request.pty_id, handle.clone(), takeover);
                current
            }
        }
        .ok_or_else(|| ServerError::internal("lease response unexpectedly empty"))?;

        Ok(LeaseResponse {
            v: swarm_protocol::PROTOCOL_VERSION,
            pty_id: request.pty_id,
            lease,
        })
    }

    pub fn release_lease(
        &self,
        request: ReleaseLeaseRequest,
        holder: &str,
    ) -> Result<Ack, ServerError> {
        validate_protocol_version(request.v)?;
        let handle = self.session(&request.pty_id)?;
        self.refresh_pending_takeover(&request.pty_id, &handle)?;

        let mutation = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            state.lease_state.release(holder, now_millis())
        }?;

        if let LeaseMutation::Changed(lease) = mutation {
            self.apply_lease_change(&request.pty_id, &handle, lease)?;
        }

        Ok(Ack::ok())
    }

    pub fn replay(
        &self,
        pty_id: &str,
        since_seq: Option<PtySeq>,
    ) -> Result<Vec<Frame>, PtyAttachRejectedFrame> {
        let handle = self.session(pty_id).map_err(|_| PtyAttachRejectedFrame {
            pty_id: pty_id.to_owned(),
            earliest_seq: PtySeq::new(0),
            reason: "unknown pty".to_owned(),
        })?;
        let mut frames = handle
            .buffer
            .lock()
            .map_err(|_| PtyAttachRejectedFrame {
                pty_id: pty_id.to_owned(),
                earliest_seq: PtySeq::new(0),
                reason: "pty replay buffer lock poisoned".to_owned(),
            })?
            .replay(pty_id, since_seq)?;

        if let Ok(state) = handle.state.lock() {
            if let Some(exit_at) = state.exit_at {
                frames.push(Frame::new(FramePayload::PtyExit(PtyExitFrame {
                    pty_id: pty_id.to_owned(),
                    exit_code: state.info.exit_code,
                    at: exit_at,
                })));
            }
        }

        Ok(frames)
    }

    pub fn snapshot(&self) -> Result<PtyCatalogSnapshot, ServerError> {
        self.reap_dead_sessions()?;

        let sessions = self
            .sessions
            .read()
            .map_err(|_| ServerError::internal("PTY session map lock poisoned"))?;

        let mut rows = Vec::with_capacity(sessions.len());
        for (pty_id, handle) in &*sessions {
            self.refresh_pending_takeover(pty_id, handle)?;
            let state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            rows.push(state.info.clone());
        }
        rows.sort_unstable_by(|left, right| left.started_at.cmp(&right.started_at));

        let cursor = self
            .journal
            .lock()
            .map_err(|_| ServerError::internal("PTY catalog journal lock poisoned"))?
            .latest_cursor();

        Ok(PtyCatalogSnapshot { rows, cursor })
    }

    pub fn catalog_delta(
        &self,
        since: Option<&ChangeCursor>,
    ) -> Result<Option<DeltaTableFrame>, ServerError> {
        self.journal
            .lock()
            .map_err(|_| ServerError::internal("PTY catalog journal lock poisoned"))?
            .since(since)
    }

    pub fn bootstrap_command(&self, pty_id: &str) -> Result<Option<String>, ServerError> {
        let handle = self.session(pty_id)?;
        let state = handle
            .state
            .lock()
            .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
        Ok(state.bootstrap_command.clone())
    }

    pub fn bind_instance(
        &self,
        pty_id: &str,
        instance_id: Option<String>,
    ) -> Result<PtyInfo, ServerError> {
        let handle = self.session(pty_id)?;
        let (info, cursor) = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            state.info.bound_instance_id = instance_id;
            state.catalog_cursor = self.next_catalog_cursor(pty_id);
            (state.info.clone(), state.catalog_cursor.clone())
        };
        self.record_catalog_upsert(info.clone(), cursor)?;
        Ok(info)
    }

    pub fn bound_instance_id(&self, pty_id: &str) -> Result<Option<String>, ServerError> {
        let handle = self.session(pty_id)?;
        let state = handle
            .state
            .lock()
            .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
        Ok(state.info.bound_instance_id.clone())
    }

    fn spawn_output_threads(
        &self,
        pty_id: String,
        handle: Arc<PtyHandle>,
        mut reader: Box<dyn Read + Send>,
    ) {
        let (tx, rx) = mpsc::channel::<ReaderEvent>();
        let coalesce_window = self.config.coalesce_window;
        let exit_retention = self.config.exit_retention;
        let reader_handle = handle.clone();
        thread::spawn(move || {
            let mut chunk = [0_u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        signal_output_ready(&reader_handle);
                        if tx.send(ReaderEvent::Data(chunk[..read].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }

            let exit_code = capture_exit_code(&reader_handle);
            let _ = tx.send(ReaderEvent::Exit(exit_code));
        });

        let service_handle = handle.clone();
        let sessions = self.sessions.clone();
        let frames_sender = self.frames.clone();
        let journal = self.journal.clone();
        let counter = self.change_counter.clone();
        let pty_id_for_thread = pty_id.clone();

        thread::spawn(move || {
            let mut pending = Vec::new();
            loop {
                let event = if pending.is_empty() {
                    match rx.recv() {
                        Ok(event) => event,
                        Err(_) => break,
                    }
                } else {
                    match rx.recv_timeout(coalesce_window) {
                        Ok(event) => event,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            flush_pending(
                                &frames_sender,
                                &service_handle,
                                &pty_id_for_thread,
                                &mut pending,
                            );
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                };

                if service_handle.cleaned_up.load(Ordering::Acquire) {
                    break;
                }

                match event {
                    ReaderEvent::Data(bytes) => pending.extend(bytes),
                    ReaderEvent::Exit(exit_code) => {
                        flush_pending(
                            &frames_sender,
                            &service_handle,
                            &pty_id_for_thread,
                            &mut pending,
                        );
                        let at = now_millis();
                        let exited = {
                            let mut state = match service_handle.state.lock() {
                                Ok(state) => state,
                                Err(_) => return,
                            };
                            if state.exit_at.is_some() {
                                None
                            } else {
                                state.info.exit_code = exit_code;
                                state.exit_at = Some(at);
                                let cursor = next_cursor(counter.as_ref(), &pty_id_for_thread);
                                state.catalog_cursor = cursor.clone();
                                Some((state.info.clone(), cursor))
                            }
                        };

                        if let Some((info, cursor)) = exited {
                            record_catalog_change(
                                &journal,
                                CatalogEntry {
                                    cursor: cursor.clone(),
                                    delta: CatalogDelta::Upsert(info.clone()),
                                },
                            );
                            let _ = frames_sender.send(Frame::new(FramePayload::DeltaTable(
                                DeltaTableFrame::Ptys {
                                    cursor,
                                    upserts: vec![info],
                                    removes: Vec::new(),
                                },
                            )));
                            let _ = frames_sender.send(Frame::new(FramePayload::PtyExit(
                                PtyExitFrame {
                                    pty_id: pty_id_for_thread.clone(),
                                    exit_code,
                                    at,
                                },
                            )));
                        }
                        thread::sleep(exit_retention);
                        cleanup_session(
                            &sessions,
                            &frames_sender,
                            &journal,
                            counter.as_ref(),
                            &pty_id_for_thread,
                            &service_handle,
                        );
                        break;
                    }
                }
            }
        });
    }

    fn apply_lease_change(
        &self,
        pty_id: &str,
        handle: &Arc<PtyHandle>,
        lease: Option<Lease>,
    ) -> Result<(), ServerError> {
        let (info, at, cursor) = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            let at = now_millis();
            state.info.lease = lease.clone();
            state.catalog_cursor = self.next_catalog_cursor(pty_id);
            (state.info.clone(), at, state.catalog_cursor.clone())
        };

        self.record_catalog_upsert(info, cursor)?;
        let _ = self
            .frames
            .send(Frame::new(FramePayload::LeaseChanged(LeaseChangedFrame {
                pty_id: pty_id.to_owned(),
                lease,
                at,
            })));
        Ok(())
    }

    fn refresh_pending_takeover(
        &self,
        pty_id: &str,
        handle: &Arc<PtyHandle>,
    ) -> Result<(), ServerError> {
        let lease = {
            let mut state = handle
                .state
                .lock()
                .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
            if let Some(lease) = state.lease_state.promote_due(now_millis()) {
                state.info.lease = lease.clone();
                state.catalog_cursor = self.next_catalog_cursor(pty_id);
                Some((lease, state.info.clone(), state.catalog_cursor.clone()))
            } else {
                None
            }
        };

        if let Some((lease, info, cursor)) = lease {
            self.record_catalog_upsert(info, cursor)?;
            let _ = self
                .frames
                .send(Frame::new(FramePayload::LeaseChanged(LeaseChangedFrame {
                    pty_id: pty_id.to_owned(),
                    lease,
                    at: now_millis(),
                })));
        }

        Ok(())
    }

    fn record_catalog_upsert(
        &self,
        info: PtyInfo,
        cursor: ChangeCursor,
    ) -> Result<(), ServerError> {
        self.journal
            .lock()
            .map_err(|_| ServerError::internal("PTY catalog journal lock poisoned"))?
            .push(CatalogEntry {
                cursor: cursor.clone(),
                delta: CatalogDelta::Upsert(info.clone()),
            });

        let _ = self.frames.send(Frame::new(FramePayload::DeltaTable(
            DeltaTableFrame::Ptys {
                cursor,
                upserts: vec![info],
                removes: Vec::new(),
            },
        )));
        Ok(())
    }

    fn schedule_takeover(
        &self,
        pty_id: &str,
        handle: Arc<PtyHandle>,
        takeover: lease::PendingTakeover,
    ) {
        let frames = self.frames.clone();
        let cursor_counter = self.change_counter.clone();
        let journal = self.journal.clone();
        let pty_id = pty_id.to_owned();
        let delay = self.config.takeover_grace;

        thread::spawn(move || {
            thread::sleep(delay);
            if handle.cleaned_up.load(Ordering::Acquire) {
                return;
            }

            let promoted = {
                let mut state = match handle.state.lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                match state.lease_state.promote_matching(
                    now_millis(),
                    &takeover.holder,
                    takeover.generation,
                ) {
                    Some(lease) => {
                        state.info.lease = lease.clone();
                        state.catalog_cursor = next_cursor(&cursor_counter, &pty_id);
                        Some((lease, state.info.clone(), state.catalog_cursor.clone()))
                    }
                    None => None,
                }
            };

            if let Some((lease, info, cursor)) = promoted {
                record_catalog_change(
                    &journal,
                    CatalogEntry {
                        cursor: cursor.clone(),
                        delta: CatalogDelta::Upsert(info.clone()),
                    },
                );
                let _ = frames.send(Frame::new(FramePayload::DeltaTable(
                    DeltaTableFrame::Ptys {
                        cursor,
                        upserts: vec![info],
                        removes: Vec::new(),
                    },
                )));
                let _ = frames.send(Frame::new(FramePayload::LeaseChanged(LeaseChangedFrame {
                    pty_id,
                    lease,
                    at: now_millis(),
                })));
            }
        });
    }

    fn next_catalog_cursor(&self, pty_id: &str) -> ChangeCursor {
        next_cursor(self.change_counter.as_ref(), pty_id)
    }

    fn current_catalog_cursor(&self, handle: &Arc<PtyHandle>) -> Result<ChangeCursor, ServerError> {
        current_cursor(handle)
    }

    fn session(&self, pty_id: &str) -> Result<Arc<PtyHandle>, ServerError> {
        self.sessions
            .read()
            .map_err(|_| ServerError::internal("PTY session map lock poisoned"))?
            .get(pty_id)
            .cloned()
            .ok_or_else(|| ServerError::not_found(format!("unknown PTY session: {pty_id}")))
    }

    fn reap_dead_sessions(&self) -> Result<(), ServerError> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| ServerError::internal("PTY session map lock poisoned"))?
            .iter()
            .map(|(pty_id, handle)| (pty_id.clone(), handle.clone()))
            .collect::<Vec<_>>();

        for (pty_id, handle) in sessions {
            if handle.cleaned_up.load(Ordering::Acquire) {
                continue;
            }

            let dead_session = {
                let mut child_slot = handle
                    .child
                    .lock()
                    .map_err(|_| ServerError::internal("PTY child lock poisoned"))?;

                match child_slot.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            let exit_code = normalize_exit_code(status.exit_code());
                            child_slot.take();
                            Some((exit_code, true))
                        }
                        Ok(None) | Err(_) => None,
                    },
                    None if handle.shutdown_requested.load(Ordering::Acquire) => {
                        Some((None, false))
                    }
                    None => None,
                }
            };

            if let Some((exit_code, retain)) = dead_session {
                if retain {
                    finalize_dead_session_after_retention(
                        self.sessions.clone(),
                        self.frames.clone(),
                        self.journal.clone(),
                        self.change_counter.clone(),
                        pty_id,
                        handle,
                        exit_code,
                        self.config.exit_retention,
                    );
                } else {
                    self.finalize_dead_session(&pty_id, &handle, exit_code);
                }
            }
        }

        Ok(())
    }

    fn finalize_dead_session(&self, pty_id: &str, handle: &Arc<PtyHandle>, exit_code: Option<i32>) {
        if handle.cleaned_up.load(Ordering::Acquire) {
            return;
        }

        let at = now_millis();
        let mut send_exit = true;
        if let Ok(mut state) = handle.state.lock() {
            if state.exit_at.is_some() {
                send_exit = false;
            } else {
                state.info.exit_code = exit_code;
                state.exit_at = Some(at);
            }
        }

        if send_exit {
            let _ = self
                .frames
                .send(Frame::new(FramePayload::PtyExit(PtyExitFrame {
                    pty_id: pty_id.to_owned(),
                    exit_code,
                    at,
                })));
        }

        cleanup_session(
            &self.sessions,
            &self.frames,
            &self.journal,
            self.change_counter.as_ref(),
            pty_id,
            handle,
        );
    }
}

impl Default for PtyService {
    fn default() -> Self {
        Self::new(PtyServiceConfig::default())
    }
}

impl CatalogJournal {
    fn new(max_entries: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max_entries,
        }
    }

    fn push(&mut self, entry: CatalogEntry) {
        self.entries.push_back(entry);
        while self.entries.len() > self.max_entries {
            self.entries.pop_front();
        }
    }

    fn latest_cursor(&self) -> Option<ChangeCursor> {
        self.entries.back().map(|entry| entry.cursor.clone())
    }

    fn since(&self, since: Option<&ChangeCursor>) -> Result<Option<DeltaTableFrame>, ServerError> {
        let mut final_state = HashMap::<String, CatalogDelta>::new();
        let mut last_cursor = None;

        for entry in &self.entries {
            if since.is_some_and(|cursor| &entry.cursor <= cursor) {
                continue;
            }
            last_cursor = Some(entry.cursor.clone());
            match &entry.delta {
                CatalogDelta::Upsert(info) => {
                    final_state.insert(info.id.clone(), CatalogDelta::Upsert(info.clone()));
                }
                CatalogDelta::Remove(id) => {
                    final_state.insert(id.clone(), CatalogDelta::Remove(id.clone()));
                }
            }
        }

        let Some(cursor) = last_cursor else {
            return Ok(None);
        };

        let mut upserts = Vec::new();
        let mut removes = Vec::new();
        for delta in final_state.into_values() {
            match delta {
                CatalogDelta::Upsert(info) => upserts.push(info),
                CatalogDelta::Remove(id) => removes.push(id),
            }
        }
        upserts.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        removes.sort_unstable();

        Ok(Some(DeltaTableFrame::Ptys {
            cursor,
            upserts,
            removes,
        }))
    }
}

fn command_builder(plan: &LaunchPlan) -> CommandBuilder {
    let mut builder = CommandBuilder::new(&plan.command);
    for arg in &plan.args {
        builder.arg(arg);
    }
    builder.cwd(&plan.cwd);
    for (key, value) in &plan.env {
        builder.env(key, value);
    }
    builder
}

fn assert_holder(handle: &Arc<PtyHandle>, holder: &str) -> Result<(), ServerError> {
    let state = handle
        .state
        .lock()
        .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
    match state.info.lease.as_ref() {
        Some(lease) if lease.holder == holder => Ok(()),
        Some(_) => Err(ServerError::lease_conflict(
            "another client currently holds the PTY lease",
        )),
        None => Err(ServerError::lease_conflict(
            "no client currently holds the PTY lease",
        )),
    }
}

fn flush_pending(
    frames: &broadcast::Sender<Frame>,
    handle: &Arc<PtyHandle>,
    pty_id: &str,
    pending: &mut Vec<u8>,
) {
    if pending.is_empty() {
        return;
    }

    let data = std::mem::take(pending);
    let seq = {
        let mut buffer = match handle.buffer.lock() {
            Ok(buffer) => buffer,
            Err(_) => return,
        };
        buffer.push(&data)
    };

    let _ = frames.send(Frame::new(FramePayload::PtyData(PtyDataFrame {
        pty_id: pty_id.to_owned(),
        seq,
        data,
    })));
}

fn signal_output_ready(handle: &Arc<PtyHandle>) {
    let (lock, condvar) = &handle.output_ready;
    if let Ok(mut ready) = lock.lock() {
        if !*ready {
            *ready = true;
            condvar.notify_all();
        }
    }
}

fn wait_for_output_ready(handle: &Arc<PtyHandle>, timeout: Duration) -> bool {
    let (lock, condvar) = &handle.output_ready;
    let Ok(ready) = lock.lock() else {
        return false;
    };
    if *ready {
        return true;
    }

    let Ok((ready, _)) = condvar.wait_timeout_while(ready, timeout, |ready| !*ready) else {
        return false;
    };
    *ready
}

fn kill_child(handle: &Arc<PtyHandle>) {
    if let Ok(mut child_slot) = handle.child.lock() {
        if let Some(child) = child_slot.as_mut() {
            let _ = child.kill();
        }
        child_slot.take();
    }
}

fn capture_exit_code(handle: &Arc<PtyHandle>) -> Option<i32> {
    let Ok(mut child_slot) = handle.child.lock() else {
        return None;
    };
    let Some(child) = child_slot.as_mut() else {
        return None;
    };

    match child.try_wait() {
        Ok(Some(status)) => normalize_exit_code(status.exit_code()),
        Ok(None) => child
            .wait()
            .ok()
            .and_then(|status| normalize_exit_code(status.exit_code())),
        Err(_) => None,
    }
}

fn cleanup_session(
    sessions: &SessionMap,
    frames: &broadcast::Sender<Frame>,
    journal: &Arc<Mutex<CatalogJournal>>,
    counter: &AtomicU64,
    pty_id: &str,
    handle: &Arc<PtyHandle>,
) {
    if handle.cleaned_up.swap(true, Ordering::AcqRel) {
        return;
    }

    signal_output_ready(handle);

    if let Ok(mut writer) = handle.writer.lock() {
        writer.take();
    }
    if let Ok(mut master) = handle.master.lock() {
        master.take();
    }
    if let Ok(mut child) = handle.child.lock() {
        child.take();
    }

    if let Ok(mut state) = handle.state.lock() {
        state.info.lease = None;
        state.catalog_cursor = next_cursor(counter, pty_id);
        record_catalog_change(
            journal,
            CatalogEntry {
                cursor: state.catalog_cursor.clone(),
                delta: CatalogDelta::Remove(pty_id.to_owned()),
            },
        );
        let _ = frames.send(Frame::new(FramePayload::DeltaTable(
            DeltaTableFrame::Ptys {
                cursor: state.catalog_cursor.clone(),
                upserts: Vec::new(),
                removes: vec![pty_id.to_owned()],
            },
        )));
    }

    if let Ok(mut sessions) = sessions.write() {
        sessions.remove(pty_id);
    }
}

fn finalize_dead_session_after_retention(
    sessions: SessionMap,
    frames: broadcast::Sender<Frame>,
    journal: Arc<Mutex<CatalogJournal>>,
    counter: Arc<AtomicU64>,
    pty_id: String,
    handle: Arc<PtyHandle>,
    exit_code: Option<i32>,
    exit_retention: Duration,
) {
    let at = now_millis();
    let mut exited = None;
    if let Ok(mut state) = handle.state.lock() {
        if state.exit_at.is_none() {
            state.info.exit_code = exit_code;
            state.exit_at = Some(at);
            state.catalog_cursor = next_cursor(counter.as_ref(), &pty_id);
            exited = Some((state.info.clone(), state.catalog_cursor.clone()));
        }
    }

    if let Some((info, cursor)) = exited {
        record_catalog_change(
            &journal,
            CatalogEntry {
                cursor: cursor.clone(),
                delta: CatalogDelta::Upsert(info.clone()),
            },
        );
        let _ = frames.send(Frame::new(FramePayload::DeltaTable(
            DeltaTableFrame::Ptys {
                cursor,
                upserts: vec![info],
                removes: Vec::new(),
            },
        )));
        let _ = frames.send(Frame::new(FramePayload::PtyExit(PtyExitFrame {
            pty_id: pty_id.clone(),
            exit_code,
            at,
        })));
    }

    thread::spawn(move || {
        thread::sleep(exit_retention);
        cleanup_session(
            &sessions,
            &frames,
            &journal,
            counter.as_ref(),
            &pty_id,
            &handle,
        );
    });
}

/// Tear down a session after asynchronous initial_input delivery fails or
/// times out. Mirrors `finalize_dead_session` but takes raw service handles
/// (the caller is a worker thread that does not hold `&PtyService`).
///
/// Sequence:
///   1. Mark `state.exit_at` so `snapshot()`/`reap_dead_sessions` agree the
///      session is gone.
///   2. Broadcast `PtyExit` so `pty_frame_forwarder` can delete the pending
///      instance row in the swarm DB (matches the natural-exit code path).
///   3. Keep the exited row around for `exit_retention`, then run
///      `cleanup_session` to drop owned handles, broadcast a `Ptys` remove,
///      and unregister from the session map.
fn tear_down_after_initial_input_failure(
    sessions: &SessionMap,
    frames: &broadcast::Sender<Frame>,
    journal: &Arc<Mutex<CatalogJournal>>,
    counter: &AtomicU64,
    pty_id: &str,
    handle: &Arc<PtyHandle>,
    exit_retention: Duration,
) {
    let at = now_millis();
    let mut exited = None;
    if let Ok(mut state) = handle.state.lock() {
        if state.exit_at.is_none() {
            state.info.exit_code = None;
            state.exit_at = Some(at);
            state.catalog_cursor = next_cursor(counter, pty_id);
            exited = Some((state.info.clone(), state.catalog_cursor.clone()));
        }
    }

    if let Some((info, cursor)) = exited {
        record_catalog_change(
            journal,
            CatalogEntry {
                cursor: cursor.clone(),
                delta: CatalogDelta::Upsert(info.clone()),
            },
        );
        let _ = frames.send(Frame::new(FramePayload::DeltaTable(
            DeltaTableFrame::Ptys {
                cursor,
                upserts: vec![info],
                removes: Vec::new(),
            },
        )));
        let _ = frames.send(Frame::new(FramePayload::PtyExit(PtyExitFrame {
            pty_id: pty_id.to_owned(),
            exit_code: None,
            at,
        })));
    }

    thread::sleep(exit_retention);
    cleanup_session(sessions, frames, journal, counter, pty_id, handle);
}

fn record_catalog_change(journal: &Arc<Mutex<CatalogJournal>>, entry: CatalogEntry) {
    if let Ok(mut journal) = journal.lock() {
        journal.push(entry);
    }
}

fn current_cursor(handle: &Arc<PtyHandle>) -> Result<ChangeCursor, ServerError> {
    let state = handle
        .state
        .lock()
        .map_err(|_| ServerError::internal("PTY state lock poisoned"))?;
    Ok(state.catalog_cursor.clone())
}

fn next_cursor(counter: &AtomicU64, pty_id: &str) -> ChangeCursor {
    let next = counter.fetch_add(1, Ordering::AcqRel) + 1;
    ChangeCursor::new(now_seconds(), format!("{next:020}:{pty_id}"))
}

fn normalize_exit_code(exit_code: u32) -> Option<i32> {
    i32::try_from(exit_code).ok()
}

fn now_millis() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0_u128, |duration| duration.as_millis());
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0_i64, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use swarm_protocol::ErrorClass;
    use swarm_protocol::PROTOCOL_VERSION;

    fn spawn_request() -> SpawnPtyRequest {
        SpawnPtyRequest {
            v: PROTOCOL_VERSION,
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            harness: "shell".to_owned(),
            role: None,
            scope: Some("swarm-mcp".to_owned()),
            label: None,
            name: None,
            instance_id: None,
            cols: Some(80),
            rows: Some(24),
            args: Vec::new(),
            env: Default::default(),
            initial_input: None,
        }
    }

    fn replay_text(service: &PtyService, pty_id: &str) -> String {
        let mut data = Vec::new();
        if let Ok(frames) = service.replay(pty_id, None) {
            for frame in frames {
                if let FramePayload::PtyData(payload) = frame.payload {
                    data.extend(payload.data);
                }
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    fn wait_for_replay_contains(
        service: &PtyService,
        pty_id: &str,
        needle: &str,
        timeout: Duration,
    ) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if replay_text(service, pty_id).contains(needle) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn wait_for_pty_exit(
        receiver: &mut broadcast::Receiver<Frame>,
        pty_id: &str,
        timeout: Duration,
    ) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            match receiver.try_recv() {
                Ok(frame) => {
                    if let FramePayload::PtyExit(payload) = frame.payload {
                        if payload.pty_id == pty_id {
                            return true;
                        }
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(broadcast::error::TryRecvError::Closed) => return false,
            }
        }
        false
    }

    #[test]
    fn replay_buffer_rejects_stale_cursor() {
        let mut buffer = ReplayBuffer::new(8);
        let _ = buffer.push(b"abcd");
        let _ = buffer.push(b"efgh");
        let _ = buffer.push(b"ijkl");

        let rejected = buffer.replay("pty-1", Some(PtySeq::new(0))).unwrap_err();
        assert_eq!(rejected.pty_id, "pty-1");
    }

    #[test]
    fn catalog_journal_coalesces_to_final_state() {
        let mut journal = CatalogJournal::new(32);
        let info = PtyInfo {
            id: "pty-1".to_owned(),
            command: "shell".to_owned(),
            cwd: "/tmp".to_owned(),
            started_at: 1,
            exit_code: None,
            bound_instance_id: None,
            cols: 80,
            rows: 24,
            lease: None,
        };
        journal.push(CatalogEntry {
            cursor: ChangeCursor::new(1, "0001:pty-1"),
            delta: CatalogDelta::Upsert(info.clone()),
        });
        journal.push(CatalogEntry {
            cursor: ChangeCursor::new(1, "0002:pty-1"),
            delta: CatalogDelta::Remove("pty-1".to_owned()),
        });

        let Some(DeltaTableFrame::Ptys {
            upserts, removes, ..
        }) = journal.since(None).unwrap()
        else {
            panic!("expected ptys delta");
        };
        assert!(upserts.is_empty());
        assert_eq!(removes, vec!["pty-1".to_owned()]);
    }

    #[test]
    fn force_close_reaps_session_immediately() {
        let service = PtyService::new(PtyServiceConfig {
            exit_retention: Duration::from_secs(30),
            ..PtyServiceConfig::default()
        });

        let response = service
            .spawn(spawn_request(), "local:swarm-ui")
            .expect("spawn must work");

        service
            .close(
                ClosePtyRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                    force: true,
                },
                "local:swarm-ui",
                false,
            )
            .expect("force close must work");

        let snapshot = service.snapshot().expect("snapshot must work");
        assert!(
            snapshot.rows.iter().all(|pty| pty.id != response.pty.id),
            "force close should remove the PTY from the catalog immediately"
        );
    }

    #[test]
    fn pty_write_succeeds_during_initial_input_dispatcher_window() {
        // Regression: when initial_input is deferred, `handle.writer` must
        // stay populated so swarm-ui's terminal-probe responder (which calls
        // pty_service.write to answer DSR/DA1) doesn't hit NotFound during
        // the dispatcher's wait/readiness/write window.
        let service = PtyService::new(PtyServiceConfig {
            // Long readiness pins the dispatcher in its sleep so we can
            // observe the pty_service.write path while initial_input is
            // explicitly in flight.
            initial_input_readiness: Duration::from_secs(10),
            initial_input_timeout: Duration::from_secs(15),
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let mut request = spawn_request();
        request.initial_input = Some("anything\r".to_owned());
        request.args = vec!["-c".to_owned(), "sleep 30".to_owned()];

        let response = service
            .spawn(request, "local:swarm-ui")
            .expect("spawn must work");

        // While the dispatcher is parked in readiness, an out-of-band write
        // (the swarm-ui probe responder's DSR reply, in real life) must land
        // through `handle.writer` and not fail with NotFound.
        service
            .write(
                WritePtyRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                    data: b"\x1b[1;1R".to_vec(),
                },
                "local:swarm-ui",
            )
            .expect("pty_service.write must succeed while initial_input is deferred");

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "local:swarm-ui",
            false,
        );
    }

    #[test]
    fn slow_initial_input_does_not_block_catalog_publication() {
        // A silent child guarantees the dispatcher is still waiting for first
        // output when we assert. If `/pty` ever waited on initial_input
        // delivery, this test would block for the full timeout.
        let service = PtyService::new(PtyServiceConfig {
            initial_input_readiness: Duration::from_secs(10),
            initial_input_timeout: Duration::from_secs(15),
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let mut request = spawn_request();
        request.initial_input = Some("echo hi\r".to_owned());
        // Keep the shell alive across the test so the catalog row doesn't
        // get reaped via natural child exit.
        request.args = vec!["-c".to_owned(), "sleep 30".to_owned()];

        let started = std::time::Instant::now();
        let response = service
            .spawn(request, "local:test")
            .expect("spawn must return promptly even with a slow initial_input");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(500),
            "spawn returned in {:?}, expected to finish before initial_input readiness delay",
            elapsed
        );

        let snapshot = service
            .snapshot()
            .expect("snapshot must work while initial_input is pending");
        assert!(
            snapshot.rows.iter().any(|pty| pty.id == response.pty.id),
            "PTY must be in the catalog before initial_input is delivered"
        );

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "local:test",
            false,
        );
    }

    #[test]
    fn spawn_prebinds_request_instance_id() {
        let service = PtyService::new(PtyServiceConfig {
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let mut request = spawn_request();
        request.instance_id = Some("instance-prebound".to_owned());
        request.args = vec!["-c".to_owned(), "sleep 1".to_owned()];

        let response = service
            .spawn(request, "local:test")
            .expect("spawn must work");
        assert_eq!(
            response.pty.bound_instance_id.as_deref(),
            Some("instance-prebound")
        );

        let snapshot = service.snapshot().expect("snapshot must work");
        let pty = snapshot
            .rows
            .iter()
            .find(|pty| pty.id == response.pty.id)
            .expect("PTY should be visible in catalog");
        assert_eq!(pty.bound_instance_id.as_deref(), Some("instance-prebound"));

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "local:test",
            false,
        );
    }

    #[test]
    fn initial_input_waits_for_output_then_delivers() {
        let service = PtyService::new(PtyServiceConfig {
            initial_input_readiness: Duration::from_millis(25),
            initial_input_timeout: Duration::from_secs(2),
            exit_retention: Duration::from_millis(250),
            ..PtyServiceConfig::default()
        });

        let mut request = spawn_request();
        request.initial_input = Some("hello\n".to_owned());
        request.args = vec![
            "-c".to_owned(),
            "printf ready; IFS= read -r line; printf ' got:%s' \"$line\"; sleep 1".to_owned(),
        ];

        let response = service
            .spawn(request, "local:test")
            .expect("spawn must work");

        assert!(
            wait_for_replay_contains(
                &service,
                &response.pty.id,
                "got:hello",
                Duration::from_secs(2)
            ),
            "initial_input should be delivered after first PTY output; replay was {:?}",
            replay_text(&service, &response.pty.id)
        );

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "local:test",
            false,
        );
    }

    #[test]
    fn initial_input_timeout_retains_bound_instance_until_cleanup() {
        let service = PtyService::new(PtyServiceConfig {
            initial_input_readiness: Duration::from_millis(10),
            initial_input_timeout: Duration::from_millis(250),
            exit_retention: Duration::from_millis(500),
            ..PtyServiceConfig::default()
        });
        let mut receiver = service.subscribe();

        let mut request = spawn_request();
        request.initial_input = Some("hello\n".to_owned());
        request.args = vec!["-c".to_owned(), "sleep 30".to_owned()];

        let response = service
            .spawn(request, "local:test")
            .expect("spawn must work");
        let pty_id = response.pty.id.clone();
        service
            .bind_instance(&pty_id, Some("instance-timeout".to_owned()))
            .expect("bind must work");

        assert!(
            wait_for_pty_exit(&mut receiver, &pty_id, Duration::from_secs(2)),
            "no-output initial_input timeout should emit PtyExit"
        );
        assert_eq!(
            service
                .bound_instance_id(&pty_id)
                .expect("binding is retained"),
            Some("instance-timeout".to_owned()),
            "bound instance must remain visible while exit retention is active"
        );

        thread::sleep(Duration::from_millis(650));

        let snapshot = service.snapshot().expect("snapshot must work");
        assert!(
            snapshot.rows.iter().all(|pty| pty.id != pty_id),
            "timed-out PTY should be removed after exit retention"
        );
    }

    #[test]
    fn snapshot_reaped_exit_retains_bound_instance_until_cleanup() {
        let service = PtyService::new(PtyServiceConfig {
            exit_retention: Duration::from_millis(500),
            ..PtyServiceConfig::default()
        });
        let mut receiver = service.subscribe();
        let pty_id = "pty-retained-exit".to_owned();
        let info = PtyInfo {
            id: pty_id.clone(),
            command: "codex".to_owned(),
            cwd: "/tmp".to_owned(),
            started_at: 1,
            exit_code: None,
            bound_instance_id: Some("instance-retained-exit".to_owned()),
            cols: 80,
            rows: 24,
            lease: Some(Lease {
                holder: "local:swarm-ui".to_owned(),
                acquired_at: 1,
                generation: 1,
            }),
        };
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(None),
            child: Mutex::new(None),
            writer: Mutex::new(None),
            state: Mutex::new(SessionState {
                info: info.clone(),
                exit_at: None,
                bootstrap_command: None,
                catalog_cursor: ChangeCursor::new(1, "0001:pty-retained-exit"),
                lease_state: LeaseState::new(info.lease.clone()),
            }),
            buffer: Mutex::new(ReplayBuffer::new(1024)),
            output_ready: (Mutex::new(false), Condvar::new()),
            shutdown_requested: AtomicBool::new(false),
            cleaned_up: AtomicBool::new(false),
        });
        service
            .sessions
            .write()
            .expect("session map lock must work")
            .insert(pty_id.clone(), handle.clone());

        finalize_dead_session_after_retention(
            service.sessions.clone(),
            service.frames.clone(),
            service.journal.clone(),
            service.change_counter.clone(),
            pty_id.clone(),
            handle,
            Some(7),
            Duration::from_millis(500),
        );

        assert!(
            wait_for_pty_exit(&mut receiver, &pty_id, Duration::from_secs(1)),
            "retained finalization should emit PtyExit"
        );
        let snapshot = service.snapshot().expect("snapshot must work");
        let retained = snapshot
            .rows
            .iter()
            .find(|pty| pty.id == pty_id)
            .expect("exited PTY should remain visible during retention");
        assert_eq!(retained.exit_code, Some(7));
        assert_eq!(
            retained.bound_instance_id.as_deref(),
            Some("instance-retained-exit")
        );

        thread::sleep(Duration::from_millis(650));

        let snapshot = service
            .snapshot()
            .expect("snapshot must work after cleanup");
        assert!(
            snapshot.rows.iter().all(|pty| pty.id != pty_id),
            "retained PTY should be removed after exit retention"
        );
    }

    #[test]
    fn snapshot_reaps_shutdown_zombie_without_child() {
        let service = PtyService::default();
        let pty_id = "pty-zombie".to_owned();
        let info = PtyInfo {
            id: pty_id.clone(),
            command: "codex".to_owned(),
            cwd: "/tmp".to_owned(),
            started_at: 1,
            exit_code: None,
            bound_instance_id: None,
            cols: 80,
            rows: 24,
            lease: Some(Lease {
                holder: "local:swarm-ui".to_owned(),
                acquired_at: 1,
                generation: 1,
            }),
        };

        let handle = Arc::new(PtyHandle {
            master: Mutex::new(None),
            child: Mutex::new(None),
            writer: Mutex::new(None),
            state: Mutex::new(SessionState {
                info: info.clone(),
                exit_at: None,
                bootstrap_command: None,
                catalog_cursor: ChangeCursor::new(1, "0001:pty-zombie"),
                lease_state: LeaseState::new(info.lease.clone()),
            }),
            buffer: Mutex::new(ReplayBuffer::new(1024)),
            output_ready: (Mutex::new(false), Condvar::new()),
            shutdown_requested: AtomicBool::new(true),
            cleaned_up: AtomicBool::new(false),
        });

        service
            .sessions
            .write()
            .expect("session map lock must work")
            .insert(pty_id.clone(), handle);

        let snapshot = service.snapshot().expect("snapshot must work");
        assert!(
            snapshot.rows.iter().all(|pty| pty.id != pty_id),
            "snapshot should reap shutdown PTYs that no longer have a child handle"
        );
    }

    #[test]
    fn takeover_promotes_after_grace() {
        let service = PtyService::new(PtyServiceConfig {
            takeover_grace: Duration::from_millis(25),
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let response = service
            .spawn(spawn_request(), "local:swarm-ui")
            .expect("spawn must work");

        let mut receiver = service.subscribe();
        let result = service.request_lease(
            RequestLeaseRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id.clone(),
                takeover: true,
            },
            "device:phone",
        );
        assert!(result.is_ok());

        thread::sleep(Duration::from_millis(60));

        let snapshot = service.snapshot().expect("snapshot must work");
        let lease = snapshot
            .rows
            .into_iter()
            .find(|pty| pty.id == response.pty.id)
            .and_then(|pty| pty.lease)
            .expect("lease must exist");
        assert_eq!(lease.holder, "device:phone");

        let mut saw_takeover = false;
        while let Ok(frame) = receiver.try_recv() {
            if let FramePayload::LeaseChanged(LeaseChangedFrame {
                lease: Some(lease), ..
            }) = frame.payload
            {
                if lease.holder == "device:phone" {
                    saw_takeover = true;
                    break;
                }
            }
        }
        assert!(saw_takeover, "expected lease.changed for takeover");

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "device:phone",
            false,
        );
    }

    #[test]
    fn releasing_takeover_returns_control_to_previous_holder() {
        let service = PtyService::new(PtyServiceConfig {
            takeover_grace: Duration::from_millis(25),
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let response = service
            .spawn(spawn_request(), "device:desktop")
            .expect("spawn must work");

        service
            .request_lease(
                RequestLeaseRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                    takeover: true,
                },
                "device:phone",
            )
            .expect("takeover request must work");

        thread::sleep(Duration::from_millis(60));

        service
            .release_lease(
                ReleaseLeaseRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                },
                "device:phone",
            )
            .expect("release must work");

        let lease = service
            .snapshot()
            .expect("snapshot must work")
            .rows
            .into_iter()
            .find(|pty| pty.id == response.pty.id)
            .and_then(|pty| pty.lease)
            .expect("desktop lease must be restored");
        assert_eq!(lease.holder, "device:desktop");

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "device:desktop",
            false,
        );
    }

    #[test]
    fn releasing_pending_takeover_cancels_it() {
        let service = PtyService::new(PtyServiceConfig {
            takeover_grace: Duration::from_millis(40),
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let response = service
            .spawn(spawn_request(), "device:desktop")
            .expect("spawn must work");

        service
            .request_lease(
                RequestLeaseRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                    takeover: true,
                },
                "device:phone",
            )
            .expect("takeover request must work");

        service
            .release_lease(
                ReleaseLeaseRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id.clone(),
                },
                "device:phone",
            )
            .expect("pending takeover cancel must work");

        thread::sleep(Duration::from_millis(70));

        let lease = service
            .snapshot()
            .expect("snapshot must work")
            .rows
            .into_iter()
            .find(|pty| pty.id == response.pty.id)
            .and_then(|pty| pty.lease)
            .expect("desktop lease must remain active");
        assert_eq!(lease.holder, "device:desktop");

        let _ = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id,
                force: true,
            },
            "device:desktop",
            false,
        );
    }

    #[test]
    fn privileged_force_close_can_stop_mobile_held_pty() {
        let service = PtyService::new(PtyServiceConfig {
            exit_retention: Duration::from_millis(10),
            ..PtyServiceConfig::default()
        });

        let response = service
            .spawn(spawn_request(), "device:phone")
            .expect("spawn must work");

        let unprivileged = service.close(
            ClosePtyRequest {
                v: PROTOCOL_VERSION,
                pty_id: response.pty.id.clone(),
                force: true,
            },
            "local:swarm-ui",
            false,
        );

        assert_eq!(
            unprivileged.unwrap_err().payload().class,
            ErrorClass::LeaseConflict,
        );

        service
            .close(
                ClosePtyRequest {
                    v: PROTOCOL_VERSION,
                    pty_id: response.pty.id,
                    force: true,
                },
                "local:swarm-ui",
                true,
            )
            .expect("privileged force close should bypass the interactive lease");
    }
}
