// =============================================================================
// stores/swarm.ts — Svelte stores for swarm state from Tauri events
//
// Normalized by ID for efficient lookups and targeted reactivity.
// Frontend state flow: swarm.db -> swarm.rs -> Tauri events -> these stores
//
// Architecture rule: these stores handle ONLY graph/semantic state.
// PTY byte streams are handled separately in stores/pty.ts.
// =============================================================================

import { writable, derived, get, type Readable } from 'svelte/store';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type {
  Instance,
  Task,
  Message,
  Lock,
  SwarmUpdate,
  TaskStatus,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Core stores — normalized state
// ---------------------------------------------------------------------------

/** All known instances indexed by ID */
export const instances = writable<Map<string, Instance>>(new Map());

/** All recent tasks indexed by ID */
export const tasks = writable<Map<string, Task>>(new Map());

/** Recent messages (bounded, most recent first) */
export const messages = writable<Message[]>([]);

/** Active file locks */
export const locks = writable<Lock[]>([]);

/** UI metadata from `ui/*` KV entries */
export const uiMeta = writable<Record<string, unknown> | null>(null);

// ---------------------------------------------------------------------------
// Derived stores — computed views
// ---------------------------------------------------------------------------

/** Instances with status === 'online' */
export const activeInstances: Readable<Map<string, Instance>> = derived(
  instances,
  ($instances) => {
    const active = new Map<string, Instance>();
    for (const [id, inst] of $instances) {
      if (inst.status === 'online') active.set(id, inst);
    }
    return active;
  },
);

/** Instances with status === 'stale' */
export const staleInstances: Readable<Map<string, Instance>> = derived(
  instances,
  ($instances) => {
    const stale = new Map<string, Instance>();
    for (const [id, inst] of $instances) {
      if (inst.status === 'stale') stale.set(id, inst);
    }
    return stale;
  },
);

/** Instances with status === 'offline' */
export const offlineInstances: Readable<Map<string, Instance>> = derived(
  instances,
  ($instances) => {
    const offline = new Map<string, Instance>();
    for (const [id, inst] of $instances) {
      if (inst.status === 'offline') offline.set(id, inst);
    }
    return offline;
  },
);

/** Tasks grouped by status */
export const tasksByStatus: Readable<Map<TaskStatus, Task[]>> = derived(
  tasks,
  ($tasks) => {
    const grouped = new Map<TaskStatus, Task[]>();
    for (const task of $tasks.values()) {
      const group = grouped.get(task.status);
      if (group) {
        group.push(task);
      } else {
        grouped.set(task.status, [task]);
      }
    }
    return grouped;
  },
);

/** Count of open tasks (open + claimed) */
export const openTaskCount: Readable<number> = derived(
  tasksByStatus,
  ($tasksByStatus) => {
    const open = $tasksByStatus.get('open')?.length ?? 0;
    const claimed = $tasksByStatus.get('claimed')?.length ?? 0;
    return open + claimed;
  },
);

/** Count of in-progress tasks */
export const inProgressTaskCount: Readable<number> = derived(
  tasksByStatus,
  ($tasksByStatus) => $tasksByStatus.get('in_progress')?.length ?? 0,
);

/** Status summary for the SwarmStatus panel */
export const swarmSummary: Readable<SwarmSummary> = derived(
  [instances, tasks, messages],
  ([$instances, $tasks, $messages]) => {
    let active = 0;
    let stale = 0;
    let offline = 0;

    for (const inst of $instances.values()) {
      switch (inst.status) {
        case 'online': active++; break;
        case 'stale': stale++; break;
        case 'offline': offline++; break;
      }
    }

    let tasksOpen = 0;
    let tasksInProgress = 0;
    let tasksDone = 0;
    let tasksFailed = 0;

    for (const task of $tasks.values()) {
      switch (task.status) {
        case 'open':
        case 'claimed':
          tasksOpen++;
          break;
        case 'in_progress':
          tasksInProgress++;
          break;
        case 'done':
          tasksDone++;
          break;
        case 'failed':
          tasksFailed++;
          break;
      }
    }

    return {
      active,
      stale,
      offline,
      tasksOpen,
      tasksInProgress,
      tasksDone,
      tasksFailed,
      totalMessages: $messages.length,
    };
  },
);

export interface SwarmSummary {
  active: number;
  stale: number;
  offline: number;
  tasksOpen: number;
  tasksInProgress: number;
  tasksDone: number;
  tasksFailed: number;
  totalMessages: number;
}

// ---------------------------------------------------------------------------
// Message append feed — side channel off the reactive store path
//
// Every new `messages` row emitted on `swarm:messages:new` is fanned out to
// listeners here. MessageEdge components use this to spawn per-message packet
// animations without triggering a full graph rebuild (which would reflow all
// edges and tank perf for bursty swarms).
// ---------------------------------------------------------------------------

type MessageAppendedListener = (msg: Message) => void;

const messageAppendedListeners = new Set<MessageAppendedListener>();

export function onMessageAppended(cb: MessageAppendedListener): () => void {
  messageAppendedListeners.add(cb);
  return () => {
    messageAppendedListeners.delete(cb);
  };
}

function fanoutAppendedMessage(msg: Message): void {
  for (const cb of messageAppendedListeners) {
    try {
      cb(msg);
    } catch (err) {
      console.error('[swarm] onMessageAppended listener threw:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization and event handling
// ---------------------------------------------------------------------------

let swarmUnlisten: UnlistenFn | null = null;
let messagesAppendedUnlisten: UnlistenFn | null = null;
let initialized = false;

/**
 * Initialize the swarm store:
 * 1. Fetch current cached snapshot from the backend
 * 2. Subscribe to `swarm:update` events for live updates
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initSwarmStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    // Fetch current snapshot for initial load
    const initial = await invoke<SwarmUpdate>('get_swarm_state');
    applyUpdate(initial);
  } catch (err) {
    console.warn('[swarm] failed to fetch initial state:', err);
    // Non-fatal: the event listener will populate state on next poll cycle
  }

  // Listen for incremental updates
  swarmUnlisten = await listen<SwarmUpdate>('swarm:update', (event) => {
    applyUpdate(event.payload);
  });

  // Listen for the message delta feed and fan out to per-edge subscribers
  messagesAppendedUnlisten = await listen<Message[]>(
    'swarm:messages:new',
    (event) => {
      console.log('[swarm] messages:new delta:', event.payload.length, 'msg(s), listeners:', messageAppendedListeners.size);
      for (const msg of event.payload) {
        fanoutAppendedMessage(msg);
      }
    },
  );
}

/**
 * Tear down the swarm store event listener.
 * Call this on app unmount if needed.
 */
export function destroySwarmStore(): void {
  if (swarmUnlisten) {
    swarmUnlisten();
    swarmUnlisten = null;
  }
  if (messagesAppendedUnlisten) {
    messagesAppendedUnlisten();
    messagesAppendedUnlisten = null;
  }
  messageAppendedListeners.clear();
  initialized = false;
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

/** Maximum number of messages to retain in the store */
const MAX_MESSAGES = 200;

/**
 * Apply a SwarmUpdate payload to the stores. This is called both for the
 * initial snapshot and for each incremental `swarm:update` event.
 *
 * The backend already diffs and only emits when state changes, so we
 * do a full replacement here rather than incremental patching.
 */
function applyUpdate(update: SwarmUpdate): void {
  // Instances: full replacement indexed by ID
  const instanceMap = new Map<string, Instance>();
  for (const inst of update.instances) {
    instanceMap.set(inst.id, inst);
  }
  instances.set(instanceMap);

  // Tasks: full replacement indexed by ID
  const taskMap = new Map<string, Task>();
  for (const task of update.tasks) {
    taskMap.set(task.id, task);
  }
  tasks.set(taskMap);

  // Messages: replace, bounded to MAX_MESSAGES, most recent first
  const sortedMessages = update.messages
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_MESSAGES);
  messages.set(sortedMessages);

  // Locks: full replacement
  locks.set(update.locks);

  // UI metadata
  uiMeta.set(update.ui_meta ?? null);
}

// ---------------------------------------------------------------------------
// Utility exports for consumers
// ---------------------------------------------------------------------------

/**
 * Get an instance by ID from the current snapshot.
 * Returns undefined if not found.
 */
export function getInstance(instanceId: string): Instance | undefined {
  return get(instances).get(instanceId);
}

/**
 * Get a task by ID from the current snapshot.
 */
export function getTask(taskId: string): Task | undefined {
  return get(tasks).get(taskId);
}

/**
 * Get messages between two instances (in either direction).
 */
export function getMessagesBetween(a: string, b: string): Message[] {
  return get(messages).filter(
    (m) =>
      (m.sender === a && m.recipient === b) ||
      (m.sender === b && m.recipient === a),
  );
}
