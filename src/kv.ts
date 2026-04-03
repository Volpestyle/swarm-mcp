import { db } from "./db";
import { stamp } from "./time";

function touch(scope: string) {
  const changedAt = stamp();
  db.run(
    `INSERT INTO kv_scope_updates (scope, changed_at) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET changed_at =
       CASE
         WHEN excluded.changed_at > kv_scope_updates.changed_at THEN excluded.changed_at
         ELSE kv_scope_updates.changed_at + 1
       END`,
    [scope, changedAt],
  );
}

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
  touch(scope);
}

export function del(scope: string, key: string) {
  const result = db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, key]);
  if (result.changes > 0) touch(scope);
}

export function append(scope: string, key: string, value: string) {
  const tx = db.transaction(() => {
    const existing = db
      .query("SELECT value FROM kv WHERE scope = ? AND key = ?")
      .get(scope, key) as { value: string } | null;

    let arr: unknown[];
    if (existing) {
      try {
        const parsed = JSON.parse(existing.value);
        arr = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        arr = [existing.value];
      }
    } else {
      arr = [];
    }

    arr.push(JSON.parse(value));
    const merged = JSON.stringify(arr);

    db.run(
      `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [scope, key, merged],
    );
    touch(scope);

    return arr.length;
  });
  return tx();
}

export function version(scope: string) {
  const row = db
    .query("SELECT changed_at FROM kv_scope_updates WHERE scope = ?")
    .get(scope) as { changed_at: number } | null;
  return row?.changed_at ?? 0;
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
