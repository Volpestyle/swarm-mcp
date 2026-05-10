import * as kv from "./kv";
import * as registry from "./registry";
import {
  DEFAULT_WORKSPACE_BACKEND,
  WORKSPACE_IDENTITY_PREFIX,
  identityKey,
  registeredBackends,
  requireBackend,
  type WorkspaceBackend,
  type WorkspaceHandleInfo,
  type WorkspaceIdentity,
} from "./workspace_backend";

export {
  DEFAULT_WORKSPACE_BACKEND,
  WORKSPACE_IDENTITY_PREFIX,
  identityKey,
  registeredBackends,
  registerBackend,
  clearBackendsForTesting,
} from "./workspace_backend";
export type { WorkspaceBackend, WorkspaceHandleInfo, WorkspaceIdentity };

export type ResolvedPublishedIdentity =
  | {
      ok: true;
      backend: WorkspaceBackend;
      backend_name: string;
      identity: WorkspaceIdentity;
      handle_info: WorkspaceHandleInfo;
      handle_kind: string;
      handle: string;
      agent_status: string;
      identity_repaired: boolean;
    }
  | {
      ok: false;
      reason: string;
      handle?: string;
    };

export type WorkspaceHandleSwarmMatch = {
  instance_id: string;
  label: string | null;
  backend: string;
  handle_kind: string;
  handle: string;
  agent_status?: string;
  identity_repaired?: boolean;
  source: "kv" | "workspace";
  identity?: WorkspaceIdentity;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseIdentity(raw: string): { identity?: WorkspaceIdentity; reason?: string } {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { reason: "published workspace identity is not an object" };
    }
    return { identity: parsed as WorkspaceIdentity };
  } catch {
    return { reason: "published workspace identity is not valid JSON" };
  }
}

function backendCandidates(name?: string) {
  return name ? [requireBackend(name)] : registeredBackends();
}

function loadPublishedIdentity(
  scope: string,
  backend: WorkspaceBackend,
  instanceId: string,
) {
  for (const key of backend.identityKeys(instanceId)) {
    const row = kv.get(scope, key);
    if (row) return { key, value: row.value };
  }
  return null;
}

function maybeRepairIdentity(opts: {
  scope: string;
  key: string;
  instanceId: string;
  priorValue: string;
  identity: WorkspaceIdentity;
  actor?: string | null;
}) {
  const nextValue = JSON.stringify(opts.identity);
  if (nextValue === opts.priorValue) return false;
  kv.set(opts.scope, opts.key, nextValue, opts.actor ?? opts.instanceId);
  return true;
}

function resolveWithBackend(opts: {
  scope: string;
  instanceId: string;
  backend: WorkspaceBackend;
  actor?: string | null;
}): ResolvedPublishedIdentity {
  const row = loadPublishedIdentity(opts.scope, opts.backend, opts.instanceId);
  if (!row) {
    return { ok: false, reason: "no workspace identity is published for that instance" };
  }

  const parsed = parseIdentity(row.value);
  if (!parsed.identity) {
    return { ok: false, reason: parsed.reason ?? "published workspace identity is invalid" };
  }

  const candidates = opts.backend.handlesForIdentity(parsed.identity);
  if (!candidates.length) {
    return { ok: false, reason: "published workspace identity has no handle" };
  }

  let lastReason = "";
  for (const candidate of candidates) {
    const handleResult = opts.backend.getHandle({
      handle: candidate,
      handleKind: parsed.identity.handle_kind,
      identity: parsed.identity,
    });
    if (!handleResult.ok) {
      lastReason = handleResult.error;
      continue;
    }

    const handleInfo = handleResult.value;
    const handleInstanceId = stringValue(handleInfo.swarm_instance_id);
    if (handleInstanceId && handleInstanceId !== opts.instanceId) {
      lastReason = `resolved workspace handle belongs to swarm instance ${handleInstanceId}, not ${opts.instanceId}`;
      continue;
    }

    const identity = opts.backend.canonicalizeIdentity({
      identity: parsed.identity,
      handleInfo,
      requestedHandle: candidate,
    });
    const repaired = maybeRepairIdentity({
      scope: opts.scope,
      key: row.key,
      instanceId: opts.instanceId,
      priorValue: row.value,
      identity,
      actor: opts.actor,
    });
    const handle = stringValue(identity.handle) || handleInfo.handle;
    return {
      ok: true,
      backend: opts.backend,
      backend_name: opts.backend.name,
      identity,
      handle_info: handleInfo,
      handle_kind:
        stringValue(identity.handle_kind) ||
        stringValue(handleInfo.handle_kind) ||
        opts.backend.defaultHandleKind,
      handle,
      agent_status: stringValue(handleInfo.agent_status) || "unknown",
      identity_repaired: repaired,
    };
  }

  return {
    ok: false,
    reason: lastReason || "workspace handle validation failed",
    handle: candidates[0],
  };
}

export function resolvePublishedWorkspaceIdentity(opts: {
  scope: string;
  instanceId: string;
  backend?: string;
  actor?: string | null;
}): ResolvedPublishedIdentity {
  const backends = backendCandidates(opts.backend);
  if (!backends.length) {
    return { ok: false, reason: "no workspace backends are registered" };
  }

  let sawIdentity = false;
  let lastReason = "";
  let firstHandle = "";
  for (const backend of backends) {
    const row = loadPublishedIdentity(opts.scope, backend, opts.instanceId);
    if (!row) continue;
    sawIdentity = true;

    const resolved = resolveWithBackend({
      scope: opts.scope,
      instanceId: opts.instanceId,
      backend,
      actor: opts.actor,
    });
    if (resolved.ok) return resolved;
    lastReason = resolved.reason;
    if (!firstHandle && resolved.handle) firstHandle = resolved.handle;
  }

  if (!sawIdentity) {
    return { ok: false, reason: "no workspace identity is published for that instance" };
  }
  return {
    ok: false,
    reason: lastReason || "published workspace identity could not be resolved",
    handle: firstHandle || undefined,
  };
}

function identityMatchesHandle(
  backend: WorkspaceBackend,
  identity: WorkspaceIdentity,
  handles: Set<string>,
) {
  return backend.handlesForIdentity(identity).some((handle) => handles.has(handle));
}

function identityKeyRows(scope: string, backend: WorkspaceBackend) {
  const rows = new Map<string, { key: string }>();
  for (const prefix of backend.identityKeys("")) {
    const prefixRows = kv.keys(scope, prefix) as Array<{ key: string }>;
    for (const row of prefixRows) rows.set(row.key, row);
  }
  return Array.from(rows.values());
}

export function resolveWorkspaceHandleToSwarm(opts: {
  scope: string;
  backend?: string;
  handleKind?: string;
  handle: string;
  actor?: string | null;
  validate?: boolean;
}) {
  const backend = requireBackend(opts.backend ?? DEFAULT_WORKSPACE_BACKEND);
  const handleKind = opts.handleKind?.trim() || backend.defaultHandleKind;
  const inputHandle = opts.handle.trim();
  if (!inputHandle) throw new Error("resolve_workspace_handle requires handle");

  const probe = backend.getHandle({
    handle: inputHandle,
    handleKind,
    identity: { backend: backend.name, handle_kind: handleKind },
  });
  const probeInfo = probe.ok ? probe.value : null;
  const canonicalInputHandle = probeInfo?.handle || inputHandle;
  const comparableHandles = new Set([inputHandle, canonicalInputHandle].filter(Boolean));
  const matches = new Map<string, WorkspaceHandleSwarmMatch>();

  const directInstanceId = stringValue(probeInfo?.swarm_instance_id);
  if (directInstanceId && probeInfo) {
    const inst = registry.get(directInstanceId);
    if (inst?.scope === opts.scope) {
      matches.set(directInstanceId, {
        instance_id: directInstanceId,
        label: inst.label,
        backend: backend.name,
        handle_kind: handleKind,
        handle: canonicalInputHandle,
        agent_status: stringValue(probeInfo.agent_status) || "unknown",
        source: "workspace",
      });
    }
  }

  for (const row of identityKeyRows(opts.scope, backend)) {
    const instanceId = backend.instanceIdFromIdentityKey(row.key);
    if (!instanceId) continue;
    const value = kv.get(opts.scope, row.key)?.value;
    if (!value) continue;
    const parsed = parseIdentity(value);
    if (!parsed.identity) continue;

    let identity = parsed.identity;
    let handle = stringValue(identity.handle);
    let agentStatus: string | undefined;
    let repaired = false;
    let matched = identityMatchesHandle(backend, identity, comparableHandles);

    if (!matched && opts.validate !== false) {
      const resolved = resolvePublishedWorkspaceIdentity({
        scope: opts.scope,
        instanceId,
        backend: backend.name,
        actor: opts.actor,
      });
      if (resolved.ok) {
        identity = resolved.identity;
        handle = resolved.handle;
        agentStatus = resolved.agent_status;
        repaired = resolved.identity_repaired;
        matched = identityMatchesHandle(backend, identity, comparableHandles);
      }
    }

    if (!matched) continue;
    const inst = registry.get(instanceId);
    matches.set(instanceId, {
      instance_id: instanceId,
      label: inst?.label ?? null,
      backend: backend.name,
      handle_kind: handleKind,
      handle: handle || canonicalInputHandle,
      agent_status: agentStatus,
      identity_repaired: repaired,
      source: "kv",
      identity,
    });
  }

  const resultMatches = Array.from(matches.values());
  return {
    backend: backend.name,
    handle_kind: handleKind,
    handle: inputHandle,
    canonical_handle: canonicalInputHandle,
    instance_id: resultMatches.length === 1 ? resultMatches[0].instance_id : null,
    ambiguous: resultMatches.length > 1,
    matches: resultMatches,
    probe_error: probe.ok ? undefined : probe.error,
  };
}
