import { db } from "./db";
import { emit } from "./events";
import { identityToken } from "./identity";
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

function actorIdentity(actor?: string | null) {
  if (!actor) return null;
  // Direct row lookup instead of registry.get() so kv.ts does not import registry,
  // which would create a registry → cleanup → planner → kv → registry init cycle
  // that deadlocks under esbuild's async __esm bundle format.
  const row = db
    .query("SELECT label FROM instances WHERE id = ?")
    .get(actor) as { label: string | null } | null;
  return row ? identityToken(row) || null : null;
}

function readable(owner: string | null, viewer?: string | null) {
  if (viewer === undefined) return true;
  if (!owner) return true;
  if (process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY) return true;
  return actorIdentity(viewer) === owner;
}

export function get(scope: string, key: string, viewer?: string | null) {
  const row = db
    .query("SELECT value, updated_at, owner_identity FROM kv WHERE scope = ? AND key = ?")
    .get(scope, key) as {
    value: string;
    updated_at: number;
    owner_identity: string | null;
  } | null;
  if (!row || !readable(row.owner_identity, viewer)) return null;
  return row;
}

function rawGet(scope: string, key: string) {
  return db
    .query("SELECT value, updated_at, owner_identity FROM kv WHERE scope = ? AND key = ?")
    .get(scope, key) as {
    value: string;
    updated_at: number;
    owner_identity: string | null;
  } | null;
}

/**
 * `actor` is the instance id behind the write (resolved by the MCP tool
 * handler or the CLI's `resolveIdentity`). The kv primitive itself is
 * scope-scoped, so attribution lives in the audit log only — the kv row
 * intentionally has no per-instance column.
 */
export function set(scope: string, key: string, value: string, actor?: string | null) {
  const existing = rawGet(scope, key);
  if (existing && !readable(existing.owner_identity, actor)) {
    return { error: "KV key is owned by another identity" };
  }
  const owner = actorIdentity(actor);
  db.run(
    `INSERT INTO kv (scope, key, value, owner_identity, updated_at) VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, owner_identity = COALESCE(kv.owner_identity, excluded.owner_identity), updated_at = excluded.updated_at`,
    [scope, key, value, owner],
  );
  touch(scope);
  emit({
    scope,
    type: "kv.set",
    actor: actor ?? null,
    subject: key,
    payload: { value, length: value.length },
  });
  return { ok: true as const };
}

export function del(scope: string, key: string, actor?: string | null) {
  // Snapshot the prior value before deletion so the audit row preserves what
  // was there. After the DELETE the row is gone; without this we'd lose the
  // ability to reconstruct what the key held.
  const prior = rawGet(scope, key);
  if (prior && !readable(prior.owner_identity, actor)) return false;
  const result = db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, key]);
  if (result.changes > 0) {
    touch(scope);
    emit({
      scope,
      type: "kv.deleted",
      actor: actor ?? null,
      subject: key,
      payload: prior
        ? { prior_value: prior.value, prior_length: prior.value.length }
        : null,
    });
  }
  return result.changes > 0;
}

export function append(scope: string, key: string, value: string, actor?: string | null) {
  const tx = db.transaction(() => {
    const existing = rawGet(scope, key);
    if (existing && !readable(existing.owner_identity, actor)) {
      throw new Error("KV key is owned by another identity");
    }

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

    const appended = JSON.parse(value);
    arr.push(appended);
    const merged = JSON.stringify(arr);

    db.run(
      `INSERT INTO kv (scope, key, value, owner_identity, updated_at) VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, owner_identity = COALESCE(kv.owner_identity, excluded.owner_identity), updated_at = excluded.updated_at`,
      [scope, key, merged, actorIdentity(actor)],
    );
    touch(scope);
    emit({
      scope,
      type: "kv.appended",
      actor: actor ?? null,
      subject: key,
      payload: { appended, length: arr.length },
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

export function keys(scope: string, prefix?: string, viewer?: string | null) {
  const owner = actorIdentity(viewer);
  const ownerWhere =
    viewer === undefined
      ? ""
      : owner
        ? "AND (owner_identity IS NULL OR owner_identity = ?)"
        : "AND owner_identity IS NULL";
  if (prefix) {
    return db
      .query(
        `SELECT key, updated_at FROM kv WHERE scope = ? AND key LIKE ? ${ownerWhere} ORDER BY key`,
      )
      .all(...(owner ? [scope, prefix + "%", owner] : [scope, prefix + "%"]));
  }

  return db
    .query(`SELECT key, updated_at FROM kv WHERE scope = ? ${ownerWhere} ORDER BY key`)
    .all(...(owner ? [scope, owner] : [scope]));
}
