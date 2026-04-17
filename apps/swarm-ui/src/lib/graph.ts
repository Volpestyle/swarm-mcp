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
  MessageEdgeData,
  TaskEdgeData,
  DependencyEdgeData,
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
 *   1. Messages grouped by (sender, recipient) pair -> one edge per pair
 *   2. Tasks with assignee -> edge from requester to assignee
 *   3. Dependencies -> edge from dependency task's assignee to dependent task's assignee
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

  // 1. Message edges: group by (sender, recipient) pair
  edges.push(...buildMessageEdges(messages, instanceToNodeId));

  // 2. Task edges: requester -> assignee
  edges.push(...buildTaskEdges(tasks, instanceToNodeId));

  // 3. Dependency edges: dependency task assignee -> dependent task assignee
  edges.push(...buildDependencyEdges(tasks, instanceToNodeId));

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
 * Group recent messages by (sender, recipient) pair. Create one edge per pair
 * with the most recent message in metadata.
 */
function buildMessageEdges(
  messages: Message[],
  instanceToNodeId: Map<string, string>,
): XYFlowEdge[] {
  // Group by directed sender -> recipient pair.
  const pairMap = new Map<string, Message[]>();

  for (const msg of messages) {
    if (!msg.recipient) continue; // skip broadcast messages
    const sourceNode = instanceToNodeId.get(msg.sender);
    const targetNode = instanceToNodeId.get(msg.recipient);
    if (!sourceNode || !targetNode) continue;

    const pairKey = `${msg.sender}::${msg.recipient}`;
    const group = pairMap.get(pairKey);
    if (group) {
      group.push(msg);
    } else {
      pairMap.set(pairKey, [msg]);
    }
  }

  const edges: XYFlowEdge[] = [];

  for (const [pairKey, msgs] of pairMap) {
    // Sort by created_at descending to get most recent first
    msgs.sort((a, b) => b.created_at - a.created_at);
    const latest = msgs[0];
    const recipient = latest.recipient;
    if (!recipient) continue;

    const sourceNode = instanceToNodeId.get(latest.sender);
    const targetNode = instanceToNodeId.get(recipient);
    if (!sourceNode || !targetNode) continue;

    const data: MessageEdgeData = {
      edgeType: 'message',
      messageCount: msgs.length,
      lastMessage: latest,
    };

    edges.push({
      id: `msg:${pairKey}`,
      type: 'message',
      source: sourceNode,
      target: targetNode,
      data,
    });
  }

  return edges;
}

/**
 * For each task with an assignee, create an edge from requester node to
 * assignee node, colored by status.
 */
function buildTaskEdges(
  tasks: Map<string, Task>,
  instanceToNodeId: Map<string, string>,
): XYFlowEdge[] {
  const edges: XYFlowEdge[] = [];

  for (const [id, task] of tasks) {
    if (!task.assignee) continue;

    const sourceNode = instanceToNodeId.get(task.requester);
    const targetNode = instanceToNodeId.get(task.assignee);
    if (!sourceNode || !targetNode) continue;

    const data: TaskEdgeData = {
      edgeType: 'task',
      task,
    };

    edges.push({
      id: `task:${id}`,
      type: 'task',
      source: sourceNode,
      target: targetNode,
      data,
    });
  }

  return edges;
}

/**
 * For each task with depends_on, create edges from the dependency task's
 * assignee to the dependent task's assignee.
 */
function buildDependencyEdges(
  tasks: Map<string, Task>,
  instanceToNodeId: Map<string, string>,
): XYFlowEdge[] {
  const edges: XYFlowEdge[] = [];

  for (const [dependentId, dependent] of tasks) {
    if (dependent.depends_on.length === 0 || !dependent.assignee) continue;

    const dependentNode = instanceToNodeId.get(dependent.assignee);
    if (!dependentNode) continue;

    for (const depId of dependent.depends_on) {
      const depTask = tasks.get(depId);
      if (!depTask || !depTask.assignee) continue;

      const depNode = instanceToNodeId.get(depTask.assignee);
      if (!depNode) continue;

      // Avoid self-edges
      if (depNode === dependentNode) continue;

      const satisfied = depTask.status === 'done';

      const data: DependencyEdgeData = {
        edgeType: 'dependency',
        dependencyTaskId: depId,
        dependentTaskId: dependentId,
        satisfied,
      };

      edges.push({
        id: `dep:${depId}->${dependentId}`,
        type: 'dependency',
        source: depNode,
        target: dependentNode,
        data,
      });
    }
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
