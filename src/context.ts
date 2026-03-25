import { db } from "./db";
import { randomUUIDv7 } from "bun";

export type ContextType =
  | "finding"
  | "warning"
  | "lock"
  | "note"
  | "bug"
  | "todo";

export function annotate(
  instance: string,
  file: string,
  type: ContextType,
  content: string,
) {
  const id = randomUUIDv7();
  db.run(
    "INSERT INTO context (id, instance_id, file, type, content) VALUES (?, ?, ?, ?, ?)",
    [id, instance, file, type, content],
  );
  return id;
}

export function lookup(file: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE file = ? ORDER BY created_at DESC",
    )
    .all(file);
}

export function search(pattern: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE file LIKE ? OR content LIKE ? ORDER BY created_at DESC",
    )
    .all(`%${pattern}%`, `%${pattern}%`);
}

export function remove(id: string) {
  db.run("DELETE FROM context WHERE id = ?", [id]);
}

export function list(instance?: string) {
  if (instance) {
    return db
      .query(
        "SELECT id, instance_id, file, type, content, created_at FROM context WHERE instance_id = ? ORDER BY created_at DESC",
      )
      .all(instance);
  }
  return db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context ORDER BY created_at DESC",
    )
    .all();
}

export function locks() {
  return db
    .query(
      "SELECT id, instance_id, file, content, created_at FROM context WHERE type = 'lock' ORDER BY created_at DESC",
    )
    .all();
}

export function cleanup() {
  const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h
  db.run("DELETE FROM context WHERE created_at < ? AND type != 'lock'", [
    cutoff,
  ]);
}
