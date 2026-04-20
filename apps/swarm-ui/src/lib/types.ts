// =============================================================================
// types.ts — UI-specific TypeScript types
//
// Shared swarm protocol types are generated from `crates/swarm-protocol` into
// `./generated/protocol.ts`. This file keeps only the frontend-specific graph,
// terminal, and UI payload types layered on top of that shared model.
// =============================================================================

import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte';
import type {
  Annotation,
  Event,
  Instance,
  InstanceStatus,
  KvEntry,
  Lock,
  Message,
  Task,
  TaskStatus,
  TaskType,
} from './generated/protocol';

export type {
  Annotation,
  Event,
  Instance,
  InstanceStatus,
  KvEntry,
  Lock,
  Message,
  Task,
  TaskStatus,
  TaskType,
} from './generated/protocol';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type NodeType = 'instance' | 'pty' | 'bound';

export type EdgeType = 'connection';

export interface PtyLease {
  holder: string;
  acquired_at: number;
  generation: number;
}

export interface PtySession {
  id: string;
  command: string;
  cwd: string;
  started_at: number;
  exit_code: number | null;
  bound_instance_id: string | null;
  launch_token: string | null;
  cols: number;
  rows: number;
  lease: PtyLease | null;
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  platform: string | null;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface PairingSessionInfo {
  session_id: string;
  host: string;
  port: number;
  cert_fingerprint: string;
  code: string;
  pairing_secret: string;
  expires_at: number;
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
  annotations: Annotation[];
  kv: KvEntry[];
  events: Event[];
  ui_meta: Record<string, unknown> | null;
}

/** Returned by `get_binding_state` */
export interface BindingState {
  /** [token, pty_id] pairs not yet matched to an instance */
  pending: [string, string][];
  /** [instance_id, pty_id] pairs that have been matched */
  resolved: [string, string][];
}

/** Returned by `spawn_shell` */
export interface ShellSpawnResult {
  pty_id: string;
  /**
   * Present only for swarm-aware harness launches (claude/codex/opencode).
   * Plain shells have no swarm identity.
   */
  instance_id: string | null;
  /**
   * Echo of the swarm role, when one was selected. The UI can surface it, but
   * role guidance itself comes from the explicit `swarm.register` response.
   */
  role: string | null;
}

/**
 * Returned by `respawn_instance`. Carries the harness name
 * (claude/codex/opencode) so the frontend can auto-type it into the new PTY,
 * matching the launch ergonomics (ctrl-c returns to a shell prompt instead
 * of killing the node).
 */
export interface RespawnResult {
  pty_id: string;
  token: string | null;
  instance_id: string;
  harness: string | null;
  role: string | null;
}

/** Returned by `get_role_presets` — list of role names available in the picker. */
export interface RolePresetSummary {
  role: string;
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
  /**
   * Optional human-friendly identifier extracted from the swarm label's
   * `name:<value>` token. When set, the node header shows this in place of
   * the instance UUID prefix.
   */
  displayName: string | null;
  /** True when a paired mobile device currently owns this PTY's interactive lease. */
  mobileControlled: boolean;
  /** Lease holder string such as `local:swarm-ui` or `device:abc123`. */
  mobileLeaseHolder: string | null;
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
  refit: () => void;
  getSize: () => { cols: number; rows: number };
  setViewportSize: (cols: number, rows: number) => void;
  clearViewportSize: () => void;
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
