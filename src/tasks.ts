import { randomUUID } from "node:crypto";
import { db } from "./db";
import { prune } from "./registry";
import { stamp } from "./time";

export type TaskType =
  | "review"
  | "implement"
  | "fix"
  | "test"
  | "research"
  | "other";

export type TaskStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "done"
  | "failed"
  | "cancelled";

type TaskRow = {
  id: string;
  scope: string;
  requester: string;
  assignee: string | null;
  status: TaskStatus;
  files: string | null;
};

function row(task: Record<string, unknown>) {
  if (typeof task.files === "string") task.files = JSON.parse(task.files);
  return task;
}

export function request(
  requester: string,
  scope: string,
  type: TaskType,
  title: string,
  description?: string,
  files?: string[],
  assignee?: string,
) {
  prune();

  const id = randomUUID();
  db.run(
    `INSERT INTO tasks (id, scope, type, title, description, requester, assignee, files, status, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scope,
      type,
      title,
      description ?? null,
      requester,
      assignee ?? null,
      files ? JSON.stringify(files) : null,
      assignee ? "claimed" : "open",
      stamp(),
    ],
  );
  return id;
}

export function claim(id: string, scope: string, assignee: string) {
  const result = db.run(
    `UPDATE tasks
     SET assignee = ?, status = 'claimed', updated_at = unixepoch(), changed_at = ?
     WHERE id = ? AND scope = ? AND status = 'open' AND assignee IS NULL`,
    [assignee, stamp(), id, scope],
  );

  if (result.changes > 0) return { ok: true as const };

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
  status: Exclude<TaskStatus, "open" | "claimed">,
  result?: string,
) {
  const task = db
    .query(
      "SELECT id, scope, requester, assignee, status, files FROM tasks WHERE id = ? AND scope = ?",
    )
    .get(id, scope) as TaskRow | null;

  if (!task) return { error: "Task not found" };
  if (["done", "failed", "cancelled"].includes(task.status)) {
    return { error: `Task is already ${task.status}` };
  }

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

  return { ok: true as const };
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
      `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
    )
    .all(...args) as Array<Record<string, unknown>>;

  return rows.map((item) => row(item));
}

export function cleanup() {
  db.run(
    "DELETE FROM tasks WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?",
    [Math.floor(Date.now() / 1000) - 86400],
  );
}
