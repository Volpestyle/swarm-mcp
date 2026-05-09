import { db } from "./db";
import { emit } from "./events";
import * as planner from "./planner";
import { now, stamp } from "./time";

export const CLEANUP_POLICY = {
  instanceStaleAfterSecs: 30,
  instanceReclaimAfterSecs: 60,
  messageTtlSecs: 60 * 60,
  terminalTaskTtlSecs: 24 * 60 * 60,
  contextAnnotationTtlSecs: 24 * 60 * 60,
  eventTtlSecs: 24 * 60 * 60,
  orphanKvTtlSecs: 60 * 60,
} as const;

export type CleanupMode = "opportunistic" | "periodic" | "manual";

export type CleanupOptions = {
  scope?: string;
  dryRun?: boolean;
  mode?: CleanupMode;
  nowSecs?: number;
};

export type CleanupResult = {
  dry_run: boolean;
  mode: CleanupMode;
  scope: string | null;
  at: number;
  instances_reclaimed: number;
  tasks_reopened: number;
  task_assignees_cleared: number;
  locks_deleted: number;
  messages_deleted: number;
  terminal_tasks_deleted: number;
  context_annotations_deleted: number;
  events_deleted: number;
  kv_deleted: number;
  kv_keys_deleted: string[];
};

type StaleInstance = {
  id: string;
  scope: string;
  label: string | null;
  pid: number | null;
  heartbeat: number;
};

type ReleasedTask = {
  id: string;
  title: string;
  type: string;
  assignee: string;
  scope: string;
};

type ReleaseResult = {
  tasks_reopened: number;
  task_assignees_cleared: number;
  locks_deleted: number;
  messages_deleted: number;
  released_tasks: ReleasedTask[];
};

function marks(size: number) {
  return Array.from({ length: size }, () => "?").join(",");
}

function sum(rows: Array<{ count: number }>) {
  return rows.reduce((total, row) => total + row.count, 0);
}

function emptyResult(
  options: Required<Pick<CleanupOptions, "dryRun" | "mode">> & {
    scope?: string;
    nowSecs: number;
  },
): CleanupResult {
  return {
    dry_run: options.dryRun,
    mode: options.mode,
    scope: options.scope ?? null,
    at: options.nowSecs,
    instances_reclaimed: 0,
    tasks_reopened: 0,
    task_assignees_cleared: 0,
    locks_deleted: 0,
    messages_deleted: 0,
    terminal_tasks_deleted: 0,
    context_annotations_deleted: 0,
    events_deleted: 0,
    kv_deleted: 0,
    kv_keys_deleted: [],
  };
}

function touchScope(scope: string) {
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

function emitCleanup(
  scope: string,
  type: string,
  payload: Record<string, unknown>,
) {
  emit({
    scope,
    type,
    actor: "system",
    subject: null,
    payload,
  });
}

function releaseInstances(ids: string[], dryRun = false): ReleaseResult {
  if (!ids.length) {
    return {
      tasks_reopened: 0,
      task_assignees_cleared: 0,
      locks_deleted: 0,
      messages_deleted: 0,
      released_tasks: [],
    };
  }

  const slots = marks(ids.length);
  const releasedTasks = db
    .query(
      `SELECT id, title, type, assignee, scope FROM tasks
       WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`,
    )
    .all(...ids) as ReleasedTask[];
  const clearedTaskRows = db
    .query(
      `SELECT COUNT(*) AS count FROM tasks
       WHERE assignee IN (${slots}) AND status IN ('blocked', 'approval_required')`,
    )
    .get(...ids) as { count: number };
  const lockRows = db
    .query(
      `SELECT COUNT(*) AS count FROM context WHERE type = 'lock' AND instance_id IN (${slots})`,
    )
    .get(...ids) as { count: number };
  const messageRows = db
    .query(`SELECT COUNT(*) AS count FROM messages WHERE recipient IN (${slots})`)
    .get(...ids) as { count: number };

  if (!dryRun) {
    db.run(
      `UPDATE tasks
       SET assignee = NULL, status = 'open', updated_at = unixepoch(), changed_at = ?
       WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`,
      [stamp(), ...ids],
    );
    db.run(
      `UPDATE tasks
       SET assignee = NULL, updated_at = unixepoch(), changed_at = ?
       WHERE assignee IN (${slots}) AND status IN ('blocked', 'approval_required')`,
      [stamp(), ...ids],
    );
    db.run(
      `DELETE FROM context WHERE type = 'lock' AND instance_id IN (${slots})`,
      ids,
    );
    db.run(`DELETE FROM messages WHERE recipient IN (${slots})`, ids);
  }

  return {
    tasks_reopened: releasedTasks.length,
    task_assignees_cleared: clearedTaskRows.count,
    locks_deleted: lockRows.count,
    messages_deleted: messageRows.count,
    released_tasks: releasedTasks,
  };
}

export function releaseInstanceState(id: string) {
  return releaseInstances([id]);
}

function staleInstances(cutoff: number, scope?: string) {
  const where = ["heartbeat < ?"];
  const args: Array<string | number> = [cutoff];
  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }

  return db
    .query(
      `SELECT id, scope, label, pid, heartbeat
       FROM instances
       WHERE ${where.join(" AND ")}`,
    )
    .all(...args) as StaleInstance[];
}

function reclaimOfflineInstances(options: CleanupOptions, result: CleanupResult) {
  const at = options.nowSecs ?? now();
  const cutoff = at - CLEANUP_POLICY.instanceReclaimAfterSecs;
  const stale = staleInstances(cutoff, options.scope);
  if (!stale.length) return;

  const ids = stale.map((item) => item.id);
  const scopes = [...new Set(stale.map((item) => item.scope))];
  const release = releaseInstances(ids, true);

  result.instances_reclaimed += stale.length;
  result.tasks_reopened += release.tasks_reopened;
  result.task_assignees_cleared += release.task_assignees_cleared;
  result.locks_deleted += release.locks_deleted;
  result.messages_deleted += release.messages_deleted;

  if (options.dryRun) return;

  const slots = marks(ids.length);
  const tx = db.transaction(() => {
    releaseInstances(ids);
    db.run(`DELETE FROM instances WHERE id IN (${slots})`, ids);

    for (const item of stale) {
      emit({
        scope: item.scope,
        type: "instance.stale_reclaimed",
        actor: "system",
        subject: item.id,
        payload: {
          label: item.label,
          pid: item.pid,
          last_heartbeat: item.heartbeat,
          stale_threshold_secs: CLEANUP_POLICY.instanceStaleAfterSecs,
          reclaim_threshold_secs: CLEANUP_POLICY.instanceReclaimAfterSecs,
        },
      });
    }

    if (release.released_tasks.length) {
      const byScope = new Map<string, ReleasedTask[]>();
      for (const task of release.released_tasks) {
        const list = byScope.get(task.scope) ?? [];
        list.push(task);
        byScope.set(task.scope, list);
      }

      for (const [scope, scopeTasks] of byScope) {
        const staleAgent = stale.find((s) =>
          scopeTasks.some((t) => t.assignee === s.id),
        );
        const agentLabel = staleAgent?.label ?? staleAgent?.id ?? "unknown";
        const taskSummary = scopeTasks
          .map((t) => `"${t.title}" (${t.type}, task_id: ${t.id})`)
          .join(", ");
        const content = `[auto] Agent ${agentLabel} went offline. ${scopeTasks.length} task(s) released back to open: ${taskSummary}. Claim them if they match your role.`;
        const recipients = db
          .query("SELECT id FROM instances WHERE scope = ?")
          .all(scope) as Array<{ id: string }>;

        for (const recipient of recipients) {
          db.run(
            "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
            [scope, "system", recipient.id, content],
          );
        }

        if (recipients.length > 0) {
          emit({
            scope,
            type: "message.broadcast",
            actor: "system",
            subject: null,
            payload: {
              content,
              recipients: recipients.length,
              length: content.length,
              reason: "stale_reclaim",
              released_tasks: scopeTasks.map((t) => t.id),
            },
          });
        }
      }
    }
  });
  tx();

  for (const scope of scopes) planner.refreshOwner(scope);
}

function scopedWhere(scope?: string) {
  if (!scope) return { clause: "", args: [] as Array<string | number> };
  return { clause: " AND scope = ?", args: [scope] as Array<string | number> };
}

function cleanupMessages(options: CleanupOptions) {
  const cutoff = (options.nowSecs ?? now()) - CLEANUP_POLICY.messageTtlSecs;
  const scoped = scopedWhere(options.scope);
  const rows = db
    .query(
      `SELECT scope, COUNT(*) AS count
       FROM messages
       WHERE created_at < ?${scoped.clause}
       GROUP BY scope`,
    )
    .all(cutoff, ...scoped.args) as Array<{ scope: string; count: number }>;
  if (!rows.length) return 0;
  if (options.dryRun) return sum(rows);

  db.run(`DELETE FROM messages WHERE created_at < ?${scoped.clause}`, [
    cutoff,
    ...scoped.args,
  ]);
  for (const row of rows) {
    emitCleanup(row.scope, "cleanup.messages_deleted", {
      count: row.count,
      cutoff,
      ttl_secs: CLEANUP_POLICY.messageTtlSecs,
      mode: options.mode ?? "opportunistic",
    });
  }
  return sum(rows);
}

export function cleanupTerminalTasks(options: CleanupOptions = {}) {
  const cutoff = (options.nowSecs ?? now()) - CLEANUP_POLICY.terminalTaskTtlSecs;
  const scoped = scopedWhere(options.scope);
  const rows = db
    .query(
      `SELECT scope, COUNT(*) AS count
       FROM tasks
       WHERE status IN ('done', 'failed', 'cancelled')
         AND updated_at < ?${scoped.clause}
       GROUP BY scope`,
    )
    .all(cutoff, ...scoped.args) as Array<{ scope: string; count: number }>;
  if (!rows.length) return 0;
  if (options.dryRun) return sum(rows);

  db.run(
    `DELETE FROM tasks
     WHERE status IN ('done', 'failed', 'cancelled')
       AND updated_at < ?${scoped.clause}`,
    [cutoff, ...scoped.args],
  );
  for (const row of rows) {
    emitCleanup(row.scope, "cleanup.terminal_tasks_deleted", {
      count: row.count,
      cutoff,
      ttl_secs: CLEANUP_POLICY.terminalTaskTtlSecs,
      mode: options.mode ?? "opportunistic",
    });
  }
  return sum(rows);
}

export function cleanupContextAnnotations(options: CleanupOptions = {}) {
  const cutoff =
    (options.nowSecs ?? now()) - CLEANUP_POLICY.contextAnnotationTtlSecs;
  const scoped = scopedWhere(options.scope);
  const rows = db
    .query(
      `SELECT scope, COUNT(*) AS count
       FROM context
       WHERE created_at < ?
         AND type != 'lock'${scoped.clause}
       GROUP BY scope`,
    )
    .all(cutoff, ...scoped.args) as Array<{ scope: string; count: number }>;
  if (!rows.length) return 0;
  if (options.dryRun) return sum(rows);

  db.run(
    `DELETE FROM context
     WHERE created_at < ?
       AND type != 'lock'${scoped.clause}`,
    [cutoff, ...scoped.args],
  );
  for (const row of rows) {
    emitCleanup(row.scope, "cleanup.context_annotations_deleted", {
      count: row.count,
      cutoff,
      ttl_secs: CLEANUP_POLICY.contextAnnotationTtlSecs,
      mode: options.mode ?? "opportunistic",
    });
  }
  return sum(rows);
}

function cleanupEvents(options: CleanupOptions) {
  const cutoff = (options.nowSecs ?? now()) - CLEANUP_POLICY.eventTtlSecs;
  const scoped = scopedWhere(options.scope);
  const rows = db
    .query(
      `SELECT scope, COUNT(*) AS count
       FROM events
       WHERE created_at < ?${scoped.clause}
       GROUP BY scope`,
    )
    .all(cutoff, ...scoped.args) as Array<{ scope: string; count: number }>;
  if (!rows.length) return 0;
  if (options.dryRun) return sum(rows);

  db.run(`DELETE FROM events WHERE created_at < ?${scoped.clause}`, [
    cutoff,
    ...scoped.args,
  ]);
  for (const row of rows) {
    emitCleanup(row.scope, "cleanup.events_deleted", {
      count: row.count,
      cutoff,
      ttl_secs: CLEANUP_POLICY.eventTtlSecs,
      mode: options.mode ?? "opportunistic",
    });
  }
  return sum(rows);
}

function scopedInstanceIdForKey(key: string) {
  if (key.startsWith("progress/")) return key.slice("progress/".length);
  if (key.startsWith("plan/") && key !== "plan/latest") {
    return key.slice("plan/".length);
  }
  return null;
}

function cleanupOrphanKv(options: CleanupOptions, result: CleanupResult) {
  const cutoff = (options.nowSecs ?? now()) - CLEANUP_POLICY.orphanKvTtlSecs;
  const scoped = scopedWhere(options.scope);
  const rows = db
    .query(
      `SELECT scope, key, updated_at
       FROM kv
       WHERE updated_at < ?
         AND (key LIKE 'progress/%' OR key LIKE 'plan/%')${scoped.clause}
       ORDER BY scope, key`,
    )
    .all(cutoff, ...scoped.args) as Array<{
    scope: string;
    key: string;
    updated_at: number;
  }>;

  const candidates = rows.filter((row) => {
    const instanceId = scopedInstanceIdForKey(row.key);
    if (!instanceId) return false;
    const active = db
      .query("SELECT 1 FROM instances WHERE id = ? AND scope = ?")
      .get(instanceId, row.scope);
    return !active;
  });

  if (!candidates.length) return;
  result.kv_deleted += candidates.length;
  result.kv_keys_deleted.push(
    ...candidates.map((row) => `${row.scope}:${row.key}`),
  );
  if (options.dryRun) return;

  const byScope = new Map<string, string[]>();
  for (const row of candidates) {
    db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [row.scope, row.key]);
    const keys = byScope.get(row.scope) ?? [];
    keys.push(row.key);
    byScope.set(row.scope, keys);
  }

  for (const [scope, keys] of byScope) {
    touchScope(scope);
    emitCleanup(scope, "cleanup.kv_deleted", {
      count: keys.length,
      keys,
      cutoff,
      ttl_secs: CLEANUP_POLICY.orphanKvTtlSecs,
      mode: options.mode ?? "opportunistic",
      reason: "orphaned_instance_namespace",
    });
  }
}

export function runCleanup(options: CleanupOptions = {}): CleanupResult {
  const normalized = {
    dryRun: options.dryRun ?? false,
    mode: options.mode ?? "opportunistic",
    scope: options.scope,
    nowSecs: options.nowSecs ?? now(),
  };
  const result = emptyResult(normalized);

  reclaimOfflineInstances(normalized, result);
  result.messages_deleted += cleanupMessages(normalized);
  result.terminal_tasks_deleted += cleanupTerminalTasks(normalized);
  result.context_annotations_deleted += cleanupContextAnnotations(normalized);
  result.events_deleted += cleanupEvents(normalized);
  cleanupOrphanKv(normalized, result);

  return result;
}
