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
  PtySession,
  BindingState,
  ShellSpawnResult,
  RespawnResult,
  PtyExitPayload,
  RolePresetSummary,
} from '../lib/types';
import { resolveHarnessCommand } from './harnessAliases';

const HARNESS_AUTOTYPE_MIN_DELAY_MS = 200;
const PTY_READY_TIMEOUT_MS = 1500;

type ReadyGate = {
  ready: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

const ptyReadyGates = new Map<string, ReadyGate>();

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

async function autoTypeHarnessWhenReady(
  ptyId: string,
  harness: string,
): Promise<void> {
  await Promise.all([
    waitForPtyTerminalReady(ptyId),
    delay(HARNESS_AUTOTYPE_MIN_DELAY_MS),
  ]);

  const aliased = resolveHarnessCommand(harness);
  const encoded = new TextEncoder().encode(`${aliased}\n`);
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
let ptyClosedUnlisten: UnlistenFn | null = null;
let bindResolvedUnlisten: UnlistenFn | null = null;
let bindUnresolvedUnlisten: UnlistenFn | null = null;
let ptyBoundExitUnlisten: UnlistenFn | null = null;
let initialized = false;

/**
 * Initialize PTY store event listeners.
 * Fetches current binding state and subscribes to lifecycle events.
 */
export async function initPtyStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    const [state, sessions] = await Promise.all([
      invoke<BindingState>('get_binding_state'),
      invoke<PtySession[]>('get_pty_sessions'),
    ]);

    bindings.set(state);
    ptySessions.set(new Map(sessions.map((session) => [session.id, session])));
  } catch (err) {
    console.warn('[pty] failed to fetch initial PTY state:', err);
  }

  // Listen for PTY creation events
  ptyCreatedUnlisten = await listen<PtySession>('pty:created', (event) => {
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
}

/**
 * Tear down PTY store event listeners.
 */
export function destroyPtyStore(): void {
  ptyCreatedUnlisten?.();
  ptyClosedUnlisten?.();
  bindResolvedUnlisten?.();
  bindUnresolvedUnlisten?.();
  ptyBoundExitUnlisten?.();
  ptyCreatedUnlisten = null;
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
  role?: string;
  scope?: string;
  label?: string;
  /**
   * Optional human-friendly identifier shown on the node header. Stored as a
   * `name:<value>` token on the swarm label. Falls back to a slice of the
   * instance UUID when absent.
   */
  name?: string;
}

/**
 * Spawn a swarm-aware shell. When `harness` is set, the backend pre-creates
 * a swarm instance row, binds it to the PTY, and we auto-type the harness
 * command into the shell so ctrl-c drops back to a shell prompt instead of
 * killing the node.
 *
 * When `role` is also set, the role token is stored on the swarm label. The
 * agent receives role-specific guidance when it explicitly calls
 * `swarm.register`; we intentionally avoid hidden auto-typed prompts here.
 */
export async function spawnShell(
  cwd: string,
  options: SpawnShellOptions = {},
): Promise<ShellSpawnResult> {
  const trimmedHarness = options.harness?.trim() || null;
  const trimmedRole = options.role?.trim() || null;
  const trimmedScope = options.scope?.trim() || null;
  const trimmedLabel = options.label?.trim() || null;
  const trimmedName = options.name?.trim() || null;

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
    command: trimmedHarness ?? '$SHELL',
    cwd,
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: null,
  };

  upsertSession(session);

  if (result.instance_id) {
    resolveBinding(result.instance_id, result.pty_id);
  }

  if (trimmedHarness) {
    void autoTypeHarnessWhenReady(
      result.pty_id,
      trimmedHarness,
    ).catch((err) => {
      console.warn('[pty] failed to auto-type harness into shell:', err);
    });
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
 * For harness-shell instances (claude/codex/opencode) the result carries the
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
  };

  upsertSession(session);
  resolveBinding(result.instance_id, result.pty_id);

  if (result.harness) {
    void autoTypeHarnessWhenReady(
      result.pty_id,
      result.harness,
    ).catch((err) => {
      console.warn('[pty] failed to auto-type harness on respawn:', err);
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
  await invoke('ui_deregister_instance', { instanceId });
  // Drop the binder mapping on our side immediately so the bound: node
  // disappears from the graph without waiting for the swarm:update tick.
  bindings.update((state) => ({
    pending: state.pending,
    resolved: state.resolved.filter(([id]) => id !== instanceId),
  }));
}
