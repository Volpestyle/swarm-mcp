import { db } from "./db";
import { prune } from "./registry";
import { randomUUIDv7 } from "bun";

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

export function request(
  requester: string,
  type: TaskType,
  title: string,
  description?: string,
  files?: string[],
  assignee?: string,
) {
  prune();
  const id = randomUUIDv7();
  db.run(
    `INSERT INTO tasks (id, type, title, description, requester, assignee, files, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      type,
      title,
      description ?? null,
      requester,
      assignee ?? null,
      files ? JSON.stringify(files) : null,
      assignee ? "claimed" : "open",
    ],
  );
  return id;
}

export function claim(id: string, assignee: string) {
  const row = db.query("SELECT status FROM tasks WHERE id = ?").get(id) as {
    status: string;
  } | null;
  if (!row) return { error: "Task not found" };
  if (row.status !== "open") return { error: `Task is already ${row.status}` };
  db.run(
    "UPDATE tasks SET assignee = ?, status = 'claimed', updated_at = unixepoch() WHERE id = ?",
    [assignee, id],
  );
  return { ok: true };
}

export function update(id: string, status: TaskStatus, result?: string) {
  db.run(
    "UPDATE tasks SET status = ?, result = ?, updated_at = unixepoch() WHERE id = ?",
    [status, result ?? null, id],
  );
}

export function get(id: string) {
  prune();
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) return null;
  if (row.files && typeof row.files === "string")
    row.files = JSON.parse(row.files);
  return row;
}

export function list(filter?: {
  status?: TaskStatus;
  assignee?: string;
  requester?: string;
}) {
  prune();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.assignee) {
    clauses.push("assignee = ?");
    params.push(filter.assignee);
  }
  if (filter?.requester) {
    clauses.push("requester = ?");
    params.push(filter.requester);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
    .all(...params);
  return (rows as Record<string, unknown>[]).map((r) => {
    if (r.files && typeof r.files === "string") r.files = JSON.parse(r.files);
    return r;
  });
}

export function cleanup() {
  const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h
  db.run(
    "DELETE FROM tasks WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?",
    [cutoff],
  );
}
