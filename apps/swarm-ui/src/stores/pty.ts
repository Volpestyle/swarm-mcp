// =============================================================================
// stores/pty.ts — Svelte stores for PTY session state
//
// Manages the lifecycle of local PTY sessions and the binding state between
// PTYs and swarm instances.
//
// Architecture rules:
// - PTY data events (byte streams) are NOT stored here. They flow directly
//   from Tauri events into terminal.write() via per-session subscriptions.
// - This store tracks PTY metadata (session info, exit codes, binding state).
// - The byte stream subscription functions return unlisteners for cleanup.
// =============================================================================

import { writable, derived, get, type Readable } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type {
  KillResult,
  KillSummary,
  KillTarget,
  PtySession,
  BindingState,
  ShellSpawnResult,
  RespawnResult,
  PtyExitPayload,
  RolePresetSummary,
  SystemLoadSnapshot,
} from '../lib/types';
import { buildBootstrapPrompt } from '../lib/bootstrapPrompt';
import { buildHarnessLabel, withCodexMcpEnv } from '../lib/codexLaunchCommand';
import {
  formatLaunchPreflightFailure,
  preflightLaunchCommand,
  type LaunchCommandPreflight,
} from '../lib/launchPreflight';
import { reconcilePtyCatalog } from '../lib/ptyCatalog';
import { removeInstancesFromLocalState } from './swarm';
import { resolveHarnessCommand } from './harnessAliases';

const HARNESS_AUTOTYPE_MIN_DELAY_MS = 200;
const PTY_READY_TIMEOUT_MS = 1500;
const SWARM_BOOTSTRAP_DELAY_MS = 1400;
export const LOCAL_PTY_LEASE_HOLDER = 'local:swarm-ui';

function isMissingInstanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /instance .+ not found/i.test(message);
}

function dropInstanceBindings(instanceIds: Iterable<string>): void {
  const targets = new Set([...instanceIds].map((id) => id.trim()).filter(Boolean));
  if (targets.size === 0) return;
  bindings.update((state) => ({
    pending: state.pending,
    resolved: state.resolved.filter(([id]) => !targets.has(id)),
  }));
}

type ReadyGate = {
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

const ptyReadyGates = new Map<string, ReadyGate>();

type SwarmMcpServerConfig = {
  command: string;
  args: string[];
  source: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createReadyGate(): ReadyGate {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    ready: false,
    promise,
    resolve: () => {
      if (resolvePromise) {
        resolvePromise();
        resolvePromise = null;
      }
    },
  };
}

function readyGateForPty(ptyId: string): ReadyGate {
  let gate = ptyReadyGates.get(ptyId);
  if (!gate) {
    gate = createReadyGate();
    ptyReadyGates.set(ptyId, gate);
  }
  return gate;
}

async function waitForPtyTerminalReady(ptyId: string): Promise<void> {
  const gate = readyGateForPty(ptyId);
  if (gate.ready) return;

  await Promise.race([gate.promise, delay(PTY_READY_TIMEOUT_MS)]);
}

async function autoTypeCommandWhenReady(
  ptyId: string,
  command: string,
): Promise<void> {
  await Promise.all([
    waitForPtyTerminalReady(ptyId),
    delay(HARNESS_AUTOTYPE_MIN_DELAY_MS),
  ]);

  const encoded = new TextEncoder().encode(`${command}\n`);
  await writeToPty(ptyId, encoded);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

async function codexLaunchScriptCommand(
  instanceId: string | null,
  launchCommand: string,
): Promise<string> {
  if (!instanceId) return launchCommand;
  const scriptPath = await invoke<string>('ui_write_codex_launch_script', {
    instanceId,
    command: launchCommand,
  });
  return `printf '\\033[3J\\033[2J\\033[H'; zsh ${shellQuote(scriptPath)}`;
}

async function resolveSwarmMcpServer(
  cwd: string,
  scope: string | null,
): Promise<SwarmMcpServerConfig> {
  return invoke<SwarmMcpServerConfig>('ui_resolve_swarm_mcp_server', {
    cwd,
    scope,
  });
}

async function autoBootstrapHarnessAfterCommand(
  ptyId: string,
  cwd: string,
  scope: string | null,
  role: string | null,
  label: string | null,
  bootstrapInstructions: string | null,
): Promise<void> {
  await delay(SWARM_BOOTSTRAP_DELAY_MS);

  const prompt = buildBootstrapPrompt({
    cwd,
    scope,
    role,
    label,
    bootstrapInstructions,
  });
  const encoded = new TextEncoder().encode(`${prompt}\n`);
  await writeToPty(ptyId, encoded);
}

export function markPtyTerminalReady(ptyId: string): void {
  const gate = readyGateForPty(ptyId);
  if (gate.ready) return;
  gate.ready = true;
  gate.resolve();
}

function clearPtyTerminalReady(ptyId: string): void {
  ptyReadyGates.delete(ptyId);
}

function upsertSession(session: PtySession): void {
  ptySessions.update((map) => {
    const next = new Map(map);
    next.set(session.id, { ...next.get(session.id), ...session });
    return next;
  });
}

function patchSession(id: string, patch: Partial<PtySession>): void {
  ptySessions.update((map) => {
    const current = map.get(id);
    if (!current) {
      return map;
    }

    const next = new Map(map);
    next.set(id, { ...current, ...patch });
    return next;
  });
}

export function isMobileLeaseHolder(holder: string | null | undefined): boolean {
  return typeof holder === 'string' && holder.startsWith('device:');
}

export function isMobileControlledSession(
  session: PtySession | null | undefined,
): boolean {
  return isMobileLeaseHolder(session?.lease?.holder);
}

export function getPtySessionSnapshot(id: string): PtySession | null {
  return get(ptySessions).get(id) ?? null;
}

function addPendingBinding(token: string, ptyId: string): void {
  if (!token) {
    return;
  }

  bindings.update((state) => {
    if (
      state.pending.some(
        ([existingToken, existingPtyId]) =>
          existingToken === token && existingPtyId === ptyId,
      )
    ) {
      return state;
    }

    return {
      ...state,
      pending: [...state.pending, [token, ptyId]],
    };
  });
}

function resolveBinding(instanceId: string, ptyId: string): void {
  bindings.update((state) => ({
    pending: state.pending.filter(([, pendingPtyId]) => pendingPtyId !== ptyId),
    resolved: state.resolved.some(
      ([existingInstanceId, existingPtyId]) =>
        existingInstanceId === instanceId && existingPtyId === ptyId,
    )
      ? state.resolved
      : [...state.resolved, [instanceId, ptyId]],
  }));
}

function removeBindingForPty(ptyId: string): void {
  bindings.update((state) => ({
    pending: state.pending.filter(([, pendingPtyId]) => pendingPtyId !== ptyId),
    resolved: state.resolved.filter(([, resolvedPtyId]) => resolvedPtyId !== ptyId),
  }));
}

// ---------------------------------------------------------------------------
// Core stores
// ---------------------------------------------------------------------------

/** All PTY sessions indexed by ID */
export const ptySessions = writable<Map<string, PtySession>>(new Map());

/** Current binding state between PTYs and swarm instances */
export const bindings = writable<BindingState>({ pending: [], resolved: [] });

// ---------------------------------------------------------------------------
// Derived stores
// ---------------------------------------------------------------------------

/** PTY sessions that are not yet bound to a swarm instance */
export const unboundPtySessions: Readable<PtySession[]> = derived(
  [ptySessions, bindings],
  ([$ptySessions, $bindings]) => {
    const resolvedPtyIds = new Set($bindings.resolved.map(([, ptyId]) => ptyId));
    const unbound: PtySession[] = [];
    for (const pty of $ptySessions.values()) {
      if (!resolvedPtyIds.has(pty.id)) {
        unbound.push(pty);
      }
    }
    return unbound;
  },
);

/** Count of pending (unbound) PTY sessions */
export const pendingPtyCount: Readable<number> = derived(
  bindings,
  ($bindings) => $bindings.pending.length,
);

/** PTY sessions that have exited (have an exit code) */
export const exitedPtySessions: Readable<PtySession[]> = derived(
  ptySessions,
  ($ptySessions) => {
    const exited: PtySession[] = [];
    for (const pty of $ptySessions.values()) {
      if (pty.exit_code !== null) exited.push(pty);
    }
    return exited;
  },
);

// ---------------------------------------------------------------------------
// PTY byte stream subscriptions (hot path — NOT stored)
// ---------------------------------------------------------------------------

/**
 * Subscribe to PTY output data events for a specific session.
 *
 * Data flows directly into the callback (typically terminal.write()) without
 * going through any store. This is the performance-critical path.
 *
 * Returns an unlisten function. Call it on component destroy.
 */
export async function subscribeToPty(
  ptyId: string,
  onData: (data: Uint8Array) => void,
): Promise<UnlistenFn> {
  const eventName = `pty://${ptyId}/data`;
  return listen<number[]>(eventName, (event) => {
    // Tauri serializes Vec<u8> as number[]; convert to Uint8Array
    onData(new Uint8Array(event.payload));
  });
}

/**
 * Subscribe to PTY exit events for a specific session.
 *
 * Returns an unlisten function. Call it on component destroy.
 */
export async function subscribeToPtyExit(
  ptyId: string,
  onExit: (code: number | null) => void,
): Promise<UnlistenFn> {
  const eventName = `pty://${ptyId}/exit`;
  return listen<PtyExitPayload>(eventName, (event) => {
    // Rust emits Option<i32> directly (number | null), not wrapped in an object
    const exitCode = event.payload;

    // Update the session store with the exit code
    patchSession(ptyId, { exit_code: exitCode });
    onExit(exitCode);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle event listeners
// ---------------------------------------------------------------------------

let ptyCreatedUnlisten: UnlistenFn | null = null;
let ptyUpdatedUnlisten: UnlistenFn | null = null;
let ptyClosedUnlisten: UnlistenFn | null = null;
let bindResolvedUnlisten: UnlistenFn | null = null;
let bindUnresolvedUnlisten: UnlistenFn | null = null;
let ptyBoundExitUnlisten: UnlistenFn | null = null;
let initialized = false;

async function fetchPtyCatalogSnapshot(): Promise<{
  bindings: BindingState;
  sessions: PtySession[];
}> {
  const [bindings, sessions] = await Promise.all([
    invoke<BindingState>('get_binding_state'),
    invoke<PtySession[]>('get_pty_sessions'),
  ]);

  return { bindings, sessions };
}

function applyPtyCatalogSnapshot(
  nextBindings: BindingState,
  nextSessions: PtySession[],
): void {
  const reconciled = reconcilePtyCatalog(get(ptySessions), nextBindings, nextSessions);

  for (const removedPtyId of reconciled.removedPtyIds) {
    clearPtyTerminalReady(removedPtyId);
  }

  bindings.set(reconciled.bindings);
  ptySessions.set(reconciled.sessionMap);
}

export async function refreshPtyCatalog(): Promise<void> {
  const snapshot = await fetchPtyCatalogSnapshot();
  applyPtyCatalogSnapshot(snapshot.bindings, snapshot.sessions);
}

/**
 * Initialize PTY store event listeners.
 * Fetches current binding state and subscribes to lifecycle events.
 */
export async function initPtyStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Listen for PTY creation events
  ptyCreatedUnlisten = await listen<PtySession>('pty:created', (event) => {
    upsertSession(event.payload);
  });

  // Listen for PTY metadata updates pushed from the daemon snapshot watcher.
  ptyUpdatedUnlisten = await listen<PtySession>('pty:updated', (event) => {
    upsertSession(event.payload);
  });

  // Listen for PTY closure events
  ptyClosedUnlisten = await listen<string>('pty:closed', (event) => {
    clearPtyTerminalReady(event.payload);
    removeBindingForPty(event.payload);
    ptySessions.update((map) => {
      const next = new Map(map);
      next.delete(event.payload);
      return next;
    });
  });

  // Listen for binding resolution events
  bindResolvedUnlisten = await listen<{
    token: string;
    instance_id: string;
    pty_id: string;
  }>(
    'bind:resolved',
    (event) => {
      const { instance_id, pty_id } = event.payload;

      resolveBinding(instance_id, pty_id);
      patchSession(pty_id, { bound_instance_id: instance_id });
    },
  );

  // `bind:unresolved` is emitted when a launched PTY is still waiting for a
  // swarm instance to register. If a future payload includes `instance_id`,
  // treat it as a true unbind and clear the bound state.
  bindUnresolvedUnlisten = await listen<{
    token?: string;
    pty_id: string;
    instance_id?: string;
  }>(
    'bind:unresolved',
    (event) => {
      const { token, pty_id, instance_id } = event.payload;

      if (instance_id) {
        bindings.update((state) => ({
          pending: state.pending,
          resolved: state.resolved.filter(
            ([resolvedInstanceId, resolvedPtyId]) =>
              !(
                resolvedInstanceId === instance_id &&
                resolvedPtyId === pty_id
              ),
          ),
        }));
        patchSession(pty_id, { bound_instance_id: null });
      }

      addPendingBinding(
        token ?? get(ptySessions).get(pty_id)?.launch_token ?? '',
        pty_id,
      );
    },
  );

  // A bound PTY's child exited. Drop the binding mapping and clear
  // bound_instance_id on the session — the backend has already deleted any
  // unadopted placeholder row from swarm.db. The session itself stays in
  // the map until pty:closed so the exit overlay can render.
  ptyBoundExitUnlisten = await listen<{
    pty_id: string;
    instance_id: string;
  }>('pty:bound_exit', (event) => {
    const { pty_id } = event.payload;
    removeBindingForPty(pty_id);
    patchSession(pty_id, { bound_instance_id: null });
  });

  try {
    await refreshPtyCatalog();
  } catch (err) {
    console.warn('[pty] failed to fetch initial PTY state:', err);
  }
}

/**
 * Tear down PTY store event listeners.
 */
export function destroyPtyStore(): void {
  ptyCreatedUnlisten?.();
  ptyUpdatedUnlisten?.();
  ptyClosedUnlisten?.();
  bindResolvedUnlisten?.();
  bindUnresolvedUnlisten?.();
  ptyBoundExitUnlisten?.();
  ptyCreatedUnlisten = null;
  ptyUpdatedUnlisten = null;
  ptyClosedUnlisten = null;
  bindResolvedUnlisten = null;
  bindUnresolvedUnlisten = null;
  ptyBoundExitUnlisten = null;
  initialized = false;
}

// ---------------------------------------------------------------------------
// Actions — invoke Tauri commands
// ---------------------------------------------------------------------------

/**
 * Write data to a PTY session's stdin.
 */
export async function writeToPty(id: string, data: Uint8Array): Promise<void> {
  await invoke('pty_write', { id, data: Array.from(data) });
}

/**
 * Resize a PTY session.
 */
export async function resizePty(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke('pty_resize', { id, cols, rows });
}

/**
 * Ask the daemon to make this desktop UI the interactive lease holder.
 */
export async function requestPtyLease(
  id: string,
  takeover: boolean = false,
): Promise<void> {
  await invoke('pty_request_lease', { id, takeover });
}

/**
 * Release the desktop UI's interactive lease for a PTY.
 */
export async function releasePtyLease(id: string): Promise<void> {
  await invoke('pty_release_lease', { id });
}

/**
 * Close (kill) a PTY session.
 */
export async function closePty(id: string): Promise<void> {
  await invoke('pty_close', { id });
  clearPtyTerminalReady(id);
  // Optimistic removal (backend will also emit pty:closed)
  removeBindingForPty(id);
  ptySessions.update((map) => {
    const next = new Map(map);
    next.delete(id);
    return next;
  });
}

/**
 * Clear a stale/orphan PTY row from the daemon without presenting it as a
 * process-tree kill. If the daemon no longer knows about the session, refresh
 * the catalog and only surface the error when the PTY still exists locally.
 */
export async function clearStalePtySession(id: string): Promise<void> {
  try {
    await closePty(id);
  } catch (err) {
    try {
      await refreshPtyCatalog();
    } catch (refreshErr) {
      console.warn('[pty] failed to refresh catalog after stale PTY clear:', refreshErr);
    }
    if (get(ptySessions).has(id)) {
      throw err;
    }
  }
}

/**
 * Get the current ring buffer contents for a PTY session.
 * Used for reconnect/remount to replay recent output.
 *
 * The backend returns the snapshot as a raw `tauri::ipc::Response` body
 * rather than a JSON `number[]`, so multi-megabyte buffers deserialize in
 * constant time instead of paying `O(n)` JSON parsing on the main thread.
 */
export async function getPtyBuffer(id: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer>('pty_get_buffer', { id });
  return new Uint8Array(data);
}

export interface SpawnShellOptions {
  harness?: string;
  /**
   * Optional profile-specific command typed into the shell instead of the
   * global harness alias. Useful for per-agent wrappers or permission flags.
   */
  harnessCommand?: string;
  role?: string;
  scope?: string;
  label?: string;
  /**
   * Optional human-friendly identifier shown on the node header. Stored as a
   * `name:<value>` token on the swarm label. Falls back to a slice of the
   * instance UUID when absent.
   */
  name?: string;
  /**
   * Extra operator guidance appended to the auto-typed bootstrap prompt after
   * the harness starts. Used for saved agent profiles and persona/context
   * instructions without expanding the backend launch contract.
   */
  bootstrapInstructions?: string;
  /**
   * Optional preflight result from the caller. When present and matching the
   * command we are about to type, spawnShell reuses it instead of probing the
   * login shell a second time.
   */
  launchPreflight?: LaunchCommandPreflight;
  skipLaunchPreflight?: boolean;
}

/**
 * Spawn a swarm-aware shell. When `harness` is set, the backend pre-creates
 * a swarm instance row, binds it to the PTY, and we auto-type the harness
 * command into the shell so ctrl-c drops back to a shell prompt instead of
 * killing the node.
 *
 * When `role` is also set, the role token is stored on the swarm label. The
 * agent receives the swarm bootstrap prompt immediately after launch. The
 * launch write is awaited so a failed auto-type cannot silently leave the
 * operator staring at an unregistered shell prompt.
 */
export async function spawnShell(
  cwd: string,
  options: SpawnShellOptions = {},
): Promise<ShellSpawnResult> {
  const trimmedHarness = options.harness?.trim() || null;
  const trimmedHarnessCommand = options.harnessCommand?.trim() || null;
  const trimmedRole = options.role?.trim() || null;
  const trimmedScope = options.scope?.trim() || null;
  const trimmedLabel = options.label?.trim() || null;
  const trimmedName = options.name?.trim() || null;
  const trimmedBootstrapInstructions = options.bootstrapInstructions?.trim() || null;
  const launchCommandBase =
    trimmedHarnessCommand || (trimmedHarness ? resolveHarnessCommand(trimmedHarness) : '');

  if (launchCommandBase && !options.skipLaunchPreflight) {
    const launchPreflight = options.launchPreflight?.command.trim() === launchCommandBase
      ? options.launchPreflight
      : await preflightLaunchCommand({
          command: launchCommandBase,
          cwd,
          harness: trimmedHarness,
        });
    if (!launchPreflight.ok) {
      throw new Error(formatLaunchPreflightFailure(launchPreflight));
    }
  }

  const swarmMcpServer = trimmedHarness === 'codex'
    ? await resolveSwarmMcpServer(cwd, trimmedScope)
    : null;

  const result = await invoke<ShellSpawnResult>('spawn_shell', {
    cwd,
    harness: trimmedHarness,
    role: trimmedRole,
    scope: trimmedScope,
    label: trimmedLabel,
    name: trimmedName,
  });

  const session: PtySession = {
    id: result.pty_id,
    command: trimmedHarnessCommand ?? trimmedHarness ?? '$SHELL',
    cwd,
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: null,
    cols: 120,
    rows: 40,
    lease: null,
  };

  upsertSession(session);

  if (result.instance_id) {
    resolveBinding(result.instance_id, result.pty_id);
  }

  const launchLabel = buildHarnessLabel({
    harness: trimmedHarness,
    role: trimmedRole,
    name: trimmedName,
    label: trimmedLabel,
  });
  const bootstrapPrompt = trimmedHarness
    ? buildBootstrapPrompt({
        cwd,
        scope: trimmedScope,
        role: trimmedRole,
        label: launchLabel,
        bootstrapInstructions: trimmedBootstrapInstructions,
      })
    : null;
  const configuredLaunchCommand = trimmedHarness === 'codex'
    ? withCodexMcpEnv(launchCommandBase, {
        instanceId: result.instance_id,
        directory: cwd,
        fileRoot: cwd,
        scope: trimmedScope,
        label: launchLabel,
        initialPrompt: bootstrapPrompt,
        mcpCommand: swarmMcpServer?.command,
        mcpArgs: swarmMcpServer?.args,
        startupMode: 'standby',
      })
    : launchCommandBase;
  const launchCommand = trimmedHarness === 'codex'
    ? await codexLaunchScriptCommand(result.instance_id, configuredLaunchCommand)
    : configuredLaunchCommand;

  try {
    if (launchCommand) {
      await autoTypeCommandWhenReady(result.pty_id, launchCommand);
    }

    if (trimmedHarness && trimmedHarness !== 'codex') {
      await autoBootstrapHarnessAfterCommand(
        result.pty_id,
        cwd,
        trimmedScope,
        trimmedRole,
        launchLabel,
        trimmedBootstrapInstructions,
      );
    }
  } catch (err) {
    try {
      await closePty(result.pty_id);
    } catch (closeErr) {
      console.warn('[pty] failed to close PTY after launch automation failed:', closeErr);
    }
    throw err;
  }

  return result;
}

/**
 * Fetch available role presets from the backend.
 */
export async function getRolePresets(): Promise<RolePresetSummary[]> {
  return invoke<RolePresetSummary[]>('get_role_presets');
}

/**
 * Relaunch a PTY against an existing instance row that went offline when the
 * previous swarm-ui session exited. The new child process adopts the same
 * instance id, keeping task assignments and message history intact.
 *
 * For harness-shell instances (claude/codex/hermes/openclaw/opencode) the result carries the
 * harness name and we auto-type it into the new PTY's stdin, matching the
 * ergonomics of `spawnShell` above. Role guidance still comes from an
 * explicit `swarm.register` call, not a hidden auto-typed prompt.
 */
export async function respawnInstance(instanceId: string): Promise<RespawnResult> {
  const result = await invoke<RespawnResult>('respawn_instance', { instanceId });

  const session: PtySession = {
    id: result.pty_id,
    command: result.harness ?? 'agent',
    cwd: '',
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: result.token,
    cols: 120,
    rows: 40,
    lease: null,
  };

  upsertSession(session);
  resolveBinding(result.instance_id, result.pty_id);

  if (result.harness) {
    void autoTypeCommandWhenReady(
      result.pty_id,
      resolveHarnessCommand(result.harness),
    ).catch((err: unknown) => {
      console.warn('[pty] failed to auto-type harness on respawn:', err);
    });
  }

  return result;
}

export async function respawnInstanceInProject(
  instanceId: string,
  directory: string,
  scope: string | null,
): Promise<RespawnResult> {
  const result = await invoke<RespawnResult>('respawn_instance_in_project', {
    instanceId,
    directory,
    scope,
  });

  const session: PtySession = {
    id: result.pty_id,
    command: result.harness ?? 'agent',
    cwd: directory,
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: result.token,
    cols: 120,
    rows: 40,
    lease: null,
  };

  upsertSession(session);
  resolveBinding(result.instance_id, result.pty_id);

  if (result.harness) {
    void autoTypeCommandWhenReady(
      result.pty_id,
      resolveHarnessCommand(result.harness),
    ).catch((err: unknown) => {
      console.warn('[pty] failed to auto-type harness on project respawn:', err);
    });
  }

  return result;
}

/**
 * Remove a disconnected instance row from swarm.db. Used when the user
 * clicks the trash button on a stale/offline node whose PTY is already
 * gone — e.g., an orphan placeholder left over from a previous UI
 * session, or a child process killed outside the UI.
 */
export async function deregisterInstance(instanceId: string): Promise<void> {
  try {
    await invoke('ui_deregister_instance', { instanceId });
  } catch (err) {
    if (!isMissingInstanceError(err)) throw err;
  }
  // Drop the binder mapping on our side immediately so the bound: node
  // disappears from the graph without waiting for the swarm:update tick.
  dropInstanceBindings([instanceId]);
  removeInstancesFromLocalState([instanceId]);
}

/**
 * Kill the OS process for an instance, then deregister the row. This is the
 * "red icon actually kills" path used by NodeHeader and ConversationPanel —
 * sends SIGTERM to the pid recorded at `swarm.register` time, waits briefly,
 * then SIGKILL if still alive. Unlike `deregisterInstance`, which only drops
 * the swarm row, this tears down the underlying bun/claude/etc. process so
 * externally-spawned agents stop burning tokens.
 *
 * Gate this with a confirm dialog — it's destructive.
 */
export async function killInstance(instanceId: string): Promise<void> {
  try {
    await killSessionTree({
      kind: 'bound_instance',
      instance_id: instanceId,
    });
  } catch (err) {
    if (!isMissingInstanceError(err)) throw err;
    dropInstanceBindings([instanceId]);
    removeInstancesFromLocalState([instanceId]);
  }
}

export async function scanSystemLoad(
  scope: string | null = null,
): Promise<SystemLoadSnapshot> {
  return await invoke<SystemLoadSnapshot>('ui_scan_system_load', { scope });
}

export async function killSessionTree(target: KillTarget): Promise<KillResult> {
  const result = await invoke<KillResult>('ui_kill_session_tree', { target });
  dropKilledBindings(result);
  removeInstancesFromLocalState(result.deregistered_instances);
  try {
    await refreshPtyCatalog();
  } catch (err) {
    console.warn('[pty] failed to refresh PTY catalog after kill:', err);
  }
  return result;
}

export async function killAllAgentSessions(
  scope: string | null = null,
  visibleInstanceIds: Iterable<string> = [],
): Promise<KillSummary> {
  const result = await invoke<KillSummary>('ui_kill_all_agent_sessions', { scope });
  const visibleIds = [...new Set([...visibleInstanceIds].map((id) => id.trim()).filter(Boolean))];
  const locallyRemovedIds = new Set(result.deregistered_instances);
  if (result.skipped_targets === 0) {
    for (const id of visibleIds) locallyRemovedIds.add(id);
  }
  bindings.update((state) => ({
    pending: state.pending.filter(([, ptyId]) => !result.closed_ptys.includes(ptyId)),
    resolved: state.resolved.filter(
      ([instanceId, ptyId]) =>
        !locallyRemovedIds.has(instanceId)
        && !result.closed_ptys.includes(ptyId),
    ),
  }));
  removeInstancesFromLocalState(locallyRemovedIds);
  try {
    await refreshPtyCatalog();
  } catch (err) {
    console.warn('[pty] failed to refresh PTY catalog after kill-all:', err);
  }
  return result;
}

export async function killPtySession(ptyId: string): Promise<KillResult> {
  return await killSessionTree({
    kind: 'orphan_pty_session',
    pty_id: ptyId,
  });
}

/**
 * Broadcast an operator-authored message to every agent in `scope`. Writes one
 * message row per recipient and emits a `message.broadcast` event so the
 * ConnectionEdge animations pulse. Returns the number of recipients the message
 * landed in. Zero means the scope is empty (no agents registered).
 */
export async function broadcastOperatorMessage(
  scope: string,
  content: string,
): Promise<number> {
  return await invoke<number>('ui_broadcast_message', { scope, content });
}

/**
 * Send an operator-authored direct message to one registered agent in `scope`.
 * Returns `false` when the recipient disappeared before the backend write.
 */
export async function sendOperatorMessage(
  scope: string,
  recipient: string,
  content: string,
): Promise<boolean> {
  return await invoke<boolean>('ui_send_message', { scope, recipient, content });
}

/**
 * Fan out a Ctrl-C (soft interrupt) to every bound PTY in `scope`. Used by the
 * Conversation panel's "Stop" button. Only PTYs owned by this UI session are
 * signalled — externally adopted instances the UI never bound to are skipped.
 * Returns the count of PTYs that received the interrupt.
 */
export async function sendScopeSigint(scope: string): Promise<number> {
  return await invoke<number>('ui_send_sigint_scope', { scope });
}

/**
 * Force-deregister an instance the user has explicitly told us to nuke.
 *
 * Unlike `deregisterInstance`, this bypasses the gentle policy checks the
 * server applies to the standard path:
 *   - The server best-effort closes any bound PTY (errors swallowed).
 *   - The heartbeat status check is skipped (prev-session rows whose
 *     heartbeat is still fresh from a server-side adopter can be removed).
 *   - The binder mapping is unconditionally dropped server-side.
 *
 * Callers MUST gate this with a confirm dialog — the whole point is that
 * it's a destructive override. The Home screen × button uses this so the
 * user isn't trapped behind "still has a live PTY in this session" or
 * "is online and cannot be removed yet" errors when they've already
 * decided the row is gone.
 */
export async function forceDeregisterInstance(instanceId: string): Promise<void> {
  try {
    await invoke('ui_force_deregister_instance', { instanceId });
  } catch (err) {
    if (!isMissingInstanceError(err)) throw err;
  }
  dropInstanceBindings([instanceId]);
  removeInstancesFromLocalState([instanceId]);
}

function dropKilledBindings(result: KillResult): void {
  bindings.update((state) => ({
    pending: state.pending.filter(([, ptyId]) => !result.closed_ptys.includes(ptyId)),
    resolved: state.resolved.filter(
      ([instanceId, ptyId]) =>
        !result.deregistered_instances.includes(instanceId)
        && !result.closed_ptys.includes(ptyId),
    ),
  }));
}

/**
 * Bulk-deregister every stale/offline instance in the supplied set (usually
 * the caller's scope-filtered offline list). For instances still bound to a
 * live PTY in this session (the common ADOPTING-but-offline case: the
 * harness is running but never called `swarm.register`), close the PTY
 * first — the server's pty-exit handler deletes the unadopted row
 * automatically. Pure instance-only rows (no PTY, ghosted from a prior
 * session) are cleaned up via the backend bulk sweep. Returns the number
 * of rows removed.
 */
export async function deregisterOfflineInstances(
  offlineInstanceIds: Iterable<string>,
  scope: string | null = null,
): Promise<number> {
  const targetIds = new Set(offlineInstanceIds);
  const resolvedByInstance = new Map(get(bindings).resolved);
  const ptyMap = get(ptySessions);

  let removed = 0;
  const locallyRemovedIds = new Set<string>();

  for (const instanceId of targetIds) {
    const ptyId = resolvedByInstance.get(instanceId);
    if (!ptyId) continue;

    const pty = ptyMap.get(ptyId);
    if (!pty || pty.exit_code !== null) continue;

    // Live PTY bound to an instance the user wants gone. Closing the PTY
    // is the only safe path: the exit handler on the server deletes the
    // unadopted row, drops the lease, and emits pty:closed so the node
    // disappears from the graph.
    try {
      await closePty(ptyId);
      locallyRemovedIds.add(instanceId);
      removed += 1;
    } catch (err) {
      console.warn('[pty] failed to close PTY during offline sweep:', err);
    }
  }

  try {
    removed += await invoke<number>('ui_deregister_offline_instances', {
      scope: scope ?? null,
    });
    for (const id of targetIds) locallyRemovedIds.add(id);
  } catch (err) {
    console.error('[pty] bulk deregister failed:', err);
    throw err;
  }

  dropInstanceBindings(locallyRemovedIds);
  removeInstancesFromLocalState(locallyRemovedIds);

  return removed;
}
