import * as kv from "./kv";
import { identityMatches } from "./identity";
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
      /** Live agent name reported by the backend (canonicalized: claude/codex/opencode/...). Empty when the backend can't report it. */
      agent: string;
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

export type PublishedWorkspaceSummary = {
  key: string;
  backend: string;
  handle_kind: string;
  handle: string;
  workspace_handle: string;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Map a free-form agent identifier (from herdr's pane.agent field, or a swarm
 * label like `origin:claude-code`) to a canonical bucket so we can compare them
 * across surfaces. Unknown shapes fall through unchanged.
 */
function canonicalAgentName(value: string | null | undefined): string {
  const lower = stringValue(value).toLowerCase();
  if (!lower) return "";
  if (lower.startsWith("claude")) return "claude";
  if (lower.startsWith("codex")) return "codex";
  if (lower.startsWith("opencode")) return "opencode";
  if (lower.startsWith("hermes")) return "hermes";
  return lower;
}

function expectedAgentForInstance(instanceId: string): string {
  const inst = registry.get(instanceId);
  const label = stringValue(inst?.label);
  if (!label) return "";
  const match = label.match(/\borigin:(\S+)/);
  return match ? canonicalAgentName(match[1]) : "";
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
  viewer?: string | null,
) {
  for (const key of backend.identityKeys(instanceId)) {
    const row = kv.get(scope, key, viewer);
    if (row) return { key, value: row.value };
  }
  return null;
}

function identityDetails(identity: WorkspaceIdentity) {
  const details = identity.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details
    : {};
}

function summaryFromIdentity(
  key: string,
  backend: WorkspaceBackend,
  identity: WorkspaceIdentity,
): PublishedWorkspaceSummary | null {
  const details = identityDetails(identity);
  const handle =
    stringValue(identity.handle) ||
    stringValue(identity.pane_id) ||
    stringValue(details.pane_id) ||
    backend.handlesForIdentity(identity)[0] ||
    "";
  if (!handle) return null;

  const paneId =
    stringValue(identity.pane_id) ||
    stringValue(details.pane_id) ||
    (backend.name === "herdr" ? handle : "");
  const workspaceId = stringValue(identity.workspace_id) || stringValue(details.workspace_id);
  const tabId = stringValue(identity.tab_id) || stringValue(details.tab_id);

  return {
    key,
    backend: backend.name,
    handle_kind:
      stringValue(identity.handle_kind) || backend.defaultHandleKind,
    handle,
    workspace_handle: handle,
    ...(paneId ? { pane_id: paneId } : {}),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(tabId ? { tab_id: tabId } : {}),
  };
}

export function publishedWorkspaceSummary(opts: {
  scope: string;
  instanceId: string;
  backend?: string;
  actor?: string | null;
}): PublishedWorkspaceSummary | null {
  for (const backend of backendCandidates(opts.backend)) {
    const row = loadPublishedIdentity(
      opts.scope,
      backend,
      opts.instanceId,
      opts.actor,
    );
    if (!row) continue;
    const parsed = parseIdentity(row.value);
    if (!parsed.identity) continue;
    const summary = summaryFromIdentity(row.key, backend, parsed.identity);
    if (summary) return summary;
  }
  return null;
}

export function annotateInstancesWithPublishedHandles<
  T extends { id: string },
>(
  scope: string,
  instances: T[],
  actor?: string | null,
): Array<
  T & {
    workspace_backend?: string;
    workspace_handle?: string;
    handle_kind?: string;
    pane_id?: string;
  }
> {
  return instances.map((item) => {
    const workspace = publishedWorkspaceSummary({
      scope,
      instanceId: item.id,
      actor,
    });
    if (!workspace) return item;
    return {
      ...item,
      workspace_backend: workspace.backend,
      workspace_handle: workspace.workspace_handle,
      handle_kind: workspace.handle_kind,
      pane_id: workspace.pane_id,
    };
  });
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
  const row = loadPublishedIdentity(
    opts.scope,
    opts.backend,
    opts.instanceId,
    opts.actor,
  );
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

    // Zombie-pane guard: if the live backend reports a different agent
    // type than the registered instance expects, the pane was recycled
    // (e.g. a closed codex's pane reassigned to a fresh claude). Refuse
    // to resolve so prompt_peer/peek_peer don't quietly target the new
    // occupant — that's how callers ended up reading their own scrollback.
    const liveAgent = canonicalAgentName(stringValue(handleInfo.agent));
    const expectedAgent = expectedAgentForInstance(opts.instanceId);
    if (liveAgent && expectedAgent && liveAgent !== expectedAgent) {
      lastReason = `workspace handle ${candidate} is now occupied by ${liveAgent}, but ${opts.instanceId} was registered as ${expectedAgent} (pane recycled)`;
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
      agent: liveAgent,
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
    const row = loadPublishedIdentity(
      opts.scope,
      backend,
      opts.instanceId,
      opts.actor,
    );
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

export type EnsureLocalIdentityResult =
  | { status: "no_local_handle" }
  | { status: "already_fresh"; backend: string; handle: string }
  | { status: "republished"; backend: string; handle: string; previous_handle?: string }
  | { status: "probe_failed"; backend: string; handle: string; reason: string };

/**
 * Self-repair: when a session boots, the workspace identity published in KV
 * may be stale (the original pane was closed and its id recycled into someone
 * else, or no identity was published at all). Use the backend's view of which
 * handle this process is actually running in (e.g. HERDR_PANE_ID for herdr)
 * as the source of truth and (re)publish accordingly.
 *
 * No-op for backends that don't implement currentLocalHandle (synthetic test
 * backends).
 */
export function ensureLocalWorkspaceIdentity(opts: {
  scope: string;
  instanceId: string;
  actor?: string | null;
}): EnsureLocalIdentityResult {
  for (const backend of registeredBackends()) {
    const localHandle = stringValue(backend.currentLocalHandle?.());
    if (!localHandle) continue;

    const existingRow = loadPublishedIdentity(
      opts.scope,
      backend,
      opts.instanceId,
      opts.actor,
    );
    let existingIdentity: WorkspaceIdentity | undefined;
    let existingHandle = "";
    if (existingRow) {
      const parsed = parseIdentity(existingRow.value);
      if (parsed.identity) {
        existingIdentity = parsed.identity;
        const handles = backend.handlesForIdentity(parsed.identity);
        if (handles.includes(localHandle)) {
          return { status: "already_fresh", backend: backend.name, handle: localHandle };
        }
        existingHandle = stringValue(parsed.identity.handle) || handles[0] || "";
      }
    }

    const probe = backend.getHandle({
      handle: localHandle,
      identity: existingIdentity ?? { backend: backend.name },
    });
    if (!probe.ok) {
      return {
        status: "probe_failed",
        backend: backend.name,
        handle: localHandle,
        reason: probe.error,
      };
    }

    const canonical = backend.canonicalizeIdentity({
      identity: existingIdentity ?? { backend: backend.name },
      handleInfo: probe.value,
      requestedHandle: localHandle,
    });
    const payload = JSON.stringify(canonical);
    const actor = opts.actor ?? opts.instanceId;
    for (const key of backend.identityKeys(opts.instanceId)) {
      kv.set(opts.scope, key, payload, actor);
    }
    return {
      status: "republished",
      backend: backend.name,
      handle: localHandle,
      ...(existingHandle && existingHandle !== localHandle
        ? { previous_handle: existingHandle }
        : {}),
    };
  }

  return { status: "no_local_handle" };
}

function identityKeyRows(scope: string, backend: WorkspaceBackend, viewer?: string | null) {
  const rows = new Map<string, { key: string }>();
  for (const prefix of backend.identityKeys("")) {
    const prefixRows = kv.keys(scope, prefix, viewer) as Array<{ key: string }>;
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
  const actor = opts.actor ? registry.get(opts.actor) : null;

  const directInstanceId = stringValue(probeInfo?.swarm_instance_id);
  if (directInstanceId && probeInfo) {
    const inst = registry.get(directInstanceId);
    if (inst?.scope === opts.scope && (!actor || identityMatches(actor, inst))) {
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

  for (const row of identityKeyRows(opts.scope, backend, opts.actor)) {
    const instanceId = backend.instanceIdFromIdentityKey(row.key);
    if (!instanceId) continue;
    const value = kv.get(opts.scope, row.key, opts.actor)?.value;
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
    if (actor && inst && !identityMatches(actor, inst)) continue;
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
