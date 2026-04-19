use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

use crate::events::{pty_data_event, pty_exit_event, PTY_BOUND_EXIT, PTY_CLOSED, PTY_CREATED};
use crate::model::{AppError, PtySession};

const BUFFER_CAPACITY: usize = 2 * 1024 * 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(16);
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 36;
const EXIT_SESSION_RETENTION: Duration = Duration::from_secs(10);

type SessionMap = Arc<RwLock<HashMap<String, Arc<PtyHandle>>>>;

fn validate_cwd(cwd: &str) -> Result<(), AppError> {
    if cwd.is_empty() {
        return Err(AppError::Validation("cwd must not be empty".into()));
    }
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() {
        return Err(AppError::Validation("cwd must be an absolute path".into()));
    }
    if !path.is_dir() {
        return Err(AppError::Validation(format!(
            "cwd is not a directory: {cwd}"
        )));
    }
    Ok(())
}

fn validate_command(command: &str) -> Result<(), AppError> {
    if command.trim().is_empty() {
        return Err(AppError::Validation("command must not be empty".into()));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct PtyCreateRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub display_command: Option<String>,
}

enum ReaderEvent {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

#[derive(Default)]
struct ByteRingBuffer {
    bytes: VecDeque<u8>,
}

impl ByteRingBuffer {
    fn append(&mut self, chunk: &[u8]) {
        if chunk.len() >= BUFFER_CAPACITY {
            self.bytes.clear();
            self.bytes
                .extend(chunk[chunk.len() - BUFFER_CAPACITY..].iter().copied());
            return;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(BUFFER_CAPACITY);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }

        self.bytes.extend(chunk.iter().copied());
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }
}

pub struct PtyHandle {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn Child + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    session: Mutex<PtySession>,
    buffer: Mutex<ByteRingBuffer>,
    closed: AtomicBool,
}

impl PtyHandle {
    fn new(
        id: String,
        command: String,
        cwd: String,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send>,
        writer: Box<dyn Write + Send>,
    ) -> Self {
        Self {
            master: Mutex::new(Some(master)),
            child: Mutex::new(Some(child)),
            writer: Mutex::new(Some(writer)),
            session: Mutex::new(PtySession {
                id,
                command,
                cwd,
                started_at: now_millis(),
                exit_code: None,
                bound_instance_id: None,
                launch_token: None,
            }),
            buffer: Mutex::new(ByteRingBuffer::default()),
            closed: AtomicBool::new(false),
        }
    }

    /// Appends output data to the ring buffer.
    ///
    /// Silently drops data if the lock is poisoned. This is called from a
    /// background reader thread where error propagation is not possible, and
    /// a poisoned lock indicates the session is already in a broken state.
    fn append_output(&self, chunk: &[u8]) {
        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.append(chunk);
        }
    }

    fn buffer_snapshot(&self) -> Vec<u8> {
        self.buffer
            .lock()
            .map_or_else(|_| Vec::new(), |buffer| buffer.snapshot())
    }

    fn session_snapshot(&self) -> Result<PtySession, String> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|_| "PTY session lock poisoned".to_owned())
    }

    /// Records the exit code.
    ///
    /// Silently ignores a poisoned session lock since this is called from a
    /// background thread after the child process has already exited.
    fn set_exit_code(&self, exit_code: Option<i32>) {
        if let Ok(mut session) = self.session.lock() {
            session.exit_code = exit_code;
        }
    }

    fn begin_cleanup(&self) -> bool {
        !self.closed.swap(true, Ordering::AcqRel)
    }

    fn set_launch_token(&self, token: &str) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|_| "PTY session lock poisoned".to_owned())?
            .launch_token = Some(token.to_owned());
        Ok(())
    }

    fn set_bound_instance(&self, instance_id: &str) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|_| "PTY session lock poisoned".to_owned())?
            .bound_instance_id = Some(instance_id.to_owned());
        Ok(())
    }

    fn take_bound_instance(&self) -> Option<(String, String)> {
        let Ok(mut session) = self.session.lock() else {
            return None;
        };
        let instance_id = session.bound_instance_id.take()?;
        Some((session.id.clone(), instance_id))
    }
}

pub struct PtyManager {
    sessions: SessionMap,
}

impl PtyManager {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn create_session<R: Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        request: PtyCreateRequest,
    ) -> Result<String, AppError> {
        let PtyCreateRequest {
            command,
            args,
            cwd,
            mut env,
            display_command,
        } = request;

        let id = Uuid::new_v4().to_string();
        let display_command = display_command.unwrap_or_else(|| render_command(&command, &args));

        env.insert("TERM".to_owned(), "xterm-256color".to_owned());

        let pty_pair = native_pty_system()
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::Operation(format!("failed to open PTY: {error}")))?;

        let mut command_builder = CommandBuilder::new(&command);
        for arg in &args {
            command_builder.arg(arg);
        }
        command_builder.cwd(PathBuf::from(&cwd));
        for (key, value) in &env {
            command_builder.env(key, value);
        }

        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::Operation(format!("failed to clone PTY reader: {error}")))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|error| AppError::Operation(format!("failed to take PTY writer: {error}")))?;
        let child = pty_pair
            .slave
            .spawn_command(command_builder)
            .map_err(|error| AppError::Operation(format!("failed to spawn command: {error}")))?;

        let handle = Arc::new(PtyHandle::new(
            id.clone(),
            display_command,
            cwd,
            pty_pair.master,
            child,
            writer,
        ));

        self.sessions
            .write()
            .map_err(|_| AppError::Internal("PTY manager lock poisoned".into()))?
            .insert(id.clone(), handle.clone());

        spawn_output_threads(
            app_handle.clone(),
            id.clone(),
            handle.clone(),
            reader,
            self.sessions.clone(),
        );

        let payload = handle.session_snapshot().map_err(AppError::Internal)?;
        let _ = app_handle.emit(PTY_CREATED, payload);

        Ok(id)
    }

    pub fn set_launch_token(&self, pty_id: &str, token: &str) -> Result<(), AppError> {
        let handle = self.session(pty_id)?;
        handle.set_launch_token(token).map_err(AppError::Internal)
    }

    pub fn set_bound_instance(&self, pty_id: &str, instance_id: &str) -> Result<(), AppError> {
        let handle = self.session(pty_id)?;
        handle
            .set_bound_instance(instance_id)
            .map_err(AppError::Internal)
    }

    pub fn sessions_snapshot(&self) -> Result<Vec<PtySession>, AppError> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| AppError::Internal("PTY manager lock poisoned".into()))?;

        let mut snapshot = sessions
            .values()
            .map(|handle| handle.session_snapshot().map_err(AppError::Internal))
            .collect::<Result<Vec<_>, _>>()?;
        snapshot.sort_unstable_by(|left, right| left.started_at.cmp(&right.started_at));
        Ok(snapshot)
    }

    pub fn write_input(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        let handle = self.session(id)?;
        let mut writer_slot = handle
            .writer
            .lock()
            .map_err(|_| AppError::Internal("PTY writer lock poisoned".into()))?;
        let writer = writer_slot
            .as_mut()
            .ok_or_else(|| AppError::Operation(format!("PTY session is closed: {id}")))?;

        writer
            .write_all(data)
            .map_err(|error| AppError::Operation(format!("failed to write to PTY: {error}")))?;
        writer
            .flush()
            .map_err(|error| AppError::Operation(format!("failed to flush PTY input: {error}")))
    }

    fn session(&self, id: &str) -> Result<Arc<PtyHandle>, AppError> {
        self.sessions
            .read()
            .map_err(|_| AppError::Internal("PTY manager lock poisoned".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("unknown PTY session: {id}")))
    }

    /// Removes a session from the map. Best-effort cleanup — a poisoned lock
    /// is silently ignored since the session is already closed.
    fn remove_session(&self, id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(id);
        }
    }
}

fn spawn_output_threads<R: Runtime + 'static>(
    app_handle: AppHandle<R>,
    id: String,
    handle: Arc<PtyHandle>,
    mut reader: Box<dyn Read + Send>,
    sessions: SessionMap,
) {
    let (tx, rx) = mpsc::channel::<ReaderEvent>();

    let reader_handle = handle.clone();
    thread::spawn(move || {
        let mut chunk = [0_u8; 4096];

        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
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

    thread::spawn(move || {
        let data_event = pty_data_event(&id);
        let exit_event = pty_exit_event(&id);
        let mut pending = Vec::new();

        loop {
            let event = if pending.is_empty() {
                match rx.recv() {
                    Ok(event) => event,
                    Err(_) => break,
                }
            } else {
                match rx.recv_timeout(COALESCE_WINDOW) {
                    Ok(event) => event,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        flush_pending(&app_handle, &data_event, &handle, &mut pending);
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            };

            match event {
                ReaderEvent::Data(bytes) => pending.extend(bytes),
                ReaderEvent::Exit(exit_code) => {
                    flush_pending(&app_handle, &data_event, &handle, &mut pending);
                    handle.set_exit_code(exit_code);
                    let _ = app_handle.emit(&exit_event, exit_code);
                    emit_bound_exit_if_any(&app_handle, &handle);
                    thread::sleep(EXIT_SESSION_RETENTION);
                    cleanup_session(&app_handle, &sessions, &id, &handle);
                    break;
                }
            }
        }

        if !pending.is_empty() {
            flush_pending(&app_handle, &data_event, &handle, &mut pending);
        }
    });
}

/// Emit `pty:bound_exit` if this session had been bound to a swarm instance.
///
/// main.rs listens for this to tear down the binder mapping and delete any
/// UI-owned placeholder row that was never adopted by the child process.
fn emit_bound_exit_if_any<R: Runtime>(app_handle: &AppHandle<R>, handle: &Arc<PtyHandle>) {
    if let Some((pty_id, instance_id)) = handle.take_bound_instance() {
        let _ = app_handle.emit(
            PTY_BOUND_EXIT,
            serde_json::json!({ "pty_id": pty_id, "instance_id": instance_id }),
        );
    }
}

fn cleanup_session(
    app_handle: &AppHandle<impl Runtime>,
    sessions: &SessionMap,
    id: &str,
    handle: &Arc<PtyHandle>,
) {
    if !handle.begin_cleanup() {
        return;
    }

    if let Ok(mut writer) = handle.writer.lock() {
        writer.take();
    }
    if let Ok(mut master) = handle.master.lock() {
        master.take();
    }
    if let Ok(mut child) = handle.child.lock() {
        child.take();
    }
    if let Ok(mut active_sessions) = sessions.write() {
        active_sessions.remove(id);
    }

    let _ = app_handle.emit(PTY_CLOSED, id.to_owned());
}

fn flush_pending(
    app_handle: &AppHandle<impl Runtime>,
    event_name: &str,
    handle: &Arc<PtyHandle>,
    pending: &mut Vec<u8>,
) {
    if pending.is_empty() {
        return;
    }

    handle.append_output(pending);
    let payload = std::mem::take(pending);
    let _ = app_handle.emit(event_name, payload);
}

fn capture_exit_code(handle: &Arc<PtyHandle>) -> Option<i32> {
    let Ok(mut child_slot) = handle.child.lock() else {
        return None;
    };

    let Some(child) = child_slot.as_mut() else {
        return handle
            .session_snapshot()
            .ok()
            .and_then(|session| session.exit_code);
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

fn normalize_exit_code(exit_code: u32) -> Option<i32> {
    i32::try_from(exit_code).ok()
}

fn render_command(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        command.to_owned()
    } else {
        format!("{} {}", command, args.join(" "))
    }
}

fn now_millis() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0_u128, |duration| duration.as_millis());
    i64::try_from(millis).unwrap_or(i64::MAX)
}

// Async to move off the main thread (Tauri dispatches async commands on the async runtime).
#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn pty_create(
    app_handle: AppHandle,
    manager: State<'_, PtyManager>,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
) -> Result<String, AppError> {
    validate_command(&command)?;
    validate_cwd(&cwd)?;
    manager.create_session(
        &app_handle,
        PtyCreateRequest {
            command,
            args,
            cwd,
            env,
            display_command: None,
        },
    )
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    manager.write_input(&id, &data)
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let handle = manager.session(&id)?;
    let mut master_slot = handle
        .master
        .lock()
        .map_err(|_| AppError::Internal("PTY master lock poisoned".into()))?;
    let master = master_slot
        .as_mut()
        .ok_or_else(|| AppError::Operation(format!("PTY session is closed: {id}")))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::Operation(format!("failed to resize PTY: {error}")))
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn pty_close(
    app_handle: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<(), AppError> {
    let handle = manager.session(&id)?;

    if !handle.begin_cleanup() {
        return Ok(());
    }

    handle
        .writer
        .lock()
        .map_err(|_| AppError::Internal("PTY writer lock poisoned".into()))?
        .take();
    handle
        .master
        .lock()
        .map_err(|_| AppError::Internal("PTY master lock poisoned".into()))?
        .take();

    let exit_code = {
        let mut child_slot = handle
            .child
            .lock()
            .map_err(|_| AppError::Internal("PTY child lock poisoned".into()))?;
        match child_slot.take() {
            Some(mut child) => {
                match child.try_wait() {
                    Ok(Some(status)) => normalize_exit_code(status.exit_code()),
                    Ok(None) => {
                        child.kill().map_err(|error| {
                            AppError::Operation(format!(
                                "failed to terminate PTY process: {error}"
                            ))
                        })?;
                        child
                            .wait()
                            .ok()
                            .and_then(|status| normalize_exit_code(status.exit_code()))
                    }
                    Err(_) => None,
                }
            }
            None => None,
        }
    };

    handle.set_exit_code(exit_code);
    emit_bound_exit_if_any(&app_handle, &handle);
    manager.remove_session(&id);
    let _ = app_handle.emit(PTY_CLOSED, id);

    Ok(())
}

#[tauri::command]
pub fn pty_get_buffer(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<tauri::ipc::Response, AppError> {
    let handle = manager.session(&id)?;
    Ok(tauri::ipc::Response::new(handle.buffer_snapshot()))
}

#[tauri::command]
pub fn get_pty_sessions(manager: State<'_, PtyManager>) -> Result<Vec<PtySession>, AppError> {
    manager.sessions_snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_appends_data() {
        let mut buf = ByteRingBuffer::default();
        buf.append(b"hello");
        assert_eq!(buf.snapshot(), b"hello");
    }

    #[test]
    fn ring_buffer_empty_snapshot() {
        let buf = ByteRingBuffer::default();
        assert!(buf.snapshot().is_empty());
    }

    #[test]
    fn ring_buffer_respects_capacity() {
        let mut buf = ByteRingBuffer::default();
        let chunk = vec![0xAA; BUFFER_CAPACITY + 100];
        buf.append(&chunk);
        assert_eq!(buf.snapshot().len(), BUFFER_CAPACITY);
    }

    #[test]
    fn ring_buffer_evicts_oldest_on_overflow() {
        let mut buf = ByteRingBuffer::default();
        let first = vec![1_u8; BUFFER_CAPACITY];
        buf.append(&first);

        buf.append(&[2, 3, 4]);
        let snap = buf.snapshot();
        assert_eq!(snap.len(), BUFFER_CAPACITY);
        // Newest bytes are at the tail
        assert_eq!(snap[snap.len() - 3..], [2, 3, 4]);
        // Oldest bytes were evicted — first 3 bytes of the original fill are gone
        assert_eq!(snap[0], 1);
    }

    #[test]
    fn ring_buffer_large_single_chunk_keeps_tail() {
        let mut buf = ByteRingBuffer::default();
        buf.append(b"seed");

        let mut big = vec![0_u8; BUFFER_CAPACITY + 50];
        big[BUFFER_CAPACITY + 49] = 0xFF;
        buf.append(&big);

        let snap = buf.snapshot();
        assert_eq!(snap.len(), BUFFER_CAPACITY);
        assert_eq!(*snap.last().unwrap(), 0xFF);
    }

    #[test]
    fn validate_command_rejects_empty() {
        assert!(validate_command("").is_err());
        assert!(validate_command("   ").is_err());
    }

    #[test]
    fn validate_command_accepts_non_empty() {
        assert!(validate_command("ls").is_ok());
        assert!(validate_command("/bin/sh").is_ok());
    }

    #[test]
    fn validate_cwd_rejects_empty() {
        assert!(validate_cwd("").is_err());
    }

    #[test]
    fn validate_cwd_rejects_relative_path() {
        assert!(validate_cwd("relative/path").is_err());
    }

    #[test]
    fn validate_cwd_rejects_nonexistent() {
        assert!(validate_cwd("/nonexistent/path/that/should/not/exist").is_err());
    }

    #[test]
    fn validate_cwd_accepts_tmp() {
        assert!(validate_cwd("/tmp").is_ok());
    }
}
