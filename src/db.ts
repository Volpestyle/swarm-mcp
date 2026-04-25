import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import bootstrapAsset from "../sql/swarm_db_bootstrap.sql";
import finalizeAsset from "../sql/swarm_db_finalize.sql";

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

function loadSql(asset: string) {
  if (asset.includes("\n") || asset.includes("CREATE TABLE")) return asset;
  return readFileSync(asset, "utf8");
}

const bootstrapSql = loadSql(bootstrapAsset);
const finalizeSql = loadSql(finalizeAsset);
const SWARM_DB_VERSION = (() => {
  const match = bootstrapSql.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i);
  if (!match) throw new Error("swarm DB bootstrap SQL is missing PRAGMA user_version");
  return Number(match[1]);
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

const COLUMN_MIGRATIONS = [
  ["instances", "scope TEXT NOT NULL DEFAULT ''"],
  ["instances", "root TEXT NOT NULL DEFAULT ''"],
  ["instances", "file_root TEXT NOT NULL DEFAULT ''"],
  ["instances", "adopted INTEGER NOT NULL DEFAULT 1"],
  ["messages", "scope TEXT NOT NULL DEFAULT ''"],
  ["tasks", "scope TEXT NOT NULL DEFAULT ''"],
  ["tasks", "changed_at INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "priority INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "depends_on TEXT"],
  ["tasks", "idempotency_key TEXT"],
  ["tasks", "parent_task_id TEXT"],
  ["context", "scope TEXT NOT NULL DEFAULT ''"],
] as const;

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

function userVersion() {
  const row = db.query("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

function ensureCompatibleVersion() {
  const live = userVersion();
  if (live > SWARM_DB_VERSION) {
    throw new Error(
      `swarm.db schema version ${live} is newer than this MCP server supports (${SWARM_DB_VERSION})`,
    );
  }
}

function rebuildKv() {
  if (!table("kv")) return;

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

db.exec("PRAGMA busy_timeout = 3000");
ensureCompatibleVersion();
db.exec(bootstrapSql);

for (const [tableName, spec] of COLUMN_MIGRATIONS) add(tableName, spec);
rebuildKv();
db.exec(finalizeSql);
db.exec(`PRAGMA user_version = ${SWARM_DB_VERSION}`);
