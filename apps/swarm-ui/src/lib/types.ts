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

export type UsageConfidence = 'exact' | 'estimated' | 'unlinked' | 'na';

export type KillTarget =
  | { kind: 'bound_instance'; instance_id: string }
  | { kind: 'orphan_pty_session'; pty_id: string }
  | { kind: 'terminal_process_group'; pgid: number; root_pid: number | null }
  | { kind: 'detached_mcp_process_set'; pids: number[]; label: string };

export interface UsageAttribution {
  source_kind: string;
  source_ref: string | null;
  session_id: string | null;
  thread_id: string | null;
  link_basis: string | null;
}

export interface AgentSessionRow {
  session_key: string;
  session_kind: string;
  session_label: string;
  root_pid: number | null;
  process_group_id: number | null;
  child_pids: number[];
  tty: string | null;
  pty_id: string | null;
  instance_id: string | null;
  scope: string | null;
  cwd: string | null;
  provider: string | null;
  harness: string | null;
  model: string | null;
  started_at: number | null;
  elapsed_seconds: number | null;
  cpu_percent: number;
  rss_kb: number;
  status: string;
  activity: string;
  helper_count: number;
  tokensExact: number | null;
  tokensEstimated: number | null;
  costExactUsd: number | null;
  costEstimatedUsd: number | null;
  usageConfidence: UsageConfidence;
  costConfidence: UsageConfidence;
  usageAttribution: UsageAttribution | null;
  killable: boolean;
  killProtectionReason: string | null;
  killTarget: KillTarget;
}

export interface HelperProcessRow {
  helper_key: string;
  helper_kind: string;
  label: string;
  pid: number;
  pids: number[];
  parent_session_key: string | null;
  tty: string | null;
  scope: string | null;
  command: string;
  started_at: number;
  elapsed_seconds: number;
  cpu_percent: number;
  rss_kb: number;
  killable: boolean;
  killProtectionReason: string | null;
  killTarget: KillTarget | null;
}

export interface ExternalProcessRow {
  external_key: string;
  label: string;
  pid: number;
  process_group_id: number;
  tty: string | null;
  command: string;
  started_at: number;
  elapsed_seconds: number;
  cpu_percent: number;
  rss_kb: number;
  note: string;
}

export interface SystemLoadSnapshot {
  scanned_at_ms: number;
  scope: string | null;
  price_catalog_as_of: string | null;
  total_agent_sessions: number;
  hidden_orphan_sessions: number;
  detached_helper_count: number;
  estimated_live_cost_usd: number | null;
  gpu_note: string;
  top_cpu_label: string | null;
  top_cpu_percent: number | null;
  top_memory_label: string | null;
  top_memory_rss_kb: number | null;
  agent_sessions: AgentSessionRow[];
  helper_processes: HelperProcessRow[];
  external_burden: ExternalProcessRow[];
}

export interface KillResult {
  target_label: string;
  terminated_pids: number[];
  closed_ptys: string[];
  deregistered_instances: string[];
  skipped_pids: number[];
  note: string | null;
}

export interface KillSummary {
  session_trees_killed: number;
  helper_sets_killed: number;
  terminated_pids: number[];
  closed_ptys: string[];
  deregistered_instances: string[];
  skipped_targets: number;
}

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
  setTheme: (theme: TerminalTheme) => void;
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

export type ThemeProfileId =
  | 'tron-encom-os'
  | 'ghostty-dark'
  | 'solar-dusk'
  | 'arctic-console'
  | 'operator-amber';

/**
 * Encom-only chrome tokens for the "Tron Encom OS" theme.
 *
 * These augment the standard `ThemeAppearance` block with the white-LED
 * vocabulary the mock relies on (hairline strokes, halo box-shadows,
 * pure-black bases). They are surfaced as CSS custom properties on
 * `:root` only when the active profile carries this block, so the four
 * legacy themes are completely unaffected. See `appearance.ts` and the
 * `[data-theme="tron-encom-os"]` CSS scope in `app.css`.
 */
export interface EncomChrome {
  /** Default hairline — bright white. Maps to --led-line. */
  ledLine: string;
  /** Passive / soft hairline. Maps to --led-line-s. */
  ledLineSoft: string;
  /** Active / focus hairline — pure white. Maps to --led-line-x. */
  ledLineBright: string;
  /** Default halo (multi-layer outer glow + inset 1px). Maps to --led-halo. */
  ledHalo: string;
  /** Brighter halo for active/focused surfaces. Maps to --led-halo-x. */
  ledHaloBright: string;
  /** Text glow for headings and accent labels. Maps to --glow. */
  glow: string;
  /** Soft text glow used on most labels. Maps to --glow-s. */
  glowSoft: string;
  /** Pure black canvas. Maps to --bg-base. */
  bgBase: string;
  /** Panel/card surface (near-black). Maps to --bg-panel. */
  bgPanel: string;
  /** Elevated surface (slightly lighter). Maps to --bg-elevated. */
  bgElevated: string;
  /** Input field background. Maps to --bg-input. */
  bgInput: string;
  /** Primary foreground text. Maps to --fg-primary. */
  fgPrimary: string;
  /** Secondary foreground text. Maps to --fg-secondary. */
  fgSecondary: string;
  /** Muted foreground text. Maps to --fg-muted. */
  fgMuted: string;
  /** Dimmest foreground text (rarely seen). Maps to --fg-dim. */
  fgDim: string;
  /** Single accent color — warm white per the mock. Maps to --accent. */
  accent: string;
  /** Dimmer accent for secondary HUD readouts. Maps to --accent-dim. */
  accentDim: string;
  /** Sparingly used non-white accents — only on category chips/icons. */
  accentAmber: string;
  accentRed: string;
  accentViolet: string;
  /** "Tron green" — reserved for strong operator actions and imagery. */
  accentTron: string;
  /** Color of the radial-dot grid behind everything. Maps to --grid-color. */
  gridColor: string;
}

export interface ThemeAppearance {
  defaultBackgroundOpacity: number;
  canvasRgb: [number, number, number];
  panelRgb: [number, number, number];
  sidebarRgb: [number, number, number];
  nodeRgb: [number, number, number];
  nodeHeaderRgb: [number, number, number];
  nodeBorderRgb: [number, number, number];
  nodeBorderSelected: string;
  nodeBorderMobile: string;
  nodeTitleFg: string;
  nodeStatusMuted: string;
  nodeStatusMutedDot: string;
  statusOnline: string;
  statusStale: string;
  statusOffline: string;
  statusPending: string;
  edgeTaskOpen: string;
  edgeTaskInProgress: string;
  edgeTaskDone: string;
  edgeTaskFailed: string;
  edgeTaskCancelled: string;
  edgeMessage: string;
  edgeDepBlocked: string;
  edgeDepSatisfied: string;
  badgePlanner: string;
  badgeImplementer: string;
  badgeReviewer: string;
  badgeResearcher: string;
  badgeShell: string;
  badgeCustom: string;
}

export interface ThemeProfile {
  id: ThemeProfileId;
  name: string;
  description: string;
  appearance: ThemeAppearance;
  terminal: Required<TerminalTheme>;
  /**
   * Optional extra chrome tokens. Currently only Encom carries this — the
   * four legacy themes leave it undefined and the appearance store skips
   * applying the Encom-only CSS vars. Keeping it optional means we can add
   * a second "chrome family" later (e.g. CRT, brutalist) without churning
   * every existing profile.
   */
  chrome?: EncomChrome;
}

export interface StartupLaunchDefaults {
  harness: string;
  role: string;
  scope: string;
}

export interface StartupPreferences {
  recentDirectories: string[];
  selectedDirectory: string;
  launchDefaults: StartupLaunchDefaults;
  themeProfileId: ThemeProfileId;
  backgroundOpacityOverride: number | null;
}

export interface AgentProfileDraft {
  name: string;
  workingDirectory: string;
  harness: string;
  role: string;
  scope: string;
  nodeName: string;
  label: string;
  mission: string;
  persona: string;
  specialty: string;
  skills: string;
  context: string;
  memory: string;
  permissions: string;
  launchCommand: string;
  customInstructions: string;
}

export interface AgentProfile extends AgentProfileDraft {
  id: string;
  updatedAt: number;
}

export type RecoverySessionAction =
  | 'open_scope'
  | 'respawn'
  | 'remove'
  | 'cleanup_orphan';

export type RecoverySessionStatus =
  | 'adopting'
  | 'online'
  | 'stale'
  | 'offline';

export interface RecoverySessionItem {
  id: string;
  scope: string;
  directory: string;
  label: string | null;
  displayName: string | null;
  harness: string | null;
  adopted: boolean;
  status: RecoverySessionStatus;
  action: RecoverySessionAction;
  boundPtyId: string | null;
}

export interface RecoveryScopeSummary {
  scope: string;
  layoutNodeCount: number;
  sessionCount: number;
  liveCount: number;
  staleCount: number;
  offlineCount: number;
  adoptingCount: number;
  layoutOnly: boolean;
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
