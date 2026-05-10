import { db } from "./db";
import { CLEANUP_POLICY, runCleanup } from "./cleanup";
import * as context from "./context";
import * as dispatch from "./dispatch";
import * as kv from "./kv";
import * as messages from "./messages";
import * as registry from "./registry";
import * as taskStore from "./tasks";
import * as ui from "./ui";
import { file as fileFor, scope as scopeFor } from "./paths";
import { SUBCOMMANDS, type Subcommand } from "./subcommands";
import { TASK_TYPES, type TaskType } from "./generated/protocol";
import * as spawnerBackend from "./spawner_backend";
import { registerDefaultSpawners } from "./spawner_defaults";
import * as workspaceIdentity from "./workspace_identity";
import * as workTracker from "./work_tracker";
import { herdrWorkspaceBackend } from "./backends/herdr";

workspaceIdentity.registerBackend(herdrWorkspaceBackend);
registerDefaultSpawners();

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
  spawner?: string;
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
  adoptInstanceId?: string;
  approvalRequired: boolean;
  spawn: boolean;
  forceSpawn: boolean;
  force: boolean;
  nudge: boolean;
  enter: boolean;
  dryRun: boolean;
  exclusive: boolean;
  backend?: string;
};

type InstRow = {
  id: string;
  scope: string;
  directory: string;
  root: string;
  file_root: string;
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
    forceSpawn: false,
    enter: true,
    force: false,
    nudge: true,
    dryRun: false,
    exclusive: false,
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
    if (a === "--spawner") { flags.spawner = argv[++i]; continue; }
    if (a === "--backend") { flags.backend = argv[++i]; continue; }
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
    if (a === "--adopt-instance-id") { flags.adoptInstanceId = argv[++i]; continue; }
    if (a === "--approval-required") { flags.approvalRequired = true; continue; }
    if (a === "--no-spawn") { flags.spawn = false; continue; }
    if (a === "--force-spawn") { flags.forceSpawn = true; continue; }
    if (a === "--force") { flags.force = true; continue; }
    if (a === "--dry-run") { flags.dryRun = true; continue; }
    if (a === "--no-nudge") { flags.nudge = false; continue; }
    if (a === "--no-enter") { flags.enter = false; continue; }
    if (a === "--exclusive") { flags.exclusive = true; continue; }
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
    "SELECT id, scope, directory, root, file_root, label, pid, registered_at, heartbeat FROM instances WHERE scope = ? ORDER BY registered_at ASC",
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

function instanceById(scope: string, id: string): InstRow {
  const row = db
    .query(
      "SELECT id, scope, directory, root, file_root, label, pid, registered_at, heartbeat FROM instances WHERE scope = ? AND id = ?",
    )
    .get(scope, id) as InstRow | null;
  if (!row) throw new Error(`Instance ${id} is not active in scope ${scope}`);
  return row;
}

function resolveFileForInstance(inst: InstRow, path: string) {
  return fileFor(inst.directory, path, {
    root: inst.root,
    fileRoot: inst.file_root,
  });
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

function hasLabelToken(inst: InstRow | null | undefined, token: string) {
  return (inst?.label ?? "").split(/\s+/).includes(token);
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
    flags.adoptInstanceId?.trim() || undefined,
  );
  let leasedHeartbeat: number | null = null;
  let leaseUntil: number | null = null;
  if (Number.isFinite(flags.leaseSeconds) && (flags.leaseSeconds ?? 0) > 0) {
    leaseUntil = Math.floor(Date.now() / 1000) + (flags.leaseSeconds ?? 0);
    leasedHeartbeat = Math.floor(Date.now() / 1000);
    registry.setLease(instance.id, leaseUntil);
  }
  if (flags.json) {
    return printJson(
      leasedHeartbeat
        ? { ...instance, adopted: false, heartbeat: leasedHeartbeat, lease_until: leaseUntil }
        : instance,
    );
  }
  console.log(`registered ${instance.id}`);
}

function cmdBootstrap(flags: Flags) {
  const directory = flags.directory ?? flags.positional[1] ?? process.cwd();
  let current: registry.Instance | null = null;

  const adoptId = flags.adoptInstanceId?.trim();
  if (adoptId) {
    current = registry.adoptInstanceId(
      directory,
      flags.label,
      flags.scope,
      adoptId,
    );
    if (!current) {
      throw new Error(`Could not adopt instance ${adoptId}`);
    }
  } else {
    const scope = resolveScope(flags);
    current = registry.get(resolveIdentity(scope, flags));
  }

  if (!current) throw new Error("Not registered. Call register first.");
  const peers = (registry.list(current.scope) as registry.Instance[]).filter(
    (p) => p.id !== current.id,
  );
  const unread = messages.poll(current.id, current.scope, flags.limit ?? 50);
  const payload = {
    instance: current,
    peers,
    unread_messages: unread,
    tasks: taskStore.snapshot(current.scope),
    work_tracker: workTracker.configuredWorkTracker(current.scope, current.label),
  };

  if (flags.json) return printJson(payload);
  console.log(JSON.stringify(payload, null, 2));
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

function taskRequestOpts(flags: Flags, insts: InstRow[], requester: InstRow) {
  const assignee = flags.assignee ? resolveInstanceRef(flags.assignee, insts) : undefined;
  return {
    ...(flags.description ? { description: flags.description } : {}),
    ...(flags.files.length
      ? { files: flags.files.map((file) => resolveFileForInstance(requester, file)) }
      : {}),
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
  const requesterInst = instanceById(scope, requester);
  const insts = instancesInScope(scope);

  const typeFromPosition = flags.positional[1];
  const taskType = parseTaskType(flags.taskType ?? typeFromPosition);
  const titleParts = flags.taskType ? flags.positional.slice(1) : flags.positional.slice(2);
  const title = titleParts.join(" ").trim();
  if (!title) throw new Error("request-task <type> <title...>");

  const requestOpts = taskRequestOpts(flags, insts, requesterInst);
  const result = taskStore.request(
    requester,
    scope,
    taskType,
    title,
    requestOpts,
  );
  if ("error" in result) throw new Error(result.error);

  const promptResult =
    requestOpts.assignee && !result.existing && requestOpts.assignee !== requester
      ? dispatch.promptPeerResult({
          scope,
          sender: requester,
          recipient: requestOpts.assignee,
          task: result.id,
          message: `[auto] New ${taskType} task assigned to you: "${title}" (task_id: ${result.id})${
            result.status !== "claimed" ? ` (currently ${result.status} — will be claimable when ready)` : ""
          }. Claim it with claim_task if not auto-claimed.`,
          nudge: flags.nudge,
          force: flags.force,
        })
      : null;
  const task = taskStore.get(result.id, scope);
  if (flags.json) return printJson({ ...result, task, ...(promptResult ? { prompt: promptResult } : {}) });
  console.log(`${result.existing ? "existing" : "created"} task ${result.id} [${result.status}] ${title}`);
}

function cmdClaim(flags: Flags) {
  const taskId = flags.positional[1];
  if (!taskId) throw new Error("claim <task-id>");
  const scope = resolveScope(flags);
  const assignee = resolveIdentity(scope, flags);
  const result = taskStore.claim(taskId, scope, assignee, {
    ignoreUnreadMessages: flags.force,
  });
  if ("error" in result) {
    if (flags.json) return printJson(result);
    console.error(`claim failed: ${result.error}`);
    process.exit(1);
  }
  if (flags.json) return printJson({ ...result, task_id: taskId });
  console.log(`claimed ${taskId}`);
}

function cmdUpdate(flags: Flags) {
  const taskId = flags.positional[1];
  if (!taskId) throw new Error("update-task <task-id> --status <done|failed|cancelled> [--note <result>]");
  const status = flags.status;
  if (status !== "done" && status !== "failed" && status !== "cancelled") {
    throw new Error(
      "update-task requires --status one of done|failed|cancelled",
    );
  }
  const scope = resolveScope(flags);
  const actor = resolveIdentity(scope, flags);
  const result = taskStore.update(taskId, scope, actor, status, flags.note);
  if ("error" in result) {
    if (flags.json) return printJson(result);
    console.error(`update-task failed: ${result.error}`);
    process.exit(1);
  }
  if (flags.json) return printJson({ ...result, task_id: taskId, status });
  console.log(`task ${taskId} -> ${status}`);
}

function cmdLocks(flags: Flags) {
  const scope = resolveScope(flags);
  const rows = db
    .query(
      `SELECT id, instance_id, file, type, content, created_at
       FROM context
       WHERE scope = ? AND type = 'lock'
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
  if (!rows.length) return console.log("(no locks)");
  for (const r of rows) {
    console.log(
      `  ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
    );
  }
}

async function cmdDispatch(flags: Flags) {
  const scope = resolveScope(flags);
  const requester = resolveIdentity(scope, flags);
  const requesterInst = instanceById(scope, requester);
  const taskType = parseTaskType(flags.taskType, "implement");
  const title = flags.positional.slice(1).join(" ").trim();
  if (!title) throw new Error("dispatch <title...> [--message <instructions>]");

  const payload = (await dispatch.runDispatch({
    scope,
    requester,
    type: taskType,
    title,
    message: flags.message,
    description: flags.description,
    files: flags.files.map((file) => resolveFileForInstance(requesterInst, file)),
    priority: flags.priority,
    depends_on: splitCsv(flags.dependsOn),
    idempotency_key: flags.idempotencyKey,
    parent_task_id: flags.parentTaskId,
    approval_required: flags.approvalRequired,
    role: flags.role,
    spawn: flags.spawn,
    force_spawn: flags.forceSpawn,
    spawner: flags.spawner,
    cwd: flags.directory ?? process.cwd(),
    harness: flags.harness,
    label: flags.label,
    name: flags.name,
    wait_seconds: flags.wait,
    nudge: flags.nudge,
    force: flags.force,
  })) as Record<string, any>;

  if (flags.json) return printJson(payload);
  if (payload.status === "already_terminal") {
    console.log(`task ${payload.task_id} is already ${payload.task?.status}`);
  } else if (payload.status === "dispatched") {
    console.log(`dispatched task ${payload.task_id} to ${String(payload.recipient).slice(0, 8)}`);
  } else if (payload.status === "no_worker") {
    console.log(`created task ${payload.task_id}; no role:${payload.role} worker is live`);
  } else if (payload.status === "spawn_in_flight" && "ui_command_id" in payload) {
    console.log(
      `queued spawn command #${payload.ui_command_id} for task ${payload.task_id}; lock held at ${payload.spawn_lock}`,
    );
  } else if (payload.status === "spawn_in_flight") {
    const workspaceHandle = payload.workspace_handle;
    const handle = workspaceHandle?.handle
      ? ` in ${workspaceHandle.backend ?? "workspace"} ${workspaceHandle.handle_kind ?? "handle"} ${workspaceHandle.handle}`
      : workspaceHandle?.pane_id
        ? ` in herdr workspace handle ${workspaceHandle.pane_id}`
      : "";
    console.log(`task ${payload.task_id} is ready; spawn already in flight${handle}`);
  } else if (payload.status === "spawn_failed") {
    const reason = payload.ui_command?.error ?? payload.error ?? "unknown error";
    console.log(`spawn failed: ${reason}`);
  } else if (payload.status === "spawned") {
    const spawned = payload.spawned_instance ? ` (${String(payload.spawned_instance).slice(0, 8)})` : "";
    console.log(`spawned worker for task ${payload.task_id}${spawned}`);
  } else {
    console.log(JSON.stringify(payload));
  }
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

function cmdPromptPeer(flags: Flags) {
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const recipientRef = flags.to ?? flags.positional[1];
  if (!recipientRef) throw new Error("prompt-peer requires --to <id-or-label>");
  const message = flags.message ?? flags.positional.slice(recipientRef === flags.positional[1] ? 2 : 1).join(" ");
  if (!message) throw new Error("prompt-peer requires --message <text> or content");

  const insts = instancesInScope(scope);
  const recipient = resolveInstanceRef(recipientRef, insts);
  const result = dispatch.promptPeerResult({
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
    ? " and nudged workspace handle"
    : result.nudge_skipped
      ? ` (${result.nudge_skipped})`
      : "";
  console.log(`sent ${sender.slice(0, 8)} → ${recipient.slice(0, 8)}${suffix}`);
}

function cmdResolveWorkspaceHandle(flags: Flags) {
  const handle = flags.positional[1];
  if (!handle) throw new Error("resolve-workspace-handle <handle>");
  const scope = resolveScope(flags);
  const actor = resolveOptionalIdentity(scope, flags);
  const result = workspaceIdentity.resolveWorkspaceHandleToSwarm({
    scope,
    backend: flags.backend ?? "herdr",
    handleKind: flags.kind ?? "pane",
    handle,
    actor,
    validate: true,
  });

  if (flags.json) return printJson(result);
  if (result.instance_id) {
    const label = result.matches[0]?.label ? ` (${result.matches[0].label})` : "";
    console.log(`${result.backend}:${handle} → ${result.instance_id}${label}`);
    return;
  }
  if (result.ambiguous) {
    console.log(
      `${result.backend}:${handle} matched multiple swarm instances: ${result.matches
        .map((match) => formatInst({ id: match.instance_id, label: match.label }))
        .join(", ")}`,
    );
    return;
  }
  console.log(`${result.backend}:${handle} did not match a swarm instance`);
}

function cmdLock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("lock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  const owner = instanceById(scope, inst);
  const path = resolveFileForInstance(owner, file);
  const res = context.lock(inst, scope, path, flags.note ?? "", {
    exclusive: flags.exclusive,
    taskId: flags.task?.trim() || undefined,
  });
  if ("error" in res) {
    if (flags.json) return printJson(res);
    console.error(`lock failed: ${res.error}`);
    process.exit(1);
  }
  if (flags.json) return printJson(res);
  console.log(`locked ${path}`);
}

function cmdUnlock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("unlock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  const owner = instanceById(scope, inst);
  const path = resolveFileForInstance(owner, file);
  context.clearLocks(inst, scope, path);
  if (flags.json) return printJson({ ok: true, file: path });
  console.log(`unlocked ${path}`);
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
       FROM context WHERE scope = ? AND type = 'lock' ORDER BY created_at ASC`,
    )
    .all(scope);
  const kvs = kv.keys(scope) as Array<{ key: string; updated_at: number }>;

  if (flags.json) {
    return printJson({
      scope,
      instances: insts,
      messages: (msgs as unknown[]).slice().reverse(),
      tasks: tsks,
      locks: ctx,
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
  console.log(`\nlocks (${(ctx as unknown[]).length}):`);
  for (const r of ctx as Array<{
    instance_id: string;
    file: string;
    content: string;
  }>) {
    console.log(
      `  ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
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
  console.log(`  legacy context rows deleted: ${result.non_lock_context_rows_deleted}`);
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
  bootstrap: cmdBootstrap,
  deregister: cmdDeregister,
  whoami: cmdWhoami,
  instances: cmdInstances,
  "list-instances": cmdInstances,
  messages: cmdMessages,
  tasks: cmdTasks,
  "request-task": cmdRequestTask,
  claim: cmdClaim,
  "update-task": cmdUpdate,
  dispatch: cmdDispatch,
  locks: cmdLocks,
  kv: cmdKv,
  send: cmdSend,
  broadcast: cmdBroadcast,
  "prompt-peer": cmdPromptPeer,
  "resolve-workspace-handle": cmdResolveWorkspaceHandle,
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
