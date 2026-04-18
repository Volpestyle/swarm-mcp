// =============================================================================
// types.ts — TypeScript types mirroring Rust models (Agent 1: model.rs)
//
// These types represent the serialized shapes emitted by the Tauri backend.
// Field names use snake_case to match Rust serde output directly.
// =============================================================================

import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Derived from heartbeat freshness: online <= 30s, stale 30-60s, offline > 60s */
export type InstanceStatus = 'online' | 'stale' | 'offline';

export type TaskStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'approval_required';

export type TaskType =
  | 'review'
  | 'implement'
  | 'fix'
  | 'test'
  | 'research'
  | 'other';

export type NodeType = 'instance' | 'pty' | 'bound';

export type EdgeType = 'connection';

// ---------------------------------------------------------------------------
// Data models  (match Rust Serialize output 1:1)
// ---------------------------------------------------------------------------

export interface Instance {
  id: string;
  scope: string;
  directory: string;
  root: string;
  file_root: string;
  pid: number;
  label: string | null;
  registered_at: number;
  heartbeat: number;
  status: InstanceStatus;
  /**
   * `true` once the child process inside the PTY has called `swarm.register`
   * and taken over the instance row. `false` while the row is still a
   * UI-owned placeholder waiting for adoption.
   */
  adopted: boolean;
}

export interface Task {
  id: string;
  scope: string;
  type: TaskType;
  title: string;
  description: string | null;
  requester: string;
  assignee: string | null;
  status: TaskStatus;
  files: string[];
  result: string | null;
  created_at: number;
  updated_at: number;
  changed_at: number;
  priority: number;
  depends_on: string[];
  parent_task_id: string | null;
}

export interface Message {
  id: number;
  scope: string;
  sender: string;
  recipient: string | null;
  content: string;
  created_at: number;
  read: boolean;
}

export interface Lock {
  scope: string;
  file: string;
  instance_id: string;
}

export interface PtySession {
  id: string;
  command: string;
  cwd: string;
  started_at: number;
  exit_code: number | null;
  bound_instance_id: string | null;
  launch_token: string | null;
}

// ---------------------------------------------------------------------------
// Payloads — shapes returned by Tauri commands / events
// ---------------------------------------------------------------------------

/** Emitted on `swarm:update` events and returned by `get_swarm_state` */
export interface SwarmUpdate {
  instances: Instance[];
  tasks: Task[];
  messages: Message[];
  locks: Lock[];
  ui_meta: Record<string, unknown> | null;
}

/** Returned by `get_binding_state` */
export interface BindingState {
  /** [token, pty_id] pairs not yet matched to an instance */
  pending: [string, string][];
  /** [instance_id, pty_id] pairs that have been matched */
  resolved: [string, string][];
}

/** Returned by `agent_spawn` */
export interface LaunchResult {
  pty_id: string;
  token: string;
  /**
   * Pre-created swarm instance id bound to the spawned PTY. The child
   * adopts this row via `SWARM_MCP_INSTANCE_ID` on `swarm.register`.
   */
  instance_id: string;
}

/** Returned by `spawn_shell` */
export interface ShellSpawnResult {
  pty_id: string;
  /**
   * Present only for swarm-aware harness launches (claude/codex/opencode),
   * which go through the same pre-create + adopt flow as `agent_spawn`.
   * Plain shells have no swarm identity.
   */
  instance_id: string | null;
}

/**
 * Returned by `respawn_instance`. Mirrors `LaunchResult` but also carries the
 * harness name (claude/codex/opencode) when the respawned instance was a
 * swarm-aware shell — the frontend auto-types this command into the new PTY
 * so ctrl-c drops back to a shell prompt instead of killing the node.
 */
export interface RespawnResult {
  pty_id: string;
  token: string;
  instance_id: string;
  harness: string | null;
}

/** Returned by `get_role_presets` */
export interface RolePresetSummary {
  role: string;
  command: string;
  args: string[];
  default_label_tokens: string;
}

/** Payload on `pty://{id}/exit` events — Rust emits Option<i32> directly */
export type PtyExitPayload = number | null;

// ---------------------------------------------------------------------------
// Graph types — used by graph.ts and consumed by Agent 4 Svelte components
// ---------------------------------------------------------------------------

export interface Position {
  x: number;
  y: number;
}

export interface SwarmNode {
  id: string;
  type: NodeType;
  instance: Instance | null;
  pty_session: PtySession | null;
  position: Position | null;
}

export interface SwarmEdge {
  id: string;
  type: EdgeType;
  source: string;
  target: string;
  data: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// XYFlow adapter types
// ---------------------------------------------------------------------------

/** Node shape expected by @xyflow/svelte */
export type XYFlowNode = FlowNode<SwarmNodeData, 'terminal'>;

/** Data payload carried by each XYFlow node */
export type SwarmNodeData = Record<string, unknown> & {
  nodeType: NodeType;
  instance: Instance | null;
  ptySession: PtySession | null;
  label: string;
  status: InstanceStatus | 'pending';
  /** Locks held by this instance */
  locks: Lock[];
  /** Tasks assigned to this instance */
  assignedTasks: Task[];
  /** Tasks requested by this instance */
  requestedTasks: Task[];
};

/**
 * Unified connection edge — one visual edge per unordered instance pair
 * carrying everything we know about that relationship: message history,
 * shared tasks, and task-level dependencies.
 *
 * `sourceInstanceId` / `targetInstanceId` are the canonical endpoints for
 * this unordered pair (lexical min = source, max = target) so the bezier
 * is stable across renders and the packet renderer can route individual
 * messages in the correct direction along the same curve.
 */
export type ConnectionEdgeData = Record<string, unknown> & {
  edgeType: 'connection';
  sourceInstanceId: string;
  targetInstanceId: string;
  messages: Message[];
  tasks: Task[];
  deps: ConnectionDep[];
};

export interface ConnectionDep {
  dependencyTaskId: string;
  dependentTaskId: string;
  satisfied: boolean;
}

/** Edge shape expected by @xyflow/svelte */
export type XYFlowEdge = FlowEdge<ConnectionEdgeData, EdgeType>;

// ---------------------------------------------------------------------------
// Terminal types — used by terminal.ts
// ---------------------------------------------------------------------------

export interface TerminalOptions {
  fontSize?: number;
  fontFamily?: string;
  theme?: TerminalTheme;
}

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalHandle {
  id: string;
  write: (data: Uint8Array | string) => void;
  resize: (cols: number, rows: number) => void;
  focus: () => void;
  dispose: () => void;
  onData: (cb: (data: string) => void) => () => void;
  onResize: (cb: (size: { cols: number; rows: number }) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Saved layout types — for KV persistence under ui/layout/{scope}
// ---------------------------------------------------------------------------

export interface SavedLayout {
  nodes: Record<string, Position>;
}

export interface UIConfig {
  autoLayout: boolean;
  pollInterval: number;
  theme: string;
}

export interface UIInstanceMeta {
  color: string | null;
  group: string | null;
  collapsed: boolean;
}
