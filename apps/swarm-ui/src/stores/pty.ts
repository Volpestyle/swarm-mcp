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
  LaunchResult,
  ShellSpawnResult,
  RespawnResult,
  PtyExitPayload,
  RolePresetSummary,
} from '../lib/types';

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
 */
export async function getPtyBuffer(id: string): Promise<Uint8Array> {
  const data = await invoke<number[]>('pty_get_buffer', { id });
  return new Uint8Array(data);
}

/**
 * Spawn an agent with role, working directory, and optional scope/label.
 * Returns the PTY ID and launch token.
 */
export async function spawnAgent(
  role: string,
  workingDir: string,
  scope?: string,
  label?: string,
): Promise<LaunchResult> {
  const result = await invoke<LaunchResult>('agent_spawn', {
    role,
    working_dir: workingDir,
    scope: scope ?? null,
    label: label ?? null,
  });

  // Add PTY session to local store. The backend pre-creates the swarm
  // instance row and emits `bind:resolved` before returning, so the binding
  // is resolved from the moment the PTY exists — no pending phase.
  const session: PtySession = {
    id: result.pty_id,
    command: role,
    cwd: workingDir,
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: result.token,
  };

  upsertSession(session);
  resolveBinding(result.instance_id, result.pty_id);

  return result;
}

/**
 * Spawn a plain shell session (no agent registration).
 *
 * When a harness (e.g. "claude", "codex", "opencode") is provided, the backend
 * still spawns an interactive shell — the harness command is auto-typed into
 * the shell's stdin so ctrl-c drops back to a shell prompt instead of
 * terminating the PTY node.
 *
 * Returns the PTY ID.
 */
export async function spawnShell(
  cwd: string,
  harness?: string,
): Promise<ShellSpawnResult> {
  const trimmedHarness = harness?.trim();
  const hasHarness = !!trimmedHarness && trimmedHarness.length > 0;

  const result = await invoke<ShellSpawnResult>('spawn_shell', {
    cwd,
    harness: hasHarness ? trimmedHarness : null,
  });

  const session: PtySession = {
    id: result.pty_id,
    command: hasHarness ? trimmedHarness! : '$SHELL',
    cwd,
    started_at: Date.now(),
    exit_code: null,
    bound_instance_id: result.instance_id,
    launch_token: null,
  };

  upsertSession(session);

  // When a harness was picked, the backend pre-created + bound a swarm
  // instance. Mirror that binding into the frontend store so the node
  // renders as `bound:` (draggable) from the first paint.
  if (result.instance_id) {
    resolveBinding(result.instance_id, result.pty_id);
  }

  if (hasHarness) {
    // Give the shell a moment to paint its prompt, then type the harness
    // command for the user. The shell inherits SWARM_MCP_INSTANCE_ID from
    // the PTY env, so the harness's swarm-mcp subprocess will adopt the
    // pre-created row on register. Any failure is non-fatal — the shell
    // itself is still usable.
    const encoded = new TextEncoder().encode(`${trimmedHarness}\n`);
    setTimeout(() => {
      writeToPty(result.pty_id, encoded).catch((err) => {
        console.warn('[pty] failed to auto-type harness into shell:', err);
      });
    }, 200);
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
 * ergonomics of `spawnShell` above.
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
    const encoded = new TextEncoder().encode(`${result.harness}\n`);
    setTimeout(() => {
      writeToPty(result.pty_id, encoded).catch((err) => {
        console.warn('[pty] failed to auto-type harness on respawn:', err);
      });
    }, 200);
  }

  return result;
}

/**
 * Remove an instance row from swarm.db. Used when the user clicks the
 * remove button on a node whose PTY is already gone — e.g., an orphan
 * placeholder left over from a previous UI session, or a child process
 * killed outside the UI.
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
