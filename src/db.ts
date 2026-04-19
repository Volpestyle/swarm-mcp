import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const path =
  process.env.SWARM_DB_PATH ?? join(homedir(), ".swarm-mcp", "swarm.db");
mkdirSync(dirname(path), { recursive: true });

// Runtime-pick the SQLite driver. Bun uses its built-in `bun:sqlite` (fast, no
// native build). Node uses `better-sqlite3` (N-API native module). Both expose
// a near-identical API which we thinly wrap below.
const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";

type Statement = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
};

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  transaction: <T>(fn: () => T) => () => T;
};

const raw: RawDb = await (async () => {
  if (isBun) {
    // bun:sqlite only resolves under the Bun runtime; esbuild leaves it alone
    // via --packages=external, and Node never reaches this branch.
    const { Database } = await import("bun:sqlite");
    return new Database(path) as unknown as RawDb;
  }
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  return new BetterSqlite3(path) as unknown as RawDb;
})();

export const db = {
  exec(sql: string) {
    raw.exec(sql);
  },
  query(sql: string) {
    return raw.prepare(sql);
  },
  run(sql: string, params: unknown[] = []) {
    return raw.prepare(sql).run(...params);
  },
  transaction<T>(fn: () => T) {
    return raw.transaction(fn);
  },
};

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 3000");
db.exec("PRAGMA auto_vacuum = INCREMENTAL");

db.exec(`
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
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT '',
    sender TEXT NOT NULL,
    recipient TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    read INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
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
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS context (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT '',
    instance_id TEXT NOT NULL,
    file TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Append-only audit log of every state-changing primitive call. Lets the
// UI render an activity timeline and lets cascades (auto-unblock,
// auto-cancel, stale-reclaim) be distinguished from user-driven changes
// after the fact.
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT,
    subject TEXT,
    payload TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`
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
  )
`);

function cols(table: string) {
  return db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
}

function has(table: string, col: string) {
  return cols(table).some((item) => item.name === col);
}

function add(table: string, spec: string) {
  const name = spec.trim().split(/\s+/)[0];
  if (has(table, name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${spec}`);
}

function table(name: string) {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | null;
  return !!row;
}

function rebuildKv() {
  if (!table("kv")) {
    db.exec(`
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (scope, key)
      )
    `);
    return;
  }

  if (has("kv", "scope")) return;

  db.exec(`
    CREATE TABLE kv_next (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (scope, key)
    )
  `);
  db.exec(`
    INSERT INTO kv_next (scope, key, value, updated_at)
    SELECT '', key, value, updated_at
    FROM kv
  `);
  db.exec("DROP TABLE kv");
  db.exec("ALTER TABLE kv_next RENAME TO kv");
}

add("instances", "scope TEXT NOT NULL DEFAULT ''");
add("instances", "root TEXT NOT NULL DEFAULT ''");
add("instances", "file_root TEXT NOT NULL DEFAULT ''");
add("instances", "adopted INTEGER NOT NULL DEFAULT 1");
add("messages", "scope TEXT NOT NULL DEFAULT ''");
add("tasks", "scope TEXT NOT NULL DEFAULT ''");
add("tasks", "changed_at INTEGER NOT NULL DEFAULT 0");
add("tasks", "priority INTEGER NOT NULL DEFAULT 0");
add("tasks", "depends_on TEXT");
add("tasks", "idempotency_key TEXT");
add("tasks", "parent_task_id TEXT");
add("context", "scope TEXT NOT NULL DEFAULT ''");

rebuildKv();

db.exec(`
  CREATE TABLE IF NOT EXISTS kv_scope_updates (
    scope TEXT PRIMARY KEY,
    changed_at INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  INSERT INTO kv_scope_updates (scope, changed_at)
  SELECT scope, MAX(updated_at) * 1000
  FROM kv
  GROUP BY scope
  ON CONFLICT(scope) DO NOTHING
`);

db.run("UPDATE instances SET scope = directory WHERE scope = ''");
db.run("UPDATE instances SET root = directory WHERE root = ''");
db.run("UPDATE instances SET file_root = directory WHERE file_root = ''");
db.run("UPDATE tasks SET changed_at = updated_at * 1000 WHERE changed_at = 0");

db.exec(
  "CREATE INDEX IF NOT EXISTS messages_scope_recipient_read_idx ON messages(scope, recipient, read, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at)",
);
db.exec("CREATE INDEX IF NOT EXISTS instances_scope_idx ON instances(scope)");
db.exec(
  "CREATE INDEX IF NOT EXISTS instances_heartbeat_idx ON instances(heartbeat)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS tasks_scope_status_idx ON tasks(scope, status)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS tasks_scope_assignee_idx ON tasks(scope, assignee)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS tasks_scope_changed_at_idx ON tasks(scope, changed_at)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS context_scope_file_idx ON context(scope, file)",
);
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS context_lock_idx ON context(scope, file) WHERE type = 'lock'",
);
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key_idx ON tasks(scope, idempotency_key) WHERE idempotency_key IS NOT NULL",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS events_scope_id_idx ON events(scope, id)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS ui_commands_scope_status_id_idx ON ui_commands(scope, status, id)",
);
