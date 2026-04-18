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

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use uuid::Uuid;

use crate::swarm::swarm_db_path;

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
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("failed to open swarm db rw at {}: {err}", path.display()))?;

    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|err| format!("failed to set busy_timeout: {err}"))?;

    Ok(conn)
}

/// Ensure the `instances.adopted` column exists on the shared swarm.db.
///
/// The Bun-side `src/db.ts` adds this column at startup, but swarm-ui can
/// launch before any MCP client has ever opened the DB. Running an
/// idempotent ALTER here guarantees the column is present before any write
/// that references it.
pub fn ensure_adopted_column(conn: &Connection) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info('instances') WHERE name = 'adopted'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| format!("failed to inspect instances schema: {err}"))?
        .is_some();

    if !exists {
        conn.execute(
            "ALTER TABLE instances ADD COLUMN adopted INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .map_err(|err| format!("failed to add adopted column: {err}"))?;
    }

    Ok(())
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

    tx.commit()
        .map_err(|err| format!("failed to commit deregister tx: {err}"))?;

    Ok(())
}

/// Delete every unadopted instance row. Called once at UI startup to
/// clear ghost placeholders left behind by a prior UI session that died
/// before its PTY children finished adopting.
///
/// This runs BEFORE any new PTY is spawned in the new UI session, so no
/// in-flight pre-created rows are at risk. Returns the number of rows
/// removed for logging.
pub fn sweep_unadopted_orphans(conn: &Connection) -> Result<usize, String> {
    // Collect ids first so we can cascade tasks/locks/messages per id.
    let mut stmt = conn
        .prepare("SELECT id FROM instances WHERE adopted = 0")
        .map_err(|err| format!("failed to prepare orphan sweep query: {err}"))?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|err| format!("failed to query orphans: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read orphan ids: {err}"))?;
    drop(stmt);

    for id in &ids {
        deregister_instance(conn, id)?;
    }

    Ok(ids.len())
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
    Ok(deleted)
}

/// Unassign a task — clears `assignee` and resets `status` to `open` if it
/// was claimed/in-progress. Mirrors the per-instance release logic in
/// `deregister_instance` but scoped to one task. Returns `true` if a row
/// was modified.
pub fn unassign_task(conn: &Connection, task_id: &str) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE tasks
             SET assignee = NULL,
                 status = CASE
                     WHEN status IN ('claimed', 'in_progress') THEN 'open'
                     ELSE status
                 END,
                 updated_at = unixepoch(),
                 changed_at = unixepoch() * 1000
             WHERE id = ?",
            params![task_id],
        )
        .map_err(|err| format!("failed to unassign task: {err}"))?;
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
    let raw: Option<String> = conn
        .query_row(
            "SELECT depends_on FROM tasks WHERE id = ?",
            params![dependent_task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to load depends_on: {err}"))?
        .flatten();

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

    let next = serde_json::to_string(&ids)
        .map_err(|err| format!("failed to serialize depends_on: {err}"))?;

    conn.execute(
        "UPDATE tasks
         SET depends_on = ?,
             updated_at = unixepoch(),
             changed_at = unixepoch() * 1000
         WHERE id = ?",
        params![next, dependent_task_id],
    )
    .map_err(|err| format!("failed to write depends_on: {err}"))?;

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

        // Two orphans + one adopted instance.
        let orphan_a = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
        let orphan_b = create_pending_instance(&conn, "/tmp", Some("s"), None, None).unwrap();
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
}
