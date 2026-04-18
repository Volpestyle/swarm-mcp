use std::{
    collections::{BTreeMap, HashMap},
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock, RwLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    events::{MESSAGES_APPENDED, SWARM_UPDATE},
    model::{
        AppError, Instance, InstanceStatus, Lock, Message, SwarmUpdate, Task, TaskStatus, TaskType,
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const RECENT_MESSAGE_LIMIT: i64 = 100;
const RECENT_TASK_WINDOW_MS: i64 = 24 * 60 * 60 * 1_000;
const SWARM_DB_ENV: &str = "SWARM_DB_PATH";
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
    snapshot: SwarmUpdate,
    serialized: String,
    watermarks: Option<Watermarks>,
    /// Highest `messages.id` that has already been emitted on
    /// `MESSAGES_APPENDED`. Advanced only after a successful emit so a
    /// transient error replays the delta next tick.
    last_emitted_message_id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Watermarks {
    last_message_id: i64,
    last_task_changed_at: i64,
    instance_count: i64,
    last_heartbeat_max: i64,
    kv_scope_changed_at: i64,
}

#[derive(Debug)]
struct RawTask {
    id: String,
    scope: String,
    type_: String,
    title: String,
    description: Option<String>,
    requester: String,
    assignee: Option<String>,
    status: String,
    files: Option<String>,
    result: Option<String>,
    created_at: i64,
    updated_at: i64,
    changed_at: i64,
    priority: i64,
    depends_on: Option<String>,
    parent_task_id: Option<String>,
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

    seed_initial_snapshot(&db_path)?;

    thread::spawn(move || watcher_loop(app_handle, db_path, on_update));
    Ok(())
}

fn watcher_loop<R: Runtime>(
    app_handle: AppHandle<R>,
    db_path: PathBuf,
    on_update: Option<Arc<SwarmUpdateCallback>>,
) {
    let mut conn: Option<Connection> = None;

    loop {
        let _ = refresh_cached_statuses(&app_handle, on_update.as_deref());

        if conn.is_none() {
            match open_swarm_db(&db_path) {
                Ok(connection) => conn = Some(connection),
                Err(_) => {
                    let _ = publish_snapshot(
                        SwarmUpdate::default(),
                        None,
                        &app_handle,
                        on_update.as_deref(),
                    );
                    thread::sleep(POLL_INTERVAL);
                    continue;
                }
            }
        }

        let Some(connection) = conn.as_ref() else {
            thread::sleep(POLL_INTERVAL);
            continue;
        };

        match poll_database(connection, &app_handle, on_update.as_deref()) {
            Ok(()) => {}
            Err(_) => conn = None,
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn seed_initial_snapshot(db_path: &PathBuf) -> Result<(), String> {
    let Ok(conn) = open_swarm_db(db_path) else {
        return Ok(());
    };

    let snapshot = load_snapshot(&conn)?;
    let watermarks = load_watermarks(&conn)?;
    // Seed last_emitted to the current max so startup doesn't flood the UI
    // with historical messages replayed as packets.
    let initial_last_emitted = watermarks.last_message_id;
    publish_initial_snapshot(snapshot, Some(watermarks), initial_last_emitted)
}

fn poll_database<R: Runtime>(
    conn: &Connection,
    app_handle: &AppHandle<R>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let watermarks = load_watermarks(conn)?;
    let previous = read_state()?;
    let unchanged = previous.watermarks.as_ref() == Some(&watermarks);
    let last_emitted = previous.last_emitted_message_id;
    drop(previous);

    if unchanged {
        return Ok(());
    }

    // Emit the message delta before swapping the snapshot so consumers see
    // the arrival event even if the snapshot hasn't changed shape (e.g. a
    // single new message pushes an older one off the 100-row window).
    if watermarks.last_message_id > last_emitted {
        let new_messages = load_messages_since(conn, last_emitted)?;
        if !new_messages.is_empty() {
            app_handle
                .emit(MESSAGES_APPENDED, &new_messages)
                .map_err(|err| format!("failed to emit message delta: {err}"))?;
            set_last_emitted_message_id(watermarks.last_message_id)?;
        }
    }

    let snapshot = load_snapshot(conn)?;
    publish_snapshot(snapshot, Some(watermarks), app_handle, on_update)
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
    let mut changed = false;
    let mut next_snapshot = state.snapshot.clone();
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

fn publish_initial_snapshot(
    snapshot: SwarmUpdate,
    watermarks: Option<Watermarks>,
    last_emitted_message_id: i64,
) -> Result<(), String> {
    let serialized = serialize_snapshot(&snapshot)?;
    let mut state = write_state()?;
    state.snapshot = snapshot;
    state.serialized = serialized;
    state.watermarks = watermarks;
    state.last_emitted_message_id = last_emitted_message_id;
    Ok(())
}

fn set_last_emitted_message_id(new_value: i64) -> Result<(), String> {
    let mut state = write_state()?;
    state.last_emitted_message_id = new_value;
    Ok(())
}

fn publish_snapshot<R: Runtime>(
    snapshot: SwarmUpdate,
    watermarks: Option<Watermarks>,
    app_handle: &AppHandle<R>,
    on_update: Option<&(dyn Fn(&SwarmUpdate) + Send + Sync + 'static)>,
) -> Result<(), String> {
    let serialized = serialize_snapshot(&snapshot)?;
    let mut state = write_state()?;
    let changed = serialized != state.serialized;
    state.snapshot = snapshot.clone();
    state.serialized = serialized;
    state.watermarks = watermarks;
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

fn load_snapshot(conn: &Connection) -> Result<SwarmUpdate, String> {
    Ok(SwarmUpdate {
        instances: load_instances(conn)?,
        tasks: load_tasks(conn)?,
        messages: load_messages(conn)?,
        locks: load_locks(conn)?,
        ui_meta: load_ui_meta(conn)?,
    })
}

fn load_instances(conn: &Connection) -> Result<Vec<Instance>, String> {
    let now = now_secs();
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat,
                    COALESCE(adopted, 1)
             FROM instances
             ORDER BY registered_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare instance query: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            let heartbeat = row.get::<_, i64>(8)?;
            let adopted: i64 = row.get(9)?;
            Ok(Instance {
                id: row.get(0)?,
                scope: row.get(1)?,
                directory: row.get(2)?,
                root: row.get(3)?,
                file_root: row.get(4)?,
                pid: row.get(5)?,
                label: row.get(6)?,
                registered_at: row.get(7)?,
                heartbeat,
                status: InstanceStatus::from_heartbeat(now, heartbeat),
                adopted: adopted != 0,
            })
        })
        .map_err(|err| format!("failed to query instances: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read instances: {err}"))
}

fn load_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let cutoff = now_millis() - RECENT_TASK_WINDOW_MS;
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, type, title, description, requester, assignee, status, files,
                    result, created_at, updated_at, changed_at, priority, depends_on, parent_task_id
             FROM tasks
             WHERE status NOT IN ('done', 'failed', 'cancelled') OR changed_at >= ?
             ORDER BY priority DESC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare task query: {err}"))?;

    let rows = stmt
        .query_map([cutoff], |row| {
            Ok(RawTask {
                id: row.get(0)?,
                scope: row.get(1)?,
                type_: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                requester: row.get(5)?,
                assignee: row.get(6)?,
                status: row.get(7)?,
                files: row.get(8)?,
                result: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                changed_at: row.get(12)?,
                priority: row.get(13)?,
                depends_on: row.get(14)?,
                parent_task_id: row.get(15)?,
            })
        })
        .map_err(|err| format!("failed to query tasks: {err}"))?;

    rows.map(|row| row.map_err(|err| format!("failed to read task row: {err}")))
        .map(|row| row.and_then(task_from_raw))
        .collect()
}

fn load_messages(conn: &Connection) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, sender, recipient, content, created_at, read
             FROM messages
             ORDER BY created_at DESC, id DESC
             LIMIT ?",
        )
        .map_err(|err| format!("failed to prepare message query: {err}"))?;

    let mut messages = stmt
        .query_map([RECENT_MESSAGE_LIMIT], |row| {
            Ok(Message {
                id: row.get(0)?,
                scope: row.get(1)?,
                sender: row.get(2)?,
                recipient: row.get(3)?,
                content: row.get(4)?,
                created_at: row.get(5)?,
                read: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|err| format!("failed to query messages: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read messages: {err}"))?;

    messages.reverse();
    Ok(messages)
}

/// Load messages with `id > after_id` in ascending order. Used by the delta
/// path to emit only newly-appended rows since the previous emit.
fn load_messages_since(conn: &Connection, after_id: i64) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, sender, recipient, content, created_at, read
             FROM messages
             WHERE id > ?
             ORDER BY id ASC",
        )
        .map_err(|err| format!("failed to prepare delta message query: {err}"))?;

    stmt.query_map([after_id], |row| {
        Ok(Message {
            id: row.get(0)?,
            scope: row.get(1)?,
            sender: row.get(2)?,
            recipient: row.get(3)?,
            content: row.get(4)?,
            created_at: row.get(5)?,
            read: row.get::<_, i64>(6)? != 0,
        })
    })
    .map_err(|err| format!("failed to query delta messages: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("failed to read delta messages: {err}"))
}

fn load_locks(conn: &Connection) -> Result<Vec<Lock>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT scope, file, instance_id
             FROM context
             WHERE type = 'lock'
             ORDER BY scope ASC, file ASC, instance_id ASC",
        )
        .map_err(|err| format!("failed to prepare lock query: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Lock {
                scope: row.get(0)?,
                file: row.get(1)?,
                instance_id: row.get(2)?,
            })
        })
        .map_err(|err| format!("failed to query locks: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read locks: {err}"))
}

fn load_ui_meta(conn: &Connection) -> Result<Option<Value>, String> {
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

    let mut counts = HashMap::new();
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

fn task_from_raw(task: RawTask) -> Result<Task, String> {
    Ok(Task {
        id: task.id,
        scope: task.scope,
        type_: parse_task_type(&task.type_)?,
        title: task.title,
        description: task.description,
        requester: task.requester,
        assignee: task.assignee,
        status: parse_task_status(&task.status)?,
        files: parse_json_string_array(task.files, "files")?,
        result: task.result,
        created_at: task.created_at,
        updated_at: task.updated_at,
        changed_at: task.changed_at,
        priority: task.priority,
        depends_on: parse_json_string_array(task.depends_on, "depends_on")?,
        parent_task_id: task.parent_task_id,
    })
}

fn parse_task_type(value: &str) -> Result<TaskType, String> {
    match value {
        "review" => Ok(TaskType::Review),
        "implement" => Ok(TaskType::Implement),
        "fix" => Ok(TaskType::Fix),
        "test" => Ok(TaskType::Test),
        "research" => Ok(TaskType::Research),
        "other" => Ok(TaskType::Other),
        _ => Err(format!("unknown task type: {value}")),
    }
}

fn parse_task_status(value: &str) -> Result<TaskStatus, String> {
    match value {
        "open" => Ok(TaskStatus::Open),
        "claimed" => Ok(TaskStatus::Claimed),
        "in_progress" => Ok(TaskStatus::InProgress),
        "done" => Ok(TaskStatus::Done),
        "failed" => Ok(TaskStatus::Failed),
        "cancelled" => Ok(TaskStatus::Cancelled),
        "blocked" => Ok(TaskStatus::Blocked),
        "approval_required" => Ok(TaskStatus::ApprovalRequired),
        _ => Err(format!("unknown task status: {value}")),
    }
}

fn parse_json_string_array(raw: Option<String>, field: &str) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };

    serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|err| format!("failed to parse task {field} JSON: {err}"))
}

fn parse_json_value(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::String(raw))
}

fn load_watermarks(conn: &Connection) -> Result<Watermarks, String> {
    let last_message_id = scalar_i64(conn, "SELECT COALESCE(MAX(id), 0) FROM messages")?;
    let last_task_changed_at = scalar_i64(conn, "SELECT COALESCE(MAX(changed_at), 0) FROM tasks")?;

    let (instance_count, last_heartbeat_max) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(MAX(heartbeat), 0) FROM instances",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|err| format!("failed to read instance watermarks: {err}"))?;

    let kv_scope_changed_at = if table_exists(conn, "kv_scope_updates")? {
        scalar_i64(
            conn,
            "SELECT COALESCE(MAX(changed_at), 0) FROM kv_scope_updates",
        )?
    } else {
        0
    };

    Ok(Watermarks {
        last_message_id,
        last_task_changed_at,
        instance_count,
        last_heartbeat_max,
        kv_scope_changed_at,
    })
}

fn scalar_i64(conn: &Connection, query: &str) -> Result<i64, String> {
    conn.query_row(query, [], |row| row.get(0))
        .map_err(|err| format!("failed scalar query `{query}`: {err}"))
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

pub(crate) fn swarm_db_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var(SWARM_DB_ENV) {
        return Ok(PathBuf::from(path));
    }

    let home = dirs::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?;
    Ok(home.join(".swarm-mcp").join("swarm.db"))
}

fn open_swarm_db(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("failed to open swarm db at {}: {err}", path.display()))?;

    let _: Option<String> = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .optional()
        .map_err(|err| format!("failed to read PRAGMA journal_mode: {err}"))?;

    Ok(conn)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
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
    use super::*;

    #[test]
    fn parse_known_task_types() {
        assert!(matches!(parse_task_type("review"), Ok(TaskType::Review)));
        assert!(matches!(
            parse_task_type("implement"),
            Ok(TaskType::Implement)
        ));
        assert!(matches!(parse_task_type("fix"), Ok(TaskType::Fix)));
        assert!(matches!(parse_task_type("test"), Ok(TaskType::Test)));
        assert!(matches!(
            parse_task_type("research"),
            Ok(TaskType::Research)
        ));
        assert!(matches!(parse_task_type("other"), Ok(TaskType::Other)));
    }

    #[test]
    fn parse_unknown_task_type_errors() {
        assert!(parse_task_type("invalid").is_err());
        assert!(parse_task_type("").is_err());
    }

    #[test]
    fn parse_known_task_statuses() {
        assert!(matches!(parse_task_status("open"), Ok(TaskStatus::Open)));
        assert!(matches!(
            parse_task_status("claimed"),
            Ok(TaskStatus::Claimed)
        ));
        assert!(matches!(
            parse_task_status("in_progress"),
            Ok(TaskStatus::InProgress)
        ));
        assert!(matches!(parse_task_status("done"), Ok(TaskStatus::Done)));
        assert!(matches!(
            parse_task_status("failed"),
            Ok(TaskStatus::Failed)
        ));
        assert!(matches!(
            parse_task_status("cancelled"),
            Ok(TaskStatus::Cancelled)
        ));
        assert!(matches!(
            parse_task_status("blocked"),
            Ok(TaskStatus::Blocked)
        ));
        assert!(matches!(
            parse_task_status("approval_required"),
            Ok(TaskStatus::ApprovalRequired)
        ));
    }

    #[test]
    fn parse_unknown_task_status_errors() {
        assert!(parse_task_status("unknown").is_err());
    }

    #[test]
    fn parse_json_string_array_none_returns_empty() {
        assert_eq!(
            parse_json_string_array(None, "test").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn parse_json_string_array_valid() {
        let input = Some(r#"["a","b","c"]"#.to_owned());
        assert_eq!(
            parse_json_string_array(input, "test").unwrap(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn parse_json_string_array_invalid_json_errors() {
        let input = Some("not json".to_owned());
        assert!(parse_json_string_array(input, "test").is_err());
    }

    #[test]
    fn parse_json_value_valid_object() {
        let val = parse_json_value(r#"{"key":"value"}"#.to_owned());
        assert!(val.is_object());
    }

    #[test]
    fn parse_json_value_invalid_falls_back_to_string() {
        let val = parse_json_value("not json".to_owned());
        assert_eq!(val, Value::String("not json".to_owned()));
    }
}
