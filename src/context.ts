import { randomUUID } from "node:crypto";
import { db } from "./db";
import { emit } from "./events";

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
  // `lock` writes go through `annotate` too — emit the more specific
  // `context.lock_acquired` from `lock()` instead of double-firing here.
  if (type !== "lock") {
    emit({
      scope,
      type: "context.annotated",
      actor: instance,
      subject: file,
      payload: { annotation_type: type, id },
    });
  }
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
    emit({
      scope,
      type: "context.lock_acquired",
      actor: instance,
      subject: file,
      payload: { id },
    });
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
  const result = db.run(
    "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
    [scope, file, instance],
  );
  if (result.changes > 0) {
    emit({
      scope,
      type: "context.lock_released",
      actor: instance,
      subject: file,
      payload: { released: result.changes },
    });
  }
}

export function cleanup() {
  db.run("DELETE FROM context WHERE created_at < ? AND type != 'lock'", [
    Math.floor(Date.now() / 1000) - 86400,
  ]);
}
