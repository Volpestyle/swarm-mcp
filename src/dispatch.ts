import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as context from "./context";
import { db } from "./db";
import * as messages from "./messages";
import * as registry from "./registry";
import * as taskStore from "./tasks";
import * as ui from "./ui";
import type { TaskType } from "./generated/protocol";
import * as workspaceIdentity from "./workspace_identity";

type InstanceRef = {
  id: string;
  label: string | null;
};

type SpawnLockRow = {
  id: string;
  instance_id: string;
  file: string;
  content: string;
};

export interface DispatchOptions {
  scope: string;
  requester: string;
  title: string;
  type?: TaskType;
  message?: string;
  description?: string;
  files?: string[];
  priority?: number;
  depends_on?: string[];
  idempotency_key?: string;
  parent_task_id?: string;
  approval_required?: boolean;
  role?: string;
  spawn?: boolean;
  force_spawn?: boolean;
  spawner?: string;
  cwd?: string;
  harness?: string;
  label?: string | null;
  name?: string | null;
  wait_seconds?: number;
  nudge?: boolean;
  force?: boolean;
}

function envTruthy(name: string) {
  return (
    (process.env[name] ?? "").trim().toLowerCase().match(/^(1|true|yes|on)$/) !==
    null
  );
}

function hasLabelToken(inst: InstanceRef | null | undefined, token: string) {
  return (inst?.label ?? "").split(/\s+/).includes(token);
}

function roleToken(role: string | undefined) {
  const clean = (role ?? "").trim();
  return clean ? `role:${clean}` : "";
}

function labelTokens(inst: InstanceRef) {
  return (inst.label ?? "").split(/\s+/).filter(Boolean);
}

function hasRole(inst: InstanceRef, role: string | undefined) {
  const token = roleToken(role);
  if (!token) return true;
  return labelTokens(inst).includes(token);
}

function hasAnyRole(inst: InstanceRef) {
  return labelTokens(inst).some((token) => token.startsWith("role:"));
}

function isGeneralist(inst: InstanceRef) {
  return labelTokens(inst).includes("role:generalist") || !hasAnyRole(inst);
}

function instanceById(scope: string, id: string) {
  const inst = registry.get(id);
  if (!inst || inst.scope !== scope) return null;
  return inst;
}

export function requireDispatchAuthority(scope: string, requester: string) {
  if (envTruthy("SWARM_MCP_ALLOW_SPAWN")) return;
  const inst = instanceById(scope, requester);
  if (hasLabelToken(inst, "mode:gateway")) return;
  throw new Error(
    "dispatch is gateway-only. Use a requester labeled mode:gateway, or set SWARM_MCP_ALLOW_SPAWN=1 from a trusted operator shell.",
  );
}

function findWorker(scope: string, requester: string, role: string | undefined) {
  const candidates = (registry.list(scope) as InstanceRef[]).filter(
    (inst) => inst.id !== requester,
  );
  return (
    candidates.find((inst) => hasRole(inst, role)) ??
    candidates.find((inst) => isGeneralist(inst)) ??
    null
  );
}

function hashIntent(parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function terminalTaskStatus(status: unknown) {
  return status === "done" || status === "failed" || status === "cancelled";
}

function spawnLockPath(role: string, intentHash: string) {
  const cleanRole = role.replace(/[^A-Za-z0-9_.-]/g, "_") || "worker";
  return `/__swarm/spawn/${cleanRole}/${intentHash}`;
}

type SpawnerName = "herdr" | "swarm-ui";

function resolveSpawner(value: string | undefined): SpawnerName {
  const raw = (
    value ??
    process.env.SWARM_SPAWNER ??
    process.env.SWARM_DISPATCH_SPAWNER ??
    "herdr"
  ).trim().toLowerCase();
  if (raw === "herdr") return "herdr";
  if (raw === "swarm-ui" || raw === "swarm_ui" || raw === "ui") return "swarm-ui";
  throw new Error(`Unknown dispatch spawner "${raw}". Expected herdr or swarm-ui.`);
}

function defaultHarness(spawner: SpawnerName) {
  const configured =
    process.env.SWARM_WORKER_HARNESS ?? process.env.SWARM_DISPATCH_HARNESS;
  if (configured?.trim()) return configured.trim();
  if (spawner === "swarm-ui") return "claude";

  const identity = (
    process.env.AGENT_IDENTITY ??
    process.env.SWARM_IDENTITY ??
    process.env.SWARM_CC_IDENTITY ??
    process.env.SWARM_CODEX_IDENTITY ??
    ""
  ).trim().toLowerCase();
  if (identity === "personal") return "clowd";
  if (identity === "work") return "clawd";
  return "claude";
}

function cleanLabelValue(value: string, fallback: string) {
  const clean = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  return clean || fallback;
}

function labelWithLaunchToken(opts: {
  role: string;
  harness: string;
  launchToken: string;
  extra?: string | null;
}) {
  const tokens = [
    `role:${cleanLabelValue(opts.role, "worker")}`,
    `provider:${cleanLabelValue(opts.harness, "agent")}`,
    `launch:${opts.launchToken}`,
  ];
  if (opts.extra?.trim()) tokens.push(...opts.extra.trim().split(/\s+/));
  return Array.from(new Set(tokens)).join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runHerdrCommand(
  args: string[],
  timeout = 10_000,
  extraEnv: Record<string, string> = {},
) {
  const bin = process.env.SWARM_HERDR_BIN?.trim() || "herdr";
  return spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout,
  });
}

function outputText(value: string | Buffer | null | undefined) {
  return typeof value === "string" ? value : (value?.toString("utf8") ?? "");
}

function processError(proc: ReturnType<typeof spawnSync>) {
  return (
    proc.error?.message ||
    outputText(proc.stderr).trim() ||
    outputText(proc.stdout).trim() ||
    `command exited ${proc.status ?? "unknown"}`
  );
}

function paneIdFromSplit(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    const pane =
      payload?.result?.pane?.pane_id ??
      payload?.result?.pane?.id ??
      payload?.pane_id ??
      payload?.id;
    return typeof pane === "string" && pane.trim() ? pane.trim() : "";
  } catch {
    return "";
  }
}

function herdrParentPane() {
  return (
    process.env.SWARM_HERDR_PARENT_PANE?.trim() ||
    process.env.HERDR_PANE_ID?.trim() ||
    process.env.HERDR_PANE?.trim() ||
    ""
  );
}

function herdrLaunchCommand(opts: {
  scope: string;
  cwd: string;
  role: string;
  label: string;
  harness: string;
}) {
  const env: Record<string, string> = {
    SWARM_MCP_SCOPE: opts.scope,
    SWARM_MCP_FILE_ROOT: opts.cwd,
    SWARM_MCP_DIRECTORY: opts.cwd,
    SWARM_AGENT_ROLE: opts.role,
    SWARM_CC_AGENT_ROLE: opts.role,
    SWARM_CODEX_AGENT_ROLE: opts.role,
    SWARM_CC_LABEL: opts.label,
    SWARM_CODEX_LABEL: opts.label,
    SWARM_HERMES_LABEL: opts.label,
  };
  if (process.env.SWARM_MCP_BIN?.trim()) {
    env.SWARM_MCP_BIN = process.env.SWARM_MCP_BIN.trim();
  }
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `cd ${shellQuote(opts.cwd)} && ${assignments} ${opts.harness}`;
}

async function waitForLaunchInstance(scope: string, launchToken: string, timeoutSeconds: number) {
  const deadline = Date.now() + Math.max(0, timeoutSeconds * 1000);
  const token = `launch:${launchToken}`;
  do {
    const found = (registry.list(scope) as InstanceRef[]).find((inst) =>
      (inst.label ?? "").split(/\s+/).includes(token),
    );
    if (found) return found;
    if (timeoutSeconds <= 0) return null;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
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

export function promptPeerResult(opts: {
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

  const resolved = workspaceIdentity.resolvePublishedWorkspaceIdentity({
    scope,
    instanceId: recipient,
    actor: sender,
  });
  if (!resolved.ok) {
    if (resolved.handle) result.workspace_handle = resolved.handle;
    result.nudge_skipped = resolved.reason;
    return result;
  }

  const workspaceHandle = resolved.handle;
  const status = resolved.agent_status;
  result.workspace_backend = resolved.backend_name;
  result.workspace_handle = workspaceHandle;
  result.handle_kind = resolved.handle_kind;
  const paneId =
    typeof resolved.identity.pane_id === "string" && resolved.identity.pane_id
      ? resolved.identity.pane_id
      : undefined;
  if (paneId) result.pane_id = paneId;
  result.agent_status = status;
  if (resolved.identity_repaired) result.identity_repaired = true;

  const wakePrompt = `A peer sent you a swarm message${task ? ` for task ${task}` : ""}. Call the swarm poll_messages tool, handle the message, and report back through swarm-mcp.`;
  const wakeResult = resolved.backend.wakeHandle({
    handle: workspaceHandle,
    prompt: wakePrompt,
    identity: resolved.identity,
    handleInfo: resolved.handle_info,
    force,
    timeoutMs: 5_000,
  });
  if (!wakeResult.ok) {
    result.nudge_error = wakeResult.error;
  } else if (wakeResult.value.skipped) {
    result.nudge_skipped = wakeResult.value.skipped;
  } else {
    result.nudged = true;
  }
  return result;
}

const UI_WAIT_POLL_MS = 100;
const DEFAULT_UI_WAIT_SECS = 5;
const DEFAULT_HERDR_WAIT_SECS = 30;

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

export async function runDispatch(opts: DispatchOptions) {
  requireDispatchAuthority(opts.scope, opts.requester);

  const title = opts.title.trim();
  if (!title) throw new Error("dispatch requires a title");

  const taskType = opts.type ?? "implement";
  const message = opts.message ?? opts.description ?? title;
  const workerRole = (opts.role ?? "implementer").trim() || "implementer";
  const spawner = resolveSpawner(opts.spawner);
  const harness = opts.harness?.trim() || defaultHarness(spawner);
  const idempotencyKey =
    opts.idempotency_key ??
    `dispatch:${hashIntent([opts.scope, taskType, title, message, workerRole])}`;
  const intentHash = hashIntent([idempotencyKey]);
  const lockPath = spawnLockPath(workerRole, intentHash);
  const cwd = opts.cwd ?? process.cwd();

  const result = taskStore.request(opts.requester, opts.scope, taskType, title, {
    description: opts.description ?? message,
    files: opts.files?.length ? opts.files : undefined,
    priority: Number.isFinite(opts.priority) ? opts.priority : undefined,
    depends_on: opts.depends_on?.length ? opts.depends_on : undefined,
    idempotency_key: idempotencyKey,
    parent_task_id: opts.parent_task_id,
    approval_required: opts.approval_required,
  });
  if ("error" in result) throw new Error(result.error);

  const task = taskStore.get(result.id, opts.scope);
  if (terminalTaskStatus(task?.status)) {
    return { status: "already_terminal", task_id: result.id, task };
  }

  const liveWorker = opts.force_spawn
    ? null
    : findWorker(opts.scope, opts.requester, workerRole);
  if (liveWorker) {
    context.clearLocks(opts.requester, opts.scope, lockPath);
    const prompt = promptPeerResult({
      scope: opts.scope,
      sender: opts.requester,
      recipient: liveWorker.id,
      message: dispatchInstruction(result.id, title, message),
      task: result.id,
      nudge: opts.nudge ?? true,
      force: opts.force ?? false,
    });
    return {
      status: "dispatched",
      task_id: result.id,
      task,
      recipient: liveWorker.id,
      prompt,
    };
  }

  if (opts.spawn === false) {
    return { status: "no_worker", task_id: result.id, task, role: workerRole };
  }

  const existingLock = activeSpawnLock(opts.scope, lockPath);
  if (existingLock) {
    return {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: existingLock,
    };
  }

  const startedAt = new Date().toISOString();
  const lockNote = {
    task_id: result.id,
    intent_hash: intentHash,
    role: workerRole,
    spawner,
    started_at: startedAt,
  };
  const lockResult = context.lock(
    opts.requester,
    opts.scope,
    lockPath,
    JSON.stringify(lockNote),
    { exclusive: true },
  );
  if ("error" in lockResult) {
    return {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: lockResult.active,
    };
  }

  const waitSeconds =
    opts.wait_seconds ?? (spawner === "herdr" ? DEFAULT_HERDR_WAIT_SECS : DEFAULT_UI_WAIT_SECS);
  const basePayload = {
    task_id: result.id,
    task,
    spawner,
    spawn_lock: lockPath,
  };

  if (spawner === "herdr") {
    const parentPane = herdrParentPane();
    if (!parentPane) {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return {
        status: "spawn_failed",
        ...basePayload,
        error: "herdr spawner requires HERDR_PANE_ID, HERDR_PANE, or SWARM_HERDR_PARENT_PANE",
      };
    }

    const direction = process.env.SWARM_HERDR_SPLIT_DIRECTION?.trim() || "right";
    const split = runHerdrCommand([
      "pane",
      "split",
      parentPane,
      "--direction",
      direction,
      "--cwd",
      cwd,
      "--no-focus",
    ]);
    if (split.error || split.status !== 0) {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return {
        status: "spawn_failed",
        ...basePayload,
        error: `herdr pane split failed: ${processError(split)}`,
      };
    }

    const paneId = paneIdFromSplit(split.stdout);
    if (!paneId) {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return {
        status: "spawn_failed",
        ...basePayload,
        error: "herdr pane split returned no pane id",
        herdr_stdout: split.stdout,
      };
    }

    const label = labelWithLaunchToken({
      role: workerRole,
      harness,
      launchToken: intentHash,
      extra: opts.label,
    });
    const command = herdrLaunchCommand({
      scope: opts.scope,
      cwd,
      role: workerRole,
      label,
      harness,
    });
    const run = runHerdrCommand(["pane", "run", paneId, command]);
    if (run.error || run.status !== 0) {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return {
        status: "spawn_failed",
        ...basePayload,
        workspace_handle: {
          backend: "herdr",
          handle_kind: "pane",
          handle: paneId,
          pane_id: paneId,
        },
        error: `herdr pane run failed: ${processError(run)}`,
      };
    }

    const workspaceHandle = {
      backend: "herdr",
      handle_kind: "pane",
      handle: paneId,
      pane_id: paneId,
    };
    context.lock(
      opts.requester,
      opts.scope,
      lockPath,
      JSON.stringify({
        ...lockNote,
        launch_token: intentHash,
        pane_id: paneId,
        harness,
      }),
    );

    const spawned = await waitForLaunchInstance(opts.scope, intentHash, waitSeconds);
    if (!spawned) {
      return {
        status: "spawn_in_flight",
        ...basePayload,
        launch_token: intentHash,
        workspace_handle: workspaceHandle,
      };
    }

    context.clearLocks(opts.requester, opts.scope, lockPath);
    const prompt = promptPeerResult({
      scope: opts.scope,
      sender: opts.requester,
      recipient: spawned.id,
      message: dispatchInstruction(result.id, title, message),
      task: result.id,
      nudge: false,
      force: opts.force ?? false,
    });

    return {
      status: "spawned",
      ...basePayload,
      spawned_instance: spawned.id,
      launch_token: intentHash,
      workspace_handle: workspaceHandle,
      prompt,
    };
  }

  const commandId = ui.enqueue(
    opts.scope,
    "spawn_shell",
    {
      cwd,
      harness,
      role: workerRole,
      label: opts.label ?? null,
      name: opts.name ?? null,
    },
    opts.requester,
  );
  context.lock(
    opts.requester,
    opts.scope,
    lockPath,
    JSON.stringify({ ...lockNote, ui_command_id: commandId, harness }),
  );

  const row =
    waitSeconds <= 0 ? ui.get(commandId) : await waitForUiCommand(commandId, waitSeconds * 1000);
  const uiPayload = { ...basePayload, ui_command_id: commandId };

  if (!row || row.status === "pending" || row.status === "running") {
    return { status: "spawn_in_flight", ...uiPayload, ui_command: row };
  }

  if (row.status === "failed") {
    context.clearLocks(opts.requester, opts.scope, lockPath);
    return { status: "spawn_failed", ...uiPayload, ui_command: row };
  }

  context.clearLocks(opts.requester, opts.scope, lockPath);
  const spawnResult = parseJsonMaybe(row.result) as { instance_id?: unknown } | null;
  const spawnedInstance =
    spawnResult && typeof spawnResult.instance_id === "string"
      ? spawnResult.instance_id
      : "";
  const prompt = spawnedInstance
    ? promptPeerResult({
        scope: opts.scope,
        sender: opts.requester,
        recipient: spawnedInstance,
        message: dispatchInstruction(result.id, title, message),
        task: result.id,
        nudge: false,
        force: opts.force ?? false,
      })
    : null;

  return {
    status: "spawned",
    ...uiPayload,
    spawned_instance: spawnedInstance || null,
    ui_command: row,
    prompt,
  };
}
