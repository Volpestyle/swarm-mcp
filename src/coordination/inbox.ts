import { randomUUID } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import type { Sqlite } from "./sqlite";
import type { Command, Json } from "./store";

export type SendPayload = {
  kind: string;
  body: string;
  taskId?: string;
  threadId?: string;
  ttlMs?: number;
};
export type InboxCommand =
  | {
      id: string;
      type: "inbox.wake_observed";
      payload: {
        messageId: string;
        status: "accepted" | "deferred" | "uncertain";
      };
    }
  | {
      id: string;
      type: "message.send";
      payload: SendPayload & { recipient: string };
    }
  | {
      id: string;
      type: "message.announce";
      payload: SendPayload & { recipients: string[] };
    }
  | {
      id: string;
      type: "inbox.fetch";
      payload: { consumer: string; limit?: number; leaseMs?: number };
    }
  | {
      id: string;
      type: "inbox.ack";
      payload: { messageId: string; leaseToken: string };
    }
  | {
      id: string;
      type: "inbox.reject";
      payload: { messageId: string; leaseToken: string; reason: string };
    }
  | { id: string; type: "inbox.sweep"; payload: Record<string, never> };

export type InboxPolicy = {
  maxAttempts: number;
  backoffMs: number;
  maxPendingPerRecipient: number;
};
export const DEFAULT_INBOX_POLICY: InboxPolicy = {
  maxAttempts: 5,
  backoffMs: 1000,
  maxPendingPerRecipient: 1000,
};
type State = "pending" | "leased" | "acknowledged" | "expired" | "dead_letter";
type Row = {
  seq: number;
  id: string;
  scope: string;
  sender: string;
  envelope_version: number;
  kind: string;
  body: string;
  task_id: string | null;
  thread_id: string | null;
  created_at: number;
  expires_at: number | null;
  idempotency_key: string;
  audience: "direct" | "announcement";
  max_attempts: number;
  backoff_ms: number;
  recipient: string;
  state: State;
  attempts: number;
  consumer: string | null;
  lease_token: string | null;
  lease_until: number | null;
  next_attempt_at: number;
  acknowledged_at: number | null;
  last_error: string | null;
};
const selection =
  "SELECT m.*,d.recipient,d.state,d.attempts,d.consumer,d.lease_token,d.lease_until,d.next_attempt_at,d.acknowledged_at,d.last_error FROM inbox_messages m JOIN inbox_deliveries d ON d.message_id=m.id";

function integer(value: number, name: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new CoordinationError(
      "invalid_input",
      `${name} must be an integer between ${min} and ${max}`,
    );
}
function envelope(row: Row) {
  return {
    version: row.envelope_version,
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    kind: row.kind,
    body: row.body,
    taskId: row.task_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    audience: row.audience,
  };
}
function disposition(row: Row) {
  return {
    messageId: row.id,
    recipient: row.recipient,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    acknowledgedAt: row.acknowledged_at,
    error: row.last_error,
    expiresAt: row.expires_at,
  };
}
export function readInbox(
  db: Sqlite,
  scope: string,
  actor: string,
  after = 0,
  limit = 50,
  activeOnly = false,
) {
  integer(after, "cursor", 0, Number.MAX_SAFE_INTEGER);
  integer(limit, "limit", 1, 100);
  if (typeof activeOnly !== "boolean")
    throw new CoordinationError("invalid_input", "activeOnly must be boolean");
  const rows = db
    .prepare(
      `${selection} WHERE m.scope=? AND d.recipient=? AND m.seq>? ${activeOnly ? "AND d.state IN ('pending','leased')" : ""} ORDER BY m.seq LIMIT ?`,
    )
    .all(scope, actor, after, limit) as Row[];
  return {
    items: rows.map((row) => ({ message: envelope(row), ...disposition(row) })),
    cursor: rows.at(-1)?.seq ?? after,
  };
}
export function readMessageStatus(
  db: Sqlite,
  scope: string,
  actor: string,
  id: string,
) {
  requireText(id, "message ID");
  const rows = db
    .prepare(
      `${selection} WHERE m.scope=? AND m.id=? AND (m.sender=? OR d.recipient=?) ORDER BY d.recipient`,
    )
    .all(scope, id, actor, actor) as Row[];
  if (!rows.length)
    throw new CoordinationError(
      "not_found",
      "Message is not visible to this actor",
    );
  return { messageId: id, deliveries: rows.map(disposition) };
}

export class InboxTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
    private readonly policy: InboxPolicy,
  ) {}

  send(
    payload: SendPayload,
    recipients: string[],
    audience: "direct" | "announcement",
  ) {
    requireText(payload.kind, "kind", 64);
    requireText(payload.body, "body", 16384);
    if (payload.taskId !== undefined) requireText(payload.taskId, "taskId");
    if (payload.threadId !== undefined)
      requireText(payload.threadId, "threadId");
    if (payload.ttlMs !== undefined)
      integer(payload.ttlMs, "ttlMs", 1, 30 * 24 * 60 * 60 * 1000);
    if (!Array.isArray(recipients))
      throw new CoordinationError(
        "invalid_input",
        "Recipients must be an array",
      );
    integer(recipients.length, "recipient count", 1, 100);
    const unique = [...new Set(recipients)];
    for (const recipient of unique) {
      requireText(recipient, "recipient");
      const pending = this.db
        .prepare(
          "SELECT count(*) AS n FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.scope=? AND d.recipient=? AND d.state IN ('pending','leased') AND (m.expires_at IS NULL OR m.expires_at>?)",
        )
        .get(this.command.scope, recipient, this.at) as { n: number };
      if (pending.n >= this.policy.maxPendingPerRecipient)
        throw new CoordinationError(
          "inbox_full",
          `Recipient ${recipient} has reached its pending-message quota`,
        );
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO inbox_messages(id,scope,sender,envelope_version,kind,body,task_id,thread_id,created_at,expires_at,idempotency_key,audience,max_attempts,backoff_ms) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        this.command.scope,
        this.command.actor,
        payload.kind,
        payload.body,
        payload.taskId ?? null,
        payload.threadId ?? null,
        this.at,
        payload.ttlMs === undefined ? null : this.at + payload.ttlMs,
        this.command.id,
        audience,
        this.policy.maxAttempts,
        this.policy.backoffMs,
      );
    for (const recipient of unique)
      this.db
        .prepare(
          "INSERT INTO inbox_deliveries(message_id,recipient,state,next_attempt_at) VALUES(?,?,'pending',?)",
        )
        .run(id, recipient, this.at);
    this.change("message.accepted", id, {
      recipients: unique,
      audience,
      kind: payload.kind,
    });
    return {
      messageId: id,
      recipients: unique,
      idempotencyKey: this.command.id,
    };
  }

  private own(id: string): Row {
    const row = this.db
      .prepare(`${selection} WHERE m.scope=? AND m.id=? AND d.recipient=?`)
      .get(this.command.scope, id, this.command.actor) as Row | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        "Delivery does not belong to this recipient",
      );
    return row;
  }
  private backoff(row: Row) {
    return Math.min(60000, row.backoff_ms * 2 ** Math.max(0, row.attempts - 1));
  }
  private terminal(row: Row, state: "expired" | "dead_letter", reason: string) {
    this.db
      .prepare(
        "UPDATE inbox_deliveries SET state=?,lease_token=NULL,lease_until=NULL,last_error=? WHERE message_id=? AND recipient=?",
      )
      .run(state, reason, row.id, row.recipient);
    this.change(`delivery.${state}`, row.id, {
      recipient: row.recipient,
      attempts: row.attempts,
      reason,
    });
  }

  sweep() {
    const rows = this.db
      .prepare(
        `${selection} WHERE m.scope=? AND d.recipient=? AND d.state IN ('pending','leased') AND ((m.expires_at IS NOT NULL AND m.expires_at<=?) OR (d.state='leased' AND d.lease_until<=?)) ORDER BY m.seq LIMIT 1000`,
      )
      .all(this.command.scope, this.command.actor, this.at, this.at) as Row[];
    for (const row of rows) {
      if (row.expires_at !== null && row.expires_at <= this.at)
        this.terminal(row, "expired", "message_expired");
      else if (row.attempts >= row.max_attempts)
        this.terminal(row, "dead_letter", "delivery_attempts_exhausted");
      else {
        const next = (row.lease_until ?? this.at) + this.backoff(row);
        this.db
          .prepare(
            "UPDATE inbox_deliveries SET state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error='delivery_lease_expired' WHERE message_id=? AND recipient=?",
          )
          .run(next, row.id, row.recipient);
        this.change("delivery.retry_scheduled", row.id, {
          recipient: row.recipient,
          nextAttemptAt: next,
          attempts: row.attempts,
        });
      }
    }
    return { examined: rows.length };
  }

  fetch(payload: { consumer: string; limit?: number; leaseMs?: number }) {
    requireText(payload.consumer, "consumer");
    const limit = payload.limit ?? 10,
      leaseMs = payload.leaseMs ?? 30000;
    integer(limit, "limit", 1, 50);
    integer(leaseMs, "leaseMs", 1, 120000);
    this.sweep();
    const rows = this.db
      .prepare(
        `${selection} WHERE m.scope=? AND d.recipient=? AND d.state='pending' AND d.next_attempt_at<=? AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY d.next_attempt_at,m.seq LIMIT ?`,
      )
      .all(
        this.command.scope,
        this.command.actor,
        this.at,
        this.at,
        limit,
      ) as Row[];
    const deliveries = rows.map((row) => {
      const token = randomUUID(),
        until = Math.min(
          this.at + leaseMs,
          row.expires_at ?? Number.MAX_SAFE_INTEGER,
        );
      const changed = this.db
        .prepare(
          "UPDATE inbox_deliveries SET state='leased',attempts=attempts+1,consumer=?,lease_token=?,lease_until=? WHERE message_id=? AND recipient=? AND state='pending'",
        )
        .run(payload.consumer, token, until, row.id, row.recipient);
      if (changed.changes !== 1)
        throw new CoordinationError(
          "conflict",
          "Delivery was claimed concurrently",
        );
      this.change("delivery.leased", row.id, {
        sessionId: this.command.sessionId ?? null,
        generation: this.command.generation ?? null,
        recipient: row.recipient,
        consumer: payload.consumer,
        attempt: row.attempts + 1,
        leaseUntil: until,
      });
      return {
        message: envelope(row),
        leaseToken: token,
        leaseUntil: until,
        attempt: row.attempts + 1,
      };
    });
    return { deliveries };
  }

  wakeObserved(payload: {
    messageId: string;
    status: "accepted" | "deferred" | "uncertain";
  }) {
    requireText(payload.messageId, "messageId");
    if (!["accepted", "deferred", "uncertain"].includes(payload.status))
      throw new CoordinationError("invalid_input", "Unknown wake observation");
    const row = this.own(payload.messageId);
    const task = row.task_id
      ? (this.db
          .prepare("SELECT current_attempt FROM tasks WHERE scope=? AND id=?")
          .get(this.command.scope, row.task_id) as
          { current_attempt: string | null } | undefined)
      : undefined;
    this.change("runtime.wake", row.id, {
      status: payload.status,
      recipient: this.command.actor,
      sessionId: this.command.sessionId ?? null,
      generation: this.command.generation ?? null,
      taskId: row.task_id,
      attemptId: task?.current_attempt ?? null,
      deliveryAttempt: row.attempts,
    });
    return { status: payload.status };
  }

  acknowledge(payload: { messageId: string; leaseToken: string }) {
    requireText(payload.messageId, "messageId");
    requireText(payload.leaseToken, "leaseToken");
    const row = this.own(payload.messageId);
    if (row.state === "acknowledged" && row.lease_token === payload.leaseToken)
      return {
        messageId: row.id,
        state: "acknowledged",
        acknowledgedAt: row.acknowledged_at,
      };
    this.validateLease(row, payload.leaseToken);
    this.db
      .prepare(
        "UPDATE inbox_deliveries SET state='acknowledged',acknowledged_at=?,last_error=NULL WHERE message_id=? AND recipient=? AND state='leased' AND lease_token=?",
      )
      .run(this.at, row.id, row.recipient, payload.leaseToken);
    this.change("delivery.acknowledged", row.id, {
      sessionId: this.command.sessionId ?? null,
      generation: this.command.generation ?? null,
      recipient: row.recipient,
      attempt: row.attempts,
    });
    return {
      messageId: row.id,
      state: "acknowledged",
      acknowledgedAt: this.at,
    };
  }

  reject(payload: { messageId: string; leaseToken: string; reason: string }) {
    requireText(payload.messageId, "messageId");
    requireText(payload.leaseToken, "leaseToken");
    requireText(payload.reason, "reason", 512);
    const row = this.own(payload.messageId);
    this.validateLease(row, payload.leaseToken);
    if (row.attempts >= row.max_attempts)
      this.terminal(row, "dead_letter", payload.reason);
    else {
      const next = this.at + this.backoff(row);
      this.db
        .prepare(
          "UPDATE inbox_deliveries SET state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=? WHERE message_id=? AND recipient=?",
        )
        .run(next, payload.reason, row.id, row.recipient);
      this.change("delivery.retry_scheduled", row.id, {
        recipient: row.recipient,
        nextAttemptAt: next,
        reason: payload.reason,
        attempts: row.attempts,
      });
    }
    return disposition(this.own(row.id));
  }

  private validateLease(row: Row, token: string) {
    if (
      row.state !== "leased" ||
      row.lease_token !== token ||
      row.lease_until === null ||
      row.lease_until <= this.at ||
      (row.expires_at !== null && row.expires_at <= this.at)
    ) {
      throw new CoordinationError(
        "stale_delivery",
        "Delivery lease is not current; fetch with a new command ID",
      );
    }
  }
}

export function validateInboxPolicy(policy: InboxPolicy) {
  integer(policy.maxAttempts, "maxAttempts", 1, 20);
  integer(policy.backoffMs, "backoffMs", 1, 60000);
  integer(policy.maxPendingPerRecipient, "maxPendingPerRecipient", 1, 10000);
}
