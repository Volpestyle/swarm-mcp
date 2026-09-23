import { randomUUID } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { validateSession, type SessionContext } from "./sessions";
import type { Attempt } from "./tasks";
import type { Sqlite } from "./sqlite";
import type { Command, Json } from "./store";

export type GrantRef = { id: string; fence: number };
export type ReservationCommand =
  | {
      id: string;
      type: "reservation.acquire";
      payload: {
        kind: "file" | "integration";
        paths?: string[];
        reason: string;
        leaseMs?: number;
        attemptId?: string;
      };
    }
  | {
      id: string;
      type: "reservation.renew";
      payload: { grants: GrantRef[]; leaseMs?: number };
    }
  | { id: string; type: "reservation.release"; payload: { grants: GrantRef[] } }
  | { id: string; type: "reservation.check"; payload: { grants: GrantRef[] } }
  | { id: string; type: "reservation.sweep"; payload: Record<string, never> };
export type Resource = {
  kind: "file" | "integration";
  physical: string;
  logical: string;
  repository: string;
  worktree: string;
};
export type Reservation = {
  fence: number;
  id: string;
  scope: string;
  kind: "file" | "integration";
  resource: string;
  logical_path: string;
  repository: string;
  worktree: string;
  actor: string;
  session_id: string;
  generation: number;
  attempt_id: string | null;
  reason: string;
  created_at: number;
  expires_at: number;
  state: "active" | "released" | "expired" | "superseded";
  ended_at: number | null;
};
function leaseDuration(value = 60000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300000)
    throw new CoordinationError(
      "invalid_input",
      "Reservation lease must be between 1 and 300000 milliseconds",
    );
  return value;
}
function invalidReason(
  db: Sqlite,
  row: Reservation,
  now: number,
): string | null {
  if (row.state !== "active") return row.state;
  if (row.expires_at <= now) return "lease_expired";
  try {
    validateSession(db, {
      scope: row.scope,
      actor: row.actor,
      sessionId: row.session_id,
      generation: row.generation,
    });
  } catch (error) {
    if (error instanceof CoordinationError && error.code === "stale_session")
      return "session_superseded_or_ended";
    throw error;
  }
  if (row.attempt_id) {
    const attempt = db
      .prepare(
        "SELECT a.* FROM task_attempts a JOIN tasks t ON t.current_attempt=a.id WHERE a.id=? AND t.scope=?",
      )
      .get(row.attempt_id, row.scope) as Attempt | undefined;
    if (
      !attempt ||
      attempt.state !== "running" ||
      attempt.lease_until <= now ||
      attempt.session_id !== row.session_id ||
      attempt.generation !== row.generation
    )
      return "task_attempt_ended_or_expired";
  }
  return null;
}
function detail(row: Reservation, now: number) {
  return {
    ...row,
    ageMs: Math.max(0, now - row.created_at),
    recovery:
      "Wait for release/expiry or resume/recover the holder; retry acquisition with a new command ID",
  };
}
export function readReservations(
  db: Sqlite,
  scope: string,
  now: number,
  limit = 100,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new CoordinationError(
      "invalid_input",
      "Reservation limit must be 1..1000",
    );
  return (
    db
      .prepare(
        "SELECT * FROM reservations WHERE scope=? AND state='active' ORDER BY fence LIMIT ?",
      )
      .all(scope, limit) as Reservation[]
  ).map((row) => ({
    ...detail(row, now),
    invalidReason: invalidReason(db, row, now),
  }));
}
export class ReservationTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}
  private context(): SessionContext {
    if (!this.command.sessionId || !this.command.generation)
      throw new CoordinationError(
        "session_required",
        "Reservations require a current session",
      );
    const context = this.command as SessionContext;
    validateSession(this.db, context);
    return context;
  }
  private expire(row: Reservation) {
    const reason = invalidReason(this.db, row, this.at);
    if (!reason) return false;
    const state = reason === "lease_expired" ? "expired" : "superseded";
    this.db
      .prepare(
        "UPDATE reservations SET state=?,ended_at=? WHERE id=? AND state='active'",
      )
      .run(state, this.at, row.id);
    this.change("reservation.recovered", row.id, {
      resource: row.resource,
      owner: row.actor,
      fence: row.fence,
      reason,
    });
    return true;
  }
  private attempt(id: string | undefined, context: SessionContext) {
    if (id === undefined) return null;
    requireText(id, "attemptId");
    const attempt = this.db
      .prepare(
        "SELECT a.* FROM task_attempts a JOIN tasks t ON t.current_attempt=a.id WHERE a.id=? AND t.scope=?",
      )
      .get(id, context.scope) as Attempt | undefined;
    if (
      !attempt ||
      attempt.actor !== context.actor ||
      attempt.session_id !== context.sessionId ||
      attempt.generation !== context.generation ||
      attempt.state !== "running" ||
      attempt.lease_until <= this.at
    )
      throw new CoordinationError(
        "stale_attempt",
        "Reservation requires a current task attempt owned by this session",
      );
    return attempt;
  }
  acquire(
    payload: Extract<
      ReservationCommand,
      { type: "reservation.acquire" }
    >["payload"],
    resources: Resource[],
  ) {
    const context = this.context();
    requireText(payload.reason, "reason", 1024);
    const duration = leaseDuration(payload.leaseMs),
      attempt = this.attempt(payload.attemptId, context);
    const until = Math.min(
      this.at + duration,
      attempt?.lease_until ?? Number.MAX_SAFE_INTEGER,
    );
    const sorted = [
      ...new Map(resources.map((r) => [`${r.kind}:${r.physical}`, r])).values(),
    ].sort((a, b) => a.physical.localeCompare(b.physical));
    if (!sorted.length || sorted.length > 100)
      throw new CoordinationError(
        "invalid_input",
        "Acquire between 1 and 100 resources atomically",
      );
    const reused: Reservation[] = [],
      conflicts: Reservation[] = [],
      available: Resource[] = [],
      warnings: Reservation[] = [];
    for (const resource of sorted) {
      // Integration owns its checkout's writes while other worktrees keep
      // working. The repository-wide integration grant also serializes merges.
      const overlaps = (
        resource.kind === "file"
          ? this.db
              .prepare(
                "SELECT * FROM reservations WHERE scope=? AND kind='integration' AND repository=? AND worktree=? AND state='active'",
              )
              .all(context.scope, resource.repository, resource.worktree)
          : this.db
              .prepare(
                "SELECT * FROM reservations WHERE scope=? AND kind='file' AND worktree=? AND state='active'",
              )
              .all(context.scope, resource.worktree)
      ) as Reservation[];
      for (const peer of overlaps)
        if (!this.expire(peer) && peer.session_id !== context.sessionId)
          conflicts.push(peer);
      let current = this.db
        .prepare(
          "SELECT * FROM reservations WHERE scope=? AND kind=? AND resource=? AND state='active'",
        )
        .get(context.scope, resource.kind, resource.physical) as
        | Reservation
        | undefined;
      if (current && this.expire(current)) current = undefined;
      if (current) {
        if (
          current.actor === context.actor &&
          current.session_id === context.sessionId &&
          current.generation === context.generation
        )
          reused.push(current);
        else conflicts.push(current);
      } else available.push(resource);
      if (resource.kind === "file") {
        const peers = this.db
          .prepare(
            "SELECT * FROM reservations WHERE scope=? AND kind='file' AND repository=? AND logical_path=? AND resource<>? AND state='active'",
          )
          .all(
            context.scope,
            resource.repository,
            resource.logical,
            resource.physical,
          ) as Reservation[];
        warnings.push(
          ...peers.filter((peer) => !invalidReason(this.db, peer, this.at)),
        );
      }
    }
    if (conflicts.length)
      return {
        acquired: false,
        grants: [],
        reused: [],
        conflicts: [...new Map(conflicts.map((r) => [r.id, r])).values()].map(
          (r) => detail(r, this.at),
        ),
        warnings: warnings.map((r) => detail(r, this.at)),
      };
    const grants: Reservation[] = [];
    for (const resource of available) {
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO reservations(id,scope,kind,resource,logical_path,repository,worktree,actor,session_id,generation,attempt_id,reason,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')",
        )
        .run(
          id,
          context.scope,
          resource.kind,
          resource.physical,
          resource.logical,
          resource.repository,
          resource.worktree,
          context.actor,
          context.sessionId,
          context.generation,
          attempt?.id ?? null,
          payload.reason,
          this.at,
          until,
        );
      const grant = this.db
        .prepare("SELECT * FROM reservations WHERE id=?")
        .get(id) as Reservation;
      grants.push(grant);
      this.change("reservation.acquired", id, {
        resource: resource.physical,
        kind: resource.kind,
        fence: grant.fence,
        expiresAt: until,
      });
    }
    return {
      acquired: true,
      grants: grants.map((r) => detail(r, this.at)),
      reused: reused.map((r) => detail(r, this.at)),
      conflicts: [],
      warnings: warnings.map((r) => detail(r, this.at)),
    };
  }
  private owned(refs: GrantRef[]) {
    const context = this.context();
    if (!Array.isArray(refs) || !refs.length || refs.length > 100)
      throw new CoordinationError(
        "invalid_input",
        "Supply between 1 and 100 reservation grants",
      );
    const seen = new Set<string>();
    return refs.map((ref) => {
      requireText(ref.id, "grant ID");
      if (seen.has(ref.id) || !Number.isSafeInteger(ref.fence) || ref.fence < 1)
        throw new CoordinationError(
          "invalid_input",
          "Duplicate grant or invalid reservation fence",
        );
      seen.add(ref.id);
      const row = this.db
        .prepare("SELECT * FROM reservations WHERE id=? AND scope=?")
        .get(ref.id, context.scope) as Reservation | undefined;
      if (
        !row ||
        row.actor !== context.actor ||
        row.session_id !== context.sessionId ||
        row.generation !== context.generation ||
        row.fence !== ref.fence ||
        invalidReason(this.db, row, this.at)
      )
        throw new CoordinationError(
          "stale_reservation",
          "Reservation is expired, superseded or owned by another session",
        );
      return row;
    });
  }
  renew(payload: { grants: GrantRef[]; leaseMs?: number }) {
    const duration = leaseDuration(payload.leaseMs),
      rows = this.owned(payload.grants),
      context = this.context();
    const grants = rows.map((row) => {
      const attempt = this.attempt(row.attempt_id ?? undefined, context);
      const until = Math.min(
        Math.max(row.expires_at, this.at + duration),
        attempt?.lease_until ?? Number.MAX_SAFE_INTEGER,
      );
      this.db
        .prepare("UPDATE reservations SET expires_at=? WHERE id=?")
        .run(until, row.id);
      this.change("reservation.renewed", row.id, {
        fence: row.fence,
        expiresAt: until,
      });
      return { ...detail(row, this.at), expires_at: until };
    });
    return { grants };
  }
  release(payload: { grants: GrantRef[] }) {
    const rows = this.owned(payload.grants);
    for (const row of rows) {
      this.db
        .prepare(
          "UPDATE reservations SET state='released',ended_at=? WHERE id=?",
        )
        .run(this.at, row.id);
      this.change("reservation.released", row.id, { fence: row.fence });
    }
    return { released: rows.map((row) => row.id) };
  }
  check(payload: { grants: GrantRef[] }) {
    return {
      grants: this.owned(payload.grants).map((row) => detail(row, this.at)),
    };
  }
  sweep() {
    this.context();
    const rows = this.db
      .prepare(
        "SELECT * FROM reservations WHERE scope=? AND state='active' ORDER BY fence LIMIT 1000",
      )
      .all(this.command.scope) as Reservation[];
    return {
      examined: rows.length,
      recovered: rows.filter((row) => this.expire(row)).length,
    };
  }
}
