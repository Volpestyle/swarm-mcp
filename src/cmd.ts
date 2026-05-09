import { db } from "./db";
import { CLEANUP_POLICY, runCleanup } from "./cleanup";
import * as context from "./context";
import * as kv from "./kv";
import * as messages from "./messages";
import * as registry from "./registry";
import * as taskStore from "./tasks";
import * as ui from "./ui";
import { scope as scopeFor } from "./paths";
import { SUBCOMMANDS, type Subcommand } from "./subcommands";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TASK_TYPES, type TaskType } from "./generated/protocol";

type Flags = {
  positional: string[];
  json: boolean;
  scope?: string;
  as?: string;
  to?: string;
  from?: string;
  limit?: number;
  prefix?: string;
  status?: string;
  note?: string;
  target?: string;
  harness?: string;
  role?: string;
  label?: string;
  name?: string;
  directory?: string;
  fileRoot?: string;
  message?: string;
  task?: string;
  taskType?: string;
  description?: string;
  idempotencyKey?: string;
  files: string[];
  assignee?: string;
  dependsOn?: string;
  parentTaskId?: string;
  priority?: number;
  kind?: string;
  x?: number;
  y?: number;
  wait?: number;
  leaseSeconds?: number;
  approvalRequired: boolean;
  spawn: boolean;
  force: boolean;
  nudge: boolean;
  enter: boolean;
  dryRun: boolean;
};

type InstRow = {
  id: string;
  scope: string;
  directory: string;
  label: string | null;
  pid: number;
  registered_at: number;
  heartbeat: number;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    positional: [],
    json: false,
    files: [],
    approvalRequired: false,
    spawn: true,
    enter: true,
    force: false,
    nudge: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { flags.json = true; continue; }
    if (a === "--scope") { flags.scope = argv[++i]; continue; }
    if (a === "--as") { flags.as = argv[++i]; continue; }
    if (a === "--to") { flags.to = argv[++i]; continue; }
    if (a === "--from") { flags.from = argv[++i]; continue; }
    if (a === "--limit") { flags.limit = parseInt(argv[++i] ?? "", 10); continue; }
    if (a === "--prefix") { flags.prefix = argv[++i]; continue; }
    if (a === "--status") { flags.status = argv[++i]; continue; }
    if (a === "--note") { flags.note = argv[++i]; continue; }
    if (a === "--target") { flags.target = argv[++i]; continue; }
    if (a === "--harness") { flags.harness = argv[++i]; continue; }
    if (a === "--role") { flags.role = argv[++i]; continue; }
    if (a === "--label") { flags.label = argv[++i]; continue; }
    if (a === "--name") { flags.name = argv[++i]; continue; }
    if (a === "--directory") { flags.directory = argv[++i]; continue; }
    if (a === "--file-root") { flags.fileRoot = argv[++i]; continue; }
    if (a === "--message") { flags.message = argv[++i]; continue; }
    if (a === "--task" || a === "--task-id") { flags.task = argv[++i]; continue; }
    if (a === "--type") { flags.taskType = argv[++i]; continue; }
    if (a === "--description") { flags.description = argv[++i]; continue; }
    if (a === "--idempotency-key") { flags.idempotencyKey = argv[++i]; continue; }
    if (a === "--file") { flags.files.push(argv[++i]); continue; }
    if (a === "--assignee") { flags.assignee = argv[++i]; continue; }
    if (a === "--depends-on") { flags.dependsOn = argv[++i]; continue; }
    if (a === "--parent-task") { flags.parentTaskId = argv[++i]; continue; }
    if (a === "--priority") { flags.priority = parseInt(argv[++i] ?? "", 10); continue; }
    if (a === "--kind") { flags.kind = argv[++i]; continue; }
    if (a === "--x") { flags.x = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--y") { flags.y = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--wait") { flags.wait = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--lease-seconds") { flags.leaseSeconds = parseInt(argv[++i] ?? "", 10); continue; }
    if (a === "--approval-required") { flags.approvalRequired = true; continue; }
    if (a === "--no-spawn") { flags.spawn = false; continue; }
    if (a === "--force") { flags.force = true; continue; }
    if (a === "--dry-run") { flags.dryRun = true; continue; }
    if (a === "--no-nudge") { flags.nudge = false; continue; }
    if (a === "--no-enter") { flags.enter = false; continue; }
    if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    flags.positional.push(a);
  }
  return flags;
}

function resolveScope(flags: Flags): string {
  return scopeFor(process.cwd(), flags.scope);
}

function instancesInScope(scope: string): InstRow[] {
  return db.query(
    "SELECT id, scope, directory, label, pid, registered_at, heartbeat FROM instances WHERE scope = ? ORDER BY registered_at ASC",
  ).all(scope) as InstRow[];
}

function formatInst(i: { id: string; label: string | null }) {
  const short = i.id.slice(0, 8);
  return i.label ? `${short} (${i.label})` : short;
}

function resolveInstanceRef(ref: string, insts: InstRow[]): string {
  const byId = insts.find((i) => i.id === ref);
  if (byId) return byId.id;
  const byPrefix = insts.filter((i) => i.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0].id;
  if (byPrefix.length > 1) {
    throw new Error(
      `Ambiguous id prefix "${ref}": ${byPrefix.map(formatInst).join(", ")}`,
    );
  }
  const byLabel = insts.filter((i) => i.label?.includes(ref));
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) {
    throw new Error(
      `Ambiguous label match "${ref}": ${byLabel.map(formatInst).join(", ")}`,
    );
  }
  throw new Error(
    `No instance matches "${ref}" in this scope. Candidates: ${insts.map(formatInst).join(", ") || "(none)"}`,
  );
}

function resolveIdentity(scope: string, flags: Flags): string {
  const explicit = flags.as ?? process.env.SWARM_MCP_INSTANCE_ID;
  const insts = instancesInScope(scope);
  if (explicit) return resolveInstanceRef(explicit, insts);
  if (insts.length === 1) return insts[0].id;
  if (insts.length === 0) {
    throw new Error(
      `No instances registered in scope ${scope}. Pass --as <id-or-label> or set SWARM_MCP_INSTANCE_ID.`,
    );
  }
  throw new Error(
    `Multiple instances in scope ${scope}; pass --as <id-or-label>. Candidates: ${insts.map(formatInst).join(", ")}`,
  );
}

function resolveOptionalIdentity(scope: string, flags: Flags): string | null {
  const explicit = flags.as ?? process.env.SWARM_MCP_INSTANCE_ID;
  const insts = instancesInScope(scope);
  if (explicit) return resolveInstanceRef(explicit, insts);
  if (insts.length === 1) return insts[0].id;
  return null;
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function ts(n: number) {
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function idleLabel(heartbeat: number) {
  const idle = Math.max(0, Math.floor(Date.now() / 1000) - heartbeat);
  if (idle > CLEANUP_POLICY.instanceReclaimAfterSecs) return `offline (${idle}s)`;
  if (idle > CLEANUP_POLICY.instanceStaleAfterSecs) return `stale (${idle}s)`;
  return `live (${idle}s)`;
}

function parseTaskType(value: string | undefined, fallback: TaskType = "other"): TaskType {
  const raw = (value ?? fallback).trim();
  if ((TASK_TYPES as readonly string[]).includes(raw)) return raw as TaskType;
  throw new Error(`Invalid task type "${raw}". Expected one of: ${TASK_TYPES.join(", ")}`);
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function terminalTaskStatus(status: unknown) {
  return status === "done" || status === "failed" || status === "cancelled";
}

function roleToken(role: string | undefined) {
  const clean = (role ?? "").trim();
  return clean ? `role:${clean}` : "";
}

function hasRole(inst: InstRow, role: string | undefined) {
  const token = roleToken(role);
  if (!token) return true;
  return (inst.label ?? "").split(/\s+/).includes(token);
}

function hasLabelToken(inst: InstRow | null | undefined, token: string) {
  return (inst?.label ?? "").split(/\s+/).includes(token);
}

function instanceById(scope: string, id: string) {
  return instancesInScope(scope).find((inst) => inst.id === id) ?? null;
}

function envTruthy(name: string) {
  return (process.env[name] ?? "").trim().toLowerCase().match(/^(1|true|yes|on)$/) !== null;
}

function requireSpawnAuthority(scope: string, requester: string, action: string) {
  if (envTruthy("SWARM_MCP_ALLOW_SPAWN")) return;
  const inst = instanceById(scope, requester);
  if (hasLabelToken(inst, "mode:gateway")) return;
  throw new Error(
    `${action} is gateway-only. Use a requester labeled mode:gateway, or set SWARM_MCP_ALLOW_SPAWN=1 from a trusted operator shell.`,
  );
}

function findWorker(scope: string, requester: string, role: string | undefined) {
  return instancesInScope(scope).find((inst) => inst.id !== requester && hasRole(inst, role)) ?? null;
}

function hashIntent(parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

const UI_WAIT_POLL_MS = 100;
const DEFAULT_UI_WAIT_SECS = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUiCommand(id: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let row = ui.get(id);
  while (
    row &&
    row.status !== "done" &&
    row.status !== "failed" &&
    Date.now() < deadline
  ) {
    await sleep(UI_WAIT_POLL_MS);
    row = ui.get(id);
  }
  return row;
}

function parseJsonMaybe(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function printUiCommand(row: ui.UiCommandRow, asJson: boolean) {
  if (asJson) {
    return printJson({
      ...row,
      payload: parseJsonMaybe(row.payload),
      result: parseJsonMaybe(row.result),
    });
  }

  console.log(
    `#${row.id}  [${row.status}]  ${row.kind}  scope=${row.scope}`,
  );
  if (row.result) {
    console.log(`  result: ${JSON.stringify(parseJsonMaybe(row.result))}`);
  }
  if (row.error) {
    console.log(`  error: ${row.error}`);
  }
}

async function maybeWaitForUiCommand(
  id: number,
  flags: Flags,
  fallbackSeconds = DEFAULT_UI_WAIT_SECS,
) {
  const waitSeconds = flags.wait ?? fallbackSeconds;
  if (waitSeconds <= 0) return ui.get(id);
  return waitForUiCommand(id, Math.round(waitSeconds * 1000));
}

async function enqueueUiCommand(
  scope: string,
  kind: ui.UiCommandKind,
  payload: Record<string, unknown>,
  flags: Flags,
  fallbackSeconds = DEFAULT_UI_WAIT_SECS,
  createdBy = resolveOptionalIdentity(scope, flags),
) {
  const id = ui.enqueue(scope, kind, payload, createdBy);
  const row = await maybeWaitForUiCommand(id, flags, fallbackSeconds);
  if (!row) throw new Error(`ui command ${id} disappeared`);
  printUiCommand(row, flags.json);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdInstances(flags: Flags) {
  const scope = resolveScope(flags);
  const rows = instancesInScope(scope);
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log(`(no instances in scope ${scope})`);
  console.log(`scope: ${scope}`);
  for (const r of rows) {
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.label ?? "-"}  pid=${r.pid}  ${idleLabel(r.heartbeat)}`,
    );
  }
}

function cmdRegister(flags: Flags) {
  const directory = flags.directory ?? flags.positional[1] ?? process.cwd();
  const label = flags.label;
  const instance = registry.register(
    directory,
    label,
    flags.scope,
    flags.fileRoot,
    process.env.SWARM_MCP_INSTANCE_ID?.trim() || undefined,
  );
  let leasedHeartbeat: number | null = null;
  if (Number.isFinite(flags.leaseSeconds) && (flags.leaseSeconds ?? 0) > 0) {
    leasedHeartbeat = Math.floor(Date.now() / 1000) + (flags.leaseSeconds ?? 0);
    db.run("UPDATE instances SET heartbeat = unixepoch() + ? WHERE id = ?", [
      flags.leaseSeconds,
      instance.id,
    ]);
  }
  if (flags.json) return printJson(leasedHeartbeat ? { ...instance, heartbeat: leasedHeartbeat } : instance);
  console.log(`registered ${instance.id}`);
}

function cmdDeregister(flags: Flags) {
  const scope = resolveScope(flags);
  const id = resolveIdentity(scope, flags);
  registry.deregister(id);
  if (flags.json) return printJson({ ok: true, id, scope });
  console.log(`deregistered ${id}`);
}

function cmdWhoami(flags: Flags) {
  const scope = resolveScope(flags);
  const id = resolveIdentity(scope, flags);
  const instance = registry.get(id);
  if (!instance) {
    if (flags.json) return printJson(null);
    process.exit(1);
  }
  if (flags.json) return printJson(instance);
  console.log(`${instance.id}  ${instance.label ?? "-"}  scope=${instance.scope}`);
}

function cmdMessages(flags: Flags) {
  const scope = resolveScope(flags);
  const limit = flags.limit ?? 50;
  const where: string[] = ["scope = ?"];
  const args: (string | number)[] = [scope];
  if (flags.to) {
    const insts = instancesInScope(scope);
    where.push("recipient = ?");
    args.push(resolveInstanceRef(flags.to, insts));
  }
  if (flags.from) {
    const insts = instancesInScope(scope);
    where.push("sender = ?");
    args.push(resolveInstanceRef(flags.from, insts));
  }
  args.push(limit);
  const rows = db
    .query(
      `SELECT id, sender, recipient, content, created_at, read
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...args) as Array<{
      id: number;
      sender: string;
      recipient: string;
      content: string;
      created_at: number;
      read: number;
    }>;
  rows.reverse();
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no messages)");
  for (const r of rows) {
    const readMark = r.read ? " " : "*";
    console.log(
      `${readMark} #${r.id}  ${ts(r.created_at)}  ${r.sender.slice(0, 8)} → ${r.recipient.slice(0, 8)}`,
    );
    for (const line of r.content.split("\n")) console.log(`    ${line}`);
  }
}

function cmdTasks(flags: Flags) {
  const scope = resolveScope(flags);
  const where: string[] = ["scope = ?"];
  const args: (string | number)[] = [scope];
  if (flags.status) {
    where.push("status = ?");
    args.push(flags.status);
  }
  const rows = db
    .query(
      `SELECT id, type, title, status, assignee, requester, priority, created_at
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC`,
    )
    .all(...args);
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no tasks)");
  for (const r of rows as Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    assignee: string | null;
    requester: string;
    priority: number;
  }>) {
    const who = r.assignee ? r.assignee.slice(0, 8) : "-";
    console.log(
      `  ${r.id.slice(0, 8)}  [${r.status}]  ${r.type}  p${r.priority}  assignee=${who}  ${r.title}`,
    );
  }
}

function taskRequestOpts(flags: Flags, insts: InstRow[]) {
  const assignee = flags.assignee ? resolveInstanceRef(flags.assignee, insts) : undefined;
  return {
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.files.length ? { files: flags.files } : {}),
    ...(assignee ? { assignee } : {}),
    ...(Number.isFinite(flags.priority) ? { priority: flags.priority } : {}),
    ...(splitCsv(flags.dependsOn) ? { depends_on: splitCsv(flags.dependsOn) } : {}),
    ...(flags.idempotencyKey ? { idempotency_key: flags.idempotencyKey } : {}),
    ...(flags.parentTaskId ? { parent_task_id: flags.parentTaskId } : {}),
    ...(flags.approvalRequired ? { approval_required: true } : {}),
  };
}

function cmdRequestTask(flags: Flags) {
  const scope = resolveScope(flags);
  const requester = resolveIdentity(scope, flags);
  const insts = instancesInScope(scope);

  const typeFromPosition = flags.positional[1];
  const taskType = parseTaskType(flags.taskType ?? typeFromPosition);
  const titleParts = flags.taskType ? flags.positional.slice(1) : flags.positional.slice(2);
  const title = titleParts.join(" ").trim();
  if (!title) throw new Error("request-task <type> <title...>");

  const result = taskStore.request(
    requester,
    scope,
    taskType,
    title,
    taskRequestOpts(flags, insts),
  );
  if ("error" in result) throw new Error(result.error);

  const task = taskStore.get(result.id, scope);
  if (flags.json) return printJson({ ...result, task });
  console.log(`${result.existing ? "existing" : "created"} task ${result.id} [${result.status}] ${title}`);
}

function cmdContext(flags: Flags) {
  const scope = resolveScope(flags);
  const rows = db
    .query(
      `SELECT id, instance_id, file, type, content, created_at
       FROM context
       WHERE scope = ?
       ORDER BY created_at ASC`,
    )
    .all(scope) as Array<{
      id: string;
      instance_id: string;
      file: string;
      type: string;
      content: string;
      created_at: number;
    }>;
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no context entries)");
  for (const r of rows) {
    console.log(
      `  [${r.type}] ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
    );
  }
}

type SpawnLockRow = {
  id: string;
  instance_id: string;
  file: string;
  content: string;
};

function spawnLockPath(role: string, intentHash: string) {
  const cleanRole = role.replace(/[^A-Za-z0-9_.-]/g, "_") || "worker";
  return `/__swarm/spawn/${cleanRole}/${intentHash}`;
}

function exactSpawnLock(scope: string, file: string) {
  return db
    .query(
      "SELECT id, instance_id, file, content FROM context WHERE scope = ? AND file = ? AND type = 'lock' LIMIT 1",
    )
    .get(scope, file) as SpawnLockRow | null;
}

function activeSpawnLock(scope: string, file: string) {
  const lock = exactSpawnLock(scope, file);
  if (!lock) return null;

  try {
    const payload = JSON.parse(lock.content) as { ui_command_id?: unknown };
    const id = Number(payload.ui_command_id);
    if (Number.isInteger(id)) {
      const row = ui.get(id);
      if (row?.status === "done" || row?.status === "failed") {
        context.clearLocks(lock.instance_id, scope, file);
        return null;
      }
    }
  } catch {
    // Older lock notes may be plain text. Treat them as active.
  }
  return lock;
}

function dispatchInstruction(taskId: string, title: string, message: string) {
  const body = message.trim() || title;
  return [
    `Task ${taskId} is ready: ${title}`,
    body,
    "Call poll_messages first, claim the task if it matches your role, then complete it with update_task and structured results.",
  ].join("\n\n");
}

async function cmdDispatch(flags: Flags) {
  const scope = resolveScope(flags);
  const requester = resolveIdentity(scope, flags);
  requireSpawnAuthority(scope, requester, "dispatch");
  const taskType = parseTaskType(flags.taskType, "implement");
  const title = flags.positional.slice(1).join(" ").trim();
  if (!title) throw new Error("dispatch <title...> [--message <instructions>]");

  const message = flags.message ?? flags.description ?? title;
  const workerRole = (flags.role ?? "implementer").trim();
  const idempotencyKey =
    flags.idempotencyKey ??
    `dispatch:${hashIntent([scope, taskType, title, message, workerRole])}`;
  const intentHash = hashIntent([idempotencyKey]);
  const lockPath = spawnLockPath(workerRole, intentHash);

  const result = taskStore.request(requester, scope, taskType, title, {
    description: flags.description ?? message,
    files: flags.files.length ? flags.files : undefined,
    priority: Number.isFinite(flags.priority) ? flags.priority : undefined,
    depends_on: splitCsv(flags.dependsOn),
    idempotency_key: idempotencyKey,
    parent_task_id: flags.parentTaskId,
    approval_required: flags.approvalRequired,
  });
  if ("error" in result) throw new Error(result.error);

  const task = taskStore.get(result.id, scope);
  if (terminalTaskStatus(task?.status)) {
    const payload = { status: "already_terminal", task_id: result.id, task };
    if (flags.json) return printJson(payload);
    console.log(`task ${result.id} is already ${task?.status}`);
    return;
  }

  const liveWorker = findWorker(scope, requester, workerRole);
  if (liveWorker) {
    context.clearLocks(requester, scope, lockPath);
    const prompt = promptPeerResult({
      scope,
      sender: requester,
      recipient: liveWorker.id,
      message: dispatchInstruction(result.id, title, message),
      task: result.id,
      nudge: flags.nudge,
      force: flags.force,
    });
    const payload = {
      status: "dispatched",
      task_id: result.id,
      task,
      recipient: liveWorker.id,
      prompt,
    };
    if (flags.json) return printJson(payload);
    console.log(`dispatched task ${result.id} to ${formatInst(liveWorker)}`);
    return;
  }

  if (!flags.spawn) {
    const payload = { status: "no_worker", task_id: result.id, task, role: workerRole };
    if (flags.json) return printJson(payload);
    console.log(`created task ${result.id}; no role:${workerRole} worker is live`);
    return;
  }

  const existingLock = activeSpawnLock(scope, lockPath);
  if (existingLock) {
    const payload = {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: existingLock,
    };
    if (flags.json) return printJson(payload);
    console.log(`task ${result.id} is ready; spawn already in flight at ${lockPath}`);
    return;
  }

  const startedAt = new Date().toISOString();
  const lockNote = {
    task_id: result.id,
    intent_hash: intentHash,
    role: workerRole,
    started_at: startedAt,
  };
  const lockResult = context.lock(requester, scope, lockPath, JSON.stringify(lockNote));
  if ("error" in lockResult) {
    const payload = {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: lockResult.active,
    };
    if (flags.json) return printJson(payload);
    console.log(`task ${result.id} is ready; spawn already in flight at ${lockPath}`);
    return;
  }

  const commandId = ui.enqueue(
    scope,
    "spawn_shell",
    {
      cwd: flags.directory ?? process.cwd(),
      harness: flags.harness ?? "claude",
      role: workerRole,
      label: flags.label ?? null,
      name: flags.name ?? null,
    },
    requester,
  );
  context.lock(
    requester,
    scope,
    lockPath,
    JSON.stringify({ ...lockNote, ui_command_id: commandId }),
  );

  const row = await maybeWaitForUiCommand(commandId, flags, 5);
  const basePayload = {
    task_id: result.id,
    task,
    ui_command_id: commandId,
    spawn_lock: lockPath,
  };

  if (!row || row.status === "pending" || row.status === "running") {
    const payload = { status: "spawn_in_flight", ...basePayload, ui_command: row };
    if (flags.json) return printJson(payload);
    console.log(`queued spawn command #${commandId} for role:${workerRole}; lock held at ${lockPath}`);
    return;
  }

  if (row.status === "failed") {
    context.clearLocks(requester, scope, lockPath);
    const payload = { status: "spawn_failed", ...basePayload, ui_command: row };
    if (flags.json) return printJson(payload);
    console.log(`spawn command #${commandId} failed: ${row.error ?? "unknown error"}`);
    return;
  }

  context.clearLocks(requester, scope, lockPath);
  const spawnResult = parseJsonMaybe(row.result) as { instance_id?: unknown } | null;
  const spawnedInstance =
    spawnResult && typeof spawnResult.instance_id === "string" ? spawnResult.instance_id : "";
  const prompt = spawnedInstance
    ? promptPeerResult({
        scope,
        sender: requester,
        recipient: spawnedInstance,
        message: dispatchInstruction(result.id, title, message),
        task: result.id,
        nudge: false,
        force: flags.force,
      })
    : null;
  const payload = {
    status: "spawned",
    ...basePayload,
    spawned_instance: spawnedInstance || null,
    ui_command: row,
    prompt,
  };
  if (flags.json) return printJson(payload);
  console.log(
    `spawned role:${workerRole} for task ${result.id}${spawnedInstance ? ` (${spawnedInstance.slice(0, 8)})` : ""}`,
  );
}

function cmdKv(flags: Flags) {
  const [sub, ...rest] = flags.positional.slice(1);
  const scope = resolveScope(flags);
  if (!sub || sub === "list") {
    const rows = kv.keys(scope, flags.prefix) as Array<{
      key: string;
      updated_at: number;
    }>;
    if (flags.json) return printJson(rows);
    if (!rows.length) return console.log("(no kv entries)");
    for (const r of rows) console.log(`  ${r.key}  (${ts(r.updated_at)})`);
    return;
  }
  if (sub === "get") {
    const key = rest[0];
    if (!key) throw new Error("kv get <key>");
    const row = kv.get(scope, key);
    if (!row) {
      if (flags.json) return printJson(null);
      process.exit(1);
    }
    if (flags.json) return printJson(row);
    console.log(row.value);
    return;
  }
  if (sub === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) throw new Error("kv set <key> <value>");
    const actor = resolveIdentity(scope, flags);
    kv.set(scope, key, value, actor);
    if (flags.json) return printJson({ ok: true, key });
    console.log(`set ${key}`);
    return;
  }
  if (sub === "append") {
    const [key, value] = rest;
    if (!key || value === undefined) {
      throw new Error("kv append <key> <json-value>");
    }
    const actor = resolveIdentity(scope, flags);
    const length = kv.append(scope, key, value, actor);
    if (flags.json) return printJson({ ok: true, key, length });
    console.log(`appended to ${key} (length=${length})`);
    return;
  }
  if (sub === "del") {
    const key = rest[0];
    if (!key) throw new Error("kv del <key>");
    const actor = resolveIdentity(scope, flags);
    kv.del(scope, key, actor);
    if (flags.json) return printJson({ ok: true, key });
    console.log(`deleted ${key}`);
    return;
  }
  throw new Error(`Unknown kv subcommand: ${sub}`);
}

function cmdSend(flags: Flags) {
  const content = flags.positional.slice(1).join(" ");
  if (!flags.to) throw new Error("send requires --to <id-or-label>");
  if (!content) throw new Error("send requires content");
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const insts = instancesInScope(scope);
  const recipient = resolveInstanceRef(flags.to, insts);
  messages.send(sender, scope, recipient, content);
  if (flags.json) {
    return printJson({ ok: true, sender, recipient, scope });
  }
  console.log(`sent ${sender.slice(0, 8)} → ${recipient.slice(0, 8)}`);
}

function cmdBroadcast(flags: Flags) {
  const content = flags.positional.slice(1).join(" ");
  if (!content) throw new Error("broadcast requires content");
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const count = messages.broadcast(sender, scope, content);
  if (flags.json) return printJson({ ok: true, sender, scope, count });
  console.log(`broadcast to ${count} recipient(s)`);
}

function herdrEnv(identity: Record<string, unknown>) {
  const env = { ...process.env };
  if (typeof identity.socket_path === "string" && identity.socket_path) {
    env.HERDR_SOCKET_PATH = identity.socket_path;
  }
  return env;
}

function runHerdr(args: string[], identity: Record<string, unknown>) {
  return spawnSync("herdr", args, {
    encoding: "utf8",
    env: herdrEnv(identity),
    timeout: 5_000,
  });
}

function promptPeerResult(opts: {
  scope: string;
  sender: string;
  recipient: string;
  message: string;
  task?: string;
  nudge: boolean;
  force: boolean;
}) {
  const { scope, sender, recipient, message, task, nudge, force } = opts;
  const durable = task ? `[task:${task}] ${message}` : message;
  messages.send(sender, scope, recipient, durable);

  const result: Record<string, unknown> = {
    message_sent: true,
    sender,
    recipient,
    nudged: false,
  };
  if (!nudge) {
    result.nudge_skipped = "nudge=false";
    return result;
  }

  const identityRow = kv.get(scope, `identity/herdr/${recipient}`);
  if (!identityRow) {
    result.nudge_skipped = "no herdr identity is published for that instance";
    return result;
  }

  let identity: Record<string, unknown>;
  try {
    const parsed = JSON.parse(identityRow.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("identity is not an object");
    }
    identity = parsed as Record<string, unknown>;
  } catch {
    result.nudge_skipped = "published herdr identity is not valid JSON";
    return result;
  }

  const paneId = identity.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    result.nudge_skipped = "published herdr identity has no pane_id";
    return result;
  }

  const getProc = runHerdr(["pane", "get", paneId], identity);
  if (getProc.error || getProc.status !== 0) {
    result.pane_id = paneId;
    result.nudge_skipped =
      getProc.error?.message ||
      getProc.stderr?.trim() ||
      getProc.stdout?.trim() ||
      "herdr pane get failed";
    return result;
  }

  let status = "unknown";
  try {
    const payload = JSON.parse(getProc.stdout || "{}");
    const pane = payload?.result?.pane;
    if (pane && typeof pane.agent_status === "string") status = pane.agent_status;
  } catch {
    status = "unknown";
  }
  result.pane_id = paneId;
  result.agent_status = status;

  if (!["idle", "blocked", "done", "unknown"].includes(status) && !force) {
    result.nudge_skipped = `target pane is ${status}; pass --force to inject anyway`;
    return result;
  }

  const wakePrompt = `A peer sent you a swarm message${task ? ` for task ${task}` : ""}. Call the swarm poll_messages tool, handle the message, and report back through swarm-mcp.`;
  const runProc = runHerdr(["pane", "run", paneId, wakePrompt], identity);
  if (runProc.error || runProc.status !== 0) {
    result.nudge_error =
      runProc.error?.message ||
      runProc.stderr?.trim() ||
      runProc.stdout?.trim() ||
      "herdr pane run failed";
  } else {
    result.nudged = true;
  }
  return result;
}

function cmdPromptPeer(flags: Flags) {
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const recipientRef = flags.to ?? flags.positional[1];
  if (!recipientRef) throw new Error("prompt-peer requires --to <id-or-label>");
  const message = flags.message ?? flags.positional.slice(recipientRef === flags.positional[1] ? 2 : 1).join(" ");
  if (!message) throw new Error("prompt-peer requires --message <text> or content");

  const insts = instancesInScope(scope);
  const recipient = resolveInstanceRef(recipientRef, insts);
  const result = promptPeerResult({
    scope,
    sender,
    recipient,
    message,
    task: flags.task,
    nudge: flags.nudge,
    force: flags.force,
  });

  if (flags.json) return printJson(result);
  const suffix = result.nudged
    ? " and nudged pane"
    : result.nudge_skipped
      ? ` (${result.nudge_skipped})`
      : "";
  console.log(`sent ${sender.slice(0, 8)} → ${recipient.slice(0, 8)}${suffix}`);
}

function cmdLock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("lock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  const res = context.lock(inst, scope, file, flags.note ?? "");
  if ("error" in res) {
    if (flags.json) return printJson(res);
    console.error(`lock failed: ${res.error}`);
    process.exit(1);
  }
  if (flags.json) return printJson(res);
  console.log(`locked ${file}`);
}

function cmdUnlock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("unlock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  context.clearLocks(inst, scope, file);
  if (flags.json) return printJson({ ok: true, file });
  console.log(`unlocked ${file}`);
}

function cmdInspect(flags: Flags) {
  const scope = resolveScope(flags);
  const insts = instancesInScope(scope);
  const msgs = db
    .query(
      `SELECT id, sender, recipient, content, created_at, read
       FROM messages WHERE scope = ? ORDER BY id DESC LIMIT 20`,
    )
    .all(scope);
  const tsks = db
    .query(
      `SELECT id, type, title, status, assignee, requester
       FROM tasks WHERE scope = ? ORDER BY created_at ASC`,
    )
    .all(scope);
  const ctx = db
    .query(
      `SELECT id, instance_id, file, type, content, created_at
       FROM context WHERE scope = ? ORDER BY created_at ASC`,
    )
    .all(scope);
  const kvs = kv.keys(scope) as Array<{ key: string; updated_at: number }>;

  if (flags.json) {
    return printJson({
      scope,
      instances: insts,
      messages: (msgs as unknown[]).slice().reverse(),
      tasks: tsks,
      context: ctx,
      kv: kvs,
    });
  }

  console.log(`scope: ${scope}\n`);
  console.log(`instances (${insts.length}):`);
  for (const r of insts) {
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.label ?? "-"}  ${idleLabel(r.heartbeat)}`,
    );
  }
  console.log(`\ntasks (${(tsks as unknown[]).length}):`);
  for (const r of tsks as Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    assignee: string | null;
  }>) {
    console.log(
      `  ${r.id.slice(0, 8)}  [${r.status}]  ${r.type}  ${r.title}`,
    );
  }
  console.log(`\ncontext (${(ctx as unknown[]).length}):`);
  for (const r of ctx as Array<{
    instance_id: string;
    file: string;
    type: string;
    content: string;
  }>) {
    console.log(
      `  [${r.type}] ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
    );
  }
  console.log(`\nkv (${kvs.length}):`);
  for (const r of kvs) console.log(`  ${r.key}  (${ts(r.updated_at)})`);
  console.log(`\nrecent messages (${(msgs as unknown[]).length}, newest last):`);
  for (const r of (msgs as Array<{
    id: number;
    sender: string;
    recipient: string;
    content: string;
    created_at: number;
    read: number;
  }>).slice().reverse()) {
    const mark = r.read ? " " : "*";
    const head = r.content.split("\n")[0].slice(0, 80);
    console.log(
      `${mark} #${r.id}  ${ts(r.created_at)}  ${r.sender.slice(0, 8)} → ${r.recipient.slice(0, 8)}  ${head}`,
    );
  }
}

function cmdCleanup(flags: Flags) {
  const result = runCleanup({
    scope: flags.scope ? resolveScope(flags) : undefined,
    dryRun: flags.dryRun,
    mode: "manual",
  });
  if (flags.json) return printJson(result);

  const verb = flags.dryRun ? "would clean" : "cleaned";
  console.log(`${verb} ${result.scope ?? "all scopes"}`);
  console.log(`  instances reclaimed: ${result.instances_reclaimed}`);
  console.log(`  tasks reopened: ${result.tasks_reopened}`);
  console.log(`  task assignees cleared: ${result.task_assignees_cleared}`);
  console.log(`  locks deleted: ${result.locks_deleted}`);
  console.log(`  messages deleted: ${result.messages_deleted}`);
  console.log(`  terminal tasks deleted: ${result.terminal_tasks_deleted}`);
  console.log(`  context annotations deleted: ${result.context_annotations_deleted}`);
  console.log(`  events deleted: ${result.events_deleted}`);
  console.log(`  kv rows deleted: ${result.kv_deleted}`);
}

async function cmdUi(flags: Flags) {
  const [sub, ...rest] = flags.positional.slice(1);
  if (!sub || sub === "commands" || sub === "list") {
    const rows = ui.list({
      scope: flags.scope ? resolveScope(flags) : undefined,
      status: flags.status,
      limit: flags.limit,
    });
    if (flags.json) return printJson(rows.map((row) => ({
      ...row,
      payload: parseJsonMaybe(row.payload),
      result: parseJsonMaybe(row.result),
    })));
    if (!rows.length) return console.log("(no ui commands)");
    for (const row of rows.slice().reverse()) {
      console.log(
        `#${row.id}  [${row.status}]  ${row.kind}  scope=${row.scope}`,
      );
    }
    return;
  }

  if (sub === "get") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error("ui get <id>");
    const row = ui.get(id);
    if (!row) {
      if (flags.json) return printJson(null);
      process.exit(1);
    }
    return printUiCommand(row, flags.json);
  }

  if (sub === "spawn") {
    const cwd = rest[0];
    if (!cwd) {
      throw new Error(
        "ui spawn <cwd> [--harness <claude|clawd|clowd|codex|cdx|opencode|opc|hermesw|hermesp>] [--role <role>] [--label <tokens>] [--scope <path>] [--wait <seconds>]",
      );
    }
    const scope = scopeFor(cwd, flags.scope);
    const createdBy = resolveOptionalIdentity(scope, flags);
    if (createdBy) requireSpawnAuthority(scope, createdBy, "ui spawn");
    return enqueueUiCommand(
      scope,
      "spawn_shell",
      {
        cwd,
        harness: flags.harness ?? null,
        role: flags.role ?? null,
        label: flags.label ?? null,
      },
      flags,
      DEFAULT_UI_WAIT_SECS,
      createdBy,
    );
  }

  if (sub === "prompt") {
    const content = rest.join(" ");
    if (!flags.target) {
      throw new Error(
        "ui prompt --target <node|instance|pty> <content...> [--no-enter] [--scope <path>] [--wait <seconds>]",
      );
    }
    if (!content) throw new Error("ui prompt requires content");
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "send_prompt",
      {
        target: flags.target,
        text: content,
        enter: flags.enter,
      },
      flags,
    );
  }

  if (sub === "move") {
    if (!flags.target || !Number.isFinite(flags.x) || !Number.isFinite(flags.y)) {
      throw new Error(
        "ui move --target <node|instance|pty> --x <number> --y <number> [--scope <path>] [--wait <seconds>]",
      );
    }
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "move_node",
      {
        target: flags.target,
        x: flags.x,
        y: flags.y,
      },
      flags,
    );
  }

  if (sub === "organize") {
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "organize_nodes",
      {
        kind: flags.kind ?? "grid",
      },
      flags,
    );
  }

  throw new Error(`Unknown ui subcommand: ${sub}`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const HANDLERS: Record<Subcommand, (flags: Flags) => void | Promise<void>> = {
  register: cmdRegister,
  deregister: cmdDeregister,
  whoami: cmdWhoami,
  instances: cmdInstances,
  "list-instances": cmdInstances,
  messages: cmdMessages,
  tasks: cmdTasks,
  "request-task": cmdRequestTask,
  dispatch: cmdDispatch,
  context: cmdContext,
  kv: cmdKv,
  send: cmdSend,
  broadcast: cmdBroadcast,
  "prompt-peer": cmdPromptPeer,
  lock: cmdLock,
  unlock: cmdUnlock,
  inspect: cmdInspect,
  cleanup: cmdCleanup,
  ui: cmdUi,
};
export { SUBCOMMANDS };

export async function run(subcommand: Subcommand, argv: string[]) {
  const handler = HANDLERS[subcommand];
  // Run normal cleanup before read/write so the CLI sees the same world a live agent would.
  if (subcommand !== "cleanup") registry.prune();
  try {
    const flags = parseFlags([subcommand, ...argv]);
    await handler(flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`swarm-mcp ${subcommand}: ${msg}`);
    process.exit(1);
  }
}
