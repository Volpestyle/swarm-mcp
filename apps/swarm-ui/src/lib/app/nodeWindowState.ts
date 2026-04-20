import { get, writable } from 'svelte/store';

const COMPACT_NODE_STORAGE_PREFIX = 'swarm-ui:compact-nodes:';
const GLOBAL_SCOPE_KEY = '__all__';

type NodeWindowActions = {
  openWorkspace: (nodeId: string) => void;
};

const defaultActions: NodeWindowActions = {
  openWorkspace: () => {},
};

export const compactNodeIds = writable<Set<string>>(new Set());

const nodeWindowActions = writable<NodeWindowActions>(defaultActions);

let activeScopeKey = '';

function storageKeyForScope(scope: string | null): string {
  return `${COMPACT_NODE_STORAGE_PREFIX}${scope ?? GLOBAL_SCOPE_KEY}`;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function loadCompactNodeIds(scope: string | null): Set<string> {
  if (typeof window === 'undefined') return new Set();

  const raw = window.localStorage.getItem(storageKeyForScope(scope));
  if (!raw) return new Set();

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0));
  } catch (err) {
    console.warn('[nodeWindowState] failed to parse compact node ids:', err);
    return new Set();
  }
}

function persistCompactNodeIds(scopeKey: string, values: Set<string>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(scopeKey, JSON.stringify([...values].sort()));
}

function setCompactNodeIds(next: Set<string>): void {
  const current = get(compactNodeIds);
  if (setsEqual(current, next)) return;
  compactNodeIds.set(next);
  persistCompactNodeIds(activeScopeKey, next);
}

export function setCompactNodeScope(scope: string | null): void {
  const nextScopeKey = storageKeyForScope(scope);
  if (nextScopeKey === activeScopeKey) return;

  activeScopeKey = nextScopeKey;
  compactNodeIds.set(loadCompactNodeIds(scope));
}

export function pruneCompactNodeIds(nodeIds: string[]): void {
  const allowed = new Set(nodeIds);
  const current = get(compactNodeIds);
  const next = new Set([...current].filter((nodeId) => allowed.has(nodeId)));
  if (setsEqual(current, next)) return;
  compactNodeIds.set(next);
  persistCompactNodeIds(activeScopeKey, next);
}

export function toggleCompactNode(nodeId: string): void {
  const current = get(compactNodeIds);
  const next = new Set(current);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  setCompactNodeIds(next);
}

export function isCompactNode(nodeId: string): boolean {
  return get(compactNodeIds).has(nodeId);
}

export function registerNodeWindowActions(actions: Partial<NodeWindowActions>): () => void {
  const nextActions: NodeWindowActions = {
    ...defaultActions,
    ...actions,
  };
  nodeWindowActions.set(nextActions);
  return () => {
    nodeWindowActions.set(defaultActions);
  };
}

export function requestNodeWorkspace(nodeId: string): void {
  get(nodeWindowActions).openWorkspace(nodeId);
}
