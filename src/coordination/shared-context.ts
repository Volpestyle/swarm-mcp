import { CoordinationError, requireText } from "./errors";
import type { Sqlite } from "./sqlite";
import type { Command, Json } from "./store";
export type SharedContextCommand =
  | {
      id: string;
      type: "kv.set";
      payload: {
        key: string;
        value: Json;
        expectedVersion: number;
        ttlMs?: number;
      };
    }
  | {
      id: string;
      type: "kv.append";
      payload: { key: string; value: Json; expectedVersion?: number };
    }
  | {
      id: string;
      type: "kv.delete";
      payload: { key: string; expectedVersion: number };
    };
type Row = {
  scope: string;
  key: string;
  version: number;
  value: string | null;
  deleted: number;
  author: string;
  updated_at: number;
  expires_at: number | null;
  seq?: number;
};
function version(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new CoordinationError(
      "invalid_input",
      "expectedVersion must be a nonnegative integer",
    );
}
function page(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CoordinationError("invalid_input", "Page limit must be 1..100");
}
function present(row: Row, now: number) {
  const status = row.deleted
    ? "deleted"
    : row.expires_at !== null && row.expires_at <= now
      ? "expired"
      : "live";
  return {
    key: row.key,
    version: row.version,
    status,
    value:
      status === "live" && row.value !== null
        ? (JSON.parse(row.value) as Json)
        : null,
    author: row.author,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
export function readShared(
  db: Sqlite,
  scope: string,
  key: string,
  now: number,
) {
  requireText(key, "key");
  const row = db
    .prepare("SELECT * FROM shared_kv WHERE scope=? AND key=?")
    .get(scope, key) as Row | undefined;
  return row
    ? present(row, now)
    : {
        key,
        version: 0,
        status: "missing",
        value: null,
        author: null,
        updatedAt: null,
        expiresAt: null,
      };
}
export function listShared(
  db: Sqlite,
  scope: string,
  now: number,
  prefix = "",
  after = "",
  limit = 50,
) {
  page(limit);
  if (
    typeof prefix !== "string" ||
    prefix.length > 256 ||
    typeof after !== "string" ||
    after.length > 256
  )
    throw new CoordinationError(
      "invalid_input",
      "Invalid key prefix or cursor",
    );
  const rows = db
    .prepare(
      "SELECT * FROM shared_kv WHERE scope=? AND substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?",
    )
    .all(scope, prefix.length, prefix, after, limit) as Row[];
  return {
    items: rows.map((row) => present(row, now)),
    cursor: rows.at(-1)?.key ?? after,
  };
}
export function sharedHistory(
  db: Sqlite,
  scope: string,
  key: string,
  now: number,
  after = 0,
  limit = 50,
) {
  requireText(key, "key");
  page(limit);
  if (!Number.isSafeInteger(after) || after < 0)
    throw new CoordinationError("invalid_input", "Invalid history cursor");
  const rows = db
    .prepare(
      "SELECT * FROM shared_kv_history WHERE scope=? AND key=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .all(scope, key, after, limit) as Row[];
  return {
    items: rows.map((row) => ({ ...present(row, now), cursor: row.seq! })),
    cursor: rows.at(-1)?.seq ?? after,
  };
}
export class SharedContextTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}
  private row(key: string) {
    requireText(key, "key");
    return this.db
      .prepare("SELECT * FROM shared_kv WHERE scope=? AND key=?")
      .get(this.command.scope, key) as Row | undefined;
  }
  private expected(row: Row | undefined, expected: number) {
    version(expected);
    if ((row?.version ?? 0) !== expected)
      throw new CoordinationError(
        "version_conflict",
        "Shared value changed; read its current version before retrying",
      );
  }
  private write(
    key: string,
    value: Json,
    prior: Row | undefined,
    expiresAt: number | null,
    deleted = false,
  ) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 8192)
      throw new CoordinationError(
        "payload_too_large",
        "Shared values are limited to 8 KiB; store a concise artifact reference instead",
      );
    const next = (prior?.version ?? 0) + 1,
      stored = deleted ? null : encoded;
    this.db
      .prepare(
        "INSERT INTO shared_kv(scope,key,version,value,deleted,author,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET version=excluded.version,value=excluded.value,deleted=excluded.deleted,author=excluded.author,updated_at=excluded.updated_at,expires_at=excluded.expires_at",
      )
      .run(
        this.command.scope,
        key,
        next,
        stored,
        deleted ? 1 : 0,
        this.command.actor,
        this.at,
        expiresAt,
      );
    this.db
      .prepare(
        "INSERT INTO shared_kv_history(scope,key,version,value,deleted,author,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        this.command.scope,
        key,
        next,
        stored,
        deleted ? 1 : 0,
        this.command.actor,
        this.at,
        expiresAt,
      );
    this.change(deleted ? "context.deleted" : "context.updated", key, {
      version: next,
      expiresAt,
    });
    return present(this.row(key)!, this.at);
  }
  set(payload: {
    key: string;
    value: Json;
    expectedVersion: number;
    ttlMs?: number;
  }) {
    const row = this.row(payload.key);
    this.expected(row, payload.expectedVersion);
    if (
      payload.ttlMs !== undefined &&
      (!Number.isSafeInteger(payload.ttlMs) ||
        payload.ttlMs < 1 ||
        payload.ttlMs > 365 * 24 * 3600000)
    )
      throw new CoordinationError(
        "invalid_input",
        "TTL must be 1 millisecond to 365 days",
      );
    return this.write(
      payload.key,
      payload.value,
      row,
      payload.ttlMs === undefined ? null : this.at + payload.ttlMs,
    );
  }
  append(payload: { key: string; value: Json; expectedVersion?: number }) {
    const row = this.row(payload.key);
    if (payload.expectedVersion !== undefined)
      this.expected(row, payload.expectedVersion);
    if (
      row &&
      (row.deleted || (row.expires_at !== null && row.expires_at <= this.at))
    )
      throw new CoordinationError(
        "expired_context",
        "Reset expired/deleted context with an explicit versioned set before appending",
      );
    const previous = row?.value ? (JSON.parse(row.value) as Json) : null;
    const values = row ? (Array.isArray(previous) ? previous : [previous]) : [];
    return this.write(
      payload.key,
      [...values, payload.value],
      row,
      row?.expires_at ?? null,
    );
  }
  delete(payload: { key: string; expectedVersion: number }) {
    const row = this.row(payload.key);
    this.expected(row, payload.expectedVersion);
    return this.write(payload.key, null, row, null, true);
  }
}
