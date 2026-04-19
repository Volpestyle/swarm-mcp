// =============================================================================
// writes.rs — UI-initiated writes to swarm.db
//
// Mirror of `src/messages.ts` and friends from the MCP server, reimplemented in
// Rust so the UI can write without going through an MCP stdio round-trip.
//
// Architectural rule: this module is the *only* place in the Tauri backend that
// opens a read-write connection to swarm.db. Validation lives in the Tauri
// command layer (see `ui_commands.rs`), not here — matching how the Bun side
// keeps `messages.ts` dumb and validates in `index.ts`.
// =============================================================================

use std::fs::create_dir_all;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    model::{GraphPosition, SavedLayout, INSTANCE_STALE_AFTER_SECS},
    swarm::swarm_db_path,
};

const PLANNER_OWNER_KEY: &str = "owner/planner";
const UI_LAYOUT_KEY: &str = "ui/layout";

fn now_secs() -> i64 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    i64::try_from(secs).unwrap_or(i64::MAX)
}

fn now_millis() -> i64 {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

/// Open a read-write connection to the shared swarm.db.
///
/// Uses the same path resolution as the read-only watcher (env var override,
/// else `~/.swarm-mcp/swarm.db`). Sets a 3s busy timeout to match the Bun
/// side's pragma so concurrent writers don't error out under normal contention.
pub fn open_rw() -> Result<Connection, String> {
    let path = swarm_db_path()?;
    open_rw_at(&path)
}

/// Open a read-write connection at an explicit path. Exposed for tests.
pub fn open_rw_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create swarm db directory {}: {err}",
                parent.display()
            )
        })?;
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("failed to open swarm db rw at {}: {err}", path.display()))?;

    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|err| format!("failed to set busy_timeout: {err}"))?;

    ensure_schema(&conn)?;

    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|err| format!("failed to inspect sqlite_master for {table}: {err}"))
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|err| format!("failed to inspect schema for {table}: {err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("failed to query schema for {table}: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("failed to read schema row for {table}: {err}"))?
    {
        let name: String = row
            .get(1)
            .map_err(|err| format!("failed to read column name for {table}: {err}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(conn: &Connection, table: &str, spec: &str) -> Result<(), String> {
    let name = spec
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("invalid column spec: {spec}"))?;
    if column_exists(conn, table, name)? {
        return Ok(());
    }

    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {spec}"), [])
        .map_err(|err| format!("failed to add {table}.{name}: {err}"))?;
    Ok(())
}

fn touch_kv_scope(conn: &Connection, scope: &str) -> Result<(), String> {
    let changed_at = now_millis();
    conn.execute(
        r#"
        INSERT INTO kv_scope_updates (scope, changed_at) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET changed_at =
          CASE
            WHEN excluded.changed_at > kv_scope_updates.changed_at THEN excluded.changed_at
            ELSE kv_scope_updates.changed_at + 1
          END
        "#,
        params![scope, changed_at],
    )
    .map_err(|err| format!("failed to touch kv scope update for {scope}: {err}"))?;
    Ok(())
}

fn kv_set_value(conn: &Connection, scope: &str, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        r#"
        INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, unixepoch())
        ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
        params![scope, key, value],
    )
    .map_err(|err| format!("failed to set kv {scope}/{key}: {err}"))?;
    touch_kv_scope(conn, scope)
}

fn kv_delete_value(conn: &Connection, scope: &str, key: &str) -> Result<(), String> {
    let deleted = conn
        .execute(
            "DELETE FROM kv WHERE scope = ? AND key = ?",
            params![scope, key],
        )
        .map_err(|err| format!("failed to delete kv {scope}/{key}: {err}"))?;
    if deleted > 0 {
        touch_kv_scope(conn, scope)?;
    }
    Ok(())
}

fn kv_get_value(conn: &Connection, scope: &str, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM kv WHERE scope = ? AND key = ?",
        params![scope, key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("failed to read kv {scope}/{key}: {err}"))
}

pub struct UiCommandRecord {
    pub id: i64,
    pub scope: String,
    pub created_by: Option<String>,
    pub kind: String,
    pub payload: String,
}

pub fn claim_next_ui_command(
    conn: &Connection,
    worker_id: &str,
) -> Result<Option<UiCommandRecord>, String> {
    loop {
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| format!("failed to begin ui command tx: {err}"))?;
        let row = tx
            .query_row(
                "SELECT id, scope, created_by, kind, payload
                 FROM ui_commands
                 WHERE status = 'pending'
                 ORDER BY id ASC
                 LIMIT 1",
                [],
                |row| {
                    Ok(UiCommandRecord {
                        id: row.get(0)?,
                        scope: row.get(1)?,
                        created_by: row.get(2)?,
                        kind: row.get(3)?,
                        payload: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|err| format!("failed to query next ui command: {err}"))?;

        let Some(record) = row else {
            tx.commit()
                .map_err(|err| format!("failed to commit empty ui command tx: {err}"))?;
            return Ok(None);
        };

        let updated = tx
            .execute(
                "UPDATE ui_commands
                 SET status = 'running', claimed_by = ?, started_at = unixepoch()
                 WHERE id = ? AND status = 'pending'",
                params![worker_id, record.id],
            )
            .map_err(|err| format!("failed to claim ui command {}: {err}", record.id))?;

        tx.commit()
            .map_err(|err| format!("failed to commit ui command claim: {err}"))?;

        if updated == 1 {
            emit_event(
                conn,
                &record.scope,
                "ui.command.started",
                Some(worker_id),
                Some(&record.kind),
                Some(json!({ "command_id": record.id, "created_by": record.created_by })),
            )?;
            return Ok(Some(record));
        }
    }
}

pub fn complete_ui_command(
    conn: &Connection,
    record: &UiCommandRecord,
    result: &Value,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ui_commands
         SET status = 'done', result = ?, error = NULL, completed_at = unixepoch()
         WHERE id = ?",
        params![result.to_string(), record.id],
    )
    .map_err(|err| format!("failed to complete ui command {}: {err}", record.id))?;
    emit_event(
        conn,
        &record.scope,
        "ui.command.completed",
        record.created_by.as_deref(),
        Some(&record.kind),
        Some(json!({ "command_id": record.id, "result": result })),
    )
}

pub fn fail_ui_command(
    conn: &Connection,
    record: &UiCommandRecord,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ui_commands
         SET status = 'failed', error = ?, completed_at = unixepoch()
         WHERE id = ?",
        params![error, record.id],
    )
    .map_err(|err| format!("failed to fail ui command {}: {err}", record.id))?;
    emit_event(
        conn,
        &record.scope,
        "ui.command.failed",
        record.created_by.as_deref(),
        Some(&record.kind),
        Some(json!({ "command_id": record.id, "error": error })),
    )
}

pub fn load_ui_layout(conn: &Connection, scope: &str) -> Result<SavedLayout, String> {
    let Some(raw) = kv_get_value(conn, scope, UI_LAYOUT_KEY)? else {
        return Ok(SavedLayout::default());
    };
    serde_json::from_str(&raw).map_err(|err| format!("failed to parse {UI_LAYOUT_KEY}: {err}"))
}

pub fn save_ui_layout(conn: &Connection, scope: &str, layout: &SavedLayout) -> Result<(), String> {
    let raw = serde_json::to_string(layout)
        .map_err(|err| format!("failed to serialize {UI_LAYOUT_KEY}: {err}"))?;
    kv_set_value(conn, scope, UI_LAYOUT_KEY, &raw)
}

pub fn set_ui_layout_position(
    conn: &Connection,
    scope: &str,
    node_id: &str,
    position: GraphPosition,
) -> Result<SavedLayout, String> {
    let mut layout = load_ui_layout(conn, scope)?;
    layout.nodes.insert(node_id.to_owned(), position);
    save_ui_layout(conn, scope, &layout)?;
    Ok(layout)
}

fn has_role(label: Option<&str>, role: &str) -> bool {
    label
        .unwrap_or_default()
        .split_whitespace()
        .any(|token| token == format!("role:{role}"))
}

fn active_planner(
    conn: &Connection,
    scope: &str,
    instance_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    let row = conn
        .query_row(
            "SELECT id, label FROM instances WHERE id = ? AND scope = ?",
            params![instance_id, scope],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read planner instance {instance_id}: {err}"))?;

    Ok(row.filter(|(_, label)| has_role(label.as_deref(), "planner")))
}

fn next_planner(conn: &Connection, scope: &str) -> Result<Option<(String, Option<String>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label FROM instances WHERE scope = ? ORDER BY registered_at ASC, id ASC",
        )
        .map_err(|err| format!("failed to prepare planner lookup for {scope}: {err}"))?;

    let rows = stmt
        .query_map([scope], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|err| format!("failed to query planners for {scope}: {err}"))?;

    for row in rows {
        let (id, label) = row.map_err(|err| format!("failed to read planner row: {err}"))?;
        if has_role(label.as_deref(), "planner") {
            return Ok(Some((id, label)));
        }
    }

    Ok(None)
}

fn refresh_planner_owner(conn: &Connection, scope: &str) -> Result<(), String> {
    let current = kv_get_value(conn, scope, PLANNER_OWNER_KEY)?;
    if let Some(raw) = current {
        let parsed = serde_json::from_str::<Value>(&raw).ok();
        if let Some(instance_id) = parsed
            .as_ref()
            .and_then(|value| value.get("instance_id"))
            .and_then(Value::as_str)
        {
            if active_planner(conn, scope, instance_id)?.is_some() {
                return Ok(());
            }
        }
    }

    if let Some((id, label)) = next_planner(conn, scope)? {
        let payload = json!({
            "instance_id": id,
            "label": label,
            "assigned_at": now_millis(),
        });
        kv_set_value(conn, scope, PLANNER_OWNER_KEY, &payload.to_string())?;
    } else {
        kv_delete_value(conn, scope, PLANNER_OWNER_KEY)?;
    }

    Ok(())
}

fn emit_event(
    conn: &Connection,
    scope: &str,
    event_type: &str,
    actor: Option<&str>,
    subject: Option<&str>,
    payload: Option<Value>,
) -> Result<(), String> {
    let payload_text = payload.map(|value| value.to_string());
    conn.execute(
        "INSERT INTO events (scope, type, actor, subject, payload) VALUES (?, ?, ?, ?, ?)",
        params![scope, event_type, actor, subject, payload_text],
    )
    .map_err(|err| format!("failed to write event {event_type}: {err}"))?;
    Ok(())
}

fn dependency_state(
    conn: &Connection,
    scope: &str,
    dep_ids: &[String],
) -> Result<&'static str, String> {
    if dep_ids.is_empty() {
        return Ok("ready");
    }

    let mut all_done = true;
    for dep_id in dep_ids {
        let status = conn
            .query_row(
                "SELECT status FROM tasks WHERE id = ? AND scope = ?",
                params![dep_id, scope],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("failed to read dependency {dep_id}: {err}"))?;

        match status.as_deref() {
            Some("failed") | Some("cancelled") => return Ok("failed"),
            Some("done") => {}
            _ => all_done = false,
        }
    }

    Ok(if all_done { "ready" } else { "blocked" })
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA auto_vacuum = INCREMENTAL;

        CREATE TABLE IF NOT EXISTS instances (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          directory TEXT NOT NULL,
          root TEXT NOT NULL,
          file_root TEXT NOT NULL DEFAULT '',
          pid INTEGER NOT NULL,
          label TEXT,
          registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
          heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
          adopted INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL DEFAULT '',
          sender TEXT NOT NULL,
          recipient TEXT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          read INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          requester TEXT NOT NULL,
          assignee TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          files TEXT,
          result TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          changed_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS context (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL DEFAULT '',
          instance_id TEXT NOT NULL,
          file TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT,
          subject TEXT,
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS kv (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (scope, key)
        );

        CREATE TABLE IF NOT EXISTS kv_scope_updates (
          scope TEXT PRIMARY KEY,
          changed_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ui_commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          created_by TEXT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          claimed_by TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          started_at INTEGER,
          completed_at INTEGER
        );
        "#,
    )
    .map_err(|err| format!("failed to bootstrap schema: {err}"))?;

    add_column_if_missing(conn, "instances", "scope TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "instances", "root TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "instances", "file_root TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "instances", "adopted INTEGER NOT NULL DEFAULT 1")?;
    add_column_if_missing(conn, "messages", "scope TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "tasks", "scope TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "tasks", "changed_at INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "tasks", "priority INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "tasks", "depends_on TEXT")?;
    add_column_if_missing(conn, "tasks", "idempotency_key TEXT")?;
    add_column_if_missing(conn, "tasks", "parent_task_id TEXT")?;
    add_column_if_missing(conn, "context", "scope TEXT NOT NULL DEFAULT ''")?;

    conn.execute(
        r#"
        INSERT INTO kv_scope_updates (scope, changed_at)
        SELECT scope, MAX(updated_at) * 1000
        FROM kv
        GROUP BY scope
        ON CONFLICT(scope) DO NOTHING
        "#,
        [],
    )
    .map_err(|err| format!("failed to seed kv_scope_updates: {err}"))?;

    conn.execute("UPDATE instances SET scope = directory WHERE scope = ''", [])
        .map_err(|err| format!("failed to backfill instances.scope: {err}"))?;
    conn.execute("UPDATE instances SET root = directory WHERE root = ''", [])
        .map_err(|err| format!("failed to backfill instances.root: {err}"))?;
    conn.execute(
        "UPDATE instances SET file_root = directory WHERE file_root = ''",
        [],
    )
    .map_err(|err| format!("failed to backfill instances.file_root: {err}"))?;
    conn.execute(
        "UPDATE tasks SET changed_at = updated_at * 1000 WHERE changed_at = 0",
        [],
    )
    .map_err(|err| format!("failed to backfill tasks.changed_at: {err}"))?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS messages_scope_recipient_read_idx ON messages(scope, recipient, read, id)",
        [],
    )
    .map_err(|err| format!("failed to create messages index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS instances_scope_idx ON instances(scope)",
        [],
    )
    .map_err(|err| format!("failed to create instances index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS tasks_scope_status_idx ON tasks(scope, status)",
        [],
    )
    .map_err(|err| format!("failed to create tasks status index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS tasks_scope_changed_at_idx ON tasks(scope, changed_at)",
        [],
    )
    .map_err(|err| format!("failed to create tasks changed_at index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS context_scope_file_idx ON context(scope, file)",
        [],
    )
    .map_err(|err| format!("failed to create context index: {err}"))?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS context_lock_idx ON context(scope, file) WHERE type = 'lock'",
        [],
    )
    .map_err(|err| format!("failed to create context lock index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS events_scope_id_idx ON events(scope, id)",
        [],
    )
    .map_err(|err| format!("failed to create events index: {err}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ui_commands_scope_status_id_idx ON ui_commands(scope, status, id)",
        [],
    )
    .map_err(|err| format!("failed to create ui_commands index: {err}"))?;

    if table_exists(conn, "tasks")? {
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key_idx ON tasks(scope, idempotency_key) WHERE idempotency_key IS NOT NULL",
            [],
        )
        .map_err(|err| format!("failed to create idempotency index: {err}"))?;
    }

    Ok(())
}

/// Ensure the `instances.adopted` column exists on the shared swarm.db.
///
/// The Bun-side `src/db.ts` adds this column at startup, but swarm-ui can
/// launch before any MCP client has ever opened the DB. Running an
/// idempotent ALTER here guarantees the column is present before any write
/// that references it.
pub fn ensure_adopted_column(conn: &Connection) -> Result<(), String> {
    ensure_schema(conn)
}

/// Walk upward from `dir` looking for a `.git` entry, returning the first
/// directory that contains one. Falls back to `dir` itself if none is found.
///
/// Mirrors `root()` in `src/paths.ts` so UI-computed scopes match what the
/// adopting child process would compute for the same directory.
pub fn git_root(dir: &Path) -> PathBuf {
    let start = dir.to_path_buf();
    let mut cur = start.clone();
    loop {
        if cur.join(".git").exists() {
            return cur;
        }
        match cur.parent() {
            Some(parent) if parent != cur => cur = parent.to_path_buf(),
            _ => return start,
        }
    }
}

pub struct PendingInstance {
    pub id: String,
    pub scope: String,
    pub directory: String,
    pub root: String,
    pub file_root: String,
}

/// Pre-create an unadopted instance row owned by the UI.
///
/// The child process inside the spawned PTY will `swarm.register` with
/// `SWARM_MCP_INSTANCE_ID=<id>` and adopt this row (flipping `adopted = 1`).
/// Until then, the UI keeps the row's `heartbeat` fresh via
/// [`heartbeat_unadopted_instance`] so it stays visible and is not pruned
/// by the Bun side's 30s stale sweep.
pub fn create_pending_instance(
    conn: &Connection,
    directory: &str,
    explicit_scope: Option<&str>,
    label: Option<&str>,
    file_root: Option<&str>,
) -> Result<PendingInstance, String> {
    let dir_path = PathBuf::from(directory);
    let root = git_root(&dir_path);
    let scope = match explicit_scope {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => root.clone(),
    };
    let file_root_path = match file_root {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => dir_path.clone(),
    };

    let row = PendingInstance {
        id: Uuid::new_v4().to_string(),
        scope: scope.to_string_lossy().into_owned(),
        directory: dir_path.to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        file_root: file_root_path.to_string_lossy().into_owned(),
    };

    // pid=0 is the UI's marker for "child has not adopted yet". The child
    // overwrites it with its own pid during `register`.
    conn.execute(
        "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0)",
        params![row.id, row.scope, row.directory, row.root, row.file_root, label],
    )
    .map_err(|err| format!("failed to pre-create instance row: {err}"))?;

    Ok(row)
}

/// Refresh an unadopted instance's heartbeat. No-op if the row has already
/// been adopted or no longer exists.
pub fn heartbeat_unadopted_instance(conn: &Connection, instance_id: &str) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE instances SET heartbeat = unixepoch() WHERE id = ? AND adopted = 0",
            params![instance_id],
        )
        .map_err(|err| format!("failed to heartbeat instance: {err}"))?;
    Ok(updated > 0)
}

/// Delete an unadopted instance row. Used on PTY exit to clean up a row the
/// child never adopted. No-op if the child has already adopted (at which
/// point the child owns the row's lifecycle and will call
/// `swarm.deregister` itself on shutdown).
pub fn delete_unadopted_instance(conn: &Connection, instance_id: &str) -> Result<bool, String> {
    let deleted = conn
        .execute(
            "DELETE FROM instances WHERE id = ? AND adopted = 0",
            params![instance_id],
        )
        .map_err(|err| format!("failed to delete unadopted instance: {err}"))?;
    Ok(deleted > 0)
}

/// Fully deregister an instance — whatever its adoption state. Mirrors the
/// cascade in `src/registry.ts::release` so the DB is left in the same
/// shape it would be in after a clean `swarm.deregister` call from the
/// MCP side: tasks released, locks dropped, queued messages dropped.
///
/// Used by the UI when the user manually removes a node (PTY already
/// gone, instance row ghosted by a restart, etc.).
pub fn deregister_instance(conn: &Connection, instance_id: &str) -> Result<(), String> {
    let instance = load_instance_info(conn, instance_id)?
        .ok_or_else(|| format!("instance {instance_id} not found"))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin tx for deregister: {err}"))?;

    // Release claimed/in_progress work so someone else can pick it up.
    tx.execute(
        "UPDATE tasks
         SET assignee = NULL, status = 'open',
             updated_at = unixepoch(), changed_at = unixepoch() * 1000
         WHERE assignee = ? AND status IN ('claimed', 'in_progress')",
        params![instance_id],
    )
    .map_err(|err| format!("failed to release claimed tasks: {err}"))?;

    // Clear assignee on blocked/approval-required tasks but keep status.
    tx.execute(
        "UPDATE tasks
         SET assignee = NULL, updated_at = unixepoch(), changed_at = unixepoch() * 1000
         WHERE assignee = ? AND status IN ('blocked', 'approval_required')",
        params![instance_id],
    )
    .map_err(|err| format!("failed to clear blocked-task assignee: {err}"))?;

    tx.execute(
        "DELETE FROM context WHERE type = 'lock' AND instance_id = ?",
        params![instance_id],
    )
    .map_err(|err| format!("failed to drop locks: {err}"))?;

    tx.execute(
        "DELETE FROM messages WHERE recipient = ?",
        params![instance_id],
    )
    .map_err(|err| format!("failed to drop queued messages: {err}"))?;

    tx.execute(
        "DELETE FROM instances WHERE id = ?",
        params![instance_id],
    )
    .map_err(|err| format!("failed to delete instance row: {err}"))?;

    tx.execute(
        "INSERT INTO events (scope, type, actor, subject, payload) VALUES (?, 'instance.deregistered', ?, ?, ?)",
        params![
            instance.scope,
            instance_id,
            instance_id,
            json!({ "label": instance.label }).to_string()
        ],
    )
    .map_err(|err| format!("failed to record instance.deregistered: {err}"))?;

    tx.commit()
        .map_err(|err| format!("failed to commit deregister tx: {err}"))?;

    refresh_planner_owner(conn, &instance.scope)?;

    Ok(())
}

/// Delete stale unadopted instance rows left behind by prior UI sessions.
///
/// Fresh placeholders may still belong to another live `swarm-ui` window or a
/// slow-starting child process, so we only sweep rows whose heartbeat has
/// already fallen past the normal stale window.
pub fn sweep_unadopted_orphans(conn: &Connection) -> Result<usize, String> {
    let stale_before = now_secs().saturating_sub(INSTANCE_STALE_AFTER_SECS);

    // Collect ids first so we can cascade tasks/locks/messages per id.
    let mut stmt = conn
        .prepare("SELECT id FROM instances WHERE adopted = 0 AND heartbeat < ?")
        .map_err(|err| format!("failed to prepare orphan sweep query: {err}"))?;
    let ids: Vec<String> = stmt
        .query_map(params![stale_before], |row| row.get(0))
        .map_err(|err| format!("failed to query orphans: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read orphan ids: {err}"))?;
    drop(stmt);

    for id in &ids {
        let Some(instance) = load_instance_info(conn, id)? else {
            continue;
        };

        let tx = conn
            .unchecked_transaction()
            .map_err(|err| format!("failed to begin orphan sweep tx: {err}"))?;

        tx.execute(
            "UPDATE tasks
             SET assignee = NULL, status = 'open',
                 updated_at = unixepoch(), changed_at = unixepoch() * 1000
             WHERE assignee = ? AND status IN ('claimed', 'in_progress')",
            params![id],
        )
        .map_err(|err| format!("failed to release orphan claimed tasks: {err}"))?;
        tx.execute(
            "UPDATE tasks
             SET assignee = NULL, updated_at = unixepoch(), changed_at = unixepoch() * 1000
             WHERE assignee = ? AND status IN ('blocked', 'approval_required')",
            params![id],
        )
        .map_err(|err| format!("failed to clear orphan blocked-task assignee: {err}"))?;
        tx.execute(
            "DELETE FROM context WHERE type = 'lock' AND instance_id = ?",
            params![id],
        )
        .map_err(|err| format!("failed to drop orphan locks: {err}"))?;
        tx.execute("DELETE FROM messages WHERE recipient = ?", params![id])
            .map_err(|err| format!("failed to drop orphan messages: {err}"))?;
        tx.execute("DELETE FROM instances WHERE id = ?", params![id])
            .map_err(|err| format!("failed to delete orphan instance: {err}"))?;
        tx.execute(
            "INSERT INTO events (scope, type, actor, subject, payload) VALUES (?, 'instance.stale_reclaimed', 'system', ?, ?)",
            params![instance.scope, id, json!({ "label": instance.label }).to_string()],
        )
        .map_err(|err| format!("failed to record instance.stale_reclaimed: {err}"))?;
        tx.commit()
            .map_err(|err| format!("failed to commit orphan sweep tx: {err}"))?;

        refresh_planner_owner(conn, &instance.scope)?;
    }

    Ok(ids.len())
}

pub struct InstanceInfo {
    pub id: String,
    pub scope: String,
    pub directory: String,
    pub label: Option<String>,
    pub heartbeat: i64,
    pub adopted: bool,
}

/// Read the subset of an instance row needed to respawn a PTY against it.
/// Returns `None` if the row no longer exists.
pub fn load_instance_info(
    conn: &Connection,
    instance_id: &str,
) -> Result<Option<InstanceInfo>, String> {
    conn.query_row(
        "SELECT id, scope, directory, label, heartbeat, COALESCE(adopted, 1)
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
                adopted: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to load instance info: {err}"))
}

/// Returns whether the instance row has been adopted by the child process.
/// `Ok(None)` means the row no longer exists (pruned or deregistered).
pub fn instance_adoption_state(
    conn: &Connection,
    instance_id: &str,
) -> Result<Option<bool>, String> {
    conn.query_row(
        "SELECT adopted FROM instances WHERE id = ?",
        params![instance_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|maybe| maybe.map(|value| value != 0))
    .map_err(|err| format!("failed to read adoption state: {err}"))
}

/// Delete every message exchanged between two instances in either direction.
/// Used by the UI's per-edge "Clear history" action. Returns the number of
/// rows removed.
pub fn clear_messages_between(
    conn: &Connection,
    instance_a: &str,
    instance_b: &str,
) -> Result<usize, String> {
    let deleted = conn
        .execute(
            "DELETE FROM messages
             WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)",
            params![instance_a, instance_b, instance_b, instance_a],
        )
        .map_err(|err| format!("failed to clear messages: {err}"))?;

    if deleted > 0 {
        let scope = conn
            .query_row(
                "SELECT scope FROM instances WHERE id = ? LIMIT 1",
                params![instance_a],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("failed to resolve scope for message clear: {err}"))?
            .unwrap_or_default();
        if !scope.is_empty() {
            emit_event(
                conn,
                &scope,
                "message.cleared",
                None,
                Some(instance_a),
                Some(json!({
                    "peer": instance_b,
                    "deleted": deleted,
                })),
            )?;
        }
    }

    Ok(deleted)
}

/// Unassign a task — clears `assignee` and resets `status` to `open` if it
/// was claimed/in-progress. Mirrors the per-instance release logic in
/// `deregister_instance` but scoped to one task. Returns `true` if a row
/// was modified.
pub fn unassign_task(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let task = conn
        .query_row(
            "SELECT scope, status, assignee FROM tasks WHERE id = ?",
            params![task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("failed to load task for unassign: {err}"))?;

    let Some((scope, prior_status, prior_assignee)) = task else {
        return Ok(false);
    };

    let next_status = if matches!(prior_status.as_str(), "claimed" | "in_progress") {
        "open"
    } else {
        prior_status.as_str()
    };

    let updated = conn
        .execute(
            "UPDATE tasks
             SET assignee = NULL,
                 status = ?,
                 updated_at = unixepoch(),
                 changed_at = unixepoch() * 1000
             WHERE id = ?",
            params![next_status, task_id],
        )
        .map_err(|err| format!("failed to unassign task: {err}"))?;

    if updated > 0 {
        emit_event(
            conn,
            &scope,
            "task.updated",
            prior_assignee.as_deref(),
            Some(task_id),
            Some(json!({
                "status": next_status,
                "prior_status": prior_status,
                "assignee": Value::Null,
            })),
        )?;
    }

    Ok(updated > 0)
}

/// Remove `dependency_task_id` from `dependent_task_id`'s `depends_on` array.
/// `depends_on` is stored as a JSON array of task ids, matching how the Bun
/// side writes it in `src/tasks.ts`. Returns `true` if the array changed.
pub fn remove_task_dependency(
    conn: &Connection,
    dependent_task_id: &str,
    dependency_task_id: &str,
) -> Result<bool, String> {
    let task = conn
        .query_row(
            "SELECT scope, depends_on, assignee, status FROM tasks WHERE id = ?",
            params![dependent_task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("failed to load depends_on: {err}"))?;

    let Some((scope, raw, assignee, prior_status)) = task else {
        return Ok(false);
    };

    let mut ids: Vec<String> = match raw.as_deref() {
        Some(json) if !json.is_empty() => serde_json::from_str(json)
            .map_err(|err| format!("failed to parse depends_on JSON: {err}"))?,
        _ => Vec::new(),
    };

    let before = ids.len();
    ids.retain(|id| id != dependency_task_id);
    if ids.len() == before {
        return Ok(false);
    }

    let next_dep_value = if ids.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&ids)
                .map_err(|err| format!("failed to serialize depends_on: {err}"))?,
        )
    };

    let dep_state = dependency_state(conn, &scope, &ids)?;
    let (next_status, next_result, event_type) = match prior_status.as_str() {
        "blocked" => match dep_state {
            "ready" => (
                assignee
                    .as_deref()
                    .map_or("open".to_owned(), |_| "claimed".to_owned()),
                None,
                "task.cascade.unblocked",
            ),
            "failed" => (
                "cancelled".to_owned(),
                Some(format!(
                    "auto-cancelled: dependency state still contains failed/cancelled tasks after removing {dependency_task_id}"
                )),
                "task.cascade.cancelled",
            ),
            _ => (prior_status.clone(), None, "task.updated"),
        },
        "approval_required" => match dep_state {
            "failed" => (
                "cancelled".to_owned(),
                Some(format!(
                    "auto-cancelled: dependency state still contains failed/cancelled tasks after removing {dependency_task_id}"
                )),
                "task.cascade.cancelled",
            ),
            _ => (prior_status.clone(), None, "task.updated"),
        },
        _ => (prior_status.clone(), None, "task.updated"),
    };

    conn.execute(
        "UPDATE tasks
         SET depends_on = ?,
             status = ?,
             result = ?,
             updated_at = unixepoch(),
             changed_at = unixepoch() * 1000
         WHERE id = ?",
        params![next_dep_value, next_status, next_result, dependent_task_id],
    )
    .map_err(|err| format!("failed to write depends_on: {err}"))?;

    let payload = match event_type {
        "task.cascade.unblocked" => json!({
            "trigger": dependency_task_id,
            "status": next_status,
        }),
        "task.cascade.cancelled" => json!({
            "trigger": dependency_task_id,
            "reason": "dependency_failed",
        }),
        _ => json!({
            "status": next_status,
            "prior_status": prior_status,
            "removed_dependency": dependency_task_id,
        }),
    };

    emit_event(
        conn,
        &scope,
        event_type,
        None,
        Some(dependent_task_id),
        Some(payload),
    )?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Initialize a tmp `SQLite` with the subset of schema we need to test writes.
    /// Mirrors the DDL emitted by `src/db.ts` for the `messages` and
    /// `instances` tables.
    fn init_schema(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE instances (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL DEFAULT '',
                directory TEXT NOT NULL,
                root TEXT NOT NULL DEFAULT '',
                file_root TEXT NOT NULL DEFAULT '',
                pid INTEGER NOT NULL,
                label TEXT,
                registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
                heartbeat INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL DEFAULT '',
                sender TEXT NOT NULL,
                recipient TEXT,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                read INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                requester TEXT NOT NULL,
                assignee TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                files TEXT,
                result TEXT,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
                changed_at INTEGER NOT NULL DEFAULT 0,
                priority INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE context (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL DEFAULT '',
                instance_id TEXT NOT NULL,
                file TEXT NOT NULL,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            ",
        )
        .unwrap();
    }

    #[test]
    fn ensure_adopted_column_adds_missing_column() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);

        ensure_adopted_column(&conn).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('instances') WHERE name = 'adopted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);

        // Idempotent — second call should be a no-op.
        ensure_adopted_column(&conn).unwrap();
    }

    #[test]
    fn create_pending_instance_inserts_unadopted_row() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        let pending = create_pending_instance(
            &conn,
            "/tmp/workspace",
            Some("my-scope"),
            Some("role:planner launch:abc"),
            None,
        )
        .unwrap();

        assert_eq!(pending.scope, "my-scope");
        assert_eq!(pending.directory, "/tmp/workspace");
        assert_eq!(pending.file_root, "/tmp/workspace");

        let (pid, adopted, label): (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT pid, adopted, label FROM instances WHERE id = ?",
                params![pending.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(pid, 0, "pid=0 marks UI-owned pre-adoption state");
        assert_eq!(adopted, 0);
        assert_eq!(label.as_deref(), Some("role:planner launch:abc"));
    }

    #[test]
    fn heartbeat_unadopted_only_touches_unadopted_rows() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        // Insert an already-adopted row with a known heartbeat.
        conn.execute(
            "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, heartbeat, adopted)
             VALUES (?, 's', '/tmp', '/tmp', '/tmp', 1234, NULL, 1, 1)",
            params!["adopted-id"],
        )
        .unwrap();

        let updated = heartbeat_unadopted_instance(&conn, "adopted-id").unwrap();
        assert!(!updated, "adopted rows are skipped");

        // Unadopted row gets its heartbeat refreshed.
        let pending = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        // Stomp heartbeat to an old value so we can observe the bump.
        conn.execute(
            "UPDATE instances SET heartbeat = 100 WHERE id = ?",
            params![pending.id],
        )
        .unwrap();

        let updated = heartbeat_unadopted_instance(&conn, &pending.id).unwrap();
        assert!(updated);

        let heartbeat: i64 = conn
            .query_row(
                "SELECT heartbeat FROM instances WHERE id = ?",
                params![pending.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(heartbeat > 100, "heartbeat should be bumped to unixepoch()");
    }

    #[test]
    fn delete_unadopted_leaves_adopted_rows_alone() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        let pending = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        conn.execute(
            "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
             VALUES ('adopted', 's', '/tmp', '/tmp', '/tmp', 9, NULL, 1)",
            [],
        )
        .unwrap();

        let deleted = delete_unadopted_instance(&conn, &pending.id).unwrap();
        assert!(deleted, "unadopted row should be deleted");

        let deleted = delete_unadopted_instance(&conn, "adopted").unwrap();
        assert!(!deleted, "adopted rows are ignored");

        let still_there: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM instances WHERE id = 'adopted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_there, 1);
    }

    #[test]
    fn deregister_instance_cascades_cleanup() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        // Set up an instance with a lock, a claimed task, a blocked task,
        // and an incoming message. All of these should disappear/be
        // released when the instance is deregistered.
        conn.execute(
            "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
             VALUES ('inst', 's', '/tmp', '/tmp', '/tmp', 42, 'role:x', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO context (id, scope, instance_id, file, type, content)
             VALUES ('lock1', 's', 'inst', '/tmp/a.txt', 'lock', 'held')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
             VALUES ('t1', 's', 'implement', 'claimed', 'someone', 'inst', 'claimed')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
             VALUES ('t2', 's', 'implement', 'blocked', 'someone', 'inst', 'blocked')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (scope, sender, recipient, content)
             VALUES ('s', 'other', 'inst', 'queued')",
            [],
        )
        .unwrap();

        deregister_instance(&conn, "inst").unwrap();

        let instance_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM instances WHERE id = 'inst'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(instance_count, 0);

        let lock_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM context WHERE instance_id = 'inst'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(lock_count, 0);

        let msg_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages WHERE recipient = 'inst'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(msg_count, 0);

        let (t1_status, t1_assignee): (String, Option<String>) = conn
            .query_row("SELECT status, assignee FROM tasks WHERE id = 't1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(t1_status, "open", "claimed task should be released to open");
        assert_eq!(t1_assignee, None);

        let (t2_status, t2_assignee): (String, Option<String>) = conn
            .query_row("SELECT status, assignee FROM tasks WHERE id = 't2'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(t2_status, "blocked", "blocked task keeps status");
        assert_eq!(t2_assignee, None, "blocked task assignee cleared");
    }

    #[test]
    fn sweep_unadopted_orphans_removes_only_unadopted() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        // Two stale orphans + one adopted instance.
        let orphan_a = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        let orphan_b = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        let stale_heartbeat = now_secs() - INSTANCE_STALE_AFTER_SECS - 1;
        conn.execute(
            "UPDATE instances SET heartbeat = ? WHERE id IN (?, ?)",
            params![stale_heartbeat, orphan_a.id, orphan_b.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
             VALUES ('live', 's', '/tmp', '/tmp', '/tmp', 1, NULL, 1)",
            [],
        )
        .unwrap();

        let swept = sweep_unadopted_orphans(&conn).unwrap();
        assert_eq!(swept, 2);

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM instances")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["live".to_string()]);

        // Just for paranoia: both orphans are actually gone.
        assert!(!remaining.contains(&orphan_a.id));
        assert!(!remaining.contains(&orphan_b.id));
    }

    #[test]
    fn sweep_unadopted_orphans_keeps_recent_placeholders() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        let recent = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();

        let swept = sweep_unadopted_orphans(&conn).unwrap();
        assert_eq!(swept, 0);

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM instances WHERE id = ?",
                params![recent.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
    }

    #[test]
    fn instance_adoption_state_reports_states() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        let pending = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        assert_eq!(instance_adoption_state(&conn, &pending.id).unwrap(), Some(false));

        conn.execute(
            "UPDATE instances SET adopted = 1 WHERE id = ?",
            params![pending.id],
        )
        .unwrap();
        assert_eq!(instance_adoption_state(&conn, &pending.id).unwrap(), Some(true));

        assert_eq!(instance_adoption_state(&conn, "missing").unwrap(), None);
    }

    #[test]
    fn deregister_instance_refreshes_planner_owner() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        conn.execute(
            "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted)
             VALUES
             ('planner-a', 's', '/tmp', '/tmp', '/tmp', 1, 'role:planner', 1),
             ('planner-b', 's', '/tmp', '/tmp', '/tmp', 2, 'role:planner', 1)",
            [],
        )
        .unwrap();
        kv_set_value(
            &conn,
            "s",
            PLANNER_OWNER_KEY,
            &json!({
                "instance_id": "planner-a",
                "label": "role:planner",
                "assigned_at": 1,
            })
            .to_string(),
        )
        .unwrap();

        deregister_instance(&conn, "planner-a").unwrap();

        let owner = kv_get_value(&conn, "s", PLANNER_OWNER_KEY)
            .unwrap()
            .expect("owner/planner should be reassigned");
        let parsed: Value = serde_json::from_str(&owner).unwrap();
        assert_eq!(
            parsed.get("instance_id").and_then(Value::as_str),
            Some("planner-b")
        );
    }

    #[test]
    fn unassign_task_releases_claimed_work() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        conn.execute(
            "INSERT INTO tasks (id, scope, type, title, requester, assignee, status)
             VALUES ('task-1', 's', 'implement', 'claimed', 'planner', 'worker-1', 'claimed')",
            [],
        )
        .unwrap();

        let changed = unassign_task(&conn, "task-1").unwrap();
        assert!(changed);

        let (status, assignee): (String, Option<String>) = conn
            .query_row(
                "SELECT status, assignee FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "open");
        assert_eq!(assignee, None);
    }

    #[test]
    fn remove_task_dependency_recomputes_blocked_and_approval_required_tasks() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn);
        ensure_adopted_column(&conn).unwrap();

        conn.execute(
            "INSERT INTO tasks (id, scope, type, title, requester, status)
             VALUES
             ('dep-ready', 's', 'implement', 'dep ready', 'planner', 'done'),
             ('dep-failed', 's', 'implement', 'dep failed', 'planner', 'failed')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, scope, type, title, requester, status, depends_on)
             VALUES
             ('blocked-task', 's', 'implement', 'blocked', 'planner', 'blocked', ?),
             ('approval-task', 's', 'review', 'approval', 'planner', 'approval_required', ?)",
            params![
                serde_json::to_string(&vec!["dep-ready"]).unwrap(),
                serde_json::to_string(&vec!["dep-ready", "dep-failed"]).unwrap(),
            ],
        )
        .unwrap();

        let changed = remove_task_dependency(&conn, "blocked-task", "dep-ready").unwrap();
        assert!(changed);
        let changed = remove_task_dependency(&conn, "approval-task", "dep-ready").unwrap();
        assert!(changed);

        let (blocked_status, blocked_depends_on): (String, Option<String>) = conn
            .query_row(
                "SELECT status, depends_on FROM tasks WHERE id = 'blocked-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(blocked_status, "open");
        assert_eq!(blocked_depends_on, None);

        let (approval_status, approval_result, approval_depends_on): (
            String,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT status, result, depends_on FROM tasks WHERE id = 'approval-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(approval_status, "cancelled");
        assert!(
            approval_result
                .as_deref()
                .unwrap_or_default()
                .contains("auto-cancelled"),
        );
        assert_eq!(
            approval_depends_on,
            Some(serde_json::to_string(&vec!["dep-failed"]).unwrap())
        );
    }
}
