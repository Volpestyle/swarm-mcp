import { CoordinationError, requireText } from "./errors";
import type { Sqlite } from "./sqlite";
import type { Task, Json } from "./store";
import type { TaskContract } from "./task-contract";

export function taskDetail(
  db: Sqlite,
  scope: string,
  taskId: string,
  now: number,
) {
  requireText(taskId, "taskId");
  const row = db
    .prepare(
      `SELECT t.*, a.actor AS owner, a.fence, a.lease_until,a.progress_at,a.created_at AS attempt_created_at,a.progress_timeout_ms,
      a.state AS attempt_state, s.state AS session_state,
      (SELECT json_group_array(dependency_id) FROM task_dependencies WHERE task_id=t.id) AS dependencies
    FROM tasks t LEFT JOIN task_attempts a ON a.id=t.current_attempt
    LEFT JOIN sessions s ON s.id=a.session_id
    WHERE t.scope=? AND t.id=?`,
    )
    .get(scope, taskId) as
    | (Task & {
        owner: string | null;
        fence: number | null;
        lease_until: number | null;
        progress_at: number | null;
        attempt_created_at: number;
        progress_timeout_ms: number;
        attempt_state: string | null;
        session_state: string | null;
        dependencies: string;
      })
    | undefined;
  if (!row)
    throw new CoordinationError(
      "not_found",
      "Task does not exist in this scope",
    );
  const expired = row.expires_at != null && row.expires_at <= now;
  return {
    taskId: row.id,
    scope: row.scope,
    title: row.title,
    status: row.status,
    version: row.version,
    creator: row.creator,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contract: row.contract ? (JSON.parse(row.contract) as TaskContract) : null,
    dependencies: JSON.parse(row.dependencies) as string[],
    owner:
      row.owner === null
        ? null
        : {
            actor: row.owner,
            attemptId: row.current_attempt!,
            fence: row.fence!,
            leaseUntil: row.lease_until!,
            progressAt: row.progress_at,
            progressDeadline: (row.progress_at ?? row.attempt_created_at) + row.progress_timeout_ms,
            active:
              row.attempt_state === "running" &&
              row.session_state === "active" &&
              row.lease_until! > now,
          },
    result:
      expired || row.result === null ? null : (JSON.parse(row.result) as Json),
    retention: expired ? ("expired" as const) : ("retained" as const),
    reason: row.reason,
  };
}

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
      .prepare("SELECT max(coalesce((SELECT max(id) FROM events WHERE scope=?),0),coalesce((SELECT floor FROM event_retention WHERE scope=?),0)) AS cursor")
      .get(scope, scope) as { cursor: number }
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
