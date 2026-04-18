// =============================================================================
// graph.ts — Transform normalized swarm state into @xyflow/svelte nodes + edges
//
// Pure function: no side effects, no store subscriptions. Called reactively by
// Svelte when any upstream store changes.
// =============================================================================

import type {
  Instance,
  PtySession,
  Task,
  Message,
  Lock,
  BindingState,
  Position,
  XYFlowNode,
  XYFlowEdge,
  SwarmNodeData,
  ConnectionEdgeData,
  ConnectionDep,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full XYFlow graph from the current normalized state.
 *
 * Node derivation:
 *   1. Each instance NOT bound to a PTY -> instance node
 *   2. Each PTY NOT bound to an instance -> pty node (pending state)
 *   3. Each resolved binding -> bound node (merged card)
 *
 * Edge derivation:
 *   One `connection` edge per unordered instance pair, aggregating all
 *   messages, shared tasks, and task dependencies between the two
 *   endpoints. Overlapping edge types that used to stack on top of each
 *   other are collapsed into a single edge carrying a "key" of what's
 *   present and routed to the combined inspector.
 */
export function buildGraph(
  instances: Map<string, Instance>,
  ptySessions: Map<string, PtySession>,
  tasks: Map<string, Task>,
  messages: Message[],
  locks: Lock[],
  bindings: BindingState,
  savedLayout?: Record<string, Position>,
): { nodes: XYFlowNode[]; edges: XYFlowEdge[] } {
  // Build lookup sets for binding resolution
  const resolvedInstanceIds = new Set<string>();
  const resolvedPtyIds = new Set<string>();

  for (const [instanceId, ptyId] of bindings.resolved) {
    resolvedInstanceIds.add(instanceId);
    resolvedPtyIds.add(ptyId);
  }

  // Build lock index: instance_id -> locks
  const locksByInstance = groupBy(locks, (l) => l.instance_id);

  // Build task indexes
  const tasksByAssignee = groupBy([...tasks.values()], (t) => t.assignee ?? '');
  const tasksByRequester = groupBy([...tasks.values()], (t) => t.requester);

  // --- Nodes ---
  const nodes: XYFlowNode[] = [];
  let autoIndex = 0;

  // 1. Bound nodes (PTY + instance merged)
  for (const [instanceId, ptyId] of bindings.resolved) {
    const instance = instances.get(instanceId) ?? null;
    const pty = ptySessions.get(ptyId) ?? null;
    const nodeId = `bound:${instanceId}`;

    nodes.push(makeNode(nodeId, 'bound', instance, pty, {
      locks: locksByInstance.get(instanceId) ?? [],
      assignedTasks: tasksByAssignee.get(instanceId) ?? [],
      requestedTasks: tasksByRequester.get(instanceId) ?? [],
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 2. Unbound instance nodes
  for (const [id, instance] of instances) {
    if (resolvedInstanceIds.has(id)) continue;
    const nodeId = `instance:${id}`;

    nodes.push(makeNode(nodeId, 'instance', instance, null, {
      locks: locksByInstance.get(id) ?? [],
      assignedTasks: tasksByAssignee.get(id) ?? [],
      requestedTasks: tasksByRequester.get(id) ?? [],
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 3. Unbound PTY nodes (pending)
  for (const [id, pty] of ptySessions) {
    if (resolvedPtyIds.has(id)) continue;
    const nodeId = `pty:${id}`;

    nodes.push(makeNode(nodeId, 'pty', null, pty, {
      locks: [],
      assignedTasks: [],
      requestedTasks: [],
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // --- Edges ---
  const edges: XYFlowEdge[] = [];

  // Build a mapping from instance ID to the graph node ID that represents it
  const instanceToNodeId = new Map<string, string>();
  for (const [instanceId] of instances) {
    if (resolvedInstanceIds.has(instanceId)) {
      instanceToNodeId.set(instanceId, `bound:${instanceId}`);
    } else {
      instanceToNodeId.set(instanceId, `instance:${instanceId}`);
    }
  }

  edges.push(...buildConnectionEdges(messages, tasks, instanceToNodeId));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

interface MakeNodeOpts {
  locks: Lock[];
  assignedTasks: Task[];
  requestedTasks: Task[];
  savedLayout?: Record<string, Position>;
  autoIndex: number;
}

function makeNode(
  nodeId: string,
  nodeType: 'instance' | 'pty' | 'bound',
  instance: Instance | null,
  pty: PtySession | null,
  opts: MakeNodeOpts,
): XYFlowNode {
  const position = resolvePosition(nodeId, opts.savedLayout, opts.autoIndex);
  const label = deriveLabel(nodeType, instance, pty);
  const status = deriveStatus(nodeType, instance, pty);

  const data: SwarmNodeData = {
    nodeType,
    instance,
    ptySession: pty,
    label,
    status,
    locks: opts.locks,
    assignedTasks: opts.assignedTasks,
    requestedTasks: opts.requestedTasks,
  };

  return {
    id: nodeId,
    type: 'terminal', // All nodes use the TerminalNode component (Agent 4)
    position,
    data,
    // Default size; NodeResizer lets the user drag corners/edges to resize.
    // Using `style` (instead of node.width/height) keeps xyflow from treating
    // the size as measured-and-fixed, so the resize handles stay authoritative.
    style: 'width: 760px; height: 620px;',
  };
}

function deriveLabel(
  nodeType: 'instance' | 'pty' | 'bound',
  instance: Instance | null,
  pty: PtySession | null,
): string {
  if (instance) {
    // Extract role from label string if present (e.g., "role:implementer")
    if (instance.label) {
      const roleMatch = instance.label.match(/role:(\S+)/);
      if (roleMatch) return roleMatch[1];
      return instance.label;
    }
    return instance.id.slice(0, 8);
  }
  if (pty) {
    return pty.command.split('/').pop() ?? pty.command;
  }
  return nodeType;
}

function deriveStatus(
  nodeType: 'instance' | 'pty' | 'bound',
  instance: Instance | null,
  pty: PtySession | null,
): 'online' | 'stale' | 'offline' | 'pending' {
  if (instance) return instance.status;
  if (nodeType === 'pty') {
    // PTYs carrying a launch token are waiting to bind to a swarm instance.
    // Shells have no token and are just live local processes.
    return pty?.launch_token ? 'pending' : 'online';
  }
  return 'offline';
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

/** Grid layout constants */
const GRID_COLS = 3;
const GRID_CELL_W = 420;
const GRID_CELL_H = 360;
const GRID_PAD_X = 60;
const GRID_PAD_Y = 60;

function resolvePosition(
  nodeId: string,
  savedLayout: Record<string, Position> | undefined,
  autoIndex: number,
): Position {
  if (savedLayout && savedLayout[nodeId]) {
    return savedLayout[nodeId];
  }
  // Auto grid layout: arrange nodes in a grid pattern
  const col = autoIndex % GRID_COLS;
  const row = Math.floor(autoIndex / GRID_COLS);
  return {
    x: GRID_PAD_X + col * GRID_CELL_W,
    y: GRID_PAD_Y + row * GRID_CELL_H,
  };
}

// ---------------------------------------------------------------------------
// Edge construction
// ---------------------------------------------------------------------------

/**
 * Build one connection edge per unordered pair of participating instances.
 * Every relationship between A and B (messages in either direction, shared
 * tasks, task dependencies that cross between their assignees) collapses
 * into a single edge so nothing stacks visually.
 *
 * Canonical direction: `min(a, b)` lexically is the edge `source`, `max`
 * is the `target`. This keeps the bezier stable across snapshots and lets
 * the packet renderer route individual messages forward or reverse along
 * the same curve.
 */
function buildConnectionEdges(
  messages: Message[],
  tasks: Map<string, Task>,
  instanceToNodeId: Map<string, string>,
): XYFlowEdge[] {
  interface PairBucket {
    sourceInstanceId: string;
    targetInstanceId: string;
    messages: Message[];
    tasks: Task[];
    deps: ConnectionDep[];
  }

  const pairs = new Map<string, PairBucket>();

  const bucketFor = (a: string, b: string): PairBucket | null => {
    if (a === b) return null;
    if (!instanceToNodeId.has(a) || !instanceToNodeId.has(b)) return null;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}::${hi}`;
    let bucket = pairs.get(key);
    if (!bucket) {
      bucket = {
        sourceInstanceId: lo,
        targetInstanceId: hi,
        messages: [],
        tasks: [],
        deps: [],
      };
      pairs.set(key, bucket);
    }
    return bucket;
  };

  // Messages between two instances (skip broadcasts)
  for (const msg of messages) {
    if (!msg.recipient) continue;
    const bucket = bucketFor(msg.sender, msg.recipient);
    if (bucket) bucket.messages.push(msg);
  }

  // Tasks where requester and assignee are both known instances
  for (const task of tasks.values()) {
    if (!task.assignee) continue;
    const bucket = bucketFor(task.requester, task.assignee);
    if (bucket) bucket.tasks.push(task);
  }

  // Dependencies: edge between the dep-task's assignee and the dependent-task's assignee
  for (const dependent of tasks.values()) {
    if (dependent.depends_on.length === 0 || !dependent.assignee) continue;
    for (const depId of dependent.depends_on) {
      const depTask = tasks.get(depId);
      if (!depTask || !depTask.assignee) continue;
      const bucket = bucketFor(depTask.assignee, dependent.assignee);
      if (!bucket) continue;
      bucket.deps.push({
        dependencyTaskId: depId,
        dependentTaskId: dependent.id,
        satisfied: depTask.status === 'done',
      });
    }
  }

  const edges: XYFlowEdge[] = [];
  for (const [key, bucket] of pairs) {
    // Sort messages most-recent-first for the inspector; packet animation
    // reads per-message sender/recipient to pick direction.
    bucket.messages.sort((x, y) => y.created_at - x.created_at);

    const sourceNode = instanceToNodeId.get(bucket.sourceInstanceId);
    const targetNode = instanceToNodeId.get(bucket.targetInstanceId);
    if (!sourceNode || !targetNode) continue;

    const data: ConnectionEdgeData = {
      edgeType: 'connection',
      sourceInstanceId: bucket.sourceInstanceId,
      targetInstanceId: bucket.targetInstanceId,
      messages: bucket.messages,
      tasks: bucket.tasks,
      deps: bucket.deps,
    };

    edges.push({
      id: `conn:${key}`,
      type: 'connection',
      source: sourceNode,
      target: targetNode,
      data,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
