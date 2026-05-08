import type { XYFlowEdge, XYFlowNode } from '../types';

export function findNodeIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
}

export function findNodeById(
  nodes: XYFlowNode[],
  nodeId: string | null | undefined,
): XYFlowNode | null {
  if (!nodeId) return null;
  return nodes.find((node) => node.id === nodeId) ?? null;
}

export function nodeHasPty(
  nodes: XYFlowNode[],
  nodeId: string | null | undefined,
): nodeId is string {
  return findNodeById(nodes, nodeId)?.data?.ptySession != null;
}

export function findPtyNodeIdFromTarget(
  target: EventTarget | null,
  nodes: XYFlowNode[],
): string | null {
  const nodeId = findNodeIdFromTarget(target);
  return nodeHasPty(nodes, nodeId) ? nodeId : null;
}

export function applyNodeSelection(
  nodes: XYFlowNode[],
  selectedId: string | null,
): XYFlowNode[] {
  return nodes.map((node) => {
    const nextSelected = selectedId !== null && node.id === selectedId;
    return node.selected === nextSelected
      ? node
      : { ...node, selected: nextSelected };
  });
}

export function applyEdgeSelection(
  edges: XYFlowEdge[],
  selectedId: string | null,
): XYFlowEdge[] {
  return edges.map((edge) => {
    const nextSelected = selectedId !== null && edge.id === selectedId;
    return edge.selected === nextSelected
      ? edge
      : { ...edge, selected: nextSelected };
  });
}

export function orderedSelectableNodeIds(nodes: XYFlowNode[]): string[] {
  return nodes
    .slice()
    .sort((left, right) => {
      const leftY = left.position?.y ?? 0;
      const rightY = right.position?.y ?? 0;
      if (leftY !== rightY) return leftY - rightY;

      const leftX = left.position?.x ?? 0;
      const rightX = right.position?.x ?? 0;
      if (leftX !== rightX) return leftX - rightX;

      return left.id.localeCompare(right.id);
    })
    .map((node) => node.id);
}

export function nodeCanBeClosed(node: XYFlowNode | null): boolean {
  if (!node) return false;
  const data = node.data;
  if (data?.ptySession?.id) return true;
  if (data?.browserContext?.id) return true;
  if (data?.appSurface?.id) return true;
  return (
    data?.nodeType === 'instance' &&
    (data?.instance?.status === 'offline' || data?.instance?.status === 'stale')
  );
}

export function resolveClosableNodeId(
  event: KeyboardEvent,
  nodes: XYFlowNode[],
  selectedNodeId: string | null,
): string | null {
  const fromTarget =
    findNodeIdFromTarget(event.target) ??
    findNodeIdFromTarget(document.activeElement);
  if (nodeCanBeClosed(findNodeById(nodes, fromTarget))) return fromTarget;

  if (nodeCanBeClosed(findNodeById(nodes, selectedNodeId))) return selectedNodeId;
  return null;
}

export function resolveNodeTargetId(
  event: KeyboardEvent,
  selectedNodeId: string | null,
): string | null {
  return (
    findNodeIdFromTarget(event.target) ??
    findNodeIdFromTarget(document.activeElement) ??
    selectedNodeId
  );
}

export function resolveFullscreenTargetId(
  event: KeyboardEvent,
  nodes: XYFlowNode[],
  selectedNodeId: string | null,
): string | null {
  if (nodeHasPty(nodes, selectedNodeId)) return selectedNodeId;

  return (
    findPtyNodeIdFromTarget(event.target, nodes) ??
    findPtyNodeIdFromTarget(document.activeElement, nodes)
  );
}
