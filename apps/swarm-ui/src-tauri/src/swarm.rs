use std::{
    collections::{BTreeMap, BTreeMap as Map, BTreeSet},
    sync::{
        Arc, OnceLock, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use swarm_protocol::frames::{DeltaTableFrame, KvKey, LockKey};
use swarm_protocol::{
    Event, Frame, FramePayload, Message, PtyInfo, SwarmSnapshot as ProtocolSnapshot,
};
pub use swarm_state::swarm_db_path;
use swarm_state::{RECENT_EVENT_LIMIT, RECENT_MESSAGE_LIMIT, load_snapshot, open_swarm_db};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    bind::Binder,
    daemon,
    events::{EVENTS_APPENDED, MESSAGES_APPENDED, SWARM_UPDATE},
    model::{AppError, InstanceStatus, SwarmUpdate},
    pty::PtyManager,
};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const UI_KEY_PREFIX: &str = "ui/";
const COLLISION_SEPARATOR: &str = "::";

pub type SwarmUpdateCallback = dyn Fn(&SwarmUpdate) + Send + Sync + 'static;

static SWARM_RUNTIME: OnceLock<SwarmRuntime> = OnceLock::new();

#[derive(Default)]
struct SwarmRuntime {
    started: AtomicBool,
    state: RwLock<WatcherState>,
}

#[derive(Clone, Default)]
struct WatcherState {
    protocol_snapshot: Option<ProtocolSnapshot>,
    snapshot: SwarmUpdate,
    serialized: String,
}

#[derive(Debug)]
struct UiMetaRow {
    scope: String,
    key: String,
    value: String,
}

#[tauri::command]
pub fn get_swarm_state() -> Result<SwarmUpdate, AppError> {
    Ok(read_state().map_err(AppError::Internal)?.snapshot)
}

pub fn start_swarm_watcher<R: Runtime + 'static>(
    app_handle: AppHandle<R>,
    on_update: Option<Arc<SwarmUpdateCallback>>,
) -> Result<(), String> {
    let db_path = swarm_db_path()?;
    let runtime = runtime();
    if runtime.started.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    seed_initial_snapshot(&app_handle, &db_path)?;

    thread::spawn(move || watcher_loop(app_handle, db_path, on_update));
    Ok(())
}

fn watcher_loop<R: Runtime>(
    app_handle: AppHandle<R>,
    db_path: std::path::PathBuf,
    on_update: Option<Arc<SwarmUpdateCallback>>,
) {
    let mut conn: Option<Connection> = None;
    let mut daemon_snapshot_log = daemon::RetryLogThrottle::default();
    let mut daemon_stream_log = daemon::RetryLogThrottle::default();
    let mut daemon_subscribe_log = daemon::RetryLogThrottle::default();
    let mut daemon_read_log = daemon::RetryLogThrottle::default();
    let mut daemon_recovery_log = daemon::RetryLogThrottle::default();

    loop {
        if conn.is_none() {
            match open_swarm_db(&db_path) {
                Ok(connection) => conn = Some(connection),
                Err(_) => conn = None,
            }
        }

        if let Err(err) = refresh_local_ui_state(&app_handle, conn.as_ref(), on_update.as_deref()) {
            eprintln!("[swarm] failed to refresh local UI state: {err}");
            conn = None;
            thread::sleep(POLL_INTERVAL);
            continue;
        }

        if let Err(err) = fetch_and_publish_state(&app_handle, conn.as_ref(), on_update.as_deref())
        {
            daemon_snapshot_log.warn(|| format!("[swarm] failed to fetch daemon snapshot: {err}"));
            recover_daemon("fetching daemon snapshot", &mut daemon_recovery_log);
            thread::sleep(POLL_INTERVAL);
            continue;
        }
        daemon_snapshot_log.reset();
        daemon_recovery_log.reset();

        let cursors = match read_state() {
            Ok(state) => state
                .protocol_snapshot
                .as_ref()
                .map_or_else(Default::default, |snapshot| snapshot.cursors.clone()),
            Err(err) => {
                eprintln!("[swarm] failed to read watcher state: {err}");
                thread::sleep(POLL_INTERVAL);
                continue;
            }
        };
        let mut socket = match tauri::async_runtime::block_on(daemon::open_stream()) {
            Ok(socket) => {
                daemon_stream_log.reset();
                socket
            }
            Err(err) => {
                daemon_stream_log.warn(|| format!("[swarm] failed to open daemon stream: {err}"));
                recover_daemon("opening daemon stream", &mut daemon_recovery_log);
                thread::sleep(POLL_INTERVAL);
                continue;
            }
        };
        if let Err(err) =
            tauri::async_runtime::block_on(daemon::subscribe_with_cursors(&mut socket, cursors))
        {
            daemon_subscribe_log
                .warn(|| format!("[swarm] failed to subscribe daemon stream: {err}"));
            thread::sleep(POLL_INTERVAL);
            continue;
        }
        daemon_subscribe_log.reset();

        loop {
            match tauri::async_runtime::block_on(async {
                tokio::time::timeout(POLL_INTERVAL, daemon::read_frame(&mut socket)).await
            }) {
                Ok(Ok(Some(frame))) => {
                    daemon_read_log.reset();
                    if let Err(err) =
                        apply_stream_frame(&app_handle, frame, conn.as_ref(), on_update.as_deref())
                    {
                        eprintln!("[swarm] daemon stream update failed: {err}");
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(err)) => {
                    daemon_read_log.warn(|| format!("[swarm] daemon stream read failed: {err}"));
                    break;
                }
                Err(_) => {
                    if let Err(err) =
                        refresh_local_ui_state(&app_handle, conn.as_ref(), on_update.as_deref())
                    {
                        eprintln!("[swarm] failed to refresh local UI state: {err}");
                        conn = None;
                        break;
                    }
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn recover_daemon(operation: &'static str, log: &mut daemon::RetryLogThrottle) {
    if let Err(err) = daemon::ensure_running() {
        log.warn(|| format!("[swarm] failed to recover swarm-server after {operation}: {err}"));
    }
}

fn seed_initial_snapshot<R: Runtime>(
    app_handle: &AppHandle<R>,
    db_path: &std::path::Path,
) -> Result<(), String> {
    let conn = open_swarm_db(db_path).ok();
    let protocol_snapshot = match tauri::async_runtime::block_on(daemon::fetch_state()) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            return publish_local_snapshot(SwarmUpdate {
                ui_meta: conn
                    .as_ref()
                    .and_then(|conn| load_ui_meta(conn).ok())
                    .flatten(),
                ..SwarmUpdate::default()
            });
        }
    };
    sync_pty_and_binding_state(app_handle, &protocol_snapshot)?;
    let local_truth = load_local_truth_snapshot(conn.as_ref(), &protocol_snapshot)?;
    let snapshot = ui_update_from_snapshots(
        &protocol_snapshot,
        local_truth.as_ref(),
        conn.as_ref().map_or(Ok(None), load_ui_meta)?,
    );
    publish_initial_snapshot(protocol_snapshot, snapshot)
}

fn refresh_local_ui_state<R: Runtime>(
    app_handle: &AppHandle<R>,
    conn: Option<&Connection>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    refresh_cached_statuses(app_handle, on_update)?;
    refresh_ui_meta(app_handle, conn, on_update)
}

fn fetch_and_publish_state<R: Runtime>(
    app_handle: &AppHandle<R>,
    conn: Option<&Connection>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let current_protocol = tauri::async_runtime::block_on(daemon::fetch_state())?;
    sync_pty_and_binding_state(app_handle, &current_protocol)?;
    let local_truth = load_local_truth_snapshot(conn, &current_protocol)?;
    let ui_meta = conn.map_or(Ok(None), load_ui_meta)?;
    let snapshot = ui_update_from_snapshots(&current_protocol, local_truth.as_ref(), ui_meta);
    publish_snapshot(current_protocol, snapshot, app_handle, on_update)
}

fn apply_stream_frame<R: Runtime>(
    app_handle: &AppHandle<R>,
    frame: Frame,
    conn: Option<&Connection>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    if matches!(
        frame.payload,
        FramePayload::PtyData(_) | FramePayload::PtyExit(_)
    ) {
        return Ok(());
    }

    let mut protocol = read_state()?.protocol_snapshot.unwrap_or_default();
    let mut ptys_changed = false;

    let protocol_changed = match &frame.payload {
        FramePayload::DeltaTable(delta) => {
            let changed = apply_delta_table(&mut protocol, delta);
            ptys_changed = matches!(delta, DeltaTableFrame::Ptys { .. });
            changed
        }
        FramePayload::EventAppended(payload) => {
            let changed = append_event(&mut protocol.events, &payload.event);
            protocol.cursors.events = Some(
                protocol
                    .cursors
                    .events
                    .unwrap_or_default()
                    .max(payload.watermark),
            );
            changed
        }
        FramePayload::LeaseChanged(payload) => {
            let changed = update_pty_lease(&mut protocol.ptys, &payload.pty_id, &payload.lease);
            ptys_changed = true;
            changed
        }
        FramePayload::Error(payload) => return Err(payload.message.clone()),
        _ => return Ok(()),
    };

    if ptys_changed {
        sync_pty_and_binding_state(app_handle, &protocol)?;
    }
    if !protocol_changed && !ptys_changed {
        return Ok(());
    }

    emit_frames(app_handle, std::slice::from_ref(&frame))?;

    let ui_meta = conn.map_or(Ok(None), load_ui_meta)?;
    let local_truth = load_local_truth_snapshot(conn, &protocol)?;
    let snapshot = ui_update_from_snapshots(&protocol, local_truth.as_ref(), ui_meta);
    publish_snapshot(protocol, snapshot, app_handle, on_update)
}

fn refresh_cached_statuses<R: Runtime>(
    app_handle: &AppHandle<R>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let mut state = write_state()?;
    if state.snapshot.instances.is_empty() {
        return Ok(());
    }

    let now = now_secs();
    let mut next_snapshot = state.snapshot.clone();
    let mut changed = false;

    for instance in &mut next_snapshot.instances {
        let next_status = InstanceStatus::from_heartbeat(now, instance.heartbeat);
        if next_status != instance.status {
            instance.status = next_status;
            changed = true;
        }
    }

    if !changed {
        return Ok(());
    }

    let serialized = serialize_snapshot(&next_snapshot)?;
    if serialized == state.serialized {
        return Ok(());
    }

    state.snapshot = next_snapshot.clone();
    state.serialized = serialized;
    drop(state);

    emit_snapshot(app_handle, &next_snapshot, on_update)
}

fn refresh_ui_meta<R: Runtime>(
    app_handle: &AppHandle<R>,
    conn: Option<&Connection>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let ui_meta = conn.map_or(Ok(None), load_ui_meta)?;
    let mut state = write_state()?;
    if state.snapshot.ui_meta == ui_meta {
        return Ok(());
    }

    let mut next_snapshot = state.snapshot.clone();
    next_snapshot.ui_meta = ui_meta;
    let serialized = serialize_snapshot(&next_snapshot)?;
    if serialized == state.serialized {
        return Ok(());
    }

    state.snapshot = next_snapshot.clone();
    state.serialized = serialized;
    drop(state);

    emit_snapshot(app_handle, &next_snapshot, on_update)
}

fn publish_initial_snapshot(
    protocol_snapshot: ProtocolSnapshot,
    snapshot: SwarmUpdate,
) -> Result<(), String> {
    let serialized = serialize_snapshot(&snapshot)?;
    let mut state = write_state()?;
    state.protocol_snapshot = Some(protocol_snapshot);
    state.snapshot = snapshot;
    state.serialized = serialized;
    Ok(())
}

fn publish_local_snapshot(snapshot: SwarmUpdate) -> Result<(), String> {
    let serialized = serialize_snapshot(&snapshot)?;
    let mut state = write_state()?;
    state.protocol_snapshot = None;
    state.snapshot = snapshot;
    state.serialized = serialized;
    Ok(())
}

fn publish_snapshot<R: Runtime>(
    protocol_snapshot: ProtocolSnapshot,
    snapshot: SwarmUpdate,
    app_handle: &AppHandle<R>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let serialized = serialize_snapshot(&snapshot)?;
    let mut state = write_state()?;
    let changed = serialized != state.serialized;
    state.protocol_snapshot = Some(protocol_snapshot);
    state.snapshot = snapshot.clone();
    state.serialized = serialized;
    drop(state);

    if changed {
        emit_snapshot(app_handle, &snapshot, on_update)?;
    }

    Ok(())
}

fn emit_snapshot<R: Runtime>(
    app_handle: &AppHandle<R>,
    snapshot: &SwarmUpdate,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    app_handle
        .emit(SWARM_UPDATE, snapshot)
        .map_err(|err| format!("failed to emit swarm update: {err}"))?;

    if let Some(callback) = on_update {
        callback(snapshot);
    }

    Ok(())
}

fn emit_frames<R: Runtime>(app_handle: &AppHandle<R>, frames: &[Frame]) -> Result<(), String> {
    let mut new_messages = Vec::new();
    let mut new_events = Vec::new();

    for frame in frames {
        match &frame.payload {
            FramePayload::DeltaTable(DeltaTableFrame::Messages { upserts, .. }) => {
                new_messages.extend(upserts.clone());
            }
            FramePayload::EventAppended(payload) => {
                new_events.push(payload.event.clone());
            }
            _ => {}
        }
    }

    if !new_messages.is_empty() {
        app_handle
            .emit(MESSAGES_APPENDED, &new_messages)
            .map_err(|err| format!("failed to emit message delta: {err}"))?;
    }

    if !new_events.is_empty() {
        app_handle
            .emit(EVENTS_APPENDED, &new_events)
            .map_err(|err| format!("failed to emit event delta: {err}"))?;
    }

    Ok(())
}

fn sync_pty_and_binding_state<R: Runtime>(
    app_handle: &AppHandle<R>,
    snapshot: &ProtocolSnapshot,
) -> Result<(), String> {
    app_handle
        .state::<PtyManager>()
        .sync_sessions(app_handle, snapshot.ptys.clone())?;

    let resolved = snapshot
        .ptys
        .iter()
        .filter_map(|pty| {
            pty.bound_instance_id
                .as_ref()
                .map(|instance_id| (instance_id.clone(), pty.id.clone()))
        })
        .collect::<Vec<_>>();
    app_handle.state::<Binder>().replace_resolved(resolved)?;

    Ok(())
}

fn protocol_to_ui_update(protocol: &ProtocolSnapshot, ui_meta: Option<Value>) -> SwarmUpdate {
    SwarmUpdate {
        instances: protocol.instances.clone(),
        tasks: protocol.tasks.clone(),
        messages: protocol.messages.clone(),
        locks: protocol.locks.clone(),
        annotations: protocol.annotations.clone(),
        kv: protocol.kv.clone(),
        events: protocol.events.clone(),
        ui_meta,
    }
}

fn load_local_truth_snapshot(
    conn: Option<&Connection>,
    protocol_snapshot: &ProtocolSnapshot,
) -> Result<Option<ProtocolSnapshot>, String> {
    conn.map(|conn| load_snapshot(conn, &protocol_snapshot.ptys))
        .transpose()
}

fn ui_update_from_snapshots(
    protocol_snapshot: &ProtocolSnapshot,
    local_truth: Option<&ProtocolSnapshot>,
    ui_meta: Option<Value>,
) -> SwarmUpdate {
    protocol_to_ui_update(local_truth.unwrap_or(protocol_snapshot), ui_meta)
}

fn apply_delta_table(snapshot: &mut ProtocolSnapshot, delta: &DeltaTableFrame) -> bool {
    match delta {
        DeltaTableFrame::Instances {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.instances = Some(cursor.clone());
            apply_string_key_delta(&mut snapshot.instances, upserts, removes, |instance| {
                instance.id.clone()
            })
        }
        DeltaTableFrame::Tasks {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.tasks = Some(cursor.clone());
            apply_string_key_delta(&mut snapshot.tasks, upserts, removes, |task| {
                task.id.clone()
            })
        }
        DeltaTableFrame::Messages { watermark, upserts } => {
            snapshot.cursors.messages = Some(
                snapshot
                    .cursors
                    .messages
                    .unwrap_or_default()
                    .max(*watermark),
            );
            append_messages(&mut snapshot.messages, upserts)
        }
        DeltaTableFrame::Locks {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.locks = Some(cursor.clone());
            apply_keyed_delta(&mut snapshot.locks, upserts, removes, |lock| LockKey {
                scope: lock.scope.clone(),
                file: lock.file.clone(),
            })
        }
        DeltaTableFrame::Annotations {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.annotations = Some(cursor.clone());
            apply_string_key_delta(&mut snapshot.annotations, upserts, removes, |annotation| {
                annotation.id.clone()
            })
        }
        DeltaTableFrame::Kv {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.kv = Some(cursor.clone());
            apply_keyed_delta(&mut snapshot.kv, upserts, removes, |entry| KvKey {
                scope: entry.scope.clone(),
                key: entry.key.clone(),
            })
        }
        DeltaTableFrame::Ptys {
            cursor,
            upserts,
            removes,
        } => {
            snapshot.cursors.ptys = Some(cursor.clone());
            apply_string_key_delta(&mut snapshot.ptys, upserts, removes, |pty| pty.id.clone())
        }
        DeltaTableFrame::Unknown => false,
    }
}

fn append_messages(messages: &mut Vec<Message>, incoming: &[Message]) -> bool {
    if incoming.is_empty() {
        return false;
    }

    let mut by_id = Map::new();
    for message in messages.drain(..) {
        by_id.insert(message.id, message);
    }

    let mut changed = false;
    for message in incoming {
        match by_id.insert(message.id, message.clone()) {
            Some(previous) if previous == *message => {}
            _ => changed = true,
        }
    }

    let limit = usize::try_from(RECENT_MESSAGE_LIMIT).unwrap_or(usize::MAX);
    let mut next = by_id.into_values().collect::<Vec<_>>();
    next.sort_unstable_by_key(|message| message.id);
    if next.len() > limit {
        let drain_until = next.len() - limit;
        next.drain(..drain_until);
        changed = true;
    }
    *messages = next;
    changed
}

fn append_event(events: &mut Vec<Event>, event: &Event) -> bool {
    if events.iter().any(|existing| existing.id == event.id) {
        return false;
    }

    events.push(event.clone());
    events.sort_unstable_by_key(|entry| entry.id);
    let limit = usize::try_from(RECENT_EVENT_LIMIT).unwrap_or(usize::MAX);
    if events.len() > limit {
        let drain_until = events.len() - limit;
        events.drain(..drain_until);
    }
    true
}

fn update_pty_lease(
    ptys: &mut [PtyInfo],
    pty_id: &str,
    lease: &Option<swarm_protocol::Lease>,
) -> bool {
    let Some(pty) = ptys.iter_mut().find(|pty| pty.id == pty_id) else {
        return false;
    };
    if pty.lease == *lease {
        return false;
    }
    pty.lease = lease.clone();
    true
}

fn apply_string_key_delta<T, F>(
    rows: &mut Vec<T>,
    upserts: &[T],
    removes: &[String],
    key_fn: F,
) -> bool
where
    T: Clone + PartialEq,
    F: Fn(&T) -> String,
{
    apply_keyed_delta(rows, upserts, removes, key_fn)
}

fn apply_keyed_delta<T, K, F>(rows: &mut Vec<T>, upserts: &[T], removes: &[K], key_fn: F) -> bool
where
    T: Clone + PartialEq,
    K: Clone + Ord,
    F: Fn(&T) -> K,
{
    if upserts.is_empty() && removes.is_empty() {
        return false;
    }

    let remove_keys = removes.iter().cloned().collect::<BTreeSet<_>>();
    let mut upsert_map = upserts
        .iter()
        .cloned()
        .map(|row| (key_fn(&row), row))
        .collect::<Map<_, _>>();
    let mut changed = false;
    let mut next = Vec::with_capacity(rows.len() + upsert_map.len());

    for row in rows.drain(..) {
        let key = key_fn(&row);
        if remove_keys.contains(&key) {
            changed = true;
            continue;
        }
        if let Some(updated) = upsert_map.remove(&key) {
            if updated != row {
                changed = true;
            }
            next.push(updated);
        } else {
            next.push(row);
        }
    }

    if !upsert_map.is_empty() {
        changed = true;
        next.extend(upsert_map.into_values());
    }

    *rows = next;
    changed
}

fn load_ui_meta(conn: &Connection) -> Result<Option<Value>, String> {
    if !table_exists(conn, "kv")? {
        return Ok(None);
    }

    let mut stmt = conn
        .prepare(
            "SELECT scope, key, value
             FROM kv
             WHERE key LIKE ?
             ORDER BY key ASC, scope ASC",
        )
        .map_err(|err| format!("failed to prepare ui metadata query: {err}"))?;

    let rows = stmt
        .query_map([format!("{UI_KEY_PREFIX}%")], |row| {
            Ok(UiMetaRow {
                scope: row.get(0)?,
                key: row.get(1)?,
                value: row.get(2)?,
            })
        })
        .map_err(|err| format!("failed to query ui metadata: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read ui metadata: {err}"))?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut counts = std::collections::HashMap::new();
    for row in &rows {
        *counts.entry(row.key.clone()).or_insert(0usize) += 1;
    }

    let mut meta = BTreeMap::new();
    for row in rows {
        let value = parse_json_value(row.value);
        if counts.get(&row.key).copied().unwrap_or_default() > 1 {
            meta.insert(
                format!("{}{}{}", row.scope, COLLISION_SEPARATOR, row.key),
                value,
            );
        } else {
            meta.insert(row.key, value);
        }
    }

    serde_json::to_value(meta)
        .map(Some)
        .map_err(|err| format!("failed to serialize ui metadata: {err}"))
}

fn parse_json_value(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::String(raw))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(|err| format!("failed to inspect sqlite schema for `{table}`: {err}"))
}

fn serialize_snapshot(snapshot: &SwarmUpdate) -> Result<String, String> {
    serde_json::to_string(snapshot)
        .map_err(|err| format!("failed to serialize swarm snapshot: {err}"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn runtime() -> &'static SwarmRuntime {
    SWARM_RUNTIME.get_or_init(SwarmRuntime::default)
}

fn read_state() -> Result<WatcherState, String> {
    runtime()
        .state
        .read()
        .map(|state| state.clone())
        .map_err(|_| "swarm watcher state lock poisoned".to_string())
}

fn write_state() -> Result<std::sync::RwLockWriteGuard<'static, WatcherState>, String> {
    runtime()
        .state
        .write()
        .map_err(|_| "swarm watcher state lock poisoned".to_string())
}

#[cfg(test)]
mod tests {
    use super::ui_update_from_snapshots;
    use swarm_protocol::{Instance, InstanceStatus, SwarmSnapshot};

    fn make_instance(id: &str) -> Instance {
        Instance {
            id: id.to_string(),
            scope: "/Users/example/Desktop".to_string(),
            directory: "/Users/example/Desktop".to_string(),
            root: "/Users/example/Desktop".to_string(),
            file_root: "/Users/example/Desktop".to_string(),
            pid: 42,
            label: Some("provider:claude role:planner".to_string()),
            registered_at: 10,
            heartbeat: 10,
            status: InstanceStatus::Online,
            adopted: true,
        }
    }

    #[test]
    fn ui_update_from_snapshots_prefers_local_db_truth_for_instances() {
        let protocol_snapshot = SwarmSnapshot {
            instances: vec![make_instance("stale-instance")],
            server_time: 10,
            ..SwarmSnapshot::default()
        };
        let local_truth = SwarmSnapshot {
            server_time: 10,
            ..SwarmSnapshot::default()
        };

        let update = ui_update_from_snapshots(&protocol_snapshot, Some(&local_truth), None);

        assert!(
            update.instances.is_empty(),
            "local DB truth should clear stale protocol instances"
        );
    }

    #[test]
    fn ui_update_from_snapshots_falls_back_to_protocol_when_local_truth_missing() {
        let protocol_snapshot = SwarmSnapshot {
            instances: vec![make_instance("live-instance")],
            server_time: 10,
            ..SwarmSnapshot::default()
        };

        let update = ui_update_from_snapshots(&protocol_snapshot, None, None);

        assert_eq!(update.instances.len(), 1);
        assert_eq!(update.instances[0].id, "live-instance");
    }
}
