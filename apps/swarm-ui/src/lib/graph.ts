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
  Event,
  BindingState,
  BrowserContext,
  BrowserSnapshot,
  BrowserTab,
  CanvasAppSurface,
  CanvasMission,
  Position,
  XYFlowNode,
  XYFlowEdge,
  SwarmNodeData,
  ConnectionEdgeData,
  ConnectionDep,
} from './types';
import { deriveAgentListenerHealth } from './agentListenerHealth';
import { buildAgentDisplayState } from './agentIdentity';

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
  events: Event[],
  bindings: BindingState,
  activeScope: string | null,
  savedLayout?: Record<string, Position>,
  browserContexts: BrowserContext[] = [],
  browserTabs: BrowserTab[] = [],
  browserSnapshots: BrowserSnapshot[] = [],
  allInstances: Map<string, Instance> = instances,
  appSurfaces: CanvasAppSurface[] = [],
  missions: CanvasMission[] = [],
): { nodes: XYFlowNode[]; edges: XYFlowEdge[] } {
  // Build lookup sets for binding resolution
  const resolvedInstanceIds = new Set<string>();
  const resolvedPtyIds = new Set<string>();

  for (const [instanceId, ptyId] of bindings.resolved) {
    if (!instances.has(instanceId)) {
      if (allInstances.has(instanceId)) {
        resolvedPtyIds.add(ptyId);
      }
      continue;
    }
    resolvedInstanceIds.add(instanceId);
    resolvedPtyIds.add(ptyId);
  }

  // Build lock index: instance_id -> locks
  const locksByInstance = groupBy(locks, (l) => l.instance_id);
  const unreadByRecipient = groupBy(
    messages.filter((message) => message.recipient && !message.read),
    (message) => message.recipient ?? '',
  );

  // Build task indexes
  const tasksByAssignee = groupBy([...tasks.values()], (t) => t.assignee ?? '');
  const tasksByRequester = groupBy([...tasks.values()], (t) => t.requester);

  // --- Nodes ---
  const nodes: XYFlowNode[] = [];
  let autoIndex = 0;

  // 1. Bound nodes (PTY + instance merged)
  for (const [instanceId, ptyId] of bindings.resolved) {
    const instance = instances.get(instanceId) ?? null;
    if (!instance) continue;
    const pty = ptySessions.get(ptyId) ?? null;
    const nodeId = `bound:${instanceId}`;

    nodes.push(makeNode(nodeId, 'bound', instance, pty, {
      locks: locksByInstance.get(instanceId) ?? [],
      assignedTasks: tasksByAssignee.get(instanceId) ?? [],
      requestedTasks: tasksByRequester.get(instanceId) ?? [],
      unreadMessages: unreadByRecipient.get(instanceId)?.length ?? 0,
      events,
      activeScope,
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
      unreadMessages: unreadByRecipient.get(id)?.length ?? 0,
      events,
      activeScope,
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 3. Unbound PTY nodes (pending)
  for (const [id, pty] of ptySessions) {
    if (resolvedPtyIds.has(id)) continue;
    if (
      pty.bound_instance_id &&
      !instances.has(pty.bound_instance_id) &&
      !ptyBelongsToScope(pty, activeScope)
    ) {
      continue;
    }
    const nodeId = `pty:${id}`;

    nodes.push(makeNode(nodeId, 'pty', null, pty, {
      locks: [],
      assignedTasks: [],
      requestedTasks: [],
      unreadMessages: 0,
      events,
      activeScope,
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 4. Managed browser contexts are first-class canvas nodes. The actual
  // Chrome surface is still OS-managed, but the context, tabs, and snapshots
  // live in swarm.db and should be visible on the graph like agents.
  for (const context of browserContexts) {
    if (activeScope !== null && context.scope !== activeScope) continue;
    if (context.status === 'closed') continue;
    const contextTabs = browserTabs.filter((tab) => tab.contextId === context.id);
    const contextSnapshots = browserSnapshots.filter((snapshot) => snapshot.contextId === context.id);
    nodes.push(makeBrowserNode(context, contextTabs, contextSnapshots, {
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 5. Native/external app surfaces are canvas objects too. They are not swarm
  // agents, but the operator can place them on the canvas and notify agents
  // that the app is part of the current working context.
  for (const surface of appSurfaces) {
    if (activeScope !== null && surface.scope !== null && surface.scope !== activeScope) continue;
    if (surface.status === 'closed') continue;
    nodes.push(makeAppSurfaceNode(surface, {
      savedLayout,
      autoIndex: autoIndex++,
    }));
  }

  // 6. Mission boards are draggable project-owned operator surfaces. They
  // summarize project tasks without creating project membership side effects.
  for (const mission of missions) {
    if (activeScope !== null && mission.scope !== null && mission.scope !== activeScope) continue;
    if (mission.status === 'archived') continue;
    nodes.push(makeMissionNode(mission, {
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

function ptyBelongsToScope(pty: PtySession, activeScope: string | null): boolean {
  if (!pty.bound_instance_id || activeScope === null) return true;
  const scope = trimTrailingSlash(activeScope);
  const cwd = trimTrailingSlash(pty.cwd);
  return cwd === scope || cwd.startsWith(`${scope}/`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

interface MakeNodeOpts {
  locks: Lock[];
  assignedTasks: Task[];
  requestedTasks: Task[];
  unreadMessages: number;
  events: Event[];
  activeScope: string | null;
  savedLayout?: Record<string, Position>;
  autoIndex: number;
}

interface MakeBrowserNodeOpts {
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
  const displayName = deriveDisplayName(instance);
  const mobileControlled = isMobileControlledPty(pty);
  const preferredSize = derivePreferredNodeSize(nodeType, pty);
  const listenerHealth = deriveAgentListenerHealth({
    instance,
    activeScope: opts.activeScope,
    unreadMessages: opts.unreadMessages,
    assignedTasks: opts.assignedTasks,
    events: opts.events,
  });
  const agentDisplay = buildAgentDisplayState({
    nodeType,
    instance,
    pty,
    label,
    displayName,
    taskCount: opts.assignedTasks.length,
    lockCount: opts.locks.length,
    unreadMessages: opts.unreadMessages,
    listenerLabel: listenerHealth.label,
  });

  const data: SwarmNodeData = {
    nodeType,
    instance,
    ptySession: pty,
    label,
    status,
    locks: opts.locks,
    assignedTasks: opts.assignedTasks,
    requestedTasks: opts.requestedTasks,
    unreadMessages: opts.unreadMessages,
    listenerHealth,
    agentDisplay,
    project: null,
    displayName,
    mobileControlled,
    mobileLeaseHolder: pty?.lease?.holder ?? null,
    browserContext: null,
    browserTabs: [],
    browserSnapshots: [],
    appSurface: null,
  };

  return {
    id: nodeId,
    type: 'terminal', // All nodes use the TerminalNode component (Agent 4)
    position,
    data,
    // Default size for freshly-created nodes. `mergeNodes` in App.svelte
    // spreads the previous node over the freshly-built one, so NodeResizer-
    // driven updates to width/height persist across reactive graph rebuilds.
    // Keeping these as discrete numeric props (not a `style` string with
    // hardcoded width/height) lets NodeResizer author the DOM size cleanly.
    width: preferredSize?.width ?? 760,
    height: preferredSize?.height ?? 620,
  };
}

function makeBrowserNode(
  context: BrowserContext,
  tabs: BrowserTab[],
  snapshots: BrowserSnapshot[],
  opts: MakeBrowserNodeOpts,
): XYFlowNode {
  const nodeId = `browser:${context.id}`;
  const activeTab = tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
  const label = activeTab?.title?.trim() || activeTab?.url?.trim() || context.startUrl || 'Browser';
  const data: SwarmNodeData = {
    nodeType: 'browser',
    instance: null,
    ptySession: null,
    label,
    status: context.status === 'open' ? 'online' : 'offline',
    locks: [],
    assignedTasks: [],
    requestedTasks: [],
    unreadMessages: 0,
    listenerHealth: {
      status: context.status === 'open' ? 'listening' : 'offline',
      label: context.status === 'open' ? 'Managed' : 'Closed',
      detail: activeTab?.url ?? context.startUrl,
      lastPollAt: null,
      lastWaitAt: null,
      lastWaitReturnAt: null,
      unreadMessages: 0,
      activeTaskCount: 0,
    },
    agentDisplay: {
      name: 'Browser',
      role: 'browser',
      provider: 'chrome',
      persona: null,
      mission: activeTab?.url ?? context.startUrl,
      skills: '',
      permissions: 'managed',
      taskCount: 0,
      lockCount: 0,
      unreadMessages: 0,
      listenerLabel: context.status,
    },
    project: null,
    displayName: 'Browser',
    mobileControlled: false,
    mobileLeaseHolder: null,
    browserContext: context,
    browserTabs: tabs,
    browserSnapshots: snapshots,
    appSurface: null,
  };

  return {
    id: nodeId,
    type: 'browser',
    position: resolvePosition(nodeId, opts.savedLayout, opts.autoIndex),
    data,
    width: 560,
    height: 420,
  };
}

function makeAppSurfaceNode(
  surface: CanvasAppSurface,
  opts: MakeBrowserNodeOpts,
): XYFlowNode {
  const nodeId = `app:${surface.id}`;
  const data: SwarmNodeData = {
    nodeType: 'app',
    instance: null,
    ptySession: null,
    label: surface.name,
    status: surface.status === 'closed' ? 'offline' : 'online',
    locks: [],
    assignedTasks: [],
    requestedTasks: [],
    unreadMessages: 0,
    listenerHealth: {
      status: surface.status === 'closed' ? 'offline' : 'listening',
      label: surface.status === 'closed' ? 'Closed' : 'Canvas app',
      detail: surface.detail,
      lastPollAt: null,
      lastWaitAt: null,
      lastWaitReturnAt: null,
      unreadMessages: 0,
      activeTaskCount: 0,
    },
    agentDisplay: {
      name: surface.name,
      role: 'app',
      provider: surface.appId,
      persona: null,
      mission: surface.detail,
      skills: '',
      permissions: 'operator-visible',
      taskCount: 0,
      lockCount: 0,
      unreadMessages: 0,
      listenerLabel: surface.status,
    },
    project: null,
    displayName: surface.name,
    mobileControlled: false,
    mobileLeaseHolder: null,
    browserContext: null,
    browserTabs: [],
    browserSnapshots: [],
    appSurface: surface,
  };

  return {
    id: nodeId,
    type: 'appSurface',
    position: resolvePosition(nodeId, opts.savedLayout, opts.autoIndex),
    data,
    width: 380,
    height: 240,
  };
}

function makeMissionNode(
  mission: CanvasMission,
  opts: MakeBrowserNodeOpts,
): XYFlowNode {
  const nodeId = `mission:${mission.projectId}`;
  const data: SwarmNodeData = {
    nodeType: 'mission',
    instance: null,
    ptySession: null,
    label: mission.title,
    status: mission.status === 'paused' || mission.status === 'archived' ? 'offline' : 'online',
    locks: [],
    assignedTasks: mission.tasks,
    requestedTasks: [],
    unreadMessages: 0,
    listenerHealth: {
      status: mission.status === 'active' ? 'listening' : 'offline',
      label: mission.status === 'active' ? 'Mission live' : mission.status,
      detail: mission.summary,
      lastPollAt: null,
      lastWaitAt: null,
      lastWaitReturnAt: null,
      unreadMessages: 0,
      activeTaskCount: mission.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress').length,
    },
    agentDisplay: {
      name: mission.title,
      role: 'mission',
      provider: 'swarm-ui',
      persona: null,
      mission: mission.summary,
      skills: '',
      permissions: 'operator',
      taskCount: mission.tasks.length,
      lockCount: 0,
      unreadMessages: 0,
      listenerLabel: mission.status,
    },
    project: mission.color
      ? { id: mission.projectId, name: mission.title, color: mission.color }
      : null,
    displayName: mission.title,
    mobileControlled: false,
    mobileLeaseHolder: null,
    browserContext: null,
    browserTabs: [],
    browserSnapshots: [],
    appSurface: null,
    mission,
  };

  return {
    id: nodeId,
    type: 'mission',
    position: resolvePosition(nodeId, opts.savedLayout, opts.autoIndex),
    data,
    width: 600,
    height: 500,
  };
}

function isMobileControlledPty(pty: PtySession | null): boolean {
  return typeof pty?.lease?.holder === 'string' && pty.lease.holder.startsWith('device:');
}

function derivePreferredNodeSize(
  nodeType: 'instance' | 'pty' | 'bound',
  pty: PtySession | null,
): { width: number; height: number } | null {
  if (!pty || nodeType === 'instance' || !isMobileControlledPty(pty)) {
    return null;
  }

  // PTYs have one logical viewport. When a phone owns the lease, mirror that
  // tighter geometry in the desktop graph so the card clearly reads as a
  // mobile-shaped remote viewport instead of a desktop-sized terminal.
  const width = clamp(Math.round(pty.cols * 9 + 56), 360, 520);
  const height = clamp(Math.round(pty.rows * 18 + 92), 320, 820);
  return { width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function deriveDisplayName(instance: Instance | null): string | null {
  if (!instance?.label) return null;
  for (const token of instance.label.split(/\s+/)) {
    if (token.startsWith('name:')) {
      const value = token.slice('name:'.length);
      if (value) return value;
    }
  }
  return null;
}

function deriveStatus(
  nodeType: 'instance' | 'pty' | 'bound',
  instance: Instance | null,
  pty: PtySession | null,
): 'online' | 'stale' | 'offline' | 'pending' {
  if (instance) return instance.status;
  if (nodeType === 'pty') {
    if (pty?.bound_instance_id) return 'pending';
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
