PRAGMA journal_mode = WAL;
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA user_version = 1;

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
  changed_at INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT,
  idempotency_key TEXT,
  parent_task_id TEXT,
  review_of_task_id TEXT,
  fixes_task_id TEXT,
  progress_summary TEXT,
  progress_updated_at INTEGER,
  blocked_reason TEXT,
  expected_next_update_at INTEGER,
  tracker_required INTEGER NOT NULL DEFAULT 0,
  tracker_provider TEXT
);

CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  file TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  task_id TEXT,
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
  owner_identity TEXT,
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  claimed_by TEXT,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (status = 'pending' OR claimed_by IS NOT NULL),
  CHECK (status != 'pending' OR started_at IS NULL),
  CHECK (status NOT IN ('done', 'failed') OR completed_at IS NOT NULL)
);
