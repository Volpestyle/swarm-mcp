import { randomUUID } from "node:crypto";
import * as context from "./context";
import { cleanupTerminalTasks } from "./cleanup";
import { db } from "./db";
import { emit } from "./events";
import { identityMatches } from "./identity";
import {
  TASK_STATUSES,
  TASK_TYPES,
  type TaskStatus,
  type TaskType,
} from "./generated/protocol";
import { get as getInstance, prune, type Instance } from "./registry";
import { now, stamp } from "./time";

export { TASK_STATUSES, TASK_TYPES, type TaskStatus, type TaskType };

type TaskRow = {
  id: string;
  scope: string;
  title?: string | null;
  description?: string | null;
  requester: string;
  assignee: string | null;
  status: TaskStatus;
  files: string | null;
  depends_on: string | null;
  priority: number;
  idempotency_key: string | null;
  parent_task_id: string | null;
  review_of_task_id: string | null;
  fixes_task_id: string | null;
  progress_summary: string | null;
  progress_updated_at: number | null;
  blocked_reason: string | null;
  expected_next_update_at: number | null;
  tracker_required?: number | null;
  tracker_provider?: string | null;
};

function taskIdentityOwner(task: { requester?: string | null; assignee?: string | null }) {
  if (task.requester) {
    const requester = getInstance(task.requester);
    if (requester) return requester;
  }
  if (task.assignee) return getInstance(task.assignee);
  return null;
}

function canSeeTask(viewer: Instance | undefined, task: Record<string, unknown>) {
  if (!viewer) return true;
  if (task.requester === viewer.id || task.assignee === viewer.id) return true;
  const owner = taskIdentityOwner({
    requester: typeof task.requester === "string" ? task.requester : null,
    assignee: typeof task.assignee === "string" ? task.assignee : null,
  });
  return owner ? identityMatches(viewer, owner) : false;
}

type TaskRelationFields = Pick<
  RequestOpts,
  "depends_on" | "parent_task_id" | "review_of_task_id" | "fixes_task_id"
>;
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
  review_of_task_id: string | null;
  fixes_task_id: string | null;
  approval_required: boolean;
  tracker_required: boolean;
  tracker_provider: string | null;
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
  review_of_task_id?: string;
  fixes_task_id?: string;
  approval_required?: boolean;
  tracker_required?: boolean;
  tracker_provider?: string;
}

export interface StructuredTestResult {
  command?: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  notes?: string;
}

export interface StructuredCompletionResult {
  summary: string;
  files_changed: string[];
  tests: StructuredTestResult[];
  tracker_update?: unknown;
  tracker_update_skipped?: unknown;
  followups: string[];
}

export interface StructuredCompletionOpts {
  status?: "done" | "failed" | "cancelled";
  summary: string;
  files_changed?: string[];
  tests?: StructuredTestResult[];
  tracker_update?: unknown;
  tracker_update_skipped?: unknown;
  followups?: string[];
}

export interface ProgressOpts {
  blocked_reason?: string | null;
  expected_next_update_at?: number | null;
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
  terminal_counts?: Record<"done" | "failed" | "cancelled", number>;
};

export type SnapshotOpts = {
  include_terminal?: boolean;
  terminal_limit?: number;
};

export interface ClaimOpts {
  ignoreUnreadMessages?: boolean;
}

export interface ClaimNextOpts extends ClaimOpts {
  types?: TaskType[];
  files?: string[];
}

function marks(size: number) {
  return Array.from({ length: size }, () => "?").join(",");
}

function parseTaskFiles(value: unknown) {
  if (typeof value === "string") return JSON.parse(value) as string[];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hasFileOverlap(task: Record<string, unknown>, files: string[]) {
  if (!files.length) return true;
  const wanted = new Set(files);
  return parseTaskFiles(task.files).some((file) => wanted.has(file));
}

function structuredCompletionResult(
  opts: StructuredCompletionOpts,
): StructuredCompletionResult {
  return {
    summary: opts.summary,
    files_changed: [...new Set(opts.files_changed ?? [])],
    tests: opts.tests ?? [],
    ...(opts.tracker_update ? { tracker_update: opts.tracker_update } : {}),
    ...(opts.tracker_update_skipped ? { tracker_update_skipped: opts.tracker_update_skipped } : {}),
    followups: opts.followups ?? [],
  };
}

function hasTrackerDisposition(opts: StructuredCompletionOpts) {
  return opts.tracker_update !== undefined || opts.tracker_update_skipped !== undefined;
}

function isLinearBackedTask(task: {
  title?: string | null;
  description?: string | null;
  idempotency_key?: string | null;
}) {
  const haystack = [task.idempotency_key, task.title, task.description]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
  return /\blinear:[A-Z][A-Z0-9]*-\d+\b/i.test(haystack) ||
    /linear\.app\/[^\s]+\/issue\/[A-Z][A-Z0-9]*-\d+\b/i.test(haystack) ||
    /\b[A-Z][A-Z0-9]*-\d+\b/.test(haystack);
}

function hasOwn<K extends string>(
  value: object,
  key: K,
): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function row(task: Record<string, unknown>) {
  if (typeof task.files === "string") task.files = JSON.parse(task.files);
  if (typeof task.depends_on === "string")
    task.depends_on = JSON.parse(task.depends_on);
  return task;
}

function unreadMessageGate(scope: string, recipient: string) {
  const latest = db
    .query(
      `SELECT id, sender, created_at
       FROM messages
       WHERE scope = ? AND recipient = ? AND read = 0
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(scope, recipient) as
    | { id: number; sender: string; created_at: number }
    | null;

  if (!latest) return null;

  const count = db
    .query(
      `SELECT COUNT(*) as count
       FROM messages
       WHERE scope = ? AND recipient = ? AND read = 0`,
    )
    .get(scope, recipient) as { count: number };

  return {
    error:
      `Unread messages pending (${count.count}). Call bootstrap or poll_messages before claiming new work, ` +
      `or retry claim_task/claim_next_task with ignore_unread_messages=true if you intentionally want to skip them. ` +
      `Latest unread message: #${latest.id} from ${latest.sender}.`,
    unread_message_count: count.count,
    latest_message_id: latest.id,
    latest_message_sender: latest.sender,
  };
}

function hasOtherActiveTasks(scope: string, assignee: string, taskId: string) {
  const row = db
    .query(
      `SELECT COUNT(*) AS count
       FROM tasks
       WHERE scope = ?
         AND assignee = ?
         AND id != ?
         AND status IN ('claimed', 'in_progress')`,
    )
    .get(scope, assignee, taskId) as { count: number };
  return row.count > 0;
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
        payload: {
          trigger: completedId,
          reason: "dependency_failed",
          prior_status: "blocked",
          dependency_status: state.depStatus,
          result: autoCancelledResult(state.depId, state.depStatus),
        },
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
        payload: {
          trigger: completedId,
          status: newStatus,
          prior_status: "blocked",
        },
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

    const cancelResult = `auto-cancelled: dependency ${failedId} failed`;
    db.run(
      `UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?`,
      [cancelResult, stamp(), task.id],
    );
    emit({
      scope,
      type: "task.cascade.cancelled",
      actor: "system",
      subject: task.id,
      payload: {
        trigger: failedId,
        reason: "dependency_failed",
        result: cancelResult,
      },
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

function validateExistingTaskId(scope: string, field: string, id: string) {
  const task = db
    .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope);
  if (!task) return `${field} task ${id} not found in scope`;
  return null;
}

function validateTaskRelations(scope: string, relations: TaskRelationFields) {
  if (relations.depends_on?.length) {
    for (const depId of relations.depends_on) {
      const error = validateExistingTaskId(scope, "Dependency", depId);
      if (error) return error;
    }
  }

  if (relations.parent_task_id) {
    const error = validateExistingTaskId(scope, "Parent", relations.parent_task_id);
    if (error) return error;
  }

  if (relations.review_of_task_id) {
    const error = validateExistingTaskId(scope, "Review target", relations.review_of_task_id);
    if (error) return error;
  }

  if (relations.fixes_task_id) {
    const error = validateExistingTaskId(scope, "Fix target", relations.fixes_task_id);
    if (error) return error;
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
    `INSERT INTO tasks (
       id, scope, type, title, description, requester, assignee, files, status,
       priority, depends_on, idempotency_key, parent_task_id, review_of_task_id,
       fixes_task_id, result, changed_at, tracker_required, tracker_provider
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      task.review_of_task_id,
      task.fixes_task_id,
      task.result,
      stamp(),
      task.tracker_required ? 1 : 0,
      task.tracker_provider,
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
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      parent_task_id: task.parent_task_id,
      review_of_task_id: task.review_of_task_id,
      fixes_task_id: task.fixes_task_id,
      depends_on: task.depends_on,
      files: task.files ?? null,
      priority: task.priority,
      result: task.result,
      tracker_required: task.tracker_required,
      tracker_provider: task.tracker_provider,
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
    review_of_task_id: opts.review_of_task_id ?? null,
    fixes_task_id: opts.fixes_task_id ?? null,
    approval_required: opts.approval_required ?? false,
    tracker_required:
      opts.tracker_required ??
      isLinearBackedTask({
        title,
        description: opts.description ?? null,
        idempotency_key: opts.idempotency_key ?? null,
      }),
    tracker_provider: opts.tracker_provider ?? null,
  });

  insertPreparedTask(prepared);
  return { id: prepared.id, status: prepared.status };
}

export function claim(
  id: string,
  scope: string,
  assignee: string,
  opts: ClaimOpts = {},
) {
  const before = db
    .query("SELECT status, requester, assignee FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as { status: TaskStatus; requester: string; assignee: string | null } | null;

  if (!before) return { error: "Task not found" };
  const actor = getInstance(assignee) ?? undefined;
  const owner = taskIdentityOwner(before);
  if (actor && owner && !identityMatches(actor, owner)) {
    return { error: "Task belongs to another identity" };
  }

  // Allowed: open + unassigned, or pre-assigned to this caller (status=claimed
  // when planner pre-set assignee). Everything else is a no-op.
  const isOpenForAnyone = before.status === "open" && before.assignee === null;
  const isPreassignedToMe =
    before.status === "claimed" && before.assignee === assignee;
  if (!isOpenForAnyone && !isPreassignedToMe) {
    return { error: `Task is already ${before.status}` };
  }

  if (!opts.ignoreUnreadMessages) {
    const gate = unreadMessageGate(scope, assignee);
    if (gate) return gate;
  }

  const result = db.run(
    `UPDATE tasks
     SET assignee = ?, status = 'in_progress', updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ?
       AND (
         (status = 'open' AND assignee IS NULL)
         OR (status = 'claimed' AND assignee = ?)
       )`,
    [assignee, stamp(), id, scope, assignee],
  );

  if (result.changes > 0) {
    emit({
      scope,
      type: "task.claimed",
      actor: assignee,
      subject: id,
      payload: { prior_status: before.status, status: "in_progress" },
    });
    return { ok: true as const };
  }

  const task = db
    .query("SELECT status FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as { status: TaskStatus } | null;

  if (!task) return { error: "Task not found" };
  return { error: `Task is already ${task.status}` };
}

export function claimNext(
  scope: string,
  assignee: string,
  opts: ClaimNextOpts = {},
) {
  prune();

  if (!opts.ignoreUnreadMessages) {
    const gate = unreadMessageGate(scope, assignee);
    if (gate) return gate;
  }

  const actor = getInstance(assignee) ?? undefined;
  const types = [...new Set(opts.types ?? [])];
  const files = [...new Set(opts.files ?? [])];
  const where = [
    "scope = ?",
    "((status = 'open' AND assignee IS NULL) OR (status = 'claimed' AND assignee = ?))",
  ];
  const args: unknown[] = [scope, assignee];

  if (types.length > 0) {
    where.push(`type IN (${marks(types.length)})`);
    args.push(...types);
  }

  const tx = db.transaction(() => {
    const candidates = db
      .query(
        `SELECT * FROM tasks
         WHERE ${where.join(" AND ")}
         ORDER BY
           CASE WHEN status = 'claimed' AND assignee = ? THEN 0 ELSE 1 END,
           priority DESC,
           created_at ASC,
           id ASC
         LIMIT 200`,
      )
      .all(...args, assignee) as Array<Record<string, unknown> & { id: string; status: TaskStatus }>;

    for (const candidate of candidates.map((item) => row(item)) as Array<Record<string, unknown> & { id: string; status: TaskStatus }>) {
      if (!canSeeTask(actor, candidate)) continue;
      if (!hasFileOverlap(candidate, files)) continue;

      const result = db.run(
        `UPDATE tasks
         SET assignee = ?, status = 'in_progress', updated_at = unixepoch(), changed_at = ?
         WHERE id = ? AND scope = ?
           AND (
             (status = 'open' AND assignee IS NULL)
             OR (status = 'claimed' AND assignee = ?)
           )`,
        [assignee, stamp(), candidate.id, scope, assignee],
      );

      if (result.changes === 0) continue;

      emit({
        scope,
        type: "task.claimed",
        actor: assignee,
        subject: candidate.id,
        payload: { prior_status: candidate.status, status: "in_progress", claim_next: true },
      });

      const task = db
        .query("SELECT * FROM tasks WHERE id = ? AND scope = ?")
        .get(candidate.id, scope) as Record<string, unknown> | null;

      return {
        ok: true as const,
        task_id: candidate.id,
        prior_status: candidate.status,
        task: task ? row(task) : null,
      };
    }

    return { error: "No claimable task found" };
  });

  return tx();
}

export function reserveForAssignee(id: string, scope: string, assignee: string) {
  const before = db
    .query("SELECT status, assignee FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as { status: TaskStatus; assignee: string | null } | null;

  if (!before) return { error: "Task not found" };
  if (before.status !== "open" || before.assignee !== null) {
    return { error: `Task is already ${before.status}` };
  }

  const result = db.run(
    `UPDATE tasks
     SET assignee = ?, status = 'claimed', updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ? AND status = 'open' AND assignee IS NULL`,
    [assignee, stamp(), id, scope],
  );

  if (result.changes > 0) {
    emit({
      scope,
      type: "task.reserved",
      actor: assignee,
      subject: id,
      payload: { prior_status: before.status, status: "claimed" },
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
  status: "done" | "failed" | "cancelled",
  result?: string,
) {
  const tx = db.transaction(() => {
    const task = db
      .query(
        `SELECT id, scope, requester, assignee, status, files, depends_on,
                review_of_task_id, fixes_task_id, progress_summary,
                progress_updated_at, blocked_reason, expected_next_update_at
         FROM tasks WHERE id = ? AND scope = ?`,
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

    db.run(
      `UPDATE tasks
       SET status = ?, result = ?, progress_summary = NULL, progress_updated_at = NULL,
           blocked_reason = NULL, expected_next_update_at = NULL,
           updated_at = unixepoch(), changed_at = ?
       WHERE id = ? AND scope = ?`,
      [status, result ?? null, stamp(), id, scope],
    );
    emit({
      scope,
      type: "task.updated",
      actor,
      subject: id,
      payload: {
        status,
        prior_status: task.status,
        result: result ?? null,
      },
    });

    // Terminal task updates release this task's declared files. If this was
    // the assignee's only active task, also sweep any remaining normal edit
    // locks so tasks without complete file lists do not leave stale locks.
    // Internal `/__swarm/` mutex locks are managed by their owning flow.
    if (task.assignee) {
      context.releaseInstanceLocksForTask(task.assignee, scope, id);
      const files = task.files ? (JSON.parse(task.files) as string[]) : [];
      if (files.length) {
        context.releaseInstanceLocksForFiles(task.assignee, scope, files);
      }
      if (!hasOtherActiveTasks(scope, task.assignee, id)) {
        context.releaseInstanceEditLocks(task.assignee, scope);
      }
    }

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

export function completeStructured(
  id: string,
  scope: string,
  actor: string,
  opts: StructuredCompletionOpts,
) {
  const task = db
    .query(
      "SELECT title, description, idempotency_key, tracker_required, tracker_provider FROM tasks WHERE id = ? AND scope = ?",
    )
    .get(id, scope) as
    | {
        title: string | null;
        description: string | null;
        idempotency_key: string | null;
        tracker_required: number | null;
        tracker_provider: string | null;
      }
    | null;
  if (!task) return { error: "Task not found" };
  if ((task.tracker_required || isLinearBackedTask(task)) && !hasTrackerDisposition(opts)) {
    return {
      error:
        "Tracker-backed tasks require tracker_update or tracker_update_skipped in complete_task",
    };
  }
  const structured = structuredCompletionResult(opts);
  const terminalStatus = opts.status ?? "done";
  const next = update(id, scope, actor, terminalStatus, JSON.stringify(structured));
  if ("ok" in next) {
    return {
      ...next,
      status: terminalStatus,
      result: structured,
    };
  }
  return next;
}

export function requireTrackerDisposition(
  id: string,
  scope: string,
  opts: { provider?: string | null } = {},
) {
  const result = db.run(
    `UPDATE tasks
     SET tracker_required = 1, tracker_provider = COALESCE(?, tracker_provider),
         updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ?`,
    [opts.provider ?? null, stamp(), id, scope],
  );
  if (result.changes === 0) return { error: "Task not found" };
  return { ok: true as const };
}

export function reportProgress(
  id: string,
  scope: string,
  actor: string,
  summary: string,
  opts: ProgressOpts = {},
) {
  const tx = db.transaction(() => {
    const task = db
      .query(
        `SELECT id, requester, assignee, status
         FROM tasks
         WHERE id = ? AND scope = ?`,
      )
      .get(id, scope) as Pick<TaskRow, "id" | "requester" | "assignee" | "status"> | null;

    if (!task) return { error: "Task not found" };
    if (["done", "failed", "cancelled"].includes(task.status)) {
      return { error: `Task is already ${task.status}` };
    }
    if (task.assignee !== actor) {
      return { error: "Only the assignee can report progress on this task" };
    }
    if (task.status !== "in_progress") {
      return { error: "Task must be in_progress before progress can be reported" };
    }

    const current = db
      .query(
        `SELECT blocked_reason, expected_next_update_at
         FROM tasks
         WHERE id = ? AND scope = ?`,
      )
      .get(id, scope) as {
      blocked_reason: string | null;
      expected_next_update_at: number | null;
    };

    const hasBlockedReason = hasOwn(opts, "blocked_reason");
    const hasExpectedNextUpdateAt = hasOwn(opts, "expected_next_update_at");
    const blockedReason = hasBlockedReason
      ? opts.blocked_reason ?? null
      : current.blocked_reason;
    const expectedNextUpdateAt = hasExpectedNextUpdateAt
      ? opts.expected_next_update_at ?? null
      : current.expected_next_update_at;
    const progressUpdatedAt = now();

    db.run(
      `UPDATE tasks
       SET progress_summary = ?, progress_updated_at = ?, blocked_reason = ?,
           expected_next_update_at = ?, updated_at = unixepoch(), changed_at = ?
       WHERE id = ? AND scope = ?`,
      [
        summary,
        progressUpdatedAt,
        blockedReason,
        expectedNextUpdateAt,
        stamp(),
        id,
        scope,
      ],
    );
    emit({
      scope,
      type: "task.progress",
      actor,
      subject: id,
      payload: {
        summary,
        blocked_reason: blockedReason,
        expected_next_update_at: expectedNextUpdateAt,
        progress_updated_at: progressUpdatedAt,
      },
    });

    return {
      ok: true as const,
      progress_summary: summary,
      progress_updated_at: progressUpdatedAt,
      blocked_reason: blockedReason,
      expected_next_update_at: expectedNextUpdateAt,
    };
  });
  return tx();
}

export function approve(id: string, scope: string, actor?: string) {
  const tx = db.transaction(() => {
    const task = db
      .query(
        "SELECT id, scope, requester, depends_on, assignee, status FROM tasks WHERE id = ? AND scope = ?",
      )
      .get(id, scope) as TaskRow | null;

    if (!task) return { error: "Task not found" };
    if (actor) {
      const actorInst = getInstance(actor);
      const owner = taskIdentityOwner(task);
      if (actorInst && owner && !identityMatches(actorInst, owner)) {
        return { error: "Task belongs to another identity" };
      }
    }
    if (task.status !== "approval_required") {
      return { error: `Task is ${task.status}, not approval_required` };
    }

    // Check if any dependency has failed/cancelled
    if (task.depends_on) {
      const deps = JSON.parse(task.depends_on as string) as string[];
      const state = dependencyState(scope, deps);

      if (state.kind === "failed") {
        const cancelResult = autoCancelledResult(state.depId, state.depStatus);
        db.run(
          "UPDATE tasks SET status = 'cancelled', result = ?, updated_at = unixepoch(), changed_at = ? WHERE id = ?",
          [cancelResult, stamp(), id],
        );
        emit({
          scope,
          type: "task.cascade.cancelled",
          actor: "system",
          subject: id,
          payload: {
            trigger: state.depId,
            reason: "dependency_failed",
            prior_status: "approval_required",
            dependency_status: state.depStatus,
            result: cancelResult,
          },
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
          payload: { status: "blocked", prior_status: "approval_required" },
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
      payload: { status: newStatus, prior_status: "approval_required" },
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
  review_of_task_id?: string; // $N ref or external task ID
  fixes_task_id?: string; // $N ref or external task ID
  approval_required?: boolean;
  tracker_required?: boolean;
  tracker_provider?: string;
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

    // Validate $N refs in single-task relationship fields
    for (const field of ["parent_task_id", "review_of_task_id", "fixes_task_id"] as const) {
      const value = spec[field];
      if (!value) continue;

      const n = isRef(value);
      if (n === null) continue;

      if (n < 1 || n > specs.length) {
        errors.push({ task_index: i, field, message: `${value} is out of range` });
      } else if (n === i + 1) {
        errors.push({ task_index: i, field, message: `${value} is a self-reference` });
      } else if (n > i + 1) {
        errors.push({ task_index: i, field, message: `${value} is a forward reference` });
      }
    }

    // Validate assignee
    if (spec.assignee && validateAssignee && !validateAssignee(spec.assignee)) {
      errors.push({ task_index: i, field: "assignee", message: `Instance ${spec.assignee} is not active in this scope` });
    }
  }

  if (errors.length > 0) return { error: "Validation failed", details: errors };

  // Phase 3: Resolve $N refs to actual UUIDs and validate external refs
  const resolvedSpecs: Array<{
    depends_on: string[] | null;
    parent_task_id: string | null;
    review_of_task_id: string | null;
    fixes_task_id: string | null;
  }> = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    let resolvedDeps: string[] | null = null;
    let resolvedParent: string | null = null;
    let resolvedReviewOf: string | null = null;
    let resolvedFixes: string | null = null;

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

    for (const field of ["parent_task_id", "review_of_task_id", "fixes_task_id"] as const) {
      const value = spec[field];
      if (!value) continue;

      const n = isRef(value);
      let resolvedValue: string;
      if (n !== null) {
        resolvedValue = resolved[n - 1].id;
      } else {
        // External relationship target — validate
        if (resolved[i].isNew) {
          const ext = db
            .query("SELECT id FROM tasks WHERE id = ? AND scope = ?")
            .get(value, scope);
          if (!ext) {
            const label = field === "parent_task_id"
              ? "Parent"
              : field === "review_of_task_id"
                ? "Review target"
                : "Fix target";
            return {
              error: "Validation failed",
              details: [
                {
                  task_index: i,
                  field,
                  message: `${label} task ${value} not found in scope`,
                },
              ],
            };
          }
        }
        resolvedValue = value;
      }

      if (field === "parent_task_id") resolvedParent = resolvedValue;
      if (field === "review_of_task_id") resolvedReviewOf = resolvedValue;
      if (field === "fixes_task_id") resolvedFixes = resolvedValue;
    }

    resolvedSpecs.push({
      depends_on: resolvedDeps,
      parent_task_id: resolvedParent,
      review_of_task_id: resolvedReviewOf,
      fixes_task_id: resolvedFixes,
    });
  }

  // Phase 4: Compute statuses and insert in a single transaction
  const tx = db.transaction(() => {
    for (let i = 0; i < specs.length; i++) {
      if (!resolved[i].isNew) continue;

      const spec = specs[i];
      const deps = resolvedSpecs[i].depends_on;
      const parentId = resolvedSpecs[i].parent_task_id;
      const reviewOfTaskId = resolvedSpecs[i].review_of_task_id;
      const fixesTaskId = resolvedSpecs[i].fixes_task_id;

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
        review_of_task_id: reviewOfTaskId,
        fixes_task_id: fixesTaskId,
        approval_required: spec.approval_required ?? false,
        tracker_required:
          spec.tracker_required ??
          isLinearBackedTask({
            title: spec.title,
            description: spec.description ?? null,
            idempotency_key: spec.idempotency_key ?? null,
          }),
        tracker_provider: spec.tracker_provider ?? null,
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

export function get(id: string, scope: string, viewer?: Instance) {
  prune();

  const task = db
    .query("SELECT * FROM tasks WHERE id = ? AND scope = ?")
    .get(id, scope) as Record<string, unknown> | null;
  if (!task) return null;
  if (!canSeeTask(viewer, task)) return null;
  return row(task);
}

export function list(
  scope: string,
  filter?: {
    status?: TaskStatus;
    assignee?: string;
    requester?: string;
    viewer?: Instance;
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

  return rows.filter((item) => canSeeTask(filter?.viewer, item)).map((item) => row(item));
}

export function snapshot(scope: string, opts: SnapshotOpts = {}, viewer?: Instance): TaskSnapshot {
  prune();

  const includeTerminal = opts.include_terminal ?? true;
  const terminalLimit = Math.max(0, Math.floor(opts.terminal_limit ?? 0));

  const grouped: TaskSnapshot = {
    open: [],
    claimed: [],
    in_progress: [],
    done: [],
    failed: [],
    cancelled: [],
    blocked: [],
    approval_required: [],
    terminal_counts: { done: 0, failed: 0, cancelled: 0 },
  };

  const rows = db
    .query(
      `SELECT * FROM tasks WHERE scope = ? ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .all(scope) as Array<Record<string, unknown>>;

  for (const item of rows) {
    if (!canSeeTask(viewer, item)) continue;
    const task = row(item) as Record<string, unknown> & { status: TaskStatus };
    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      grouped.terminal_counts![task.status] += 1;
      if (includeTerminal || (grouped[task.status]?.length ?? 0) < terminalLimit) {
        grouped[task.status]?.push(task);
      }
      continue;
    }
    grouped[task.status].push(task);
  }

  if (!includeTerminal && terminalLimit === 0) {
    delete (grouped as Partial<TaskSnapshot>).done;
    delete (grouped as Partial<TaskSnapshot>).failed;
    delete (grouped as Partial<TaskSnapshot>).cancelled;
  }

  return grouped;
}

export function cleanup() {
  cleanupTerminalTasks({ mode: "manual" });
}
