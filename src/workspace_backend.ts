export const WORKSPACE_IDENTITY_PREFIX = "identity/workspace/";
export const DEFAULT_WORKSPACE_BACKEND = "herdr";

export type WorkspaceIdentity = Record<string, unknown> & {
  schema_version?: number;
  backend?: string;
  handle_kind?: string;
  handle?: string;
  handle_aliases?: string[];
  details?: Record<string, unknown>;
};

export type WorkspaceHandleInfo = Record<string, unknown> & {
  backend?: string;
  handle_kind?: string;
  handle: string;
  handle_aliases?: string[];
  agent_status?: string;
  swarm_instance_id?: string;
  details?: Record<string, unknown>;
};

export type BackendResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

export type WakeHandleResult = {
  skipped?: string;
};

export type ReadHandleSource = "visible" | "recent" | "recent-unwrapped";

export type ReadHandleResult = {
  text: string;
  source: ReadHandleSource;
  lines?: number;
  truncated?: boolean;
};

export type WorkspaceBackend = {
  name: string;
  defaultHandleKind: string;
  identityKeys(instanceId: string): readonly string[];
  instanceIdFromIdentityKey(key: string): string | null;
  handlesForIdentity(identity: WorkspaceIdentity): string[];
  getHandle(input: {
    handle: string;
    handleKind?: string;
    identity?: WorkspaceIdentity;
    timeoutMs?: number;
  }): BackendResult<WorkspaceHandleInfo>;
  wakeHandle(input: {
    handle: string;
    prompt: string;
    identity?: WorkspaceIdentity;
    handleInfo?: WorkspaceHandleInfo;
    force?: boolean;
    timeoutMs?: number;
  }): BackendResult<WakeHandleResult>;
  readHandle?(input: {
    handle: string;
    identity?: WorkspaceIdentity;
    handleInfo?: WorkspaceHandleInfo;
    source?: ReadHandleSource;
    lines?: number;
    timeoutMs?: number;
  }): BackendResult<ReadHandleResult>;
  canonicalizeIdentity(input: {
    identity: WorkspaceIdentity;
    handleInfo: WorkspaceHandleInfo;
    requestedHandle: string;
  }): WorkspaceIdentity;
};

const backends = new Map<string, WorkspaceBackend>();

export function normalizeBackendName(value: string | undefined) {
  return (value ?? DEFAULT_WORKSPACE_BACKEND).trim().toLowerCase();
}

export function identityKey(backend: string, instanceId: string) {
  return `${WORKSPACE_IDENTITY_PREFIX}${normalizeBackendName(backend)}/${instanceId}`;
}

export function registerBackend(backend: WorkspaceBackend) {
  const name = normalizeBackendName(backend.name);
  if (!name) throw new Error("Workspace backend name is required");
  backends.set(name, { ...backend, name });
}

export function getBackend(name: string | undefined) {
  return backends.get(normalizeBackendName(name)) ?? null;
}

export function requireBackend(name: string | undefined) {
  const normalized = normalizeBackendName(name);
  const backend = backends.get(normalized);
  if (backend) return backend;

  const registered = Array.from(backends.keys()).sort();
  const suffix = registered.length
    ? ` Currently registered: ${registered.join(", ")}.`
    : " No workspace backends are registered.";
  throw new Error(`Unsupported workspace backend "${name ?? normalized}".${suffix}`);
}

export function registeredBackends() {
  return Array.from(backends.values());
}

export function clearBackendsForTesting() {
  backends.clear();
}
