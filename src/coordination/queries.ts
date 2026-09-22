import { CoordinationError, requireText } from "./errors";
import type { Sqlite } from "./sqlite";

export type Page = { cursor?: number; limit?: number };
export type PeerFilter = Page & { role?: string };
export type TaskFilter = Page & { owner?: string; status?: string };
function page(input: Page) {
  const cursor = input.cursor ?? 0,
    limit = input.limit ?? 20;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new CoordinationError(
      "invalid_input",
      "Page cursor must be nonnegative and limit 1..50",
    );
  return { cursor, limit };
}

export function peers(db: Sqlite, scope: string, filter: PeerFilter = {}) {
  const { cursor, limit } = page(filter);
  if (filter.role !== undefined) {
    requireText(filter.role, "role", 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(filter.role))
      throw new CoordinationError(
        "invalid_input",
        "Role must be a single label token",
      );
  }
  const rows = db
    .prepare(
      `SELECT a.rowid AS cursor,a.id AS agentId,a.label,s.id AS sessionId,s.generation,s.runtime_state AS runtimeState,s.transport_at AS transportAt,s.progress_at AS progressAt
    FROM agents a JOIN sessions s ON s.scope=a.scope AND s.agent_id=a.id AND s.generation=a.generation
    WHERE a.scope=? AND a.rowid>? AND s.state='active'
    ${filter.role === undefined ? "" : "AND instr(' ' || a.label || ' ',?)>0"}
    ORDER BY a.rowid LIMIT ?`,
    )
    .all(
      scope,
      cursor,
      ...(filter.role === undefined ? [] : [` role:${filter.role} `]),
      limit,
    ) as Array<{
    cursor: number;
    agentId: string;
    label: string;
    sessionId: string;
    generation: number;
    runtimeState: string;
    transportAt: number | null;
    progressAt: number | null;
  }>;
  return { items: rows, cursor: rows.at(-1)?.cursor ?? cursor };
}

export function taskSummaries(
  db: Sqlite,
  scope: string,
  filter: TaskFilter = {},
) {
  const { cursor, limit } = page(filter);
  const where = ["t.scope=?", "t.rowid>?"];
  const params: unknown[] = [scope, cursor];
  if (filter.owner !== undefined) {
    requireText(filter.owner, "owner");
    where.push("a.actor=?");
    params.push(filter.owner);
  }
  if (filter.status !== undefined) {
    if (
      ![
        "open",
        "blocked",
        "running",
        "cancel_requested",
        "cancelled",
        "failed",
        "completed",
      ].includes(filter.status)
    )
      throw new CoordinationError("invalid_input", "Unknown task state");
    where.push("t.status=?");
    params.push(filter.status);
  }
  const rows = db
    .prepare(
      `SELECT t.rowid AS cursor,t.id,t.title,t.status,t.version,t.current_attempt AS attemptId,a.actor AS owner,t.updated_at AS updatedAt
    FROM tasks t LEFT JOIN task_attempts a ON a.id=t.current_attempt WHERE ${where.join(" AND ")} ORDER BY t.rowid LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    cursor: number;
    id: string;
    title: string;
    status: string;
    version: number;
    attemptId: string | null;
    owner: string | null;
    updatedAt: number;
  }>;
  return { items: rows, cursor: rows.at(-1)?.cursor ?? cursor };
}

/** Called inside one read transaction so the event cursor cannot skip a change
 * between reading current state and establishing the resume position. */
export function bootstrap(db: Sqlite, scope: string, actor: string) {
  const cursor = (
    db
      .prepare("SELECT coalesce(max(id),0) AS cursor FROM events WHERE scope=?")
      .get(scope) as { cursor: number }
  ).cursor;
  const inbox = db
    .prepare(
      `SELECT d.state,count(*) AS count FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.scope=? AND d.recipient=? GROUP BY d.state`,
    )
    .all(scope, actor) as Array<{ state: string; count: number }>;
  return {
    scope,
    actor,
    eventCursor: cursor,
    tasks: taskSummaries(db, scope, { owner: actor, limit: 10 }),
    inbox,
  };
}
