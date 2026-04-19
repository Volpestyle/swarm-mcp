import { db } from "./db";

export type UiCommandKind =
  | "spawn_shell"
  | "send_prompt"
  | "move_node"
  | "organize_nodes";

export type UiCommandStatus = "pending" | "running" | "done" | "failed";

export type UiCommandRow = {
  id: number;
  scope: string;
  created_by: string | null;
  kind: UiCommandKind;
  payload: string;
  status: UiCommandStatus;
  claimed_by: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

export function enqueue(
  scope: string,
  kind: UiCommandKind,
  payload: unknown,
  createdBy?: string | null,
) {
  const res = db.run(
    `INSERT INTO ui_commands (scope, created_by, kind, payload)
     VALUES (?, ?, ?, ?)`,
    [scope, createdBy ?? null, kind, JSON.stringify(payload)],
  );
  return Number(res.lastInsertRowid);
}

export function get(id: number) {
  return db
    .query(
      `SELECT id, scope, created_by, kind, payload, status, claimed_by, result,
              error, created_at, started_at, completed_at
       FROM ui_commands
       WHERE id = ?`,
    )
    .get(id) as UiCommandRow | null;
}

export function list(opts: {
  scope?: string;
  status?: string;
  limit?: number;
}) {
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (opts.scope) {
    where.push("scope = ?");
    args.push(opts.scope);
  }
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }

  const limit = opts.limit ?? 20;
  args.push(limit);
  return db
    .query(
      `SELECT id, scope, created_by, kind, payload, status, claimed_by, result,
              error, created_at, started_at, completed_at
       FROM ui_commands
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...args) as UiCommandRow[];
}
