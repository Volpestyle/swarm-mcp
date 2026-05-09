import { randomUUID } from "node:crypto";
import { cleanupContextAnnotations } from "./cleanup";
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
      payload: { annotation_type: type, id, content },
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

  // Pull non-lock annotations from peers so the caller doesn't need a
  // separate read round-trip before editing.
  const annotations = db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? AND type != 'lock' ORDER BY created_at DESC, id DESC",
    )
    .all(scope, file);

  try {
    const id = annotate(instance, scope, file, "lock", content);
    emit({
      scope,
      type: "context.lock_acquired",
      actor: instance,
      subject: file,
      payload: { id, content },
    });
    return { ok: true as const, id, annotations };
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
    return { error: "File is already locked", active, annotations };
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

/** Release all locks the given instance holds on the listed files. */
export function releaseInstanceLocksForFiles(
  instance: string,
  scope: string,
  files: string[],
) {
  let released = 0;
  for (const file of files) {
    const result = db.run(
      "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
      [scope, file, instance],
    );
    if (result.changes > 0) {
      released += result.changes;
      emit({
        scope,
        type: "context.lock_released",
        actor: instance,
        subject: file,
        payload: { released: result.changes, reason: "task_terminal" },
      });
    }
  }
  return released;
}

export function cleanup() {
  cleanupContextAnnotations({ mode: "manual" });
}
