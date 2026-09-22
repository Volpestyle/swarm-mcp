import type { Sqlite } from "./sqlite";
import { CoordinationError } from "./errors";

// A separate application identity prevents accidental adoption of legacy swarm.db.
export const APPLICATION_ID = 0x53574d32;
export const SCHEMA_VERSION = 1;
export type FaultPoint =
  | "before_migration_commit"
  | "before_command_commit"
  | "after_command_commit";
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
  checkIdentity(db);
  // journal_mode is outside the migration transaction; the application identity,
  // DDL and version are committed together. FULL durability is not negotiable.
  db.exec("PRAGMA journal_mode = WAL");
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
