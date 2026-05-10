import { createHash } from "node:crypto";
import * as context from "./context";
import { db } from "./db";
import * as messages from "./messages";
import * as registry from "./registry";
import * as taskStore from "./tasks";
import type { TaskType } from "./generated/protocol";
import * as spawnerBackend from "./spawner_backend";
import { registerDefaultSpawners } from "./spawner_defaults";
import * as ui from "./ui";
import * as workspaceIdentity from "./workspace_identity";

registerDefaultSpawners();

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

function identityToken(inst: InstanceRef | null | undefined) {
  return (inst?.label ?? "").split(/\s+/).find((token) => token.startsWith("identity:")) ?? "";
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
  const requesterInst = instanceById(scope, requester);
  const requesterIdentity = identityToken(requesterInst);
  const candidates = (registry.list(scope) as InstanceRef[]).filter((inst) => {
    if (inst.id === requester) return false;
    const candidateIdentity = identityToken(inst);
    return requesterIdentity ? candidateIdentity === requesterIdentity : true;
  });
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

function defaultHarness(spawner: spawnerBackend.SpawnerBackend) {
  const configured =
    process.env.SWARM_WORKER_HARNESS ?? process.env.SWARM_DISPATCH_HARNESS;
  if (configured?.trim()) return configured.trim();
  return spawner.defaultHarness();
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

export async function runDispatch(opts: DispatchOptions) {
  requireDispatchAuthority(opts.scope, opts.requester);

  const title = opts.title.trim();
  if (!title) throw new Error("dispatch requires a title");

  const taskType = opts.type ?? "implement";
  const message = opts.message ?? opts.description ?? title;
  const workerRole = (opts.role ?? "implementer").trim() || "implementer";
  const spawner = spawnerBackend.requireSpawner(opts.spawner);
  const harness = opts.harness?.trim() || defaultHarness(spawner);
  const idempotencyKey =
    opts.idempotency_key ??
    `dispatch:${hashIntent([opts.scope, taskType, title, message, workerRole])}`;
  const intentHash = hashIntent([idempotencyKey]);
  const lockPath = spawnLockPath(workerRole, intentHash);
  const cwd = opts.cwd ?? process.cwd();

  const liveWorker = opts.force_spawn
    ? null
    : findWorker(opts.scope, opts.requester, workerRole);

  const result = taskStore.request(opts.requester, opts.scope, taskType, title, {
    description: opts.description ?? message,
    files: opts.files?.length ? opts.files : undefined,
    assignee: liveWorker?.id,
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
      task: taskStore.get(result.id, opts.scope),
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
    spawner: spawner.name,
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

  const waitSeconds = opts.wait_seconds ?? spawner.defaultWaitSeconds;
  const basePayload = {
    task_id: result.id,
    task,
    spawner: spawner.name,
    spawn_lock: lockPath,
  };

  const spawn = await spawner.spawn({
    scope: opts.scope,
    requester: opts.requester,
    cwd,
    role: workerRole,
    harness,
    label: opts.label,
    name: opts.name,
    launch_token: intentHash,
    lock_path: lockPath,
    lock_note: lockNote,
    wait_seconds: waitSeconds,
  });

  if (spawn.status === "spawn_failed") {
    context.clearLocks(opts.requester, opts.scope, lockPath);
    return { ...basePayload, ...spawn };
  }
  if (spawn.status === "spawn_in_flight") {
    return { ...basePayload, ...spawn };
  }

  const spawnedInstance =
    typeof spawn.spawned_instance === "string" ? spawn.spawned_instance : "";
  let binding: Record<string, unknown> | null = null;
  if (spawnedInstance) {
    binding = taskStore.reserveForAssignee(result.id, opts.scope, spawnedInstance);
  }
  context.clearLocks(opts.requester, opts.scope, lockPath);
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
    ...basePayload,
    ...spawn,
    spawned_instance: spawnedInstance || null,
    binding,
    prompt,
  };
}
