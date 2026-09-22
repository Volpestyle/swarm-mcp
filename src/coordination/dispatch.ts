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
      row.provision_token !== input.token
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
      return {
        status: existing.state,
        created: false,
        taskId: existing.task_id,
        routeId: existing.route_id,
        path: existing.path,
      };
    }
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
