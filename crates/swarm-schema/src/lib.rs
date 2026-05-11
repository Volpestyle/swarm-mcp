use rusqlite::{Connection, OptionalExtension};

pub const SWARM_DB_VERSION: i32 = 1;
pub const BOOTSTRAP_SQL: &str = include_str!("../../../sql/swarm_db_bootstrap.sql");
pub const FINALIZE_SQL: &str = include_str!("../../../sql/swarm_db_finalize.sql");

pub const EXPECTED_TABLES: &[&str] = &[
    "instances",
    "messages",
    "tasks",
    "context",
    "events",
    "kv",
    "kv_scope_updates",
    "ui_commands",
];

const COLUMN_MIGRATIONS: &[(&str, &str)] = &[
    ("instances", "scope TEXT NOT NULL DEFAULT ''"),
    ("instances", "root TEXT NOT NULL DEFAULT ''"),
    ("instances", "file_root TEXT NOT NULL DEFAULT ''"),
    ("instances", "adopted INTEGER NOT NULL DEFAULT 1"),
    ("messages", "scope TEXT NOT NULL DEFAULT ''"),
    ("tasks", "scope TEXT NOT NULL DEFAULT ''"),
    ("tasks", "changed_at INTEGER NOT NULL DEFAULT 0"),
    ("tasks", "priority INTEGER NOT NULL DEFAULT 0"),
    ("tasks", "depends_on TEXT"),
    ("tasks", "idempotency_key TEXT"),
    ("tasks", "parent_task_id TEXT"),
    ("tasks", "review_of_task_id TEXT"),
    ("tasks", "fixes_task_id TEXT"),
    ("tasks", "progress_summary TEXT"),
    ("tasks", "progress_updated_at INTEGER"),
    ("tasks", "blocked_reason TEXT"),
    ("tasks", "expected_next_update_at INTEGER"),
    ("context", "scope TEXT NOT NULL DEFAULT ''"),
    ("context", "task_id TEXT"),
];

/// Create or migrate `swarm.db`, then validate its embedded schema version.
///
/// # Errors
///
/// Returns an error when the live database is newer than this crate supports,
/// the database rejects bootstrap/finalize statements, a legacy column migration
/// fails, or the final schema validation does not match expectations.
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    let live_version = user_version(conn)?;
    if live_version > SWARM_DB_VERSION {
        return Err(format!(
            "swarm.db schema version {live_version} is newer than this binary supports ({SWARM_DB_VERSION})"
        ));
    }

    conn.execute_batch(BOOTSTRAP_SQL)
        .map_err(|err| format!("failed to bootstrap swarm.db schema: {err}"))?;

    ensure_columns(conn)?;
    rebuild_kv_table(conn)?;

    conn.execute_batch(FINALIZE_SQL)
        .map_err(|err| format!("failed to finalize swarm.db schema: {err}"))?;

    set_user_version(conn, SWARM_DB_VERSION)?;
    validate_schema(conn)
}

/// Validate that the live database matches this crate's embedded schema version.
///
/// # Errors
///
/// Returns an error when `PRAGMA user_version` differs from
/// [`SWARM_DB_VERSION`] or any expected table is missing.
pub fn validate_schema(conn: &Connection) -> Result<(), String> {
    let live_version = user_version(conn)?;
    if live_version != SWARM_DB_VERSION {
        return Err(format!(
            "swarm.db schema version {live_version} does not match this binary's embedded version {SWARM_DB_VERSION}"
        ));
    }

    for table in EXPECTED_TABLES {
        if !table_exists(conn, table)? {
            return Err(format!("swarm.db is missing required table `{table}`"));
        }
    }

    Ok(())
}

/// Read the database's `PRAGMA user_version` value.
///
/// # Errors
///
/// Returns an error when the database cannot read the pragma value.
pub fn user_version(conn: &Connection) -> Result<i32, String> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|err| format!("failed to read PRAGMA user_version: {err}"))
}

fn set_user_version(conn: &Connection, version: i32) -> Result<(), String> {
    conn.pragma_update(None, "user_version", version)
        .map_err(|err| format!("failed to set PRAGMA user_version: {err}"))
}

fn ensure_columns(conn: &Connection) -> Result<(), String> {
    for (table, spec) in COLUMN_MIGRATIONS {
        add_column_if_missing(conn, table, spec)?;
    }
    Ok(())
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

fn rebuild_kv_table(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "kv")? || column_exists(conn, "kv", "scope")? {
        return Ok(());
    }

    conn.execute_batch(
        r"
        CREATE TABLE kv_next (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (scope, key)
        );
        INSERT INTO kv_next (scope, key, value, updated_at)
        SELECT '', key, value, updated_at
        FROM kv;
        DROP TABLE kv;
        ALTER TABLE kv_next RENAME TO kv;
        ",
    )
    .map_err(|err| format!("failed to rebuild kv table: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_schema_creates_expected_tables_and_version() {
        let conn = Connection::open_in_memory().unwrap();

        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();

        assert_eq!(user_version(&conn).unwrap(), SWARM_DB_VERSION);
        for table in EXPECTED_TABLES {
            assert!(table_exists(&conn, table).unwrap(), "{table} should exist");
        }
    }

    #[test]
    fn ensure_schema_rejects_newer_database() {
        let conn = Connection::open_in_memory().unwrap();
        set_user_version(&conn, SWARM_DB_VERSION + 1).unwrap();

        let err = ensure_schema(&conn).unwrap_err();
        assert!(err.contains("newer than this binary supports"));
    }
}
