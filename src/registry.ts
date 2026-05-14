import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { releaseInstanceState, runCleanup, type CleanupMode } from "./cleanup";
import { db } from "./db";
import { emit } from "./events";
import {
  identityMatches,
  identityName,
  identityToken,
  processIdentity,
} from "./identity";
import { profileScopedEnvName } from "./launcher_identity";
import { norm, root, scope as scoped } from "./paths";
import * as planner from "./planner";
import { now } from "./time";

function warnIdentityMismatch(label: string | null, context: string) {
  const claimed = identityToken({ label });
  const actual = processIdentity();
  if (!claimed || !actual) return;
  if (claimed !== actual) {
    console.warn(
      `[swarm-mcp] ${context}: claimed ${claimed} but process AGENT_IDENTITY is ${actual.slice("identity:".length)}. ` +
        `The launcher and label disagree — coordination-write checks will trust the label, not the process env. ` +
        `Verify the calling agent is launched under the matching identity wrapper.`,
    );
  }
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandHome(path: string) {
  return path === "~" || path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : resolve(path);
}

function isUnder(path: string, base: string) {
  const rel = relative(base, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function identityRoots(identity: string) {
  const envName = profileScopedEnvName(identity, "ROOTS");
  return envName ? envList(envName).map(expandHome) : [];
}

function validateIdentityDirectory(label: string | null, dir: string, fileRoot: string) {
  const identity = identityName({ label });
  if (!identity) return;
  const roots = identityRoots(identity);
  if (!roots.length) return;
  if (roots.some((base) => isUnder(dir, base) && isUnder(fileRoot, base))) return;
  const rootsEnvName = profileScopedEnvName(identity, "ROOTS") || `SWARM_MCP_<PROFILE>_ROOTS`;
  throw new Error(
    `Registration blocked: identity:${identity} directory must be under one of ${roots.join(", ")}. Set ${rootsEnvName} to override.`,
  );
}

export type Instance = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  file_root: string;
  pid: number;
  label: string | null;
  adopted: boolean;
  lease_until: number | null;
};

type InstanceRow = Omit<Instance, "adopted" | "lease_until"> & {
  adopted: number;
  lease_until: number | null;
};

const INSTANCE_COLUMNS =
  "id, scope, directory, root, file_root, pid, label, adopted, lease_until";

function instanceRow(id: string): InstanceRow | null {
  return db
    .query(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE id = ?`,
    )
    .get(id) as InstanceRow | null;
}

function adopt(existing: InstanceRow, nextLabel: string | null): Instance {
  db.run(
    `UPDATE instances
     SET pid = ?, label = ?, adopted = 1, heartbeat = unixepoch(), lease_until = NULL
     WHERE id = ?`,
    [process.pid, nextLabel, existing.id],
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
    lease_until: null,
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

export function adoptInstanceId(
  directory: string,
  label: string | undefined,
  value: string | undefined,
  instanceId: string,
): Instance | null {
  prune();

  const dir = norm(directory);
  const nextScope = scoped(dir, value);
  const trimmedLabel = label?.trim() || null;
  const existing = instanceRow(instanceId);
  if (!existing) return null;
  if (existing.scope !== nextScope || existing.directory !== dir) return null;
  const nextLabel = trimmedLabel ?? existing.label;
  warnIdentityMismatch(nextLabel, `adoptInstanceId(${instanceId})`);
  return adopt(existing, nextLabel);
}

export function prune(mode: CleanupMode = "opportunistic") {
  runCleanup({ mode });
}

export function register(
  directory: string,
  label?: string,
  value?: string,
  fileRoot?: string,
  preassignedId?: string,
  adoptId?: string,
): Instance {
  prune();

  const dir = norm(directory);
  const trimmedLabel = label?.trim() || null;
  const nextScope = scoped(dir, value);
  const nextFileRoot = norm(fileRoot || dir);

  warnIdentityMismatch(trimmedLabel, "register");
  validateIdentityDirectory(trimmedLabel, dir, nextFileRoot);

  if (adoptId) {
    const adopted = adoptInstanceId(directory, label, value, adoptId);
    if (adopted) return adopted;
  }

  // Adoption path: a UI-owned instance row was pre-created with `adopted = 0`
  // and its id injected via SWARM_MCP_INSTANCE_ID. Update the existing row
  // with the live pid + label and flip `adopted = 1`. We leave
  // scope/directory/root/file_root alone since the UI already computed them
  // for the same directory.
  if (preassignedId) {
    const existing = instanceRow(preassignedId);

    if (existing) {
      return adopt(existing, trimmedLabel ?? existing.label);
    }
    // If the pre-created row was pruned before adoption (stale heartbeat,
    // manual deregister), fall through to a fresh INSERT with that same id
    // so the UI's PTY binding stays valid.
  }

  if (!preassignedId && trimmedLabel && /\bsession:[^\s]+/.test(trimmedLabel)) {
    const existing = db
      .query(
        `SELECT ${INSTANCE_COLUMNS}
         FROM instances
         WHERE scope = ? AND directory = ? AND label = ?
         ORDER BY registered_at ASC
         LIMIT 1`,
      )
      .get(nextScope, dir, trimmedLabel) as InstanceRow | null;
    if (existing) return adopt(existing, trimmedLabel);
  }

  const requestedId = preassignedId ?? (adoptId && !instanceRow(adoptId) ? adoptId : undefined);
  const row: Instance = {
    id: requestedId ?? randomUUID(),
    scope: nextScope,
    directory: dir,
    root: root(dir),
    file_root: nextFileRoot,
    pid: process.pid,
    label: trimmedLabel,
    adopted: true,
    lease_until: null,
  };

  db.run(
    "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted, lease_until) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)",
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

export function precreateInstanceLease(
  directory: string,
  label: string | undefined,
  value: string | undefined,
  fileRoot: string | undefined,
  leaseUntil: number,
  requestedId?: string,
): Instance {
  prune();

  const dir = norm(directory);
  const trimmedLabel = label?.trim() || null;
  const nextScope = scoped(dir, value);
  const nextFileRoot = norm(fileRoot || dir);

  warnIdentityMismatch(trimmedLabel, "precreateInstanceLease");
  validateIdentityDirectory(trimmedLabel, dir, nextFileRoot);

  const row: Instance = {
    id: requestedId ?? randomUUID(),
    scope: nextScope,
    directory: dir,
    root: root(dir),
    file_root: nextFileRoot,
    pid: 0,
    label: trimmedLabel,
    adopted: false,
    lease_until: leaseUntil,
  };

  db.run(
    "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, adopted, lease_until) VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)",
    [row.id, row.scope, row.directory, row.root, row.file_root, row.label, row.lease_until],
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
      lease_until: row.lease_until,
    },
  });

  return row;
}

export function get(id: string) {
  prune();
  const row = db
    .query(
      `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE id = ?`,
    )
    .get(id) as InstanceRow | null;
  if (!row) return null;
  return { ...row, adopted: row.adopted !== 0 } as Instance;
}

export function setLease(id: string, leaseUntil: number) {
  db.run(
    `UPDATE instances
     SET adopted = 0, heartbeat = unixepoch(), lease_until = ?
     WHERE id = ?`,
    [leaseUntil, id],
  );
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
  db.run("UPDATE instances SET pid = ?, heartbeat = ? WHERE id = ?", [
    process.pid,
    now(),
    id,
  ]);

  const item = db
    .query("SELECT id, scope, label FROM instances WHERE id = ?")
    .get(id) as { id: string; scope: string; label: string | null } | null;
  if (item) planner.ensureOwner(item);

  prune("periodic");
}

export function list(scope?: string, labelContains?: string) {
  prune();

  const where: string[] = ["adopted = 1"];
  const args: (string | number)[] = [];

  if (scope) {
    where.push("scope = ?");
    args.push(scope);
  }
  if (labelContains) {
    where.push("label LIKE '%' || ? || '%'");
    args.push(labelContains);
  }

  return db
    .query(
      `SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, adopted, lease_until FROM instances WHERE ${where.join(" AND ")} ORDER BY registered_at ASC`,
    )
    .all(...args);
}

export function listVisible(viewer: Instance, labelContains?: string) {
  return (list(viewer.scope, labelContains) as Instance[]).filter(
    (item) => item.id === viewer.id || identityMatches(viewer, item),
  );
}
