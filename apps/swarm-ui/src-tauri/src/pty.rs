use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use swarm_protocol::PtyInfo;
use swarm_protocol::cursors::PtySeq;
use swarm_protocol::frames::{FramePayload, PtyAttachFrame, PtyAttachRejectedFrame};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::daemon;
use crate::events::{
    PTY_BOUND_EXIT, PTY_CLOSED, PTY_CREATED, PTY_UPDATED, pty_data_event, pty_exit_event,
};
use crate::model::{AppError, PtySession};

const BUFFER_CAPACITY: usize = 2 * 1024 * 1024;
const STREAM_RETRY_DELAY: Duration = Duration::from_millis(500);

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

struct PtyHandle {
    session: Mutex<PtySession>,
    buffer: Mutex<ByteRingBuffer>,
    last_seq: Mutex<Option<PtySeq>>,
    exit_emitted: AtomicBool,
    closed: AtomicBool,
    stream_task: Mutex<Option<JoinHandle<()>>>,
}

impl PtyHandle {
    fn new(session: PtySession) -> Self {
        Self {
            session: Mutex::new(session),
            buffer: Mutex::new(ByteRingBuffer::default()),
            last_seq: Mutex::new(None),
            exit_emitted: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stream_task: Mutex::new(None),
        }
    }

    fn session_snapshot(&self) -> Result<PtySession, String> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|_| "PTY session lock poisoned".to_owned())
    }

    fn update_from_info(
        &self,
        info: &PtyInfo,
    ) -> Result<(Option<Option<i32>>, Option<PtySession>), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "PTY session lock poisoned".to_owned())?;
        let before = session.clone();
        let prior_exit = session.exit_code;
        session.command = info.command.clone();
        session.cwd = info.cwd.clone();
        session.started_at = info.started_at;
        session.exit_code = info.exit_code;
        session.bound_instance_id = info.bound_instance_id.clone();
        session.launch_token = None;
        session.cols = info.cols;
        session.rows = info.rows;
        session.lease = info.lease.clone();

        let exit_change = (prior_exit != info.exit_code).then_some(info.exit_code);
        let snapshot = (*session != before).then(|| session.clone());
        Ok((exit_change, snapshot))
    }

    fn set_exit_code(&self, exit_code: Option<i32>) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|_| "PTY session lock poisoned".to_owned())?
            .exit_code = exit_code;
        Ok(())
    }

    fn emit_exit_once<R: Runtime>(&self, app_handle: &AppHandle<R>, exit_code: Option<i32>) {
        if self.exit_emitted.swap(true, Ordering::AcqRel) {
            return;
        }

        if let Ok(session) = self.session.lock() {
            let _ = app_handle.emit(&pty_exit_event(&session.id), exit_code);
            if let Some(instance_id) = session.bound_instance_id.clone() {
                let _ = app_handle.emit(
                    PTY_BOUND_EXIT,
                    serde_json::json!({
                        "pty_id": session.id,
                        "instance_id": instance_id,
                    }),
                );
            }
        }
    }

    fn append_output<R: Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        pty_id: &str,
        seq: PtySeq,
        data: Vec<u8>,
    ) -> Result<(), String> {
        let should_emit = {
            let mut last_seq = self
                .last_seq
                .lock()
                .map_err(|_| "PTY replay cursor lock poisoned".to_owned())?;
            if last_seq.is_some_and(|current| seq.value() <= current.value()) {
                false
            } else {
                *last_seq = Some(seq);
                true
            }
        };

        if !should_emit {
            return Ok(());
        }

        self.buffer
            .lock()
            .map_err(|_| "PTY buffer lock poisoned".to_owned())?
            .append(&data);
        let _ = app_handle.emit(&pty_data_event(pty_id), data);
        Ok(())
    }

    fn buffer_snapshot(&self) -> Result<Vec<u8>, String> {
        self.buffer
            .lock()
            .map(|buffer| buffer.snapshot())
            .map_err(|_| "PTY buffer lock poisoned".to_owned())
    }

    fn replay_cursor(&self) -> Option<PtySeq> {
        self.last_seq.lock().ok().and_then(|cursor| *cursor)
    }

    fn reset_replay_cursor(&self, rejected: &PtyAttachRejectedFrame) {
        if let Ok(mut cursor) = self.last_seq.lock() {
            *cursor = rejected
                .earliest_seq
                .value()
                .checked_sub(1)
                .map(PtySeq::new);
        }
    }

    fn set_stream_task(&self, task: JoinHandle<()>) {
        if let Ok(mut slot) = self.stream_task.lock() {
            *slot = Some(task);
        }
    }

    fn abort_stream(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut slot) = self.stream_task.lock() {
            if let Some(task) = slot.take() {
                task.abort();
            }
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

pub struct PtyManager {
    sessions: Arc<RwLock<HashMap<String, Arc<PtyHandle>>>>,
}

impl PtyManager {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Insert or update a single session without touching the rest of the
    /// catalog. Spawns a stream task for freshly-inserted PTYs. Use this when
    /// a single spawn just returned (`launch.rs`) — calling the full-snapshot
    /// `sync_sessions` with a one-element vec would nuke every other PTY in
    /// the manager because that path treats its input as the complete active
    /// set.
    pub fn upsert_session<R: Runtime + 'static>(
        &self,
        app_handle: &AppHandle<R>,
        info: PtyInfo,
    ) -> Result<(), String> {
        let mut new_handle: Option<(PtySession, Arc<PtyHandle>)> = None;
        {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|_| "PTY manager lock poisoned".to_owned())?;

            if let Some(handle) = sessions.get(&info.id) {
                let (exit_change, updated_session) = handle.update_from_info(&info)?;
                if let Some(session) = updated_session {
                    let _ = app_handle.emit(PTY_UPDATED, session);
                }
                if let Some(exit_code) = exit_change {
                    handle.emit_exit_once(app_handle, exit_code);
                }
            } else {
                let session = protocol_to_session(&info);
                let handle = Arc::new(PtyHandle::new(session.clone()));
                sessions.insert(info.id.clone(), handle.clone());
                new_handle = Some((session, handle));
            }
        }

        if let Some((session, handle)) = new_handle {
            let _ = app_handle.emit(PTY_CREATED, session.clone());
            self.spawn_stream_task(app_handle.clone(), session.id.clone(), handle);
        }

        Ok(())
    }

    pub fn sync_sessions<R: Runtime + 'static>(
        &self,
        app_handle: &AppHandle<R>,
        infos: Vec<PtyInfo>,
    ) -> Result<(), String> {
        let mut new_handles = Vec::new();
        let active_ids = infos
            .iter()
            .map(|info| info.id.clone())
            .collect::<HashSet<_>>();

        {
            let mut sessions = self
                .sessions
                .write()
                .map_err(|_| "PTY manager lock poisoned".to_owned())?;

            for info in &infos {
                if let Some(handle) = sessions.get(&info.id) {
                    let (exit_change, updated_session) = handle.update_from_info(info)?;
                    if let Some(session) = updated_session {
                        let _ = app_handle.emit(PTY_UPDATED, session);
                    }
                    if let Some(exit_code) = exit_change {
                        handle.emit_exit_once(app_handle, exit_code);
                    }
                    continue;
                }

                let session = protocol_to_session(info);
                let handle = Arc::new(PtyHandle::new(session.clone()));
                sessions.insert(info.id.clone(), handle.clone());
                new_handles.push((session, handle));
            }

            let removed = sessions
                .keys()
                .filter(|id| !active_ids.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            for id in removed {
                if let Some(handle) = sessions.remove(&id) {
                    handle.abort_stream();
                    let _ = app_handle.emit(PTY_CLOSED, id);
                }
            }
        }

        for (session, handle) in new_handles {
            let _ = app_handle.emit(PTY_CREATED, session.clone());
            self.spawn_stream_task(app_handle.clone(), session.id.clone(), handle);
        }

        Ok(())
    }

    fn spawn_stream_task<R: Runtime + 'static>(
        &self,
        app_handle: AppHandle<R>,
        pty_id: String,
        handle: Arc<PtyHandle>,
    ) {
        let stream_handle = handle.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut open_stream_log = daemon::RetryLogThrottle::default();
            let mut subscribe_log = daemon::RetryLogThrottle::default();
            let mut attach_log = daemon::RetryLogThrottle::default();
            let mut read_log = daemon::RetryLogThrottle::default();

            loop {
                if stream_handle.is_closed() {
                    return;
                }

                match daemon::open_stream().await {
                    Ok(mut socket) => {
                        open_stream_log.reset();
                        if let Err(err) = daemon::subscribe(&mut socket).await {
                            subscribe_log.warn(|| {
                                format!(
                                    "[pty] failed to subscribe daemon stream for {pty_id}: {err}"
                                )
                            });
                            tokio::time::sleep(STREAM_RETRY_DELAY).await;
                            continue;
                        }
                        subscribe_log.reset();
                        if let Err(err) = daemon::send_frame(
                            &mut socket,
                            &swarm_protocol::Frame::new(FramePayload::PtyAttach(PtyAttachFrame {
                                pty_id: pty_id.clone(),
                                since_seq: stream_handle.replay_cursor(),
                            })),
                        )
                        .await
                        {
                            attach_log.warn(|| {
                                format!(
                                    "[pty] failed to attach daemon PTY stream for {pty_id}: {err}"
                                )
                            });
                            tokio::time::sleep(STREAM_RETRY_DELAY).await;
                            continue;
                        }
                        attach_log.reset();

                        loop {
                            let frame = match daemon::read_frame(&mut socket).await {
                                Ok(Some(frame)) => {
                                    read_log.reset();
                                    frame
                                }
                                Ok(None) => break,
                                Err(err) => {
                                    read_log.warn(|| {
                                        format!("[pty] daemon PTY stream error for {pty_id}: {err}")
                                    });
                                    break;
                                }
                            };

                            match frame.payload {
                                FramePayload::PtyData(payload) if payload.pty_id == pty_id => {
                                    let _ = stream_handle.append_output(
                                        &app_handle,
                                        &pty_id,
                                        payload.seq,
                                        payload.data,
                                    );
                                }
                                FramePayload::PtyExit(payload) if payload.pty_id == pty_id => {
                                    let _ = stream_handle.set_exit_code(payload.exit_code);
                                    stream_handle.emit_exit_once(&app_handle, payload.exit_code);
                                    break;
                                }
                                FramePayload::PtyAttachRejected(rejected)
                                    if rejected.pty_id == pty_id =>
                                {
                                    stream_handle.reset_replay_cursor(&rejected);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(err) => {
                        open_stream_log.warn(|| {
                            format!("[pty] failed to open daemon stream for {pty_id}: {err}")
                        });
                    }
                }

                if stream_handle
                    .session_snapshot()
                    .ok()
                    .is_some_and(|session| session.exit_code.is_some())
                {
                    return;
                }

                tokio::time::sleep(STREAM_RETRY_DELAY).await;
            }
        });
        handle.set_stream_task(task);
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
        self.session(id)?;
        tauri::async_runtime::block_on(daemon::write_pty(id, data.to_vec()))
            .map_err(AppError::Operation)
    }

    pub fn request_lease(&self, id: &str, takeover: bool) -> Result<(), AppError> {
        self.session(id)?;
        tauri::async_runtime::block_on(daemon::request_pty_lease(id, takeover))
            .map(|_| ())
            .map_err(AppError::Operation)
    }

    pub fn release_lease(&self, id: &str) -> Result<(), AppError> {
        self.session(id)?;
        tauri::async_runtime::block_on(daemon::release_pty_lease(id)).map_err(AppError::Operation)
    }

    fn session(&self, id: &str) -> Result<Arc<PtyHandle>, AppError> {
        self.sessions
            .read()
            .map_err(|_| AppError::Internal("PTY manager lock poisoned".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("unknown PTY session: {id}")))
    }
}

fn protocol_to_session(info: &PtyInfo) -> PtySession {
    PtySession {
        id: info.id.clone(),
        command: info.command.clone(),
        cwd: info.cwd.clone(),
        started_at: info.started_at,
        exit_code: info.exit_code,
        bound_instance_id: info.bound_instance_id.clone(),
        launch_token: None,
        cols: info.cols,
        rows: info.rows,
        lease: info.lease.clone(),
    }
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
    manager.session(&id)?;
    tauri::async_runtime::block_on(daemon::resize_pty(&id, cols, rows)).map_err(AppError::Operation)
}

#[tauri::command]
pub fn pty_request_lease(
    manager: State<'_, PtyManager>,
    id: String,
    takeover: bool,
) -> Result<(), AppError> {
    manager.request_lease(&id, takeover)
}

#[tauri::command]
pub fn pty_release_lease(manager: State<'_, PtyManager>, id: String) -> Result<(), AppError> {
    manager.release_lease(&id)
}

#[tauri::command]
#[allow(clippy::unused_async)]
pub async fn pty_close(manager: State<'_, PtyManager>, id: String) -> Result<(), AppError> {
    manager.session(&id)?;
    daemon::close_pty(&id, true)
        .await
        .map_err(AppError::Operation)
}

#[tauri::command]
pub fn pty_get_buffer(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<tauri::ipc::Response, AppError> {
    let handle = manager.session(&id)?;
    Ok(tauri::ipc::Response::new(
        handle.buffer_snapshot().map_err(AppError::Internal)?,
    ))
}

#[tauri::command]
pub fn get_pty_sessions(manager: State<'_, PtyManager>) -> Result<Vec<PtySession>, AppError> {
    manager.sessions_snapshot()
}
