import { spawnSync } from "node:child_process";
import {
  identityKey,
  type BackendResult,
  type WakeHandleResult,
  type WorkspaceBackend,
  type WorkspaceHandleInfo,
  type WorkspaceIdentity,
} from "../workspace_backend";
import { herdrEnvWithSocket } from "../herdr_socket";

export const HERDR_BACKEND_NAME = "herdr";
export const LEGACY_HERDR_IDENTITY_PREFIX = "identity/herdr/";

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniqueStrings(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map(stringValue)
        .filter(Boolean),
    ),
  );
}

function details(identity: WorkspaceIdentity | undefined) {
  const raw = identity?.details;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function identityValue(identity: WorkspaceIdentity | undefined, key: string) {
  return stringValue(identity?.[key]) || stringValue(details(identity)[key]);
}

function herdrEnv(identity: WorkspaceIdentity | undefined) {
  const env = herdrEnvWithSocket(process.env);
  const socketPath = identityValue(identity, "socket_path");
  if (socketPath) env.HERDR_SOCKET_PATH = socketPath;
  return env;
}

function herdrBin() {
  return process.env.SWARM_HERDR_BIN?.trim() || "herdr";
}

function outputText(value: string | Buffer | null | undefined) {
  return typeof value === "string" ? value : (value?.toString("utf8") ?? "");
}

function processError(
  proc: ReturnType<typeof spawnSync>,
  fallback: string,
) {
  return (
    proc.error?.message ||
    outputText(proc.stderr).trim() ||
    outputText(proc.stdout).trim() ||
    fallback
  );
}

function runHerdr(
  args: string[],
  identity: WorkspaceIdentity | undefined,
  timeoutMs = 5_000,
) {
  return spawnSync(herdrBin(), args, {
    encoding: "utf8",
    env: herdrEnv(identity),
    timeout: timeoutMs,
  });
}

function paneFromGet(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    const pane = payload?.result?.pane ?? payload?.pane;
    return pane && typeof pane === "object" && !Array.isArray(pane)
      ? (pane as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canonicalHandle(info: Record<string, unknown>, fallback: string) {
  return (
    stringValue(info.handle) ||
    stringValue(info.pane_id) ||
    stringValue(info.id) ||
    fallback
  );
}

function swarmInstanceId(info: Record<string, unknown>) {
  return (
    stringValue(info.swarm_instance_id) ||
    stringValue(info.swarm_instance) ||
    stringValue(info.swarm_id)
  );
}

function handleDetails(info: Record<string, unknown>, identity?: WorkspaceIdentity) {
  const next: Record<string, unknown> = { ...details(identity) };
  const paneId = stringValue(info.pane_id) || stringValue(info.id);
  if (paneId) next.pane_id = paneId;
  const workspaceId = stringValue(info.workspace_id);
  if (workspaceId) next.workspace_id = workspaceId;
  const tabId = stringValue(info.tab_id);
  if (tabId) next.tab_id = tabId;
  const socketPath = identityValue(identity, "socket_path");
  if (socketPath) next.socket_path = socketPath;
  return next;
}

export const herdrWorkspaceBackend: WorkspaceBackend = {
  name: HERDR_BACKEND_NAME,
  defaultHandleKind: "pane",

  identityKeys(instanceId: string) {
    return [
      identityKey(HERDR_BACKEND_NAME, instanceId),
      `${LEGACY_HERDR_IDENTITY_PREFIX}${instanceId}`,
    ];
  },

  instanceIdFromIdentityKey(key: string) {
    const genericPrefix = identityKey(HERDR_BACKEND_NAME, "");
    if (key.startsWith(genericPrefix)) return key.slice(genericPrefix.length);
    if (key.startsWith(LEGACY_HERDR_IDENTITY_PREFIX)) {
      return key.slice(LEGACY_HERDR_IDENTITY_PREFIX.length);
    }
    return null;
  },

  handlesForIdentity(identity: WorkspaceIdentity) {
    const detail = details(identity);
    return uniqueStrings([
      identity.handle,
      identity.handle_aliases,
      identity.pane_id,
      identity.pane_aliases,
      detail.pane_id,
      detail.pane_aliases,
    ]);
  },

  getHandle({ handle, handleKind, identity, timeoutMs }) {
    const proc = runHerdr(["pane", "get", handle], identity, timeoutMs);
    if (proc.error || proc.status !== 0) {
      return {
        ok: false,
        error: processError(proc, "herdr pane get failed"),
      };
    }

    const pane = paneFromGet(proc.stdout);
    if (!pane) {
      return { ok: false, error: "herdr pane get returned no pane" };
    }

    const canonical = canonicalHandle(pane, handle);
    return {
      ok: true,
      value: {
        ...pane,
        backend: HERDR_BACKEND_NAME,
        handle_kind: handleKind || stringValue(identity?.handle_kind) || "pane",
        handle: canonical,
        agent_status: stringValue(pane.agent_status) || "unknown",
        swarm_instance_id: swarmInstanceId(pane),
        details: handleDetails(pane, identity),
      } as WorkspaceHandleInfo,
    };
  },

  wakeHandle({ handle, prompt, identity, handleInfo, force, timeoutMs }) {
    const status = stringValue(handleInfo?.agent_status) || "unknown";
    if (!["idle", "blocked", "done", "unknown"].includes(status) && !force) {
      return {
        ok: true,
        value: {
          skipped: `target workspace handle is ${status}; pass force=true to inject anyway`,
        },
      };
    }

    const proc = runHerdr(["pane", "run", handle, prompt], identity, timeoutMs);
    if (proc.error || proc.status !== 0) {
      return {
        ok: false,
        error: processError(proc, "herdr pane run failed"),
      };
    }
    return { ok: true, value: {} satisfies WakeHandleResult };
  },

  canonicalizeIdentity({ identity, handleInfo, requestedHandle }) {
    const handle = canonicalHandle(handleInfo, requestedHandle);
    const aliases = uniqueStrings([
      identity.handle_aliases,
      identity.pane_aliases,
      identity.handle === handle ? "" : identity.handle,
      identity.pane_id === handle ? "" : identity.pane_id,
      requestedHandle === handle ? "" : requestedHandle,
    ]);
    const detail = handleDetails(handleInfo, identity);
    detail.pane_id = handle;

    const next: WorkspaceIdentity = {
      ...identity,
      schema_version: 1,
      backend: HERDR_BACKEND_NAME,
      handle_kind: stringValue(identity.handle_kind) || "pane",
      handle,
      pane_id: handle,
      details: detail,
    };

    if (aliases.length) {
      next.handle_aliases = aliases;
      next.pane_aliases = aliases;
    } else {
      delete next.handle_aliases;
      delete next.pane_aliases;
    }

    const socketPath = stringValue(detail.socket_path);
    if (socketPath) next.socket_path = socketPath;
    const workspaceId = stringValue(detail.workspace_id);
    if (workspaceId) next.workspace_id = workspaceId;
    const tabId = stringValue(detail.tab_id);
    if (tabId) next.tab_id = tabId;

    return next;
  },
};
