import { createHash } from "node:crypto";
import * as context from "./context";
import { db, stateBackendFingerprint } from "./db";
import { identityToken } from "./identity";
import { labelWithIdentity, launcherForIdentity } from "./launcher_identity";
import * as messages from "./messages";
import * as registry from "./registry";
import * as taskStore from "./tasks";
import type { TaskType } from "./generated/protocol";
import * as spawnerBackend from "./spawner_backend";
import { registerDefaultSpawners } from "./spawner_defaults";
import * as ui from "./ui";
import * as workspaceIdentity from "./workspace_identity";
import * as workTracker from "./work_tracker";
import type { ReadHandleSource } from "./workspace_backend";

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
  completion_wait_seconds?: number;
  completion_poll_ms?: number;
  nudge?: boolean;
  force?: boolean;
  placement?: spawnerBackend.SpawnPlacement | null;
  /**
   * Per-dispatch promotion override (VUH-36). Highest precedence layer in the
   * promotion policy: `true` forces promote, `false` suppresses, identifier
   * forces a link decision. See docs/linear-promotion-policy.md §4.
   */
  promote?: boolean;
  promote_identifier?: string;
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

function spawnLockTaskId(lock: SpawnLockRow) {
  try {
    const payload = JSON.parse(lock.content) as { task_id?: unknown };
    return typeof payload.task_id === "string" ? payload.task_id : "";
  } catch {
    return "";
  }
}

function releaseCompletedSpawnLock(opts: DispatchOptions, payload: Record<string, unknown>) {
  const lockPath = typeof payload.spawn_lock === "string" ? payload.spawn_lock : "";
  const completion = payload.completion as { status?: unknown } | undefined;
  if (!lockPath || completion?.status !== "completed") return 0;
  return context.clearLocks(opts.requester, opts.scope, lockPath);
}

async function consumeCompletionMessages(opts: DispatchOptions, payload: Record<string, unknown>) {
  const completion = payload.completion as { status?: unknown } | undefined;
  const taskId = typeof payload.task_id === "string" ? payload.task_id : "";
  if (!taskId || completion?.status !== "completed") return [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rows = messages.consumeTaskMessages(opts.requester, opts.scope, taskId);
    if (rows.length || attempt === 5) return rows;
    await sleep(50);
  }
  return [];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMs(start: number) {
  return Date.now() - start;
}

export async function waitForTaskCompletion(opts: {
  scope: string;
  task_id: string;
  timeout_seconds: number;
  poll_ms?: number;
}) {
  const timeoutMs = Math.max(0, opts.timeout_seconds * 1000);
  const pollMs = Math.max(1, Math.floor(opts.poll_ms ?? 500));
  const start = Date.now();
  const deadline = start + timeoutMs;

  let task = taskStore.get(opts.task_id, opts.scope);
  if (!task) {
    return {
      status: "missing",
      timeout_seconds: opts.timeout_seconds,
      waited_ms: elapsedMs(start),
      task: null,
    };
  }
  if (terminalTaskStatus(task.status)) {
    return {
      status: "completed",
      terminal_status: task.status,
      timeout_seconds: opts.timeout_seconds,
      waited_ms: elapsedMs(start),
      task,
    };
  }

  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    task = taskStore.get(opts.task_id, opts.scope);
    if (!task) {
      return {
        status: "missing",
        timeout_seconds: opts.timeout_seconds,
        waited_ms: elapsedMs(start),
        task: null,
      };
    }
    if (terminalTaskStatus(task.status)) {
      return {
        status: "completed",
        terminal_status: task.status,
        timeout_seconds: opts.timeout_seconds,
        waited_ms: elapsedMs(start),
        task,
      };
    }
  }

  return {
    status: "timeout",
    timeout_seconds: opts.timeout_seconds,
    waited_ms: elapsedMs(start),
    task,
  };
}

async function maybeWaitForCompletion(
  opts: DispatchOptions,
  payload: Record<string, unknown> & { task_id: string; task?: unknown },
) {
  const timeoutSeconds = opts.completion_wait_seconds ?? 0;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return payload;

  const completion = await waitForTaskCompletion({
    scope: opts.scope,
    task_id: payload.task_id,
    timeout_seconds: timeoutSeconds,
    poll_ms: opts.completion_poll_ms,
  });
  const next = {
    ...payload,
    task: completion.task ?? payload.task,
    completion,
  };
  const consumedMessages = await consumeCompletionMessages(opts, next);
  const releasedSpawnLocks = releaseCompletedSpawnLock(opts, next);
  return {
    ...next,
    ...(consumedMessages.length
      ? { consumed_completion_messages: consumedMessages }
      : {}),
    ...(releasedSpawnLocks ? { released_spawn_locks: releasedSpawnLocks } : {}),
  };
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
    const taskId = spawnLockTaskId(lock);
    const task = taskId ? taskStore.get(taskId, scope) : null;
    if (terminalTaskStatus(task?.status)) {
      context.clearLocks(lock.instance_id, scope, file);
      return null;
    }

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
    "Call bootstrap or poll_messages first, claim the task if it matches your role, then complete it with update_task and structured results.",
  ].join("\n\n");
}

function spawnPromptRecipient(ready: spawnerBackend.SpawnReady | Record<string, unknown>) {
  for (const key of ["spawned_instance", "expected_instance"] as const) {
    const value = ready[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function dispatchHealth(opts: {
  scope: string;
  taskId: string;
  workerId: string;
  expectAssigned?: boolean;
}) {
  const gatewayTask = taskStore.get(opts.taskId, opts.scope);
  const worker = registry.get(opts.workerId);
  const workerScopeMatches = worker?.scope === opts.scope;
  const workerTask = worker && workerScopeMatches
    ? taskStore.get(opts.taskId, opts.scope, worker)
    : null;
  const expectAssigned = opts.expectAssigned ?? true;
  const checks = {
    gateway_task_exists: !!gatewayTask,
    worker_instance_exists: !!worker,
    worker_adopted: !!worker?.adopted,
    worker_scope_matches: workerScopeMatches,
    worker_task_visible: !!workerTask,
    ...(expectAssigned ? { worker_assigned: workerTask?.assignee === opts.workerId } : {}),
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  return {
    status,
    checks,
    state_backend: stateBackendFingerprint(opts.scope),
    worker: worker
      ? {
          id: worker.id,
          scope: worker.scope,
          directory: worker.directory,
          file_root: worker.file_root,
          label: worker.label,
          adopted: worker.adopted,
        }
      : null,
    task: gatewayTask
      ? {
          id: gatewayTask.id,
          scope: gatewayTask.scope,
          requester: gatewayTask.requester,
          assignee: gatewayTask.assignee,
          status: gatewayTask.status,
        }
      : null,
  };
}

function failedDispatchHealthPayload(
  basePayload: Record<string, unknown> & { task_id: string; task?: unknown },
  spawn: spawnerBackend.SpawnResult,
  health: ReturnType<typeof dispatchHealth>,
) {
  return {
    ...basePayload,
    ...spawn,
    status: "spawn_failed",
    error: "dispatch health check failed: spawned worker cannot see the task",
    failure: "worker_task_not_visible",
    dispatch_health: health,
  };
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

  const wakePrompt = `A peer sent you a swarm message${task ? ` for task ${task}` : ""}. Call the swarm bootstrap or poll_messages tool, handle the message, and report back through swarm-mcp.`;
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

function addResolvedWorkspaceFields(
  result: Record<string, unknown>,
  resolved: Extract<workspaceIdentity.ResolvedPublishedIdentity, { ok: true }>,
) {
  const paneId =
    typeof resolved.identity.pane_id === "string" && resolved.identity.pane_id
      ? resolved.identity.pane_id
      : undefined;

  result.workspace_backend = resolved.backend_name;
  result.workspace_handle = resolved.handle;
  result.handle_kind = resolved.handle_kind;
  result.agent_status = resolved.agent_status;
  if (paneId) result.pane_id = paneId;
  if (resolved.identity_repaired) result.identity_repaired = true;
}

export function peekPeerResult(opts: {
  scope: string;
  sender: string;
  recipient: string;
  source?: ReadHandleSource;
  lines?: number;
}) {
  const source = opts.source ?? "recent";
  const lines =
    typeof opts.lines === "number" && Number.isFinite(opts.lines)
      ? Math.min(Math.max(Math.trunc(opts.lines), 1), 300)
      : 80;
  const result: Record<string, unknown> = {
    sender: opts.sender,
    recipient: opts.recipient,
    peeked: false,
    source,
    lines,
  };

  const resolved = workspaceIdentity.resolvePublishedWorkspaceIdentity({
    scope: opts.scope,
    instanceId: opts.recipient,
    actor: opts.sender,
  });
  if (!resolved.ok) {
    if (resolved.handle) result.workspace_handle = resolved.handle;
    result.peek_skipped = resolved.reason;
    return result;
  }

  addResolvedWorkspaceFields(result, resolved);
  if (!resolved.backend.readHandle) {
    result.peek_skipped = `workspace backend ${resolved.backend_name} does not support reading handles`;
    return result;
  }

  const readResult = resolved.backend.readHandle({
    handle: resolved.handle,
    identity: resolved.identity,
    handleInfo: resolved.handle_info,
    source,
    lines,
    timeoutMs: 5_000,
  });
  if (!readResult.ok) {
    result.peek_error = readResult.error;
    return result;
  }

  result.peeked = true;
  result.text = readResult.value.text;
  result.source = readResult.value.source;
  if (readResult.value.lines !== undefined) result.lines = readResult.value.lines;
  if (readResult.value.truncated !== undefined) {
    result.truncated = readResult.value.truncated;
  }
  return result;
}

function defaultIdempotencyKey(opts: {
  scope: string;
  identity: string;
  taskType: TaskType;
  title: string;
  workerRole: string;
}) {
  return `dispatch:${hashIntent([
    opts.scope,
    opts.identity,
    opts.taskType,
    opts.title,
    opts.workerRole,
  ])}`;
}

function evaluatePromotionForDispatch(opts: {
  scope: string;
  requester: string;
  taskId: string;
  taskType: TaskType;
  title: string;
  description: string;
  files: string[] | null;
  idempotencyKey: string;
  parentTaskId: string | null;
  spawnLabel: string | null;
  override?: workTracker.DispatchPromotionOverride;
}) {
  const requesterInst = instanceById(opts.scope, opts.requester);
  const tracker = workTracker.configuredWorkTracker(opts.scope, requesterInst?.label ?? null);
  const taskLabel = opts.spawnLabel ?? requesterInst?.label ?? null;
  return workTracker.evaluateAndAutoLink({
    scope: opts.scope,
    task: {
      task_id: opts.taskId,
      type: opts.taskType,
      title: opts.title,
      description: opts.description ?? null,
      idempotency_key: opts.idempotencyKey,
      parent_task_id: opts.parentTaskId,
      label: taskLabel,
      files: opts.files,
    },
    tracker,
    override: opts.override,
    actor: opts.requester,
  });
}

export async function runDispatch(opts: DispatchOptions) {
  requireDispatchAuthority(opts.scope, opts.requester);

  const title = opts.title.trim();
  if (!title) throw new Error("dispatch requires a title");

  const requesterInst = instanceById(opts.scope, opts.requester);
  const requestedIdentity = identityToken(requesterInst);
  const taskType = opts.type ?? "implement";
  const message = opts.message ?? opts.description ?? title;
  const workerRole = (opts.role ?? "implementer").trim() || "implementer";
  const spawner = spawnerBackend.requireSpawner(opts.spawner);
  const requestedHarness = opts.harness?.trim() || defaultHarness(spawner);
  const harness = launcherForIdentity(requestedHarness, requestedIdentity);
  const spawnLabel = labelWithIdentity(opts.label, requestedIdentity) || null;
  const idempotencyKey =
    opts.idempotency_key ??
    defaultIdempotencyKey({
      scope: opts.scope,
      identity: requestedIdentity,
      taskType,
      title,
      workerRole,
    });
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

  const promotionOverride: workTracker.DispatchPromotionOverride | undefined =
    opts.promote === undefined && !opts.promote_identifier
      ? undefined
      : {
          ...(opts.promote === undefined ? {} : { promote: opts.promote }),
          ...(opts.promote_identifier ? { identifier: opts.promote_identifier } : {}),
        };
  const promotion = result.existing
    ? null
    : evaluatePromotionForDispatch({
        scope: opts.scope,
        requester: opts.requester,
        taskId: result.id,
        taskType,
        title,
        description: opts.description ?? message,
        files: opts.files?.length ? opts.files : null,
        idempotencyKey,
        parentTaskId: opts.parent_task_id ?? null,
        spawnLabel,
        override: promotionOverride,
      });
  if (promotion?.decision.promote) {
    taskStore.requireTrackerDisposition(result.id, opts.scope, {
      provider: promotion.decision.provider,
    });
  }
  const promotionFields = promotion ? { promotion } : {};

  const task = taskStore.get(result.id, opts.scope);
  if (terminalTaskStatus(task?.status)) {
    return maybeWaitForCompletion(opts, {
      status: "already_terminal",
      task_id: result.id,
      task,
      ...promotionFields,
    });
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
    return maybeWaitForCompletion(opts, {
      status: "dispatched",
      task_id: result.id,
      task: taskStore.get(result.id, opts.scope),
      recipient: liveWorker.id,
      prompt,
      ...promotionFields,
    });
  }

  if (opts.spawn === false) {
    return maybeWaitForCompletion(opts, {
      status: "no_worker",
      task_id: result.id,
      task,
      role: workerRole,
      ...promotionFields,
    });
  }

  const existingLock = activeSpawnLock(opts.scope, lockPath);
  if (existingLock) {
    return maybeWaitForCompletion(opts, {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: existingLock,
      ...promotionFields,
    });
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
    return maybeWaitForCompletion(opts, {
      status: "spawn_in_flight",
      task_id: result.id,
      task,
      lock: lockResult.active,
    });
  }

  const waitSeconds = opts.wait_seconds ?? spawner.defaultWaitSeconds;
  const basePayload = {
    task_id: result.id,
    task,
    spawner: spawner.name,
    spawn_lock: lockPath,
    ...promotionFields,
  };
  let spawnReadyPrompt: Record<string, unknown> | null = null;
  let spawnReadyPromptRecipient = "";

  const promptSpawnReady = (ready: spawnerBackend.SpawnReady | Record<string, unknown>) => {
    const recipient = spawnPromptRecipient(ready);
    if (!recipient || recipient === spawnReadyPromptRecipient) return spawnReadyPrompt;
    const prompt = promptPeerResult({
      scope: opts.scope,
      sender: opts.requester,
      recipient,
      message: dispatchInstruction(result.id, title, message),
      task: result.id,
      nudge: true,
      force: true,
    });
    spawnReadyPrompt = prompt;
    spawnReadyPromptRecipient = recipient;
    return prompt;
  };

  const spawn = await spawner.spawn({
    scope: opts.scope,
    requester: opts.requester,
    cwd,
    role: workerRole,
    harness,
    identity: requestedIdentity,
    label: spawnLabel,
    name: opts.name,
    launch_token: intentHash,
    lock_path: lockPath,
    lock_note: lockNote,
    wait_seconds: waitSeconds,
    placement: opts.placement,
    on_ready_to_prompt: promptSpawnReady,
  });

  if (spawn.status === "spawn_failed") {
    context.clearLocks(opts.requester, opts.scope, lockPath);
    return maybeWaitForCompletion(opts, { ...basePayload, ...spawn });
  }
  if (spawn.status === "spawn_in_flight") {
    const expectedInstance =
      typeof spawn.expected_instance === "string" ? spawn.expected_instance : "";
    const kickstart = spawnReadyPrompt ?? (expectedInstance ? promptSpawnReady(spawn) : null);
    return maybeWaitForCompletion(opts, {
      ...basePayload,
      ...spawn,
      ...(kickstart ? { kickstart_prompt: kickstart } : {}),
    });
  }

  const spawnedInstance =
    typeof spawn.spawned_instance === "string" ? spawn.spawned_instance : "";
  let binding: Record<string, unknown> | null = null;
  if (spawnedInstance) {
    const preBindHealth = dispatchHealth({
      scope: opts.scope,
      taskId: result.id,
      workerId: spawnedInstance,
      expectAssigned: false,
    });
    if (preBindHealth.status === "failed") {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return maybeWaitForCompletion(
        opts,
        failedDispatchHealthPayload(basePayload, spawn, preBindHealth),
      );
    }
    binding = taskStore.reserveForAssignee(result.id, opts.scope, spawnedInstance);
    if ("error" in binding) {
      context.clearLocks(opts.requester, opts.scope, lockPath);
      return maybeWaitForCompletion(opts, {
        ...basePayload,
        ...spawn,
        status: "spawn_failed",
        error: `dispatch task binding failed: ${binding.error}`,
        failure: "task_binding_failed",
        binding,
      });
    }
  }
  context.clearLocks(opts.requester, opts.scope, lockPath);
  const postBindHealth = spawnedInstance
    ? dispatchHealth({
        scope: opts.scope,
        taskId: result.id,
        workerId: spawnedInstance,
      })
    : null;
  if (postBindHealth?.status === "failed") {
    return maybeWaitForCompletion(
      opts,
      failedDispatchHealthPayload(basePayload, spawn, postBindHealth),
    );
  }
  const prompt =
    spawnedInstance && spawnedInstance !== spawnReadyPromptRecipient
      ? promptPeerResult({
          scope: opts.scope,
          sender: opts.requester,
          recipient: spawnedInstance,
          message: dispatchInstruction(result.id, title, message),
          task: result.id,
          nudge: opts.nudge ?? true,
          force: true,
        })
      : spawnReadyPrompt;

  return maybeWaitForCompletion(opts, {
    ...basePayload,
    ...spawn,
    spawned_instance: spawnedInstance || null,
    binding,
    ...(postBindHealth ? { dispatch_health: postBindHealth } : {}),
    prompt,
  });
}
