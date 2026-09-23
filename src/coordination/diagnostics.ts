import type { Sqlite } from "./sqlite";
import { CoordinationError, requireText } from "./errors";

export type DiagnosticFilter = {
  taskId?: string;
  messageId?: string;
  limit?: number;
};

/** Read-only, scope-bound metadata. Never project message bodies, results,
 * capability hashes, lease tokens, user error text, or arbitrary event payloads. */
export function inspectCoordination(
  db: Sqlite,
  scope: string,
  now: number,
  filter: DiagnosticFilter = {},
) {
  const limit = filter.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new CoordinationError(
      "invalid_input",
      "Diagnostic limit must be 1..20",
    );
  if (filter.taskId !== undefined) requireText(filter.taskId, "taskId");
  if (filter.messageId !== undefined)
    requireText(filter.messageId, "messageId");
  const rows = <T>(sql: string, ...params: unknown[]) =>
    db.prepare(sql).all(...params) as T[];
  const deliveries = rows<{
    messageId: string;
    taskId: string | null;
    recipient: string;
    state: string;
    attempts: number;
    createdAt: number;
    leaseUntil: number | null;
    acknowledgedAt: number | null;
    nextAttemptAt: number;
    expiresAt: number | null;
  }>(
    `SELECT m.id AS messageId,m.task_id AS taskId,d.recipient,d.state,d.attempts,
    m.created_at AS createdAt,d.lease_until AS leaseUntil,d.acknowledged_at AS acknowledgedAt,
    d.next_attempt_at AS nextAttemptAt,m.expires_at AS expiresAt
    FROM inbox_messages m JOIN inbox_deliveries d ON d.message_id=m.id
    WHERE m.scope=? AND (? IS NULL OR m.task_id=?) AND (? IS NULL OR m.id=?)
    ORDER BY m.seq DESC,d.recipient LIMIT ?`,
    scope,
    filter.taskId ?? null,
    filter.taskId ?? null,
    filter.messageId ?? null,
    filter.messageId ?? null,
    limit + 1,
  );
  const tasks = rows<{
    taskId: string;
    status: string;
    attemptId: string | null;
    fence: number | null;
    sessionId: string | null;
    generation: number | null;
    leaseUntil: number | null;
    progressAt: number | null;
    sessionState: string | null;
  }>(
    `SELECT t.id AS taskId,t.status,a.id AS attemptId,a.fence,a.session_id AS sessionId,
    a.generation,a.lease_until AS leaseUntil,a.progress_at AS progressAt,s.state AS sessionState
    FROM tasks t LEFT JOIN task_attempts a ON a.id=t.current_attempt
    LEFT JOIN sessions s ON s.id=a.session_id
    WHERE t.scope=? AND (? IS NULL OR t.id=?) ORDER BY t.updated_at DESC,t.id LIMIT ?`,
    scope,
    filter.taskId ?? null,
    filter.taskId ?? null,
    limit + 1,
  );
  const sessions = rows<{
    actor: string;
    sessionId: string;
    generation: number;
    state: string;
    runtime: string;
    runtimeAt: number | null;
    transportAt: number | null;
    progressAt: number | null;
  }>(
    `SELECT agent_id AS actor,id AS sessionId,generation,state,runtime_state AS runtime,
    runtime_at AS runtimeAt,transport_at AS transportAt,progress_at AS progressAt
    FROM sessions WHERE scope=? ORDER BY created_at DESC,id LIMIT ?`,
    scope,
    limit + 1,
  );
  const events = rows<{
    cursor: number;
    type: string;
    entityId: string;
    actor: string;
    at: number;
  }>(
    `SELECT id AS cursor,type,entity_id AS entityId,actor,created_at AS at,
     json_extract(payload,'$.sessionId') AS sessionId,json_extract(payload,'$.generation') AS generation FROM events
     WHERE scope=? AND (type LIKE 'delivery.%' OR type LIKE 'dispatch.%' OR type IN ('task.recovered','task.retried'))
     ORDER BY id DESC LIMIT ?`,
    scope,
    limit + 1,
  );
  const summary = db
    .prepare(
      `SELECT count(*) AS total,
    sum(CASE WHEN d.state='pending' THEN 1 ELSE 0 END) AS pending,
    sum(CASE WHEN d.state='leased' THEN 1 ELSE 0 END) AS leased,
    sum(CASE WHEN d.state='dead_letter' THEN 1 ELSE 0 END) AS deadLetter,
    sum(CASE WHEN d.state='acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
    coalesce(sum(max(d.attempts-1,0)),0) AS retries,
    avg(CASE WHEN d.acknowledged_at IS NOT NULL THEN d.acknowledged_at-m.created_at END) AS meanAcknowledgmentMs
    FROM inbox_messages m JOIN inbox_deliveries d ON d.message_id=m.id WHERE m.scope=?`,
    )
    .get(scope);
  const page = <T>(items: T[]) => ({
    items: items.slice(0, limit),
    truncated: items.length > limit,
  });
  return {
    observedAt: now,
    adapterCoverage: {
      evidenceDate: "2026-09-22",
      meaning: "Candidate support, not host discovery or a liveness claim",
      opencode: {
        boundaries: ["turn_start", "tool_complete"],
        idleWake: true,
        coverage: "installed-host verified",
        limitation: "killed/resumed delivery and large histories unverified",
      },
      claude: {
        boundaries: ["turn_start", "tool_complete"],
        idleWake: false,
        coverage: "installed-host verified",
        limitation: "waits for native boundary; legacy-plugin rollout pending",
      },
      codex: {
        boundaries: ["owner_driven"],
        idleWake: false,
        coverage: "degraded",
        limitation: "automatic enrollment and autonomous delivery unverified",
      },
      hermes: {
        boundaries: ["in_process"],
        idleWake: false,
        coverage: "degraded",
        limitation: "lifecycle tests only; installed-host delivery unverified",
      },
    },
    scope,
    freshnessMs: 60000,
    summary,
    recoveryCounts: rows(
      `SELECT type,count(*) AS count FROM events WHERE scope=? AND type IN
      ('task.recovered','task.retried','dispatch.reassigned','delivery.leased','delivery.dead_letter') GROUP BY type`,
      scope,
    ),
    deliveryLatency: db
      .prepare(
        `SELECT avg(e.created_at-m.created_at) AS meanFirstDeliveryMs,count(*) AS measuredMessages
      FROM inbox_messages m JOIN (SELECT scope,entity_id,min(created_at) AS created_at FROM events WHERE scope=? AND type='delivery.leased' GROUP BY scope,entity_id) e
      ON e.scope=m.scope AND e.entity_id=m.id WHERE m.scope=?`,
      )
      .get(scope, scope),
    deliveries: page(
      deliveries.map((d) => ({
        ...d,
        ageMs: Math.max(0, now - d.createdAt),
        acknowledgmentLatencyMs:
          d.acknowledgedAt === null ? null : d.acknowledgedAt - d.createdAt,
        recovery:
          d.state === "acknowledged"
            ? "none"
            : d.expiresAt !== null && d.expiresAt <= now
              ? "expired: inspect intent before sending replacement work"
              : d.state === "dead_letter"
                ? "inspect recipient and failure history before an explicit replay"
                : d.state === "leased"
                  ? d.leaseUntil! <= now
                    ? "lease expired: recipient fetch will recover delivery; deduplicate prior effects"
                    : "await processing acknowledgment; wake acceptance is insufficient"
                  : "check recipient availability and adapter wake coverage; fetch at a safe boundary",
      })),
    ),
    tasks: page(
      tasks.map((t) => ({
        ...t,
        recovery:
          t.attemptId && (t.leaseUntil! <= now || t.sessionState !== "active")
            ? "recover stale ownership; prove external work stopped before dispatch release or reassignment"
            : t.status === "cancel_requested"
              ? "await fenced cancelled result; do not launch replacement yet"
              : "none",
      })),
    ),
    sessions: page(
      sessions.map((s) => ({
        ...s,
        availability:
          s.state !== "active" || s.runtime === "unavailable"
            ? "unavailable"
            : s.runtimeAt === null || now - s.runtimeAt > 60000
              ? "unknown_stale_observation"
              : s.runtime,
        processLiveness: "not established by enrollment or transport activity",
      })),
    ),
    audit: page(events),
    wakes: page(
      rows(
        `SELECT id AS cursor,entity_id AS messageId,actor AS recipient,created_at AS at,
      json_extract(payload,'$.status') AS status,json_extract(payload,'$.sessionId') AS sessionId,
      json_extract(payload,'$.generation') AS generation,json_extract(payload,'$.taskId') AS taskId,
      json_extract(payload,'$.attemptId') AS attemptId,json_extract(payload,'$.deliveryAttempt') AS deliveryAttempt
      FROM events WHERE scope=? AND type='runtime.wake'
      AND (? IS NULL OR entity_id=?) AND (? IS NULL OR json_extract(payload,'$.taskId')=?)
      ORDER BY id DESC LIMIT ?`,
        scope,
        filter.messageId ?? null,
        filter.messageId ?? null,
        filter.taskId ?? null,
        filter.taskId ?? null,
        limit + 1,
      ),
    ),
    wakeCoverage:
      "Authenticated recipient self-reports; accepted means host admission, never processing acknowledgment. Missing records do not establish failure.",
  };
}
