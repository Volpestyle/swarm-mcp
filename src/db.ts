import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const path =
  process.env.SWARM_DB_PATH ?? join(homedir(), ".swarm-mcp", "swarm.db");
mkdirSync(dirname(path), { recursive: true });

export const db = new Database(path);

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
    heartbeat INTEGER NOT NULL DEFAULT (unixepoch())
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
add("messages", "scope TEXT NOT NULL DEFAULT ''");
add("tasks", "scope TEXT NOT NULL DEFAULT ''");
add("tasks", "changed_at INTEGER NOT NULL DEFAULT 0");
add("context", "scope TEXT NOT NULL DEFAULT ''");

rebuildKv();

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
