import { db } from "./db";
import { now } from "./time";

const EVENT_TTL_SECS = 24 * 60 * 60;

export type EventType =
  | "message.sent"
  | "message.broadcast"
  | "task.created"
  | "task.claimed"
  | "task.updated"
  | "task.approved"
  | "task.cascade.unblocked"
  | "task.cascade.cancelled"
  | "kv.set"
  | "kv.deleted"
  | "kv.appended"
  | "context.lock_acquired"
  | "context.lock_released"
  | "instance.registered"
  | "instance.deregistered"
  | "instance.stale_reclaimed"
  | "cleanup.messages_deleted"
  | "cleanup.terminal_tasks_deleted"
  | "cleanup.non_lock_context_rows_deleted"
  | "cleanup.events_deleted"
  | "cleanup.kv_deleted";

export interface EmitArgs {
  scope: string;
  type: EventType | string;
  /** Instance id of whoever caused the change, or `'system'` for prune. */
  actor?: string | null;
  /** Most-relevant entity id (task id, kv key, file, recipient...). */
  subject?: string | null;
  /** Type-specific JSON detail (e.g. dep ids, content snippets). */
  payload?: Record<string, unknown> | null;
}

/**
 * Append one row to the audit log. Safe to call inside an existing
 * transaction (single INSERT joins the surrounding tx). For non-tx writes
 * the event is emitted right after the mutation — if the mutation throws,
 * `emit` never runs and the audit log stays honest.
 */
export function emit(args: EmitArgs): void {
  db.run(
    "INSERT INTO events (scope, type, actor, subject, payload) VALUES (?, ?, ?, ?, ?)",
    [
      args.scope,
      args.type,
      args.actor ?? null,
      args.subject ?? null,
      args.payload ? JSON.stringify(args.payload) : null,
    ],
  );
}

export interface EventRow {
  id: number;
  scope: string;
  type: string;
  actor: string | null;
  subject: string | null;
  payload: string | null;
  created_at: number;
}

export function listSince(scope: string, sinceId = 0, limit = 200): EventRow[] {
  return db
    .query(
      `SELECT id, scope, type, actor, subject, payload, created_at
       FROM events
       WHERE scope = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(scope, sinceId, limit) as EventRow[];
}

/** TTL prune: drops events older than 24h. Matches the task-cleanup window. */
export function cleanup(): void {
  db.run("DELETE FROM events WHERE created_at < ?", [now() - EVENT_TTL_SECS]);
}
