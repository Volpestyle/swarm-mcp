import { createHash } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { migrate, type FaultHook } from "./migrations";
import { openSqlite, type Sqlite } from "./sqlite";
import {
  InboxTransaction,
  DEFAULT_INBOX_POLICY,
  validateInboxPolicy,
  readInbox,
  readMessageStatus,
  type InboxPolicy,
} from "./inbox";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type TaskStatus = "open" | "running" | "done" | "failed" | "cancelled";
export interface Task {
  id: string;
  scope: string;
  creator: string;
  title: string;
  status: TaskStatus;
  version: number;
  created_at: number;
  updated_at: number;
}
export interface Event {
  id: number;
  scope: string;
  actor: string;
  type: string;
  entity_id: string;
  payload: Json;
  created_at: number;
}
export interface Command {
  scope: string;
  actor: string;
  id: string;
  type: string;
  payload: Json;
}
export interface CommandResult<T> {
  value: T;
  cursor: number;
  replayed: boolean;
}

function canonical(value: Json, depth = 0): string {
  if (depth > 64)
    throw new CoordinationError(
      "invalid_input",
      "JSON nesting exceeds 64 levels",
    );
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(value[key]!, depth + 1)}`,
      )
      .join(",")}}`;
  }
  throw new CoordinationError(
    "invalid_input",
    "Command payload must contain only finite JSON values",
  );
}

export class WriteTransaction {
  readonly inbox: InboxTransaction;
  writes = 0;
  cursor = 0;
  constructor(
    private readonly db: Sqlite,
    readonly command: Command,
    readonly at: number,
    policy: InboxPolicy = DEFAULT_INBOX_POLICY,
  ) {
    this.inbox = new InboxTransaction(
      db,
      command,
      at,
      (type, id, payload) => {
        this.writes++;
        this.event(type, id, payload);
      },
      policy,
    );
  }

  task(id: string): Task | null {
    return (
      (this.db
        .prepare("SELECT * FROM tasks WHERE id = ? AND scope = ?")
        .get(id, this.command.scope) as Task | undefined | null) ?? null
    );
  }

  createTask(task: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks(id,scope,creator,title,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.scope,
        task.creator,
        task.title,
        task.status,
        task.version,
        task.created_at,
        task.updated_at,
      );
    this.writes++;
  }

  cancelTask(id: string, expectedVersion: number) {
    const result = this.db
      .prepare(
        "UPDATE tasks SET status='cancelled', version=version+1, updated_at=? WHERE id=? AND scope=? AND creator=? AND version=? AND status='open'",
      )
      .run(
        this.at,
        id,
        this.command.scope,
        this.command.actor,
        expectedVersion,
      );
    if (result.changes !== 1)
      throw new CoordinationError(
        "conflict",
        "Task ownership, version or state changed",
      );
    this.writes++;
  }

  event(type: string, entityId: string, payload: Json) {
    requireText(type, "event type");
    requireText(entityId, "entity ID");
    const result = this.db
      .prepare(
        "INSERT INTO events(scope,actor,type,entity_id,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        this.command.scope,
        this.command.actor,
        type,
        entityId,
        canonical(payload),
        this.at,
      );
    this.cursor = Number(result.lastInsertRowid);
  }
}

export class CoordinationStore {
  private readonly listeners = new Set<(cursor: number) => void>();
  private closed = false;
  private executing = false;
  private constructor(
    private readonly db: Sqlite,
    private readonly clock: () => number,
    private readonly inboxPolicy: InboxPolicy,
    private readonly fault?: FaultHook,
  ) {}

  static async open(options: {
    path: string;
    clock?: () => number;
    fault?: FaultHook;
    inboxPolicy?: Partial<InboxPolicy>;
  }) {
    const db = await openSqlite(options.path);
    try {
      const policy = { ...DEFAULT_INBOX_POLICY, ...options.inboxPolicy };
      validateInboxPolicy(policy);
      migrate(db, options.fault);
      return new CoordinationStore(
        db,
        options.clock ?? Date.now,
        policy,
        options.fault,
      );
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private ensureOpen() {
    if (this.closed)
      throw new CoordinationError("closed", "Coordinator store is closed");
  }

  execute<T extends Json>(
    command: Command,
    apply: (transaction: WriteTransaction) => T,
  ): CommandResult<T> {
    this.ensureOpen();
    if (this.executing)
      throw new CoordinationError(
        "nested_command",
        "Commands must not nest or await external work",
      );
    for (const [name, value] of Object.entries({
      scope: command.scope,
      actor: command.actor,
      id: command.id,
      type: command.type,
    }))
      requireText(value, name);
    const encoded = canonical({ type: command.type, payload: command.payload });
    if (Buffer.byteLength(encoded) > 65536)
      throw new CoordinationError(
        "payload_too_large",
        "Command exceeds 64 KiB; reference an artifact instead",
      );
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    this.executing = true;
    let committed = false;
    let began = false;
    let result: CommandResult<T>;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const cached = this.db
        .prepare(
          "SELECT fingerprint,result,cursor FROM commands WHERE scope=? AND actor=? AND command_id=?",
        )
        .get(command.scope, command.actor, command.id) as {
        fingerprint: string;
        result: string;
        cursor: number;
      } | null;
      if (cached) {
        if (cached.fingerprint !== fingerprint)
          throw new CoordinationError(
            "idempotency_conflict",
            "Command ID was already used with different content",
          );
        this.db.exec("COMMIT");
        committed = true;
        return {
          value: JSON.parse(cached.result),
          cursor: cached.cursor,
          replayed: true,
        };
      }
      const tx = new WriteTransaction(
        this.db,
        command,
        this.clock(),
        this.inboxPolicy,
      );
      const value = apply(tx);
      const serialized = canonical(value); // Also rejects accidental async callbacks.
      if (tx.writes && !tx.cursor)
        throw new CoordinationError(
          "missing_event",
          "State mutation must include an event in the same transaction",
        );
      this.db
        .prepare(
          "INSERT INTO commands(scope,actor,command_id,fingerprint,result,cursor,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          command.scope,
          command.actor,
          command.id,
          fingerprint,
          serialized,
          tx.cursor,
          tx.at,
        );
      this.fault?.("before_command_commit");
      this.db.exec("COMMIT");
      committed = true;
      result = { value, cursor: tx.cursor, replayed: false };
    } catch (error) {
      if (began && !committed) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.executing = false;
    }
    // A notification is only a hint. It can fail or never occur after a crash;
    // the committed cursor remains queryable and a retried command remains safe.
    this.fault?.("after_command_commit");
    for (const listener of this.listeners) {
      try {
        listener(result.cursor);
      } catch {
        /* subscriber reconnects from durable cursor */
      }
    }
    return result;
  }

  inbox(scope: string, actor: string, cursor = 0, limit = 50) {
    this.ensureOpen();
    return readInbox(this.db, scope, actor, cursor, limit);
  }

  messageStatus(scope: string, actor: string, id: string) {
    this.ensureOpen();
    return readMessageStatus(this.db, scope, actor, id);
  }

  task(scope: string, id: string): Task | null {
    this.ensureOpen();
    return (
      (this.db
        .prepare("SELECT * FROM tasks WHERE scope=? AND id=?")
        .get(scope, id) as Task | undefined | null) ?? null
    );
  }

  events(
    scope: string,
    after = 0,
    limit = 100,
  ): { items: Event[]; cursor: number } {
    this.ensureOpen();
    requireText(scope, "scope");
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new CoordinationError(
        "invalid_input",
        "Invalid event cursor or page limit",
      );
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE scope=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(scope, after, limit) as Array<
      Omit<Event, "payload"> & { payload: string }
    >;
    return {
      items: rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      cursor: rows.at(-1)?.id ?? after,
    };
  }

  subscribe(listener: (cursor: number) => void): () => void {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close() {
    if (this.executing)
      throw new CoordinationError(
        "transaction_active",
        "Cannot close inside a command",
      );
    if (!this.closed) {
      this.closed = true;
      this.listeners.clear();
      this.db.close();
    }
  }
}
