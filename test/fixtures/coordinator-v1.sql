CREATE TABLE commands (
    scope TEXT NOT NULL, actor TEXT NOT NULL, command_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, result TEXT NOT NULL, cursor INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, actor, command_id)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
    actor TEXT NOT NULL, type TEXT NOT NULL, entity_id TEXT NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX events_scope_cursor ON events(scope, id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','running','done','failed','cancelled')),
    version INTEGER NOT NULL CHECK(version > 0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_scope_id ON tasks(scope, id);
PRAGMA application_id=0x53574d32;
PRAGMA user_version=1;
