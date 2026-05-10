import { randomUUID } from "node:crypto";
import { CLEANUP_POLICY, cleanupNonLockContextRows } from "./cleanup";
import { db } from "./db";
import { emit } from "./events";
import { now } from "./time";

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
  };
  active_tasks: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
  }>;
};

function enrichLock(scope: string, row: ContextRow | null): LockRow | null {
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
    },
    active_tasks: activeTasks,
  };
}

function activeLock(scope: string, file: string) {
  const row = db
    .query(
      "SELECT id, instance_id, file, type, content, created_at FROM context WHERE scope = ? AND file = ? AND type = 'lock'",
    )
    .get(scope, file) as ContextRow | null;
  return enrichLock(scope, row);
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

    return { error: "File is already locked", active: activeLock(scope, file) };
  }
}

export function lookup(scope: string, file: string) {
  return db
    .query(
      "SELECT id, instance_id, file, type, content, task_id, created_at FROM context WHERE scope = ? AND file = ? ORDER BY created_at DESC, id DESC",
    )
    .all(scope, file);
}

export function fileLock(scope: string, file: string) {
  return {
    file,
    active: activeLock(scope, file),
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
