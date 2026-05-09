import { randomUUID } from "node:crypto";
import { releaseInstanceState, runCleanup, type CleanupMode } from "./cleanup";
import { db } from "./db";
import { emit } from "./events";
import { norm, root, scope as scoped } from "./paths";
import * as planner from "./planner";
import { now } from "./time";

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

export function prune(mode: CleanupMode = "opportunistic") {
  runCleanup({ mode });
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
      emit({
        scope: adopted.scope,
        type: "instance.registered",
        actor: adopted.id,
        subject: adopted.id,
        payload: {
          label: nextLabel,
          adopted: true,
          pid: process.pid,
          directory: adopted.directory,
          root: adopted.root,
          file_root: adopted.file_root,
        },
      });
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
  emit({
    scope: row.scope,
    type: "instance.registered",
    actor: row.id,
    subject: row.id,
    payload: {
      label: row.label,
      adopted: false,
      pid: row.pid,
      directory: row.directory,
      root: row.root,
      file_root: row.file_root,
    },
  });

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
    .query("SELECT id, scope, label, pid FROM instances WHERE id = ?")
    .get(id) as {
      id: string;
      scope: string;
      label: string | null;
      pid: number | null;
    } | null;

  releaseInstanceState(id);
  db.run("DELETE FROM instances WHERE id = ?", [id]);

  if (item) {
    emit({
      scope: item.scope,
      type: "instance.deregistered",
      actor: item.id,
      subject: item.id,
      payload: { label: item.label, pid: item.pid },
    });
    planner.refreshOwner(item.scope);
  }
}

export function heartbeat(id: string) {
  db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [now(), id]);

  const item = db
    .query("SELECT id, scope, label FROM instances WHERE id = ?")
    .get(id) as { id: string; scope: string; label: string | null } | null;
  if (item) planner.ensureOwner(item);

  prune("periodic");
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
