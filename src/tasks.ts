import { randomUUID } from "node:crypto";
import { db } from "./db";
import { emit } from "./events";
import {
  TASK_STATUSES,
  TASK_TYPES,
  type TaskStatus,
  type TaskType,
} from "./generated/protocol";
import { prune } from "./registry";
import { stamp } from "./time";

export { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType };

type TaskRow = {
  id: string;
  scope: string;
  requester: string;
  assignee: string | null;
  status: TaskStatus;
  files: string | null;
  depends_on: string | null;
  priority: number;
  idempotency_key: string | null;
  parent_task_id: string | null;
};

type TaskRelationFields = Pick<RequestOpts, "depends_on" | "parent_task_id">;
type TaskCreationFields = {
  id: string;
  scope: string;
  requester: string;
  type: TaskType;
  title: string;
  description: string | null;
  assignee: string | null;
  files: string[] | null;
  priority: number;
  depends_on: string[] | null;
  idempotency_key: string | null;
  parent_task_id: string | null;
  approval_required: boolean;
};
type PreparedTaskInsert = TaskCreationFields & {
  status: TaskStatus;
  result: string | null;
};

export interface RequestOpts {
  description?: string;
  files?: string[];
  assignee?: string;
  priority?: number;
  depends_on?: string[];
  idempotency_key?: string;
  parent_task_id?: string;
  approval_required?: boolean;
}

export type RequestResult =
  | { id: string; status: TaskStatus; existing?: boolean }
  | { error: string };

export type TaskSnapshot = {
  open: Array<Record<string, unknown>>;
  claimed: Array<Record<string, unknown>>;
  in_progress: Array<Record<string, unknown>>;
  done: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
  cancelled: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  approval_required: Array<Record<string, unknown>>;
};

function row(task: Record<string, unknown>) {
  if (typeof task.files === "string") task.files = JSON.parse(task.files);
  if (typeof task.depends_on === "string")
    task.depends_on = JSON.parse(task.depends_on);
  return task;
}

// ---------------------------------------------------------------------------
// Dependency cascade helpers
// ---------------------------------------------------------------------------

/** When a task completes, check if any blocked tasks can be unblocked. */
function processCompletion(completedId: string, scope: string) {
  const blocked = db
    .query(
      `SELECT id, depends_on, assignee FROM tasks
       WHERE scope = ? AND status = 'blocked' AND depends_on IS NOT NULL`,
    )
    .all(scope) as Array<{
    id: string;
    depends_on: string;
    assignee: string | null;
  }>;

  for (const task of blocked) {
    const deps = JSON.parse(task.depends_on) as string[];
    if (!deps.includes(completedId)) continue;

    const state = dependencyState(scope, deps);

    if (state.kind === "failed") {
      db.run(
        `UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?`,
        [autoCancelledResult(state.depId, state.depStatus), stamp(), task.id],
      );
      emit({
        scope,
        type: "task.cascade.cancelled",
        actor: "system",
        subject: task.id,
        payload: { trigger: completedId, reason: "dependency_failed" },
      });
      processFailure(task.id, scope);
    } else if (state.kind === "ready") {
      const newStatus = task.assignee ? "claimed" : "open";
      db.run(
        "UPDATE tasks SET status = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?",
        [newStatus, stamp(), task.id],
      );
      emit({
        scope,
        type: "task.cascade.unblocked",
        actor: "system",
        subject: task.id,
        payload: { trigger: completedId, status: newStatus },
      });
    }
  }
}

/** When a task fails or is cancelled, auto-cancel all dependents recursively. */
function processFailure(failedId: string, scope: string) {
  const dependents = db
    .query(
      `SELECT id, depends_on FROM tasks
       WHERE scope = ? AND status IN ('blocked', 'approval_required')
       AND depends_on IS NOT NULL`,
    )
    .all(scope) as Array<{ id: string; depends_on: string }>;

  for (const task of dependents) {
    const deps = JSON.parse(task.depends_on) as string[];
    if (!deps.includes(failedId)) continue;

    db.run(
      `UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?`,
      [`auto-cancelled: dependency ${failedId} failed`, stamp(), task.id],
    );
    emit({
      scope,
      type: "task.cascade.cancelled",
      actor: "system",
      subject: task.id,
      payload: { trigger: failedId, reason: "dependency_failed" },
    });

    // Recursive cascade
    processFailure(task.id, scope);
  }
}

function autoCancelledResult(depId: string, depStatus: "failed" | "cancelled") {
  return `auto-cancelled: dependency ${depId} is already ${depStatus}`;
}

function dependencyState(scope: string, depIds?: string[]) {
  if (!depIds?.length) return { kind: "ready" as const };

  let allDone = true;

  for (const depId of depIds) {
    const dep = db
      .query("SELECT status FROM tasks WHERE id = ? AND scope = ?")
      .get(depId, scope) as { status: TaskStatus } | null;

    if (dep?.status === "failed" || dep?.status === "cancelled") {
      return { kind: "failed" as const, depId, depStatus: dep.status };
    }

    if (dep?.status !== "done") allDone = false;
  }

  return allDone
    ? { kind: "ready" as const }
    : { kind: "blocked" as const };
}

/** Determine initial status based on deps, assignee, and approval flag. */
function initialState(scope: string, opts: RequestOpts) {
  const deps = dependencyState(scope, opts.depends_on);

  if (deps.kind === "failed") {
    return {
      status: "cancelled" as TaskStatus,
      result: autoCancelledResult(deps.depId, deps.depStatus),
    };
  }

  if (opts.approval_required) return { status: "approval_required" as TaskStatus, result: null };

  if (deps.kind === "blocked") return { status: "blocked" as TaskStatus, result: null };

  return { status: opts.assignee ? ("claimed" as TaskStatus) : ("open" as TaskStatus), result: null };
}

function findExistingTask(scope: string, idempotency_key?: string) {
  if (!idempotency_key) return null;
  return db
    .query(
      "SELECT id, status FROM tasks WHERE scope = ? AND idempotency_key = ?",
    )
    .get(scope, idempotency_key) as {
    id: string;
    status: TaskStatus;
  } | null;
}

function validateTaskRelations(scope: string, relations: TaskRelationFields) {
  if (relations.depends_on?.length) {
    for (const depId of relations.depends_on) {
      const dep = db
        .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
        .get(depId, scope);
      if (!dep) return `Dependency task ${depId} not found in scope`;
    }
  }

  if (!relations.parent_task_id) return null;
  const parent = db
    .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
    .get(relations.parent_task_id, scope);
  if (!parent) {
    return `Parent task ${relations.parent_task_id} not found in scope`;
  }
  return null;
}

function prepareTaskInsert(fields: TaskCreationFields): PreparedTaskInsert {
  const state = initialState(fields.scope, {
    assignee: fields.assignee ?? undefined,
    depends_on: fields.depends_on ?? undefined,
    approval_required: fields.approval_required,
  });

  return {
    ...fields,
    status: state.status,
    result: state.result,
  };
}

function insertPreparedTask(
  task: PreparedTaskInsert,
  extraPayload: Record<string, unknown> = {},
) {
  db.run(
    `INSERT INTO tasks (id, scope, type, title, description, requester, assignee, files, status, priority, depends_on, idempotency_key, parent_task_id, result, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.scope,
      task.type,
      task.title,
      task.description,
      task.requester,
      task.assignee,
      task.files ? JSON.stringify(task.files) : null,
      task.status,
      task.priority,
      task.depends_on?.length ? JSON.stringify(task.depends_on) : null,
      task.idempotency_key,
      task.parent_task_id,
      task.result,
      stamp(),
    ],
  );
  emit({
    scope: task.scope,
    type: "task.created",
    actor: task.requester,
    subject: task.id,
    payload: {
      task_type: task.type,
      title: task.title,
      status: task.status,
      assignee: task.assignee,
      parent_task_id: task.parent_task_id,
      depends_on: task.depends_on,
      ...extraPayload,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function request(
  requester: string,
  scope: string,
  type: TaskType,
  title: string,
  opts: RequestOpts = {},
): RequestResult {
  prune();

  // Idempotency: return existing task if key matches
  const existing = findExistingTask(scope, opts.idempotency_key);
  if (existing) {
    return { id: existing.id, status: existing.status, existing: true };
  }

  const relationError = validateTaskRelations(scope, opts);
  if (relationError) return { error: relationError };

  const prepared = prepareTaskInsert({
    id: randomUUID(),
    scope,
    requester,
    type,
    title,
    description: opts.description ?? null,
    assignee: opts.assignee ?? null,
    files: opts.files ?? null,
    priority: opts.priority ?? 0,
    depends_on: opts.depends_on ?? null,
    idempotency_key: opts.idempotency_key ?? null,
    parent_task_id: opts.parent_task_id ?? null,
    approval_required: opts.approval_required ?? false,
  });

  insertPreparedTask(prepared);
  return { id: prepared.id, status: prepared.status };
}

export function claim(id: string, scope: string, assignee: string) {
  const result = db.run(
    `UPDATE tasks
     SET assignee = ?, status = 'claimed', updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ? AND status = 'open' AND assignee IS NULL`,
    [assignee, stamp(), id, scope],
  );

  if (result.changes > 0) {
    emit({
      scope,
      type: "task.claimed",
      actor: assignee,
      subject: id,
    });
    return { ok: true as const };
  }

  const task = db
    .query("SELECT status FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as { status: TaskStatus } | null;

  if (!task) return { error: "Task not found" };
  return { error: `Task is already ${task.status}` };
}

export function update(
  id: string,
  scope: string,
  actor: string,
  status: "in_progress" | "done" | "failed" | "cancelled",
  result?: string,
) {
  const tx = db.transaction(() => {
    const task = db
      .query(
        "SELECT id, scope, requester, assignee, status, files, depends_on FROM tasks WHERE id = ? AND scope = ?",
      )
      .get(id, scope) as TaskRow | null;

    if (!task) return { error: "Task not found" };

    // Terminal states are final
    if (["done", "failed", "cancelled"].includes(task.status)) {
      return { error: `Task is already ${task.status}` };
    }

    // Blocked/approval_required can only be cancelled
    if (
      (task.status === "blocked" || task.status === "approval_required") &&
      status !== "cancelled"
    ) {
      const hint =
        task.status === "blocked"
          ? "It will auto-unblock when dependencies complete."
          : "Use approve_task to approve it first.";
      return { error: `Task is ${task.status}. ${hint}` };
    }

    // Permission checks
    if (status === "cancelled") {
      if (task.requester !== actor && task.assignee !== actor) {
        return { error: "Only the requester or assignee can cancel this task" };
      }
    } else {
      if (!task.assignee)
        return { error: "Task must be claimed before it can be updated" };
      if (task.assignee !== actor)
        return { error: "Only the assignee can update this task" };
    }

    if (status === "in_progress" && task.status !== "claimed") {
      return { error: "Task must be claimed before it can move to in_progress" };
    }

    db.run(
      "UPDATE tasks SET status = ?, result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ? AND scope = ?",
      [status, result ?? null, stamp(), id, scope],
    );
    emit({
      scope,
      type: "task.updated",
      actor,
      subject: id,
      payload: { status, prior_status: task.status },
    });

    // Dependency cascades
    if (status === "done") {
      processCompletion(id, scope);
    } else if (status === "failed" || status === "cancelled") {
      processFailure(id, scope);
    }

    return { ok: true as const };
  });
  return tx();
}

export function approve(id: string, scope: string) {
  const tx = db.transaction(() => {
    const task = db
      .query(
        "SELECT id, scope, depends_on, assignee, status FROM tasks WHERE id = ? AND scope = ?",
      )
      .get(id, scope) as TaskRow | null;

    if (!task) return { error: "Task not found" };
    if (task.status !== "approval_required") {
      return { error: `Task is ${task.status}, not approval_required` };
    }

    // Check if any dependency has failed/cancelled
    if (task.depends_on) {
      const deps = JSON.parse(task.depends_on as string) as string[];
      const state = dependencyState(scope, deps);

      if (state.kind === "failed") {
        db.run(
          "UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?",
          [autoCancelledResult(state.depId, state.depStatus), stamp(), id],
        );
        emit({
          scope,
          type: "task.cascade.cancelled",
          actor: "system",
          subject: id,
          payload: { trigger: state.depId, reason: "dependency_failed" },
        });
        processFailure(id, scope);
        return {
          ok: true as const,
          status: "cancelled" as TaskStatus,
          reason: "dependency_failed",
        };
      }

      if (state.kind === "blocked") {
        db.run(
          "UPDATE tasks SET status = 'blocked', updated_at = unixepoch(), changed_at = ? WHERE id = ?",
          [stamp(), id],
        );
        emit({
          scope,
          type: "task.approved",
          actor: null,
          subject: id,
          payload: { status: "blocked" },
        });
        return { ok: true as const, status: "blocked" as TaskStatus };
      }
    }

    const newStatus: TaskStatus = task.assignee ? "claimed" : "open";
    db.run(
      "UPDATE tasks SET status = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?",
      [newStatus, stamp(), id],
    );
    emit({
      scope,
      type: "task.approved",
      actor: null,
      subject: id,
      payload: { status: newStatus },
    });
    return { ok: true as const, status: newStatus };
  });
  return tx();
}

// ---------------------------------------------------------------------------
// Batch creation
// ---------------------------------------------------------------------------

export interface BatchTaskSpec {
  type: TaskType;
  title: string;
  description?: string;
  files?: string[];
  assignee?: string;
  priority?: number;
  depends_on?: string[]; // mix of $N refs and external task IDs
  idempotency_key?: string;
  parent_task_id?: string; // $N ref or external task ID
  approval_required?: boolean;
}

export interface BatchTaskResult {
  id: string;
  status: TaskStatus;
  idempotency_key?: string;
  new: boolean;
}

export type BatchResult =
  | { task_ids: string[]; created: number; existing: number; tasks: BatchTaskResult[] }
  | { error: string; details?: Array<{ task_index: number; field: string; message: string }> };

const REF_PATTERN = /^\$(\d+)$/;
const MAX_BATCH_SIZE = 50;

function isRef(s: string): number | null {
  const m = REF_PATTERN.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

export function requestBatch(
  requester: string,
  scope: string,
  specs: BatchTaskSpec[],
  /** Callback to validate assignee is active in scope. Called per-assignee. */
  validateAssignee?: (id: string) => boolean,
): BatchResult {
  prune();

  if (specs.length === 0) return { error: "Batch must contain at least one task" };
  if (specs.length > MAX_BATCH_SIZE) return { error: `Batch exceeds max size of ${MAX_BATCH_SIZE}` };

  const errors: Array<{ task_index: number; field: string; message: string }> = [];

  const seenIdempotency = new Map<string, number>();
  for (let i = 0; i < specs.length; i++) {
    const key = specs[i].idempotency_key;
    if (!key) continue;

    const first = seenIdempotency.get(key);
    if (first !== undefined) {
      errors.push({
        task_index: i,
        field: "idempotency_key",
        message: `Duplicate idempotency_key ${key} also used by task ${first + 1}`,
      });
      continue;
    }

    seenIdempotency.set(key, i);
  }

  if (errors.length > 0) return { error: "Validation failed", details: errors };

  // Phase 1: Resolve idempotency keys — determine which tasks are new vs existing
  const resolved: Array<{ id: string; status: TaskStatus; isNew: boolean }> = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const existing = findExistingTask(scope, spec.idempotency_key);
    if (existing) {
      resolved.push({ id: existing.id, status: existing.status, isNew: false });
      continue;
    }
    resolved.push({ id: randomUUID(), status: "open", isNew: true }); // status computed later
  }

  // Phase 2: Validate $N references and resolve them to actual IDs
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!resolved[i].isNew) continue; // skip existing tasks — no validation needed

    // Validate $N refs in depends_on
    if (spec.depends_on) {
      for (let j = 0; j < spec.depends_on.length; j++) {
        const ref = spec.depends_on[j];
        const n = isRef(ref);
        if (n !== null) {
          if (n < 1 || n > specs.length) {
            errors.push({ task_index: i, field: "depends_on", message: `${ref} is out of range (batch has ${specs.length} tasks)` });
          } else if (n === i + 1) {
            errors.push({ task_index: i, field: "depends_on", message: `${ref} is a self-reference` });
          } else if (n > i + 1) {
            errors.push({ task_index: i, field: "depends_on", message: `${ref} is a forward reference (not allowed — task ${i + 1} cannot depend on task ${n})` });
          }
        }
      }
    }

    // Validate $N ref in parent_task_id
    if (spec.parent_task_id) {
      const n = isRef(spec.parent_task_id);
      if (n !== null) {
        if (n < 1 || n > specs.length) {
          errors.push({ task_index: i, field: "parent_task_id", message: `${spec.parent_task_id} is out of range` });
        } else if (n === i + 1) {
          errors.push({ task_index: i, field: "parent_task_id", message: `${spec.parent_task_id} is a self-reference` });
        } else if (n > i + 1) {
          errors.push({ task_index: i, field: "parent_task_id", message: `${spec.parent_task_id} is a forward reference` });
        }
      }
    }

    // Validate assignee
    if (spec.assignee && validateAssignee && !validateAssignee(spec.assignee)) {
      errors.push({ task_index: i, field: "assignee", message: `Instance ${spec.assignee} is not active in this scope` });
    }
  }

  if (errors.length > 0) return { error: "Validation failed", details: errors };

  // Phase 3: Resolve $N refs to actual UUIDs and validate external refs
  const resolvedSpecs: Array<{ depends_on: string[] | null; parent_task_id: string | null }> = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    let resolvedDeps: string[] | null = null;
    let resolvedParent: string | null = null;

    if (spec.depends_on?.length) {
      resolvedDeps = [];
      for (const ref of spec.depends_on) {
        const n = isRef(ref);
        if (n !== null) {
          resolvedDeps.push(resolved[n - 1].id);
        } else {
          // External task ID — validate it exists
          if (resolved[i].isNew) {
            const ext = db
              .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
              .get(ref, scope);
            if (!ext) {
              return { error: "Validation failed", details: [{ task_index: i, field: "depends_on", message: `External task ${ref} not found in scope` }] };
            }
          }
          resolvedDeps.push(ref);
        }
      }
    }

    if (spec.parent_task_id) {
      const n = isRef(spec.parent_task_id);
      if (n !== null) {
        resolvedParent = resolved[n - 1].id;
      } else {
        // External parent — validate
        if (resolved[i].isNew) {
          const ext = db
            .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
            .get(spec.parent_task_id, scope);
          if (!ext) {
            return { error: "Validation failed", details: [{ task_index: i, field: "parent_task_id", message: `Parent task ${spec.parent_task_id} not found in scope` }] };
          }
        }
        resolvedParent = spec.parent_task_id;
      }
    }

    resolvedSpecs.push({ depends_on: resolvedDeps, parent_task_id: resolvedParent });
  }

  // Phase 4: Compute statuses and insert in a single transaction
  const tx = db.transaction(() => {
    for (let i = 0; i < specs.length; i++) {
      if (!resolved[i].isNew) continue;

      const spec = specs[i];
      const deps = resolvedSpecs[i].depends_on;
      const parentId = resolvedSpecs[i].parent_task_id;

      const prepared = prepareTaskInsert({
        id: resolved[i].id,
        scope,
        requester,
        type: spec.type,
        title: spec.title,
        description: spec.description ?? null,
        assignee: spec.assignee ?? null,
        files: spec.files ?? null,
        priority: spec.priority ?? 0,
        depends_on: deps,
        idempotency_key: spec.idempotency_key ?? null,
        parent_task_id: parentId,
        approval_required: spec.approval_required ?? false,
      });

      resolved[i].status = prepared.status;
      insertPreparedTask(prepared, { batch_index: i });
    }
  });
  tx();

  // Build result
  const taskResults: BatchTaskResult[] = resolved.map((r, i) => ({
    id: r.id,
    status: r.status,
    ...(specs[i].idempotency_key ? { idempotency_key: specs[i].idempotency_key } : {}),
    new: r.isNew,
  }));

  return {
    task_ids: resolved.map((r) => r.id),
    created: resolved.filter((r) => r.isNew).length,
    existing: resolved.filter((r) => !r.isNew).length,
    tasks: taskResults,
  };
}

export function get(id: string, scope: string) {
  prune();

  const task = db
    .query("SELECT * FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as Record<string, unknown> | null;
  if (!task) return null;
  return row(task);
}

export function list(
  scope: string,
  filter?: {
    status?: TaskStatus;
    assignee?: string;
    requester?: string;
  },
) {
  prune();

  const where = ["scope = ?"];
  const args: string[] = [scope];

  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter?.assignee) {
    where.push("assignee = ?");
    args.push(filter.assignee);
  }
  if (filter?.requester) {
    where.push("requester = ?");
    args.push(filter.requester);
  }

  const rows = db
    .query(
      `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .all(...args) as Array<Record<string, unknown>>;

  return rows.map((item) => row(item));
}

export function snapshot(scope: string): TaskSnapshot {
  prune();

  const grouped: TaskSnapshot = {
    open: [],
    claimed: [],
    in_progress: [],
    done: [],
    failed: [],
    cancelled: [],
    blocked: [],
    approval_required: [],
  };

  const rows = db
    .query(
      `SELECT * FROM tasks WHERE scope = ? ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .all(scope) as Array<Record<string, unknown>>;

  for (const item of rows) {
    const task = row(item) as Record<string, unknown> & { status: TaskStatus };
    grouped[task.status].push(task);
  }

  return grouped;
}

export function cleanup() {
  db.run(
    "DELETE FROM tasks WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?",
    [Math.floor(Date.now() / 1000) - 86400],
  );
}
