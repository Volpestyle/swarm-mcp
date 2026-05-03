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

CREATE TABLE IF NOT EXISTS browser_contexts (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_instance_id TEXT,
  endpoint TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  profile_dir TEXT NOT NULL,
  pid INTEGER,
  start_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (scope, id)
);

CREATE TABLE IF NOT EXISTS browser_tabs (
  scope TEXT NOT NULL,
  context_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'page',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (scope, context_id, tab_id)
);

CREATE TABLE IF NOT EXISTS browser_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  context_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  elements_json TEXT NOT NULL DEFAULT '[]',
  screenshot_path TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
