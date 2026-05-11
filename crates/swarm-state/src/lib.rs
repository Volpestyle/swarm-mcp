use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Type;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use swarm_protocol::frames::{DeltaTableFrame, EventAppendedFrame, KvKey, LockKey};
use swarm_protocol::{
    ChangeCursor, Event, Frame, FramePayload, Instance, InstanceStatus, KvEntry, Lock, Message,
    PtyInfo, SwarmSnapshot, TableCursors, Task, TaskStatus, TaskType,
};

pub const RECENT_MESSAGE_LIMIT: i64 = 100;
pub const RECENT_TASK_WINDOW_MS: i64 = 24 * 60 * 60 * 1_000;
pub const RECENT_EVENT_LIMIT: i64 = 200;
pub const SWARM_DB_ENV: &str = "SWARM_DB_PATH";

const UI_KEY_PREFIX: &str = "ui/";

#[derive(Debug, Clone)]
struct LockRecord {
    lock: Lock,
    created_at: i64,
}

pub fn swarm_db_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(SWARM_DB_ENV) {
        return Ok(PathBuf::from(path));
    }

    let home = dirs::home_dir().ok_or_else(|| "failed to resolve home directory".to_string())?;
    Ok(home.join(".swarm-mcp").join("swarm.db"))
}

pub fn open_swarm_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("failed to open swarm db at {}: {err}", path.display()))?;

    let _: Option<String> = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .optional()
        .map_err(|err| format!("failed to read PRAGMA journal_mode: {err}"))?;

    swarm_schema::validate_schema(&conn)?;

    Ok(conn)
}

pub fn load_snapshot(conn: &Connection, ptys: &[PtyInfo]) -> Result<SwarmSnapshot, String> {
    let instances = load_instances(conn)?;
    let tasks = load_tasks(conn)?;
    let messages = load_messages(conn)?;
    let lock_records = load_lock_records(conn)?;
    let locks = lock_records.iter().map(|row| row.lock.clone()).collect();
    let kv = load_kv(conn)?;
    let events = load_recent_events(conn)?;
    let ptys = ptys.to_vec();

    Ok(SwarmSnapshot {
        cursors: TableCursors {
            messages: Some(max_i64(conn, "messages", "id")?),
            events: Some(max_i64(conn, "events", "id")?),
            instances: cursor_for_instances(&instances),
            tasks: cursor_for_tasks(&tasks),
            locks: cursor_for_locks(&lock_records),
            kv: cursor_for_kv(&kv),
            ptys: cursor_for_ptys(&ptys),
        },
        server_time: now_secs(),
        instances,
        tasks,
        messages,
        locks,
        kv,
        events,
        ptys,
    })
}

pub fn diff_snapshots(previous: &SwarmSnapshot, current: &SwarmSnapshot) -> Vec<Frame> {
    let mut frames = Vec::new();

    let previous_message_id = previous.cursors.messages.unwrap_or_default();
    let current_message_id = current.cursors.messages.unwrap_or_default();
    if current_message_id > previous_message_id {
        let upserts = current
            .messages
            .iter()
            .filter(|message| message.id > previous_message_id)
            .cloned()
            .collect::<Vec<_>>();
        if !upserts.is_empty() {
            frames.push(Frame::new(FramePayload::DeltaTable(
                DeltaTableFrame::Messages {
                    watermark: current_message_id,
                    upserts,
                },
            )));
        }
    }

    let previous_event_id = previous.cursors.events.unwrap_or_default();
    let current_event_id = current.cursors.events.unwrap_or_default();
    if current_event_id > previous_event_id {
        for event in current
            .events
            .iter()
            .filter(|event| event.id > previous_event_id)
            .cloned()
        {
            frames.push(Frame::new(FramePayload::EventAppended(
                EventAppendedFrame {
                    watermark: current_event_id,
                    event,
                },
            )));
        }
    }

    append_string_delta(
        &mut frames,
        previous,
        current,
        previous.instances.iter(),
        current.instances.iter(),
        |instance| instance.id.clone(),
        |cursor, upserts, removes| DeltaTableFrame::Instances {
            cursor,
            upserts,
            removes,
        },
        current.cursors.instances.clone(),
    );

    append_string_delta(
        &mut frames,
        previous,
        current,
        previous.tasks.iter(),
        current.tasks.iter(),
        |task| task.id.clone(),
        |cursor, upserts, removes| DeltaTableFrame::Tasks {
            cursor,
            upserts,
            removes,
        },
        current.cursors.tasks.clone(),
    );

    append_key_delta(
        &mut frames,
        previous,
        current,
        previous.locks.iter(),
        current.locks.iter(),
        |lock| LockKey {
            scope: lock.scope.clone(),
            file: lock.file.clone(),
        },
        |cursor, upserts, removes| DeltaTableFrame::Locks {
            cursor,
            upserts,
            removes,
        },
        current.cursors.locks.clone(),
    );

    append_key_delta(
        &mut frames,
        previous,
        current,
        previous.kv.iter(),
        current.kv.iter(),
        |entry| KvKey {
            scope: entry.scope.clone(),
            key: entry.key.clone(),
        },
        |cursor, upserts, removes| DeltaTableFrame::Kv {
            cursor,
            upserts,
            removes,
        },
        current.cursors.kv.clone(),
    );

    append_string_delta(
        &mut frames,
        previous,
        current,
        previous.ptys.iter(),
        current.ptys.iter(),
        |pty| pty.id.clone(),
        |cursor, upserts, removes| DeltaTableFrame::Ptys {
            cursor,
            upserts,
            removes,
        },
        current.cursors.ptys.clone(),
    );

    frames
}

fn append_string_delta<'a, T, IPrev, ICur, FBuild, FKey>(
    frames: &mut Vec<Frame>,
    previous: &SwarmSnapshot,
    current: &SwarmSnapshot,
    previous_rows: IPrev,
    current_rows: ICur,
    key_fn: FKey,
    build: FBuild,
    cursor: Option<ChangeCursor>,
) where
    T: Clone + PartialEq + 'a,
    IPrev: IntoIterator<Item = &'a T>,
    ICur: IntoIterator<Item = &'a T>,
    FBuild: FnOnce(ChangeCursor, Vec<T>, Vec<String>) -> DeltaTableFrame,
    FKey: Fn(&T) -> String,
{
    let (upserts, removes) = diff_rows(previous_rows, current_rows, key_fn);
    if upserts.is_empty() && removes.is_empty() {
        return;
    }

    frames.push(Frame::new(FramePayload::DeltaTable(build(
        cursor.unwrap_or_else(|| fallback_cursor(current, previous)),
        upserts,
        removes,
    ))));
}

fn append_key_delta<'a, T, K, IPrev, ICur, FBuild, FKey>(
    frames: &mut Vec<Frame>,
    previous: &SwarmSnapshot,
    current: &SwarmSnapshot,
    previous_rows: IPrev,
    current_rows: ICur,
    key_fn: FKey,
    build: FBuild,
    cursor: Option<ChangeCursor>,
) where
    T: Clone + PartialEq + 'a,
    K: Clone + Ord,
    IPrev: IntoIterator<Item = &'a T>,
    ICur: IntoIterator<Item = &'a T>,
    FBuild: FnOnce(ChangeCursor, Vec<T>, Vec<K>) -> DeltaTableFrame,
    FKey: Fn(&T) -> K,
{
    let (upserts, removes) = diff_rows(previous_rows, current_rows, key_fn);
    if upserts.is_empty() && removes.is_empty() {
        return;
    }

    frames.push(Frame::new(FramePayload::DeltaTable(build(
        cursor.unwrap_or_else(|| fallback_cursor(current, previous)),
        upserts,
        removes,
    ))));
}

fn diff_rows<'a, T, K, IPrev, ICur, FKey>(
    previous_rows: IPrev,
    current_rows: ICur,
    key_fn: FKey,
) -> (Vec<T>, Vec<K>)
where
    T: Clone + PartialEq + 'a,
    K: Clone + Ord,
    IPrev: IntoIterator<Item = &'a T>,
    ICur: IntoIterator<Item = &'a T>,
    FKey: Fn(&T) -> K,
{
    let previous = previous_rows
        .into_iter()
        .map(|row| (key_fn(row), row))
        .collect::<BTreeMap<_, _>>();
    let current = current_rows
        .into_iter()
        .map(|row| (key_fn(row), row))
        .collect::<BTreeMap<_, _>>();

    let upserts = current
        .iter()
        .filter_map(|(key, current_row)| match previous.get(key) {
            Some(previous_row) if *previous_row == *current_row => None,
            _ => Some((*current_row).clone()),
        })
        .collect::<Vec<_>>();
    let removes = previous
        .keys()
        .filter(|key| !current.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();

    (upserts, removes)
}

fn fallback_cursor(current: &SwarmSnapshot, previous: &SwarmSnapshot) -> ChangeCursor {
    ChangeCursor::new(
        current.server_time.max(previous.server_time),
        format!(
            "snapshot:{}:{}",
            current.server_time.max(previous.server_time),
            current.cursors.messages.unwrap_or_default()
        ),
    )
}

fn load_recent_events(conn: &Connection) -> Result<Vec<Event>, String> {
    if !table_exists(conn, "events")? {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, scope, type, actor, subject, payload, created_at
             FROM events
             ORDER BY id DESC
             LIMIT ?",
        )
        .map_err(|err| format!("failed to prepare events query: {err}"))?;

    let mut rows = stmt
        .query_map([RECENT_EVENT_LIMIT], |row| {
            Ok(Event {
                id: row.get(0)?,
                scope: row.get(1)?,
                type_: row.get(2)?,
                actor: row.get(3)?,
                subject: row.get(4)?,
                payload: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| format!("failed to query events: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read events: {err}"))?;

    rows.reverse();
    Ok(rows)
}

fn load_instances(conn: &Connection) -> Result<Vec<Instance>, String> {
    if !table_exists(conn, "instances")? {
        return Ok(Vec::new());
    }

    let now = now_secs();
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat,
                    COALESCE(adopted, 1)
             FROM instances
             ORDER BY registered_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare instance query: {err}"))?;

    stmt.query_map([], |row| {
        let heartbeat = row.get::<_, i64>(8)?;
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
            adopted: row.get::<_, i64>(9)? != 0,
        })
    })
    .map_err(|err| format!("failed to query instances: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("failed to read instances: {err}"))
}

fn load_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    if !table_exists(conn, "tasks")? {
        return Ok(Vec::new());
    }

    let cutoff = now_millis() - RECENT_TASK_WINDOW_MS;
    let mut stmt = conn
        .prepare(
            "SELECT id, scope, type, title, description, requester, assignee, status, files,
                    result, created_at, updated_at, changed_at, priority, depends_on,
                    parent_task_id, review_of_task_id, fixes_task_id, progress_summary,
                    progress_updated_at, blocked_reason, expected_next_update_at
             FROM tasks
             WHERE status NOT IN ('done', 'failed', 'cancelled') OR changed_at >= ?
             ORDER BY priority DESC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare task query: {err}"))?;

    stmt.query_map([cutoff], |row| {
        let raw_type = row.get::<_, String>(2)?;
        let raw_status = row.get::<_, String>(7)?;
        Ok(Task {
            id: row.get(0)?,
            scope: row.get(1)?,
            type_: parse_task_type(&raw_type).map_err(|err| invalid_data_error(2, err))?,
            title: row.get(3)?,
            description: row.get(4)?,
            requester: row.get(5)?,
            assignee: row.get(6)?,
            status: parse_task_status(&raw_status).map_err(|err| invalid_data_error(7, err))?,
            files: parse_json_string_array(row.get(8)?, "files")
                .map_err(|err| invalid_data_error(8, err))?,
            result: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            changed_at: row.get(12)?,
            priority: row.get(13)?,
            depends_on: parse_json_string_array(row.get(14)?, "depends_on")
                .map_err(|err| invalid_data_error(14, err))?,
            parent_task_id: row.get(15)?,
            review_of_task_id: row.get(16)?,
            fixes_task_id: row.get(17)?,
            progress_summary: row.get(18)?,
            progress_updated_at: row.get(19)?,
            blocked_reason: row.get(20)?,
            expected_next_update_at: row.get(21)?,
        })
    })
    .map_err(|err| format!("failed to query tasks: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("failed to read tasks: {err}"))
}

fn load_messages(conn: &Connection) -> Result<Vec<Message>, String> {
    if !table_exists(conn, "messages")? {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, scope, sender, recipient, content, created_at, read
             FROM messages
             ORDER BY created_at DESC, id DESC
             LIMIT ?",
        )
        .map_err(|err| format!("failed to prepare message query: {err}"))?;

    let mut rows = stmt
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

    rows.reverse();
    Ok(rows)
}

fn load_lock_records(conn: &Connection) -> Result<Vec<LockRecord>, String> {
    if !table_exists(conn, "context")? {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT scope, file, instance_id, created_at
             FROM context
             WHERE type = 'lock'
             ORDER BY created_at DESC, id ASC",
        )
        .map_err(|err| format!("failed to prepare lock query: {err}"))?;

    stmt.query_map([], |row| {
        Ok(LockRecord {
            lock: Lock {
                scope: row.get(0)?,
                file: row.get(1)?,
                instance_id: row.get(2)?,
            },
            created_at: row.get(3)?,
        })
    })
    .map_err(|err| format!("failed to query locks: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("failed to read locks: {err}"))
}

fn load_kv(conn: &Connection) -> Result<Vec<KvEntry>, String> {
    if !table_exists(conn, "kv")? {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT scope, key, value, updated_at
             FROM kv
             WHERE key NOT LIKE ?
             ORDER BY scope ASC, key ASC",
        )
        .map_err(|err| format!("failed to prepare kv query: {err}"))?;

    stmt.query_map([format!("{UI_KEY_PREFIX}%")], |row| {
        Ok(KvEntry {
            scope: row.get(0)?,
            key: row.get(1)?,
            value: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })
    .map_err(|err| format!("failed to query kv: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("failed to read kv: {err}"))
}

fn cursor_for_instances(rows: &[Instance]) -> Option<ChangeCursor> {
    rows.iter()
        .map(|instance| {
            ChangeCursor::new(
                instance.registered_at.max(instance.heartbeat),
                instance.id.clone(),
            )
        })
        .max()
}

fn cursor_for_tasks(rows: &[Task]) -> Option<ChangeCursor> {
    rows.iter()
        .map(|task| ChangeCursor::new(task.changed_at, task.id.clone()))
        .max()
}

fn cursor_for_locks(rows: &[LockRecord]) -> Option<ChangeCursor> {
    rows.iter()
        .map(|row| {
            ChangeCursor::new(
                row.created_at,
                format!("{}\u{1f}{}", row.lock.scope, row.lock.file),
            )
        })
        .max()
}

fn cursor_for_kv(rows: &[KvEntry]) -> Option<ChangeCursor> {
    rows.iter()
        .map(|entry| ChangeCursor::new(entry.updated_at, kv_row_key(entry)))
        .max()
}

fn cursor_for_ptys(rows: &[PtyInfo]) -> Option<ChangeCursor> {
    rows.iter()
        .map(|pty| ChangeCursor::new(pty.started_at, pty.id.clone()))
        .max()
}

fn kv_row_key(entry: &KvEntry) -> String {
    format!("{}\u{1f}{}", entry.scope, entry.key)
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

fn invalid_data_error(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn max_i64(conn: &Connection, table: &str, column: &str) -> Result<i64, String> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }

    conn.query_row(
        &format!("SELECT COALESCE(MAX({column}), 0) FROM {table}"),
        [],
        |row| row.get(0),
    )
    .map_err(|err| format!("failed to query max {table}.{column}: {err}"))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_snapshot() -> SwarmSnapshot {
        SwarmSnapshot {
            server_time: 1,
            ..SwarmSnapshot::default()
        }
    }

    #[test]
    fn diff_snapshots_emits_lock_remove() {
        let previous = SwarmSnapshot {
            locks: vec![Lock {
                scope: "scope".into(),
                file: "a.rs".into(),
                instance_id: "inst-1".into(),
            }],
            cursors: TableCursors {
                locks: Some(ChangeCursor::new(1, "scope\u{1f}a.rs")),
                ..TableCursors::default()
            },
            server_time: 1,
            ..SwarmSnapshot::default()
        };
        let current = empty_snapshot();

        let frames = diff_snapshots(&previous, &current);

        assert!(frames.iter().any(|frame| matches!(
            &frame.payload,
            FramePayload::DeltaTable(DeltaTableFrame::Locks { removes, .. }) if removes == &vec![LockKey {
                scope: "scope".into(),
                file: "a.rs".into(),
            }]
        )));
    }
}
