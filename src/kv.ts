import { db } from "./db";
import { emit } from "./events";
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

/**
 * `actor` is the instance id behind the write (resolved by the MCP tool
 * handler or the CLI's `resolveIdentity`). The kv primitive itself is
 * scope-scoped, so attribution lives in the audit log only — the kv row
 * intentionally has no per-instance column.
 */
export function set(scope: string, key: string, value: string, actor?: string | null) {
  db.run(
    `INSERT INTO kv (scope, key, value, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [scope, key, value],
  );
  touch(scope);
  emit({
    scope,
    type: "kv.set",
    actor: actor ?? null,
    subject: key,
    payload: { length: value.length },
  });
}

export function del(scope: string, key: string, actor?: string | null) {
  const result = db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, key]);
  if (result.changes > 0) {
    touch(scope);
    emit({
      scope,
      type: "kv.deleted",
      actor: actor ?? null,
      subject: key,
    });
  }
}

export function append(scope: string, key: string, value: string, actor?: string | null) {
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
    emit({
      scope,
      type: "kv.appended",
      actor: actor ?? null,
      subject: key,
      payload: { length: arr.length },
    });

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
