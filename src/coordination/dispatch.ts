import { createHash, randomUUID } from "node:crypto";
import type { Sqlite } from "./sqlite";
import type { Command, Json, Task } from "./store";
import { CoordinationError, requireText } from "./errors";
import { validateSession, type SessionContext } from "./sessions";
import { validateTaskContract, type TaskContract } from "./task-contract";
import { TaskTransaction } from "./tasks";
import { selectExecutionRoute, type ExecutionRoute } from "./routing";

export interface DispatchIntent {
  intentId: string;
  title: string;
  contract: TaskContract;
  capabilities: string[];
  durable: boolean;
  host?: string;
}
export interface DispatchPolicy {
  routes: readonly ExecutionRoute[];
  active: number;
  maximum: number;
  observationMaxAgeMs: number;
}
type Row = {
  intent_id: string;
  task_id: string;
  route_id: string;
  path: "native" | "peer";
  state: string;
  fingerprint: string;
  provision_token: string | null;
  external_id: string | null;
  worker_session: string | null;
  attempt_id: string | null;
  fence: number | null;
};

/** Runs inside the coordinator's BEGIN IMMEDIATE command transaction. Policy
 * is supplied by trusted launcher configuration, never the command payload. */
export class DispatchTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly tasks: TaskTransaction,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}

  private intent(intentId: string): Row {
    requireText(intentId, "intentId");
    if (!this.command.sessionId || !this.command.generation)
      throw new CoordinationError(
        "session_required",
        "Dispatch requires a current session",
      );
    validateSession(this.db, this.command as SessionContext);
    const row = this.db
      .prepare("SELECT * FROM dispatch_intents WHERE scope=? AND intent_id=?")
      .get(this.command.scope, intentId) as Row | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        "Dispatch intent does not exist in this scope",
      );
    return row;
  }

  begin(intentId: string) {
    const row = this.intent(intentId);
    if (row.state === "released")
      throw new CoordinationError("conflict", "Dispatch intent is released");
    if (row.state !== "reserved")
      return {
        status: row.state,
        start: false,
        token: row.provision_token,
        taskId: row.task_id,
        routeId: row.route_id,
      };
    const task = this.db
      .prepare("SELECT status FROM tasks WHERE scope=? AND id=?")
      .get(this.command.scope, row.task_id) as { status: string };
    if (task.status !== "open")
      throw new CoordinationError(
        "conflict",
        "Dispatch task is no longer open",
      );
    const token = randomUUID();
    this.db
      .prepare(
        "UPDATE dispatch_intents SET state='provisioning',provision_token=? WHERE scope=? AND intent_id=?",
      )
      .run(token, this.command.scope, intentId);
    this.change("dispatch.provisioning", intentId, {
      taskId: row.task_id,
      routeId: row.route_id,
    });
    return {
      status: "provisioning",
      start: true,
      token,
      taskId: row.task_id,
      routeId: row.route_id,
    };
  }

  provisioned(input: {
    intentId: string;
    token: string;
    routeId: string;
    externalId: string;
  }) {
    const row = this.intent(input.intentId);
    requireText(input.externalId, "externalId", 1024);
    if (
      !["provisioning", "bound"].includes(row.state) ||
      row.provision_token !== input.token ||
      row.route_id !== input.routeId ||
      (row.external_id !== null && row.external_id !== input.externalId)
    )
      throw new CoordinationError(
        "conflict",
        "External identity does not match provisioning intent",
      );
    if (row.external_id === null) {
      this.db
        .prepare(
          "UPDATE dispatch_intents SET external_id=? WHERE scope=? AND intent_id=?",
        )
        .run(input.externalId, this.command.scope, input.intentId);
      this.change("dispatch.provisioned", input.intentId, {
        taskId: row.task_id,
        externalId: input.externalId,
      });
    }
    return { externalId: input.externalId };
  }

  provisionLookup(token: string, routeId: string) {
    validateSession(this.db, this.command as SessionContext);
    requireText(token, "token");
    requireText(routeId, "routeId");
    const row = this.db
      .prepare(
        "SELECT * FROM dispatch_intents WHERE scope=? AND provision_token=? AND route_id=?",
      )
      .get(this.command.scope, token, routeId) as Row | undefined;
    return row
      ? { taskId: row.task_id, externalId: row.external_id, status: row.state }
      : null;
  }

  /** Trusted launcher only: stopped must come from terminal provider evidence,
   * never from a timeout, missing lookup, or an agent's claim of completion. */
  release(input: {
    intentId: string;
    stopped?: { token: string; routeId: string };
  }) {
    const row = this.intent(input.intentId);
    if (row.state === "released")
      return { status: "released", taskId: row.task_id, existing: true };
    let task = this.db
      .prepare("SELECT status FROM tasks WHERE scope=? AND id=?")
      .get(this.command.scope, row.task_id) as { status: string };
    if (
      row.state !== "reserved" &&
      (!input.stopped ||
        input.stopped.token !== row.provision_token ||
        input.stopped.routeId !== row.route_id)
    )
      throw new CoordinationError(
        "conflict",
        "Dispatch requires confirmed provider termination",
      );
    if (task.status === "cancel_requested" && row.state === "bound") {
      this.tasks.confirmStoppedCancellation({
        taskId: row.task_id,
        attemptId: row.attempt_id!,
        fence: row.fence!,
      });
      task = { status: "cancelled" };
    }
    if (!["completed", "failed", "cancelled"].includes(task.status))
      throw new CoordinationError("conflict", "Dispatch task is not terminal");
    this.db
      .prepare(
        "UPDATE dispatch_intents SET state='released' WHERE scope=? AND intent_id=?",
      )
      .run(this.command.scope, input.intentId);
    this.change("dispatch.released", input.intentId, { taskId: row.task_id });
    return { status: "released", taskId: row.task_id, existing: false };
  }

  requestCancellation(intentId: string) {
    const row = this.intent(intentId);
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE scope=? AND id=?")
      .get(this.command.scope, row.task_id) as Task;
    if (task.creator !== this.command.actor)
      throw new CoordinationError(
        "conflict",
        "Only the task creator may cancel dispatch",
      );
    if (["open", "blocked", "running"].includes(task.status))
      this.tasks.cancel({ taskId: task.id, expectedVersion: task.version });
    const attempt = row.attempt_id
      ? (this.db
          .prepare("SELECT actor,state FROM task_attempts WHERE id=?")
          .get(row.attempt_id) as { actor: string; state: string } | undefined)
      : undefined;
    return {
      status: row.state,
      taskId: row.task_id,
      routeId: row.route_id,
      token: row.provision_token,
      notifyActor: attempt?.state === "running" ? attempt.actor : null,
      attemptId: row.attempt_id,
      fence: row.fence,
    };
  }

  /** Cooperative existing-peer stop proof. Abandoned leases are not proof that
   * physical work ended; only a fenced worker finish or no admitted work is. */
  peerStopped(input: {
    token: string;
    routeId: string;
    worker: SessionContext;
  }) {
    validateSession(this.db, this.command as SessionContext);
    const row = this.db
      .prepare(
        "SELECT * FROM dispatch_intents WHERE scope=? AND provision_token=? AND route_id=?",
      )
      .get(this.command.scope, input.token, input.routeId) as Row | undefined;
    if (!row || input.worker.scope !== this.command.scope)
      return { stopped: false };
    const task = this.db
      .prepare("SELECT status FROM tasks WHERE id=?")
      .get(row.task_id) as { status: string };
    if (row.state === "provisioning" && task.status === "cancelled")
      return { stopped: true };
    if (row.worker_session !== input.worker.sessionId || !row.attempt_id)
      return { stopped: false };
    const attempt = this.db
      .prepare(
        "SELECT state FROM task_attempts WHERE id=? AND session_id=? AND fence=?",
      )
      .get(row.attempt_id, input.worker.sessionId, row.fence) as
      | { state: string }
      | undefined;
    return {
      stopped:
        !!attempt &&
        ["completed", "failed", "cancelled"].includes(attempt.state),
    };
  }

  /** Launcher-verified provisioning result only; never model-supplied identity. */
  bind(input: {
    intentId: string;
    token: string;
    routeId: string;
    externalId: string;
    worker: SessionContext;
  }) {
    const row = this.intent(input.intentId);
    requireText(input.externalId, "externalId", 1024);
    if (
      input.worker.scope !== this.command.scope ||
      row.route_id !== input.routeId ||
      row.provision_token !== input.token ||
      (row.external_id !== null && row.external_id !== input.externalId)
    )
      throw new CoordinationError(
        "conflict",
        "Provisioning result does not match dispatch intent",
      );
    validateSession(this.db, input.worker);
    if (row.state === "bound") {
      if (
        row.worker_session !== input.worker.sessionId ||
        row.external_id !== input.externalId
      )
        throw new CoordinationError(
          "conflict",
          "Dispatch is already bound to another worker",
        );
      return {
        taskId: row.task_id,
        attemptId: row.attempt_id!,
        fence: row.fence!,
        existing: true,
      };
    }
    if (row.state !== "provisioning")
      throw new CoordinationError("conflict", "Dispatch is not provisioning");
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE scope=? AND id=?")
      .get(this.command.scope, row.task_id) as Task;
    const workerTasks = new TaskTransaction(
      this.db,
      { ...this.command, ...input.worker },
      this.at,
      this.change,
    );
    const attempt = workerTasks.claim(
      { taskId: row.task_id, expectedVersion: task.version },
      input.intentId,
    );
    this.db
      .prepare(
        "UPDATE dispatch_intents SET state='bound',external_id=?,worker_session=?,attempt_id=?,fence=? WHERE scope=? AND intent_id=?",
      )
      .run(
        input.externalId,
        input.worker.sessionId,
        attempt.attemptId,
        attempt.fence,
        this.command.scope,
        input.intentId,
      );
    this.change("dispatch.bound", input.intentId, {
      taskId: row.task_id,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
    });
    return {
      taskId: row.task_id,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      existing: false,
    };
  }

  reserve(input: DispatchIntent, policy: DispatchPolicy) {
    return this.reserveOrReassign(input, policy);
  }

  /** Explicit creator retry after confirmed release; preserves work identity. */
  reassign(
    input: DispatchIntent,
    policy: DispatchPolicy,
    expectedVersion: number,
  ) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new CoordinationError(
        "invalid_input",
        "Reassignment requires a positive task version",
      );
    return this.reserveOrReassign(input, policy, expectedVersion);
  }

  private reserveOrReassign(
    input: DispatchIntent,
    policy: DispatchPolicy,
    expectedVersion?: number,
  ) {
    if (!this.command.sessionId || !this.command.generation)
      throw new CoordinationError(
        "session_required",
        "Dispatch requires a current session",
      );
    validateSession(this.db, this.command as SessionContext);
    requireText(input.intentId, "intentId");
    requireText(input.title, "title", 1024);
    const contract = validateTaskContract(input.contract);
    if (
      !Array.isArray(input.capabilities) ||
      input.capabilities.length > 64 ||
      typeof input.durable !== "boolean"
    )
      throw new CoordinationError(
        "invalid_input",
        "Invalid dispatch requirements",
      );
    for (const capability of input.capabilities)
      requireText(capability, "capability");
    if (input.host !== undefined) requireText(input.host, "host");
    const capabilities = [...new Set(input.capabilities)].sort();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          title: input.title,
          contract,
          capabilities,
          durable: input.durable,
          host: input.host ?? null,
        }),
      )
      .digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM dispatch_intents WHERE scope=? AND intent_id=?")
      .get(this.command.scope, input.intentId) as Row | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new CoordinationError(
          "idempotency_conflict",
          "Dispatch intent was reused for different work",
        );
      if (expectedVersion === undefined)
        return {
          status: existing.state,
          created: false,
          taskId: existing.task_id,
          routeId: existing.route_id,
          path: existing.path,
        };
      if (existing.state !== "released")
        throw new CoordinationError(
          "conflict",
          "Previous dispatch must be released before reassignment",
        );
    }
    if (!existing && expectedVersion !== undefined)
      throw new CoordinationError(
        "not_found",
        "Cannot reassign an unknown dispatch",
      );
    const counts = this.db
      .prepare(
        "SELECT route_id,COUNT(*) AS count FROM dispatch_intents WHERE scope=? AND state<>'released' GROUP BY route_id",
      )
      .all(this.command.scope) as Array<{ route_id: string; count: number }>;
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const selection = selectExecutionRoute(
      {
        scope: this.command.scope,
        worktree: contract.worktree,
        capabilities,
        durable: input.durable,
        host: input.host,
      },
      policy.routes.map((route) => ({
        ...route,
        active:
          route.active +
          (counts.find((row) => row.route_id === route.id)?.count ?? 0),
      })),
      { ...policy, active: policy.active + total },
      this.at,
    );
    if (selection.status === "blocked") return selection;
    if (existing && expectedVersion !== undefined) {
      this.tasks.retry({ taskId: existing.task_id, expectedVersion });
      this.db
        .prepare(
          "UPDATE dispatch_intents SET route_id=?,path=?,state='reserved',provision_token=NULL,external_id=NULL,worker_session=NULL,attempt_id=NULL,fence=NULL WHERE scope=? AND intent_id=?",
        )
        .run(
          selection.routeId,
          selection.path,
          this.command.scope,
          input.intentId,
        );
      this.change("dispatch.reassigned", input.intentId, {
        taskId: existing.task_id,
        routeId: selection.routeId,
        path: selection.path,
      });
      return {
        status: "reserved",
        created: false,
        taskId: existing.task_id,
        routeId: selection.routeId,
        path: selection.path,
      };
    }
    const { task } = this.tasks.create({ title: input.title, contract });
    this.db
      .prepare(
        "INSERT INTO dispatch_intents(scope,intent_id,fingerprint,task_id,route_id,path,state,creator,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?)",
      )
      .run(
        this.command.scope,
        input.intentId,
        fingerprint,
        task.id,
        selection.routeId,
        selection.path,
        this.command.actor,
        this.at,
      );
    this.change("dispatch.reserved", input.intentId, {
      taskId: task.id,
      routeId: selection.routeId,
      path: selection.path,
    });
    return {
      status: "reserved",
      created: true,
      taskId: task.id,
      routeId: selection.routeId,
      path: selection.path,
    };
  }
}
