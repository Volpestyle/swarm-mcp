import { db } from "./db";

export function get(scope: string, key: string) {
  return db
    .query("SELECT value, updated_at FROM kv WHERE scope = ? AND key = ?")
    .get(scope, key) as {
    value: string;
    updated_at: number;
  } | null;
}

export function set(scope: string, key: string, value: string) {
  db.run(
    `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [scope, key, value],
  );
}

export function del(scope: string, key: string) {
  db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, key]);
}

export function keys(scope: string, prefix?: string) {
  if (prefix) {
    return db
      .query(
        "SELECT key, updated_at FROM kv WHERE scope = ? AND key LIKE ? ORDER BY key",
      )
      .all(scope, prefix + "%");
  }

  return db
    .query("SELECT key, updated_at FROM kv WHERE scope = ? ORDER BY key")
    .all(scope);
}
