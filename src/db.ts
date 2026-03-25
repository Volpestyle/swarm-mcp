import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const dir = join(homedir(), ".opencode");
mkdirSync(dir, { recursive: true });

const path = join(dir, "swarm.db");
export const db = new Database(path);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 3000");
db.exec("PRAGMA auto_vacuum = INCREMENTAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    pid INTEGER NOT NULL,
    label TEXT,
    registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
    heartbeat INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    read INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    requester TEXT NOT NULL,
    assignee TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    files TEXT,
    result TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS context (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    file TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages(recipient, read)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS instances_heartbeat_idx ON instances(heartbeat)",
);
db.exec("CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)");
db.exec("CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee)");
db.exec("CREATE INDEX IF NOT EXISTS context_file_idx ON context(file)");
