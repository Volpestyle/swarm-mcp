import type { Position, XYFlowNode } from '../types';

export function currentLayoutSnapshot(
  nodeList: XYFlowNode[],
): Record<string, Position> {
  const next: Record<string, Position> = {};
  for (const node of nodeList) {
    const x = node.position?.x;
    const y = node.position?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    next[node.id] = { x, y };
  }
  return next;
}

export function layoutsEqual(
  left: Record<string, Position>,
  right: Record<string, Position>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;

  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i];
    if (key !== rightKeys[i]) return false;
    if (left[key]?.x !== right[key]?.x) return false;
    if (left[key]?.y !== right[key]?.y) return false;
  }

  return true;
}

type PersistLayout = (
  scope: string,
  nodesById: Record<string, Position>,
) => Promise<void> | void;

/**
 * Resolve a node's inherent scope. Used when the active canvas scope is
 * `null` ("all scopes") so each drag can still be persisted to the scope
 * that actually owns the node — otherwise ghost nodes from other scopes
 * would snap back to their auto-grid positions after every rebuild.
 */
function resolveNodeScope(node: XYFlowNode): string | null {
  const instance = node.data?.instance;
  if (instance && typeof instance.scope === 'string' && instance.scope) {
    return instance.scope;
  }
  const browserContext = node.data?.browserContext;
  if (browserContext && typeof browserContext.scope === 'string' && browserContext.scope) {
    return browserContext.scope;
  }
  const mission = node.data?.mission;
  if (mission && typeof mission.scope === 'string' && mission.scope) {
    return mission.scope;
  }
  return null;
}

export function createLayoutPersistence(delayMs = 150) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  function syncSingleScope(
    scope: string,
    nodeList: XYFlowNode[],
    persistedLayout: Record<string, Position>,
    persist: PersistLayout,
  ): void {
    const nextLayout = currentLayoutSnapshot(nodeList);
    if (Object.keys(nextLayout).length === 0) return;

    if (layoutsEqual(nextLayout, persistedLayout)) {
      clear();
      return;
    }

    clear();
    saveTimer = setTimeout(() => {
      void persist(scope, nextLayout);
      saveTimer = null;
    }, delayMs);
  }

  function syncAllScopes(
    nodeList: XYFlowNode[],
    persistedLayout: Record<string, Position>,
    persist: PersistLayout,
  ): void {
    // Fan out positions to each node's own scope. Nodes without an
    // identifiable scope (pty-only rows with no swarm identity) can't be
    // persisted — they live and die with their PTY.
    const byScope = new Map<string, Record<string, Position>>();
    for (const node of nodeList) {
      const scope = resolveNodeScope(node);
      if (!scope) continue;
      const x = node.position?.x;
      const y = node.position?.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      let group = byScope.get(scope);
      if (!group) {
        group = {};
        byScope.set(scope, group);
      }
      group[node.id] = { x, y };
    }

    if (byScope.size === 0) {
      clear();
      return;
    }

    // Per-scope dirty check. `persistedLayout` in all-scopes mode is the
    // merged union of every scope's saved layout, so comparing individual
    // node keys against it is still valid — we just have to do it per-scope
    // so we only write scopes that actually changed.
    const dirtyScopes: string[] = [];
    for (const [scope, layout] of byScope) {
      let dirty = false;
      for (const [nodeId, pos] of Object.entries(layout)) {
        const prev = persistedLayout[nodeId];
        if (!prev || prev.x !== pos.x || prev.y !== pos.y) {
          dirty = true;
          break;
        }
      }
      if (dirty) dirtyScopes.push(scope);
    }

    if (dirtyScopes.length === 0) {
      clear();
      return;
    }

    clear();
    saveTimer = setTimeout(() => {
      for (const scope of dirtyScopes) {
        const layout = byScope.get(scope) ?? {};
        void persist(scope, layout);
      }
      saveTimer = null;
    }, delayMs);
  }

  function sync(
    scope: string | null,
    nodeList: XYFlowNode[],
    persistedLayout: Record<string, Position>,
    persist: PersistLayout,
  ): void {
    if (scope) {
      syncSingleScope(scope, nodeList, persistedLayout, persist);
      return;
    }
    // All-scopes mode — persist per-scope instead of giving up entirely.
    syncAllScopes(nodeList, persistedLayout, persist);
  }

  return { sync, clear };
}
