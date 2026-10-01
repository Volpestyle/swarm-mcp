import { createHash, randomUUID } from "node:crypto";
import type { Sqlite } from "./sqlite";
import type { Command, Json, Task } from "./store";
import { CoordinationError, requireText } from "./errors";
import { validateSession, type SessionContext } from "./sessions";
import { validateTaskContract, type TaskContract } from "./task-contract";
import { TaskTransaction } from "./tasks";
import { executionModes, selectExecutionRoute, type ExecutionMode, type ExecutionRoute } from "./routing";

export interface DispatchIntent {
  intentId: string;
  title: string;
  contract: TaskContract;
  capabilities: string[];
  durable: boolean;
  host?: string;
  /** Requested execution. Omitted values resolve from the selected route and
   * stay distinguishable from explicit choices in the fingerprint. */
  execution?: { mode?: ExecutionMode };
}
export interface DispatchPolicy {
  /** Resolved outside the transaction; never rewrites the immutable intent. */
  requestedWorktree?: string;
  routes: readonly ExecutionRoute[];
  active: number;
  maximum: number | null;
  observationMaxAgeMs: number;
}
type Row = {
  intent_id: string;
  task_id: string;
  route_id: string;
  path: "native" | "peer";
  state: string;
  fingerprint: string;
  harness: string | null;
  provision_token: string | null;
  external_id: string | null;
  worker_session: string | null;
  attempt_id: string | null;
  fence: number | null;
  execution_mode: ExecutionMode | null;
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
        executionMode: row.execution_mode,
        harness: row.harness,
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
      harness: row.harness,
    });
    return {
      status: "provisioning",
      start: true,
      token,
      taskId: row.task_id,
      routeId: row.route_id,
      executionMode: row.execution_mode,
      harness: row.harness,
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
      return { status: "released", taskId: row.task_id, harness: row.harness, existing: true };
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
    // Retire obsolete control envelopes without claiming they were processed.
    // User replies/results remain available; terminal failures retain their audit.
    if (row.worker_session) {
      const controls = this.db.prepare(`SELECT d.message_id,d.recipient FROM inbox_deliveries d
        JOIN inbox_messages m ON m.id=d.message_id JOIN sessions s ON s.id=? AND s.agent_id=d.recipient
        WHERE m.scope=? AND m.task_id=? AND m.kind IN ('task.assigned','task.cancel_requested')
        AND d.state IN ('pending','leased')`).all(row.worker_session, this.command.scope, row.task_id) as Array<{ message_id: string; recipient: string }>;
      for (const delivery of controls) {
        this.db.prepare("UPDATE inbox_deliveries SET state='expired',lease_token=NULL,lease_until=NULL,last_error='dispatch_released' WHERE message_id=? AND recipient=?")
          .run(delivery.message_id, delivery.recipient);
        this.change("delivery.expired", delivery.message_id, { recipient: delivery.recipient, reason: "dispatch_released" });
      }
    }
    return { status: "released", taskId: row.task_id, harness: row.harness, existing: false };
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
      harness: row.harness,
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

  /** Trusted launch preparation pins the one enrollment allowed to claim readiness. */
  expectWorker(input: { intentId: string; token: string; worker: SessionContext }) {
    const row = this.intent(input.intentId);
    validateSession(this.db, input.worker);
    if (row.state !== "provisioning" || row.provision_token !== input.token ||
        input.worker.scope !== this.command.scope ||
        (row.worker_session !== null && row.worker_session !== input.worker.sessionId))
      throw new CoordinationError("conflict", "Worker does not match provisioning receipt");
    this.db.prepare("UPDATE dispatch_intents SET worker_session=? WHERE scope=? AND intent_id=?")
      .run(input.worker.sessionId, this.command.scope, input.intentId);
    return { taskId: row.task_id };
  }

  workerReady(input: { intentId: string; token: string; externalId: string }) {
    const row = this.intent(input.intentId);
    if (row.worker_session !== this.command.sessionId || row.provision_token !== input.token)
      throw new CoordinationError("forbidden", "Readiness must come from the pinned worker enrollment");
    const accepted = this.bind({ ...input, routeId: row.route_id, worker: this.command as SessionContext });
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(row.task_id) as Task;
    return { ...accepted, contract: task.contract ? JSON.parse(task.contract) as Json : null };
  }

  workerHealth(input: { intentId: string; token: string; reason: string }) {
    const row = this.intent(input.intentId);
    if (row.worker_session !== this.command.sessionId || row.provision_token !== input.token ||
        !["provisioning", "bound"].includes(row.state))
      throw new CoordinationError("forbidden", "Health report does not match worker launch");
    if (!["mcp_disconnected", "stale_progress", "coordinator_version_mismatch"].includes(input.reason))
      throw new CoordinationError("invalid_input", "Unknown worker health reason");
    const task = this.db.prepare("SELECT creator,current_attempt,status FROM tasks WHERE id=?").get(row.task_id) as { creator: string; current_attempt: string | null; status: string };
    if (row.state === "bound" && (task.current_attempt !== row.attempt_id || !["running", "cancel_requested"].includes(task.status)))
      throw new CoordinationError("stale_attempt", "Health report belongs to a finished or replaced attempt");
    const notice = { taskId: row.task_id, attemptId: row.attempt_id, fence: row.fence,
      intentId: input.intentId, status: `blocked:${input.reason}` };
    this.change("dispatch.worker_blocked", input.intentId, notice);
    return { ...notice, recipient: task.creator };
  }

  readyStatus(input: { intentId: string; token: string; worker: SessionContext }) {
    const row = this.intent(input.intentId);
    if (row.provision_token !== input.token || row.worker_session !== input.worker.sessionId)
      throw new CoordinationError("conflict", "Readiness receipt does not match launch");
    validateSession(this.db, input.worker);
    if (row.state !== "bound") return { ready: false, externalId: null, attemptId: null, fence: null };
    const unhealthy = this.db.prepare("SELECT 1 FROM events WHERE scope=? AND type='dispatch.worker_blocked' AND entity_id=? AND json_extract(payload,'$.attemptId')=? AND json_extract(payload,'$.status') IN ('blocked:mcp_disconnected','blocked:coordinator_version_mismatch') LIMIT 1")
      .get(this.command.scope, input.intentId, row.attempt_id);
    if (unhealthy) throw new CoordinationError("worker_mcp_unavailable", "This worker reported MCP loss; reconcile the retained attempt before resuming");
    const claim = this.db.prepare("SELECT a.id FROM task_attempts a JOIN tasks t ON t.current_attempt=a.id WHERE a.id=? AND a.session_id=? AND a.generation=? AND a.fence=? AND a.state='running' AND a.lease_until>?")
      .get(row.attempt_id, input.worker.sessionId, input.worker.generation, row.fence, this.at);
    if (!claim) throw new CoordinationError("worker_claim_failed", "Worker readiness has no current fenced claim");
    return { ready: true, externalId: row.external_id, attemptId: row.attempt_id, fence: row.fence };
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
        harness: row.harness,
        attemptId: row.attempt_id!,
        fence: row.fence!,
        existing: true,
      };
    }
    if (row.state !== "provisioning")
      throw new CoordinationError("conflict", "Dispatch is not provisioning");
    if (row.worker_session !== null && (row.worker_session !== this.command.sessionId ||
        input.worker.sessionId !== this.command.sessionId || input.worker.actor !== this.command.actor))
      throw new CoordinationError("worker_claim_failed", "Pinned worker must claim through its own authenticated MCP request");
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
      harness: row.harness,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
    });
    return {
      taskId: row.task_id,
      harness: row.harness,
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
    if (input.execution !== undefined && (!input.execution || typeof input.execution !== "object" || Array.isArray(input.execution) ||
        Object.keys(input.execution).some(key => key !== "mode") ||
        (input.execution.mode !== undefined && !executionModes.includes(input.execution.mode))))
      throw new CoordinationError("invalid_input", "execution accepts mode: interactive or stream");
    const capabilities = [...new Set(input.capabilities)].sort();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          title: input.title,
          contract,
          capabilities,
          durable: input.durable,
          host: input.host ?? null,
          // Absent for requests without a selection, so their fingerprints are unchanged.
          ...(input.execution?.mode ? { execution: { mode: input.execution.mode } } : {}),
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
          harness: existing.harness,
          path: existing.path,
          executionMode: existing.execution_mode,
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
        worktree: policy.requestedWorktree ?? contract.worktree,
        capabilities,
        durable: input.durable,
        host: input.host ?? (existing?.harness && ["claude-code", "codex", "pi"].includes(existing.harness) ? existing.harness : undefined),
        executionMode: input.execution?.mode ?? existing?.execution_mode ?? undefined,
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
    const harness = policy.routes.find(route => route.id === selection.routeId)!.host;
    if (existing && expectedVersion !== undefined) {
      this.tasks.retry({ taskId: existing.task_id, expectedVersion });
      this.db
        .prepare(
          "UPDATE dispatch_intents SET route_id=?,path=?,execution_mode=?,harness=?,state='reserved',provision_token=NULL,external_id=NULL,worker_session=NULL,attempt_id=NULL,fence=NULL WHERE scope=? AND intent_id=?",
        )
        .run(
          selection.routeId,
          selection.path,
          selection.executionMode ?? null,
          harness,
          this.command.scope,
          input.intentId,
        );
      this.change("dispatch.reassigned", input.intentId, {
        taskId: existing.task_id,
        routeId: selection.routeId,
        harness,
        path: selection.path,
        executionMode: selection.executionMode ?? null,
      });
      return {
        status: "reserved",
        created: false,
        taskId: existing.task_id,
        routeId: selection.routeId,
        harness,
        path: selection.path,
        executionMode: selection.executionMode ?? null,
      };
    }
    const { task } = this.tasks.create({ title: input.title, contract });
    this.db
      .prepare(
        "INSERT INTO dispatch_intents(scope,intent_id,fingerprint,task_id,route_id,path,execution_mode,harness,state,creator,created_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)",
      )
      .run(
        this.command.scope,
        input.intentId,
        fingerprint,
        task.id,
        selection.routeId,
        selection.path,
        selection.executionMode ?? null,
        harness,
        this.command.actor,
        this.at,
      );
    this.change("dispatch.reserved", input.intentId, {
      taskId: task.id,
      routeId: selection.routeId,
      harness,
      path: selection.path,
      executionMode: selection.executionMode ?? null,
    });
    return {
      status: "reserved",
      created: true,
      taskId: task.id,
      routeId: selection.routeId,
      harness,
      path: selection.path,
      executionMode: selection.executionMode ?? null,
    };
  }
}
