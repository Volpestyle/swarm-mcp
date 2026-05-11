import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { CLEANUP_POLICY, cleanupNonLockContextRows } from "./cleanup";
import { db } from "./db";
import { emit } from "./events";
import { identityMatches } from "./identity";
import * as registry from "./registry";
import { now } from "./time";
import * as workspaceIdentity from "./workspace_identity";

type ContextRow = {
  id: string;
  instance_id: string;
  file: string;
  type: string;
  content: string;
  created_at: number;
};

type LockRow = ContextRow & {
  owner: {
    id: string;
    label: string | null;
    heartbeat: number | null;
    heartbeat_age_seconds: number | null;
    stale: boolean;
    reclaimable: boolean;
    active: boolean;
    workspace_backend?: string;
    workspace_handle?: string;
    pane_id?: string;
  };
  workspace?: workspaceIdentity.PublishedWorkspaceSummary;
  active_tasks: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
  }>;
};

type HiddenLock = {
  hidden: true;
  reason: "cross_identity";
  file: string;
};

function isUnder(path: string, base: string) {
  const rel = relative(base, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function ownsPath(inst: registry.Instance, file: string) {
  return isUnder(file, inst.root) || isUnder(file, inst.file_root) || isUnder(file, inst.directory);
}

function crossIdentityPathOwner(instance: string, scope: string, file: string) {
  const actor = registry.get(instance);
  if (!actor) return null;
  for (const peer of registry.list(scope) as registry.Instance[]) {
    if (peer.id === instance) continue;
    if (!ownsPath(peer, file)) continue;
    if (!identityMatches(actor, peer)) return peer;
  }
  return null;
}

function enrichLock(
  scope: string,
  row: ContextRow | null,
  viewer?: registry.Instance,
): LockRow | null {
  if (!row) return null;

  const owner = db
    .query(
      "SELECT id, label, heartbeat FROM instances WHERE id = ? AND scope = ?",
    )
    .get(row.instance_id, scope) as
    | { id: string; label: string | null; heartbeat: number }
    | null;

  const age =
    owner && Number.isFinite(owner.heartbeat) ? Math.max(0, now() - owner.heartbeat) : null;
  const activeTasks = db
    .query(
      `SELECT id, type, title, status
       FROM tasks
       WHERE scope = ? AND assignee = ? AND status IN ('claimed', 'in_progress')
       ORDER BY changed_at DESC
       LIMIT 5`,
    )
    .all(scope, row.instance_id) as LockRow["active_tasks"];
  const workspace = workspaceIdentity.publishedWorkspaceSummary({
    scope,
    instanceId: row.instance_id,
    actor: viewer?.id,
  });

  return {
    ...row,
    owner: {
      id: row.instance_id,
      label: owner?.label ?? null,
      heartbeat: owner?.heartbeat ?? null,
      heartbeat_age_seconds: age,
      stale: age === null || age > CLEANUP_POLICY.instanceStaleAfterSecs,
      reclaimable: age === null || age > CLEANUP_POLICY.instanceReclaimAfterSecs,
      active: owner !== null,
      ...(workspace?.backend ? { workspace_backend: workspace.backend } : {}),
      ...(workspace?.workspace_handle
        ? { workspace_handle: workspace.workspace_handle }
        : {}),
      ...(workspace?.pane_id ? { pane_id: workspace.pane_id } : {}),
    },
    ...(workspace ? { workspace } : {}),
    active_tasks: activeTasks,
  };
}

function activeLock(scope: string, file: string, viewer?: registry.Instance): LockRow | HiddenLock | null {
  const row = db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? AND type = 'lock'",
    )
    .get(scope, file) as ContextRow | null;
  if (row && viewer && row.instance_id !== viewer.id) {
    const owner = registry.get(row.instance_id);
    if (owner && !identityMatches(viewer, owner)) {
      return { hidden: true, reason: "cross_identity", file };
    }
  }
  return enrichLock(scope, row, viewer);
}

function insertLock(
  instance: string,
  scope: string,
  file: string,
  content: string,
  taskId?: string,
) {
  const id = randomUUID();
  db.run(
    "INSERT INTO context (id, scope, instance_id, file, type, content, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, scope, instance, file, "lock", content, taskId ?? null],
  );
  return id;
}

export function lock(
  instance: string,
  scope: string,
  file: string,
  content: string,
  opts: { exclusive?: boolean; taskId?: string } = {},
) {
  const otherOwner = crossIdentityPathOwner(instance, scope, file);
  if (otherOwner) {
    return {
      error: "Cannot lock a path owned by another identity",
      active: { hidden: true as const, reason: "cross_identity" as const, file },
    };
  }

  // Re-entrant by default: same-instance callers extending their own edit
  // lock should succeed, so drop their existing row before insert. With
  // `exclusive: true`, we leave any existing lock — including our own — in
  // place so the UNIQUE INDEX on (scope, file) WHERE type = 'lock' surfaces
  // a conflict regardless of `instance_id`.
  if (!opts.exclusive) {
    db.run(
      "DELETE FROM context WHERE scope = ? AND file = ? AND type = 'lock' AND instance_id = ?",
      [scope, file, instance],
    );
  }

  try {
    const id = insertLock(instance, scope, file, content, opts.taskId);
    emit({
      scope,
      type: "context.lock_acquired",
      actor: instance,
      subject: file,
      payload: { id, content },
    });
    return { ok: true as const, id };
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.includes("UNIQUE constraint failed")
    ) {
      throw err;
    }

    return { error: "File is already locked", active: activeLock(scope, file, registry.get(instance) ?? undefined) };
  }
}

export function lookup(scope: string, file: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, task_id, created_at FROM context WHERE scope = ? AND file = ? ORDER BY created_at DESC, id DESC",
    )
    .all(scope, file);
}

export function fileLock(scope: string, file: string, viewer?: registry.Instance) {
  return {
    file,
    active: activeLock(scope, file, viewer),
  };
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
  return result.changes;
}

/** Release all locks the given instance acquired under the named task_id, regardless of which files. */
export function releaseInstanceLocksForTask(
  instance: string,
  scope: string,
  taskId: string,
) {
  const rows = db
    .query(
      "SELECT id, file FROM context WHERE scope = ? AND type = 'lock' AND instance_id = ? AND task_id = ?",
    )
    .all(scope, instance, taskId) as Array<{ id: string; file: string }>;
  let released = 0;
  for (const row of rows) {
    const result = db.run(
      "DELETE FROM context WHERE id = ? AND type = 'lock' AND instance_id = ?",
      [row.id, instance],
    );
    if (result.changes > 0) {
      released += result.changes;
      emit({
        scope,
        type: "context.lock_released",
        actor: instance,
        subject: row.file,
        payload: { released: result.changes, reason: "task_terminal", task_id: taskId },
      });
    }
  }
  return released;
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

export function releaseInstanceEditLocks(instance: string, scope: string) {
  const rows = db
    .query(
      "SELECT id, file FROM context WHERE scope = ? AND type = 'lock' AND instance_id = ? AND file NOT LIKE '/__swarm/%'",
    )
    .all(scope, instance) as Array<{ id: string; file: string }>;
  let released = 0;
  for (const row of rows) {
    const result = db.run(
      "DELETE FROM context WHERE id = ? AND type = 'lock' AND instance_id = ?",
      [row.id, instance],
    );
    if (result.changes > 0) {
      released += result.changes;
      emit({
        scope,
        type: "context.lock_released",
        actor: instance,
        subject: row.file,
        payload: { released: result.changes, reason: "task_terminal" },
      });
    }
  }
  return released;
}

export function cleanup() {
  cleanupNonLockContextRows({ mode: "manual" });
}
