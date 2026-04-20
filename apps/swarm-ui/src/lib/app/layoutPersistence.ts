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

export function createLayoutPersistence(delayMs = 150) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  function sync(
    scope: string | null,
    nodeList: XYFlowNode[],
    persistedLayout: Record<string, Position>,
    persist: PersistLayout,
  ): void {
    if (!scope) {
      clear();
      return;
    }

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

  return { sync, clear };
}
