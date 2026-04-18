// =============================================================================
// floatingEdge.ts — Adaptive edge anchor computation
//
// XYFlow by default anchors every edge to the fixed Left/Right handles on
// each node. When nodes are stacked diagonally or vertically, that produces
// awkward curves that cross through unrelated space.
//
// We expose four port positions per node — top, right, bottom, left — and
// this helper picks the pair of ports (one on each node) whose midpoints
// are closest to each other. The edge then anchors exactly on those ports
// so the curve always takes the shortest visual route while still landing
// on a visible handle dot.
// =============================================================================

import { Position, type InternalNode } from '@xyflow/svelte';

interface Point {
  x: number;
  y: number;
}

interface PortCandidate {
  position: Position;
  point: Point;
}

export interface FloatingEdgeParams {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}

/**
 * Compute the midpoint of each of the four sides of a node's rectangle in
 * absolute canvas coordinates. These are the port anchor points we pick
 * between when routing an adaptive edge.
 */
function nodePorts(node: InternalNode): PortCandidate[] {
  const width = node.measured?.width ?? 0;
  const height = node.measured?.height ?? 0;
  const { x, y } = node.internals.positionAbsolute;

  return [
    { position: Position.Top, point: { x: x + width / 2, y } },
    { position: Position.Right, point: { x: x + width, y: y + height / 2 } },
    { position: Position.Bottom, point: { x: x + width / 2, y: y + height } },
    { position: Position.Left, point: { x, y: y + height / 2 } },
  ];
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Returns adaptive anchor coordinates for the edge connecting `source` to
 * `target`, picking the pair of port midpoints (one per node) with the
 * shortest Euclidean distance between them. Returns `null` if either node
 * hasn't been measured yet so the caller can fall back to the props
 * XYFlow supplied.
 */
export function getFloatingEdgeParams(
  source: InternalNode | undefined,
  target: InternalNode | undefined,
): FloatingEdgeParams | null {
  if (!source || !target) return null;
  if (!source.measured?.width || !source.measured?.height) return null;
  if (!target.measured?.width || !target.measured?.height) return null;

  const sourcePorts = nodePorts(source);
  const targetPorts = nodePorts(target);

  let best: {
    source: PortCandidate;
    target: PortCandidate;
    distSq: number;
  } | null = null;

  for (const sp of sourcePorts) {
    for (const tp of targetPorts) {
      const distSq = distanceSquared(sp.point, tp.point);
      if (best === null || distSq < best.distSq) {
        best = { source: sp, target: tp, distSq };
      }
    }
  }

  if (!best) return null;

  return {
    sourceX: best.source.point.x,
    sourceY: best.source.point.y,
    targetX: best.target.point.x,
    targetY: best.target.point.y,
    sourcePosition: best.source.position,
    targetPosition: best.target.position,
  };
}
