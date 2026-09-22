import { randomUUID } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { validateSession, type SessionContext } from "./sessions";
import type { Sqlite } from "./sqlite";
import type { Command, Json, Task } from "./store";
import { validateTaskContract, type TaskContract } from "./task-contract";

export type TaskState =
  | "open"
  | "blocked"
  | "running"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "completed";
type AttemptRef = { taskId: string; attemptId: string; fence: number };
export type TaskCommand =
  | {
      id: string;
      type: "task.create";
      payload: {
        title: string;
        dependencies?: string[];
        contract?: TaskContract;
      };
    }
  | {
      id: string;
      type: "task.claim";
      payload: { taskId: string; expectedVersion: number; leaseMs?: number };
    }
  | {
      id: string;
      type: "task.renew";
      payload: AttemptRef & { leaseMs?: number };
    }
  | {
      id: string;
      type: "task.progress";
      payload: AttemptRef & { note: string };
    }
  | {
      id: string;
      type: "task.finish";
      payload: AttemptRef & {
        outcome: "completed" | "failed" | "cancelled";
        result?: Json;
        reason?: string;
      };
    }
  | {
      id: string;
      type: "task.cancel" | "task.retry";
      payload: { taskId: string; expectedVersion: number };
    }
  | { id: string; type: "task.recover"; payload: { taskId: string } };
export type Attempt = {
  id: string;
  task_id: string;
  actor: string;
  session_id: string;
  generation: number;
  fence: number;
  lease_until: number;
  state: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  created_at: number;
  ended_at: number | null;
  progress_at: number | null;
  result: string | null;
  reason: string | null;
};
function positive(value: number, name: string, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CoordinationError(
      "invalid_input",
      `${name} must be a positive integer no greater than ${max}`,
    );
}
export function readAttempts(
  db: Sqlite,
  scope: string,
  taskId: string,
  at = Date.now(),
) {
  return (
    db
      .prepare(
        "SELECT a.*,t.expires_at AS task_expires_at FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE t.scope=? AND t.id=? ORDER BY a.fence",
      )
      .all(scope, taskId) as Array<Attempt & { task_expires_at: number | null }>
  ).map(({ task_expires_at, ...row }) => ({
    ...row,
    retentionState:
      task_expires_at !== null && task_expires_at <= at
        ? "expired"
        : "retained",
    result:
      row.result === null || (task_expires_at !== null && task_expires_at <= at)
        ? null
        : (JSON.parse(row.result) as Json),
  }));
}

export class TaskTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}
  private task(id: string): Task {
    requireText(id, "taskId");
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE scope=? AND id=?")
      .get(this.command.scope, id) as Task | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        "Task does not exist in this scope",
      );
    return row;
  }
  private session(): SessionContext {
    if (!this.command.sessionId || !this.command.generation)
      throw new CoordinationError(
        "session_required",
        "Task ownership requires a current session",
      );
    const context = this.command as SessionContext;
    validateSession(this.db, context);
    return context;
  }
  private creator(task: Task, expected: number) {
    positive(expected, "expectedVersion");
    if (task.creator !== this.command.actor)
      throw new CoordinationError(
        "forbidden",
        "Only the task creator may change scheduling or cancellation",
      );
    if (task.version !== expected)
      throw new CoordinationError(
        "conflict",
        "Task ownership, version or state changed",
      );
  }
  private dependencies(id: string) {
    return this.db
      .prepare(
        "SELECT t.id,t.status FROM task_dependencies d JOIN tasks t ON t.id=d.dependency_id WHERE d.task_id=? AND t.status<>'completed' ORDER BY t.id",
      )
      .all(id) as { id: string; status: TaskState }[];
  }
  private propagate(id: string) {
    const rows = this.db
      .prepare(
        "SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE d.dependency_id=? AND t.status IN ('open','blocked')",
      )
      .all(id) as Task[];
    for (const row of rows) {
      const pending = this.dependencies(row.id);
      const status = pending.length ? "blocked" : "open";
      const reason = pending.length
        ? `dependencies:${pending.map((p) => `${p.id}:${p.status}`).join(",")}`
        : null;
      if (row.status === status && row.reason === reason) continue;
      this.db
        .prepare(
          "UPDATE tasks SET status=?,reason=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(status, reason, this.at, row.id);
      this.change("task.dependencies_changed", row.id, { status, reason });
    }
  }
  create(payload: {
    title: string;
    dependencies?: string[];
    contract?: TaskContract;
  }) {
    requireText(payload.title, "title", 1024);
    const contract =
      payload.contract === undefined
        ? null
        : JSON.stringify(validateTaskContract(payload.contract));
    if (
      payload.dependencies !== undefined &&
      (!Array.isArray(payload.dependencies) ||
        payload.dependencies.length > 100)
    )
      throw new CoordinationError(
        "invalid_input",
        "Dependencies must be an array of at most 100 task IDs",
      );
    const deps = [...new Set(payload.dependencies ?? [])];
    for (const dep of deps) this.task(dep);
    const id = randomUUID();
    const blocked = deps.some((dep) => this.task(dep).status !== "completed");
    this.db
      .prepare(
        "INSERT INTO tasks(id,scope,creator,title,status,version,created_at,updated_at,reason,contract) VALUES(?,?,?,?,?,1,?,?,?,?)",
      )
      .run(
        id,
        this.command.scope,
        this.command.actor,
        payload.title,
        blocked ? "blocked" : "open",
        this.at,
        this.at,
        blocked ? "dependencies_pending" : null,
        contract,
      );
    for (const dep of deps)
      this.db
        .prepare(
          "INSERT INTO task_dependencies(task_id,dependency_id) VALUES(?,?)",
        )
        .run(id, dep);
    this.change("task.created", id, {
      title: payload.title,
      version: 1,
      dependencies: deps,
    });
    return { task: { ...this.task(id) } };
  }
  claim(payload: {
    taskId: string;
    expectedVersion: number;
    leaseMs?: number;
  }) {
    const context = this.session(),
      task = this.task(payload.taskId);
    positive(payload.expectedVersion, "expectedVersion");
    const duration = payload.leaseMs ?? 60000;
    positive(duration, "leaseMs", 300000);
    if (
      task.version !== payload.expectedVersion ||
      task.status !== "open" ||
      this.dependencies(task.id).length
    )
      throw new CoordinationError(
        "conflict",
        "Task is not claimable at the expected version",
      );
    const id = randomUUID(),
      fence = task.attempt_counter + 1,
      until = this.at + duration;
    this.db
      .prepare(
        "INSERT INTO task_attempts(id,task_id,actor,session_id,generation,fence,lease_until,state,created_at) VALUES(?,?,?,?,?,?,?,'running',?)",
      )
      .run(
        id,
        task.id,
        context.actor,
        context.sessionId,
        context.generation,
        fence,
        until,
        this.at,
      );
    this.db
      .prepare(
        "UPDATE tasks SET status='running',current_attempt=?,attempt_counter=?,version=version+1,updated_at=?,reason=NULL WHERE id=?",
      )
      .run(id, fence, this.at, task.id);
    this.change("task.claimed", task.id, {
      attemptId: id,
      fence,
      sessionId: context.sessionId,
      leaseUntil: until,
    });
    return {
      task: { ...this.task(task.id) },
      attemptId: id,
      fence,
      leaseUntil: until,
    };
  }
  private owned(ref: AttemptRef) {
    const context = this.session(),
      task = this.task(ref.taskId);
    requireText(ref.attemptId, "attemptId");
    positive(ref.fence, "fence");
    const attempt = this.db
      .prepare("SELECT * FROM task_attempts WHERE id=?")
      .get(ref.attemptId) as Attempt | undefined;
    if (
      !attempt ||
      attempt.task_id !== task.id ||
      task.current_attempt !== attempt.id ||
      attempt.fence !== ref.fence ||
      attempt.actor !== context.actor ||
      attempt.session_id !== context.sessionId ||
      attempt.generation !== context.generation ||
      attempt.state !== "running" ||
      attempt.lease_until <= this.at ||
      !["running", "cancel_requested"].includes(task.status)
    )
      throw new CoordinationError(
        "stale_attempt",
        "Task attempt is expired, replaced or belongs to another session",
      );
    return { task, attempt };
  }
  renew(payload: AttemptRef & { leaseMs?: number }) {
    const { task, attempt } = this.owned(payload),
      duration = payload.leaseMs ?? 60000;
    positive(duration, "leaseMs", 300000);
    // Renewals never shorten a lease or stand in for meaningful progress.
    const until = Math.max(attempt.lease_until, this.at + duration);
    this.db
      .prepare("UPDATE task_attempts SET lease_until=? WHERE id=?")
      .run(until, attempt.id);
    this.change("task.lease_renewed", task.id, {
      attemptId: attempt.id,
      fence: attempt.fence,
      leaseUntil: until,
    });
    return {
      attemptId: attempt.id,
      fence: attempt.fence,
      leaseUntil: until,
      cancellationRequested: task.status === "cancel_requested",
    };
  }
  progress(payload: AttemptRef & { note: string }) {
    const { task, attempt } = this.owned(payload);
    requireText(payload.note, "note", 2048);
    this.db
      .prepare("UPDATE task_attempts SET progress_at=? WHERE id=?")
      .run(this.at, attempt.id);
    this.db
      .prepare("UPDATE sessions SET progress_at=? WHERE id=?")
      .run(this.at, attempt.session_id);
    this.change("task.progress", task.id, {
      attemptId: attempt.id,
      note: payload.note,
    });
    return { attemptId: attempt.id, progressAt: this.at };
  }
  finish(
    payload: AttemptRef & {
      outcome: "completed" | "failed" | "cancelled";
      result?: Json;
      reason?: string;
    },
  ) {
    const { task, attempt } = this.owned(payload);
    if (!["completed", "failed", "cancelled"].includes(payload.outcome))
      throw new CoordinationError("invalid_input", "Invalid task outcome");
    if (task.status === "cancel_requested" && payload.outcome !== "cancelled")
      throw new CoordinationError(
        "cancel_requested",
        "Acknowledge cancellation instead of publishing a late result",
      );
    if (payload.outcome === "cancelled" && task.status !== "cancel_requested")
      throw new CoordinationError(
        "invalid_transition",
        "Cancellation must be requested by the creator",
      );
    if (payload.reason !== undefined)
      requireText(payload.reason, "reason", 2048);
    const result = JSON.stringify(payload.result ?? null),
      reason = payload.reason ?? null;
    if (Buffer.byteLength(result) > 8192)
      throw new CoordinationError(
        "payload_too_large",
        "Task results are limited to 8 KiB; reference an artifact for patches or logs",
      );
    this.db
      .prepare(
        "UPDATE task_attempts SET state=?,ended_at=?,result=?,reason=? WHERE id=?",
      )
      .run(payload.outcome, this.at, result, reason, attempt.id);
    this.db
      .prepare(
        "UPDATE tasks SET status=?,current_attempt=NULL,version=version+1,updated_at=?,result=?,reason=? WHERE id=?",
      )
      .run(payload.outcome, this.at, result, reason, task.id);
    this.change(`task.${payload.outcome}`, task.id, {
      attemptId: attempt.id,
      fence: attempt.fence,
      reason,
    });
    this.propagate(task.id);
    return { task: { ...this.task(task.id) } };
  }
  cancel(payload: { taskId: string; expectedVersion: number }) {
    const task = this.task(payload.taskId);
    this.creator(task, payload.expectedVersion);
    if (!["open", "blocked", "running"].includes(task.status))
      throw new CoordinationError(
        "invalid_transition",
        "Task cannot be cancelled from its current state",
      );
    const status = task.status === "running" ? "cancel_requested" : "cancelled";
    this.db
      .prepare(
        "UPDATE tasks SET status=?,version=version+1,updated_at=?,reason='creator_cancelled' WHERE id=?",
      )
      .run(status, this.at, task.id);
    this.change(`task.${status}`, task.id, { version: task.version + 1 });
    this.propagate(task.id);
    return { task: { ...this.task(task.id) } };
  }
  retry(payload: { taskId: string; expectedVersion: number }) {
    const task = this.task(payload.taskId);
    this.creator(task, payload.expectedVersion);
    if (!["failed", "cancelled"].includes(task.status))
      throw new CoordinationError(
        "invalid_transition",
        "Only failed or cancelled tasks can be retried",
      );
    const status = this.dependencies(task.id).length ? "blocked" : "open";
    this.db
      .prepare(
        "UPDATE tasks SET status=?,version=version+1,updated_at=?,result=NULL,reason='creator_retry',expires_at=NULL WHERE id=?",
      )
      .run(status, this.at, task.id);
    this.change("task.retried", task.id, { version: task.version + 1, status });
    this.propagate(task.id);
    return { task: { ...this.task(task.id) } };
  }
  recover(payload: { taskId: string }) {
    const task = this.task(payload.taskId);
    if (!task.current_attempt) return { task: { ...task }, recovered: false };
    const attempt = this.db
      .prepare("SELECT * FROM task_attempts WHERE id=?")
      .get(task.current_attempt) as Attempt;
    let reason: string | null =
      attempt.lease_until <= this.at ? "lease_expired" : null;
    if (!reason)
      try {
        validateSession(this.db, {
          scope: task.scope,
          actor: attempt.actor,
          sessionId: attempt.session_id,
          generation: attempt.generation,
        });
      } catch (error) {
        if (
          error instanceof CoordinationError &&
          error.code === "stale_session"
        )
          reason = "session_superseded_or_ended";
        else throw error;
      }
    if (!reason)
      throw new CoordinationError(
        "lease_active",
        "Current task owner still has a valid lease",
      );
    const status =
      task.status === "cancel_requested"
        ? "cancelled"
        : this.dependencies(task.id).length
          ? "blocked"
          : "open";
    this.db
      .prepare(
        "UPDATE task_attempts SET state='abandoned',ended_at=?,reason=? WHERE id=?",
      )
      .run(this.at, reason, attempt.id);
    this.db
      .prepare(
        "UPDATE tasks SET status=?,current_attempt=NULL,version=version+1,updated_at=?,reason=? WHERE id=?",
      )
      .run(status, this.at, reason, task.id);
    this.change("task.recovered", task.id, {
      attemptId: attempt.id,
      fence: attempt.fence,
      status,
      reason,
    });
    this.propagate(task.id);
    return { task: { ...this.task(task.id) }, recovered: true };
  }
}
