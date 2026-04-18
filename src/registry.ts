import { randomUUID } from "node:crypto";
import { db } from "./db";
import { norm, root, scope as scoped } from "./paths";
import * as planner from "./planner";
import { now, stamp } from "./time";

const STALE = 30;
const MESSAGE_TTL = 3600;

export type Instance = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  file_root: string;
  pid: number;
  label: string | null;
  adopted: boolean;
};

function marks(size: number) {
  return Array.from({ length: size }, () => "?").join(",");
}

function release(ids: string[]) {
  if (!ids.length) return;

  const slots = marks(ids.length);
  db.run(
    `UPDATE tasks
     SET assignee = NULL, status = 'open', updated_at = unixepoch(), changed_at = ?
     WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`,
    [stamp(), ...ids],
  );
  // Clear assignee from blocked/approval_required tasks but keep their status
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

export function prune() {
  const cutoff = now() - STALE;
  const stale = db
    .query("SELECT id, scope, label FROM instances WHERE heartbeat < ?")
    .all(cutoff) as Array<{ id: string; scope: string; label: string | null }>;

  if (stale.length) {
    const ids = stale.map((item) => item.id);
    const slots = marks(ids.length);
    const scopes = [...new Set(stale.map((item) => item.scope))];

    // Collect released tasks before modifying them
    const releasedTasks = db
      .query(
        `SELECT id, title, type, assignee, scope FROM tasks
         WHERE assignee IN (${slots}) AND status IN ('claimed', 'in_progress')`,
      )
      .all(...ids) as Array<{
      id: string;
      title: string;
      type: string;
      assignee: string;
      scope: string;
    }>;

    const tx = db.transaction(() => {
      release(ids);
      db.run(`DELETE FROM instances WHERE id IN (${slots})`, ids);

      // Broadcast recovery notifications for released tasks
      if (releasedTasks.length) {
        // Group released tasks by scope for targeted broadcasts
        const byScope = new Map<string, typeof releasedTasks>();
        for (const task of releasedTasks) {
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
          const content = `[auto] Agent ${agentLabel} went stale. ${scopeTasks.length} task(s) released back to open: ${taskSummary}. Claim them if they match your role.`;

          // Insert broadcast messages to all remaining instances in this scope
          const recipients = db
            .query("SELECT id FROM instances WHERE scope = ?")
            .all(scope) as Array<{ id: string }>;

          for (const recipient of recipients) {
            db.run(
              "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
              [scope, "system", recipient.id, content],
            );
          }
        }
      }
    });
    tx();

    for (const scope of scopes) planner.refreshOwner(scope);
  }

  db.run("DELETE FROM messages WHERE created_at < ?", [now() - MESSAGE_TTL]);
}

export function register(
  directory: string,
  label?: string,
  value?: string,
  fileRoot?: string,
  preassignedId?: string,
): Instance {
  prune();

  const dir = norm(directory);
  const trimmedLabel = label?.trim() || null;

  // Adoption path: a UI-owned instance row was pre-created with `adopted = 0`
  // and its id injected via SWARM_MCP_INSTANCE_ID. Update the existing row
  // with the live pid + label and flip `adopted = 1`. We leave
  // scope/directory/root/file_root alone since the UI already computed them
  // for the same directory.
  if (preassignedId) {
    const existing = db
      .query(
        "SELECT id, scope, directory, root, file_root, pid, label, adopted FROM instances WHERE id = ?",
      )
      .get(preassignedId) as
      | {
          id: string;
          scope: string;
          directory: string;
          root: string;
          file_root: string;
          pid: number;
          label: string | null;
          adopted: number;
        }
      | null;

    if (existing) {
      const nextLabel = trimmedLabel ?? existing.label;
      db.run(
        `UPDATE instances
         SET pid = ?, label = ?, adopted = 1, heartbeat = unixepoch()
         WHERE id = ?`,
        [process.pid, nextLabel, preassignedId],
      );

      const adopted: Instance = {
        id: existing.id,
        scope: existing.scope,
        directory: existing.directory,
        root: existing.root,
        file_root: existing.file_root,
        pid: process.pid,
        label: nextLabel,
        adopted: true,
      };
      planner.ensureOwner({
        id: adopted.id,
        scope: adopted.scope,
        label: adopted.label,
      });
      return adopted;
    }
    // If the pre-created row was pruned before adoption (stale heartbeat,
    // manual deregister), fall through to a fresh INSERT with that same id
    // so the UI's PTY binding stays valid.
  }

  const row = {
    id: preassignedId ?? randomUUID(),
    scope: scoped(dir, value),
    directory: dir,
    root: root(dir),
    file_root: norm(fileRoot || dir),
    pid: process.pid,
    label: trimmedLabel,
    adopted: true,
  };

  db.run(
    "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    [row.id, row.scope, row.directory, row.root, row.file_root, row.pid, row.label],
  );

  planner.ensureOwner({ id: row.id, scope: row.scope, label: row.label });

  return row;
}

export function get(id: string) {
  prune();
  const row = db
    .query(
      "SELECT id, scope, directory, root, file_root, pid, label, adopted FROM instances WHERE id = ?",
    )
    .get(id) as (Omit<Instance, "adopted"> & { adopted: number }) | null;
  if (!row) return null;
  return { ...row, adopted: row.adopted !== 0 } as Instance;
}

export function deregister(id: string) {
  const item = db
    .query("SELECT id, scope, label FROM instances WHERE id = ?")
    .get(id) as { id: string; scope: string; label: string | null } | null;

  release([id]);
  db.run("DELETE FROM instances WHERE id = ?", [id]);

  if (item) planner.refreshOwner(item.scope);
}

export function heartbeat(id: string) {
  db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [now(), id]);

  const item = db
    .query("SELECT id, scope, label FROM instances WHERE id = ?")
    .get(id) as { id: string; scope: string; label: string | null } | null;
  if (item) planner.ensureOwner(item);

  prune();
}

export function list(scope?: string, labelContains?: string) {
  prune();

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (labelContains) {
    where.push("label LIKE '%' || ? || '%'");
    args.push(labelContains);
  }

  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return db
    .query(
      `SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, adopted FROM instances${clause} ORDER BY registered_at ASC`,
    )
    .all(...args);
}
