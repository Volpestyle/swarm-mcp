import { randomUUID } from "node:crypto";
import { db } from "./db";

export type ContextType =
  | "finding"
  | "warning"
  | "lock"
  | "note"
  | "bug"
  | "todo";

export function annotate(
  instance: string,
  scope: string,
  file: string,
  type: ContextType,
  content: string,
) {
  const id = randomUUID();
  db.run(
    "INSERT INTO context (id, scope, instance_id, file, type, content) VALUES (?, ?, ?, ?, ?, ?)",
    [id, scope, instance, file, type, content],
  );
  return id;
}

export function lock(
  instance: string,
  scope: string,
  file: string,
  content: string,
) {
  db.run(
    "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
    [scope, file, instance],
  );

  try {
    const id = annotate(instance, scope, file, "lock", content);
    return { ok: true as const, id };
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.includes("UNIQUE constraint failed")
    ) {
      throw err;
    }

    const active = db
      .query(
        "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? AND type = 'lock'",
      )
      .get(scope, file);
    return { error: "File is already locked", active };
  }
}

export function lookup(scope: string, file: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? ORDER BY created_at DESC, id DESC",
    )
    .all(scope, file);
}

export function search(scope: string, pattern: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND (file LIKE ? OR content LIKE ?) ORDER BY created_at DESC, id DESC",
    )
    .all(scope, `%${pattern}%`, `%${pattern}%`);
}

export function remove(id: string) {
  db.run("DELETE FROM context WHERE id = ?", [id]);
}

export function clearLocks(instance: string, scope: string, file: string) {
  db.run(
    "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
    [scope, file, instance],
  );
}

export function cleanup() {
  db.run("DELETE FROM context WHERE created_at < ? AND type != 'lock'", [
    Math.floor(Date.now() / 1000) - 86400,
  ]);
}
