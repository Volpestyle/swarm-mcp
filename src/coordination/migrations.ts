import type { Sqlite } from "./sqlite";
import { CoordinationError } from "./errors";

// A separate application identity prevents accidental adoption of legacy swarm.db.
export const APPLICATION_ID = 0x53574d32;
export const SCHEMA_VERSION = 14;
export type FaultPoint =
  | "before_migration_commit"
  | "before_command_commit"
  | "after_command_commit"
  | "before_batch_commit"
  | "after_batch_commit";
export type FaultHook = (point: FaultPoint) => void;

const migrations = [
  `CREATE TABLE commands (
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
  CREATE INDEX tasks_scope_id ON tasks(scope, id);`,
  `CREATE TABLE inbox_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, sender TEXT NOT NULL, envelope_version INTEGER NOT NULL CHECK(envelope_version=1),
    kind TEXT NOT NULL, body TEXT NOT NULL, task_id TEXT, thread_id TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER, idempotency_key TEXT NOT NULL,
    audience TEXT NOT NULL CHECK(audience IN ('direct','announcement')),
    max_attempts INTEGER NOT NULL CHECK(max_attempts>0), backoff_ms INTEGER NOT NULL,
    UNIQUE(scope,sender,idempotency_key)
  );
  CREATE TABLE inbox_deliveries (
    message_id TEXT NOT NULL REFERENCES inbox_messages(id), recipient TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','leased','acknowledged','expired','dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0, consumer TEXT, lease_token TEXT, lease_until INTEGER,
    next_attempt_at INTEGER NOT NULL, acknowledged_at INTEGER, last_error TEXT,
    PRIMARY KEY(message_id,recipient)
  );
  CREATE INDEX inbox_messages_scope_seq ON inbox_messages(scope,seq);
  CREATE INDEX inbox_recipient_state ON inbox_deliveries(recipient,state,next_attempt_at);`,
  `CREATE TABLE agents (
    scope TEXT NOT NULL, id TEXT NOT NULL, resume_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0), label TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(scope,id)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0), capability_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('active','suspended','superseded','closed')),
    runtime_state TEXT NOT NULL CHECK(runtime_state IN ('available','busy','unavailable')),
    transport_at INTEGER, runtime_at INTEGER, progress_at INTEGER,
    created_at INTEGER NOT NULL, ended_at INTEGER,
    FOREIGN KEY(scope,agent_id) REFERENCES agents(scope,id),
    UNIQUE(scope,agent_id,generation)
  );
  CREATE INDEX sessions_actor ON sessions(scope,agent_id,generation);`,
  `CREATE TABLE tasks_next (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','blocked','running','cancel_requested','cancelled','failed','completed')),
    version INTEGER NOT NULL CHECK(version>0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    current_attempt TEXT, attempt_counter INTEGER NOT NULL DEFAULT 0, result TEXT, reason TEXT
  );
  INSERT INTO tasks_next(id,scope,creator,title,status,version,created_at,updated_at)
    SELECT id,scope,creator,title,CASE status WHEN 'done' THEN 'completed' ELSE status END,version,created_at,updated_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_next RENAME TO tasks;
  CREATE INDEX tasks_scope_id ON tasks(scope,id);
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(task_id,dependency_id), CHECK(task_id<>dependency_id)
  );
  CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), actor TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL,
    fence INTEGER NOT NULL CHECK(fence>0), lease_until INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','abandoned')),
    created_at INTEGER NOT NULL, ended_at INTEGER, progress_at INTEGER, result TEXT, reason TEXT,
    UNIQUE(task_id,fence)
  );
  CREATE UNIQUE INDEX task_one_running_attempt ON task_attempts(task_id) WHERE state='running';`,
  `ALTER TABLE sessions ADD COLUMN worktree_root TEXT;
  ALTER TABLE sessions ADD COLUMN repository_root TEXT;
  CREATE TABLE reservations (
    fence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','integration')),
    resource TEXT NOT NULL, logical_path TEXT NOT NULL, repository TEXT NOT NULL, worktree TEXT NOT NULL,
    actor TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL,
    attempt_id TEXT REFERENCES task_attempts(id), reason TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','released','expired','superseded')),
    ended_at INTEGER
  );
  CREATE UNIQUE INDEX reservation_owner ON reservations(scope,kind,resource) WHERE state='active';
  CREATE INDEX reservation_logical ON reservations(scope,repository,logical_path,state);`,
  `CREATE TABLE shared_kv (
    scope TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
    value TEXT, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
    author TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY(scope,key)
  );
  CREATE TABLE shared_kv_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, key TEXT NOT NULL,
    version INTEGER NOT NULL, value TEXT, deleted INTEGER NOT NULL,
    author TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
    UNIQUE(scope,key,version)
  );
  CREATE INDEX shared_history_scope_key ON shared_kv_history(scope,key,seq);`,
  `ALTER TABLE tasks ADD COLUMN expires_at INTEGER;
  CREATE TABLE artifacts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
    digest TEXT NOT NULL, bytes INTEGER NOT NULL, summary TEXT NOT NULL, media_type TEXT NOT NULL,
    author TEXT NOT NULL, source_path TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER
  );
  CREATE INDEX artifact_scope_cursor ON artifacts(scope,seq);
  CREATE TABLE findings (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('result','decision','annotation')), summary TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id), attempt_id TEXT REFERENCES task_attempts(id),
    author TEXT NOT NULL, session_id TEXT, revision TEXT NOT NULL, files TEXT NOT NULL,
    verification TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER
  );
  CREATE TABLE finding_artifacts (
    finding_id TEXT NOT NULL REFERENCES findings(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    PRIMARY KEY(finding_id,artifact_id)
  );
  CREATE INDEX finding_scope_task ON findings(scope,task_id,seq);`,
  `ALTER TABLE tasks ADD COLUMN contract TEXT;`,
  `CREATE TABLE dispatch_intents (
    scope TEXT NOT NULL, intent_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), route_id TEXT NOT NULL,
    path TEXT NOT NULL CHECK(path IN ('native','peer')),
    state TEXT NOT NULL CHECK(state IN ('reserved','provisioning','bound','released')),
    creator TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(scope,intent_id)
  );
  CREATE INDEX dispatch_capacity ON dispatch_intents(scope,state,route_id);`,
  `ALTER TABLE dispatch_intents ADD COLUMN provision_token TEXT;
  ALTER TABLE dispatch_intents ADD COLUMN external_id TEXT;
  ALTER TABLE dispatch_intents ADD COLUMN worker_session TEXT;
  ALTER TABLE dispatch_intents ADD COLUMN attempt_id TEXT;
  ALTER TABLE dispatch_intents ADD COLUMN fence INTEGER;`,
  `CREATE TABLE legacy_imports (
    id TEXT PRIMARY KEY, snapshot_hash TEXT NOT NULL, plan TEXT NOT NULL,
    imported_at INTEGER NOT NULL, summary TEXT NOT NULL
  );
  CREATE TABLE legacy_records (
    import_id TEXT NOT NULL REFERENCES legacy_imports(id), source_table TEXT NOT NULL,
    ordinal INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(import_id,source_table,ordinal)
  );`,
  `ALTER TABLE inbox_deliveries ADD COLUMN recipient_generation INTEGER
    CHECK(recipient_generation IS NULL OR recipient_generation > 0);`,
  `ALTER TABLE inbox_messages ADD COLUMN sender_generation INTEGER
    CHECK(sender_generation IS NULL OR sender_generation > 0);`,
  `ALTER TABLE task_attempts ADD COLUMN progress_timeout_ms INTEGER NOT NULL DEFAULT 900000
    CHECK(progress_timeout_ms BETWEEN 60000 AND 86400000);
   ALTER TABLE commands ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE commands ADD COLUMN type TEXT;
   ALTER TABLE artifacts ADD COLUMN collected_at INTEGER;
   CREATE TABLE event_retention (scope TEXT PRIMARY KEY, floor INTEGER NOT NULL);
   CREATE INDEX command_retention ON commands(created_at);`,
];

function version(db: Sqlite): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}

function checkIdentity(db: Sqlite) {
  const id = (
    db.prepare("PRAGMA application_id").get() as { application_id: number }
  ).application_id;
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (
    id !== APPLICATION_ID &&
    (id !== 0 || tables.length || version(db) !== 0)
  ) {
    throw new CoordinationError(
      "incompatible_database",
      "Not a coordinator database; migrate a copy explicitly instead of opening the legacy database",
    );
  }
  if (version(db) > SCHEMA_VERSION) {
    throw new CoordinationError(
      "newer_schema",
      `Database schema ${version(db)} exceeds supported version ${SCHEMA_VERSION}`,
    );
  }
}

export function migrate(db: Sqlite, fault?: FaultHook) {
  db.exec("PRAGMA busy_timeout = 5000");
  // The ID, schema tables and version must come from one read snapshot. A
  // concurrent first startup can commit between these reads before we own the
  // writer lock; mixing the old ID with new tables falsely rejects our database.
  db.exec("BEGIN");
  try {
    checkIdentity(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // journal_mode is outside the migration transaction; the application identity,
  // DDL and version are committed together. FULL durability is not negotiable.
  // Concurrent journal-mode upgrades can return BUSY without invoking SQLite's
  // busy handler. Retry outside a transaction, bounded by the same timeout.
  const deadline = performance.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (error) {
      if (
        (error as { code?: string })?.code !== "SQLITE_BUSY" ||
        performance.now() >= deadline
      ) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    checkIdentity(db); // Another process may have migrated while this one waited.
    const current = version(db);
    for (let index = current; index < migrations.length; index++)
      db.exec(migrations[index]!);
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    fault?.("before_migration_commit");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
