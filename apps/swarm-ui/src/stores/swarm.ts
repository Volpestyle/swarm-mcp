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
  Annotation,
  KvEntry,
  Event,
  SwarmUpdate,
  TaskStatus,
  Position,
  SavedLayout,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Core stores — normalized state
// ---------------------------------------------------------------------------

const SCOPE_SELECTION_KEY = 'swarm-ui.scope-selection';
function loadStoredScopeSelection(): string {
  if (typeof localStorage === 'undefined') return 'auto';
  return localStorage.getItem(SCOPE_SELECTION_KEY) ?? 'auto';
}

const rawInstances = writable<Map<string, Instance>>(new Map());
const rawTasks = writable<Map<string, Task>>(new Map());
const rawMessages = writable<Message[]>([]);
const rawLocks = writable<Lock[]>([]);
const rawAnnotations = writable<Annotation[]>([]);
const rawKvEntries = writable<KvEntry[]>([]);
const rawEvents = writable<Event[]>([]);

export const allInstances = rawInstances;
export const allKvEntries = rawKvEntries;

export const scopeSelection = writable<string>(loadStoredScopeSelection());
if (typeof window !== 'undefined') {
  scopeSelection.subscribe((value) => {
    window.localStorage.setItem(SCOPE_SELECTION_KEY, value);
  });
}

export function setScopeSelection(value: string): void {
  scopeSelection.set(value || 'auto');
}

export const availableScopes: Readable<string[]> = derived(
  [
    rawInstances,
    rawTasks,
    rawMessages,
    rawLocks,
    rawAnnotations,
    rawKvEntries,
    rawEvents,
    scopeSelection,
  ],
  ([
    $instances,
    $tasks,
    $messages,
    $locks,
    $annotations,
    $kvEntries,
    $events,
    $selection,
  ]) => {
    const scopes = new Set<string>();
    for (const instance of $instances.values()) scopes.add(instance.scope);
    for (const task of $tasks.values()) scopes.add(task.scope);
    for (const msg of $messages) scopes.add(msg.scope);
    for (const lock of $locks) scopes.add(lock.scope);
    for (const annotation of $annotations) scopes.add(annotation.scope);
    for (const entry of $kvEntries) scopes.add(entry.scope);
    for (const evt of $events) scopes.add(evt.scope);
    if ($selection && $selection !== 'auto' && $selection !== 'all') {
      scopes.add($selection);
    }
    return [...scopes].filter(Boolean).sort();
  },
);

export const activeScope: Readable<string | null> = derived(
  [scopeSelection, availableScopes, rawInstances],
  ([$selection, $scopes, $instances]) => {
    if ($selection === 'all') return null;
    if ($selection !== 'auto') return $selection;

    if ($scopes.length === 1) return $scopes[0] ?? null;

    const onlineCounts = new Map<string, number>();
    for (const instance of $instances.values()) {
      if (instance.status !== 'online') continue;
      onlineCounts.set(
        instance.scope,
        (onlineCounts.get(instance.scope) ?? 0) + 1,
      );
    }

    const rankedOnline = [...onlineCounts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    if (rankedOnline.length > 0) return rankedOnline[0]?.[0] ?? null;

    return $scopes[0] ?? null;
  },
);

/** All known instances indexed by ID */
export const instances: Readable<Map<string, Instance>> = derived(
  [rawInstances, activeScope],
  ([$instances, $scope]) => {
    if ($scope === null) return $instances;
    const filtered = new Map<string, Instance>();
    for (const [id, instance] of $instances) {
      if (instance.scope === $scope) filtered.set(id, instance);
    }
    return filtered;
  },
);

/** All recent tasks indexed by ID */
export const tasks: Readable<Map<string, Task>> = derived(
  [rawTasks, activeScope],
  ([$tasks, $scope]) => {
    if ($scope === null) return $tasks;
    const filtered = new Map<string, Task>();
    for (const [id, task] of $tasks) {
      if (task.scope === $scope) filtered.set(id, task);
    }
    return filtered;
  },
);

/** Recent messages (bounded, most recent first) */
export const messages: Readable<Message[]> = derived(
  [rawMessages, activeScope],
  ([$messages, $scope]) =>
    $scope === null
      ? $messages
      : $messages.filter((message) => message.scope === $scope),
);

/** Active file locks */
export const locks: Readable<Lock[]> = derived(
  [rawLocks, activeScope],
  ([$locks, $scope]) =>
    $scope === null ? $locks : $locks.filter((lock) => lock.scope === $scope),
);

/**
 * All `context` rows including locks. Non-lock types (finding, warning,
 * bug, note, todo) are rendered alongside locks in the Inspector's
 * "Context" section so agent annotations are visible.
 */
export const annotations: Readable<Annotation[]> = derived(
  [rawAnnotations, activeScope],
  ([$annotations, $scope]) =>
    $scope === null
      ? $annotations
      : $annotations.filter((annotation) => annotation.scope === $scope),
);

/**
 * Non-`ui/*` KV entries — coordination state agents share through the kv
 * table. Surfaced in the Inspector "Coordination (KV)" section so turn
 * counters, status flags, and queues are visible alongside messages/tasks.
 */
export const kvEntries: Readable<KvEntry[]> = derived(
  [rawKvEntries, activeScope],
  ([$entries, $scope]) =>
    $scope === null ? $entries : $entries.filter((entry) => entry.scope === $scope),
);

/**
 * Audit-log rows used by the Activity timeline. Bounded ring buffer —
 * cold-start seeds from the snapshot, then each `swarm:events:new` delta
 * appends. Oldest rows drop off when the buffer fills.
 */
export const events: Readable<Event[]> = derived(
  [rawEvents, activeScope],
  ([$events, $scope]) =>
    $scope === null ? $events : $events.filter((evt) => evt.scope === $scope),
);

/** UI metadata from `ui/*` KV entries */
export const uiMeta = writable<Record<string, unknown> | null>(null);

function parseSavedLayoutValue(value: unknown): Record<string, Position> {
  if (!value || typeof value !== 'object') return {};
  const nodes = (value as SavedLayout).nodes;
  if (!nodes || typeof nodes !== 'object') return {};

  const parsed: Record<string, Position> = {};
  for (const [nodeId, pos] of Object.entries(nodes)) {
    if (!pos || typeof pos !== 'object') continue;
    const x = Number((pos as Position).x);
    const y = Number((pos as Position).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    parsed[nodeId] = { x, y };
  }
  return parsed;
}

export const savedLayout: Readable<Record<string, Position>> = derived(
  [uiMeta, activeScope],
  ([$uiMeta, $scope]) => {
    if (!$uiMeta) return {};

    const merged: Record<string, Position> = {};
    for (const [key, value] of Object.entries($uiMeta)) {
      if (key === 'ui/layout') {
        Object.assign(merged, parseSavedLayoutValue(value));
        continue;
      }

      if (!key.endsWith('::ui/layout')) continue;
      const entryScope = key.slice(0, -'::ui/layout'.length);
      if ($scope !== null && entryScope !== $scope) continue;
      Object.assign(merged, parseSavedLayoutValue(value));
    }
    return merged;
  },
);

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

/**
 * Side-channel feed for newly-arrived audit-log rows. Mirrors the message
 * fanout — graph-level signals (lock badges, edge flashes, KV ripples)
 * subscribe here so each event triggers a single transient effect instead
 * of re-walking the ring buffer on every poll.
 */
type EventAppendedListener = (evt: Event) => void;

const eventAppendedListeners = new Set<EventAppendedListener>();

export function onEventAppended(cb: EventAppendedListener): () => void {
  eventAppendedListeners.add(cb);
  return () => {
    eventAppendedListeners.delete(cb);
  };
}

function fanoutAppendedEvent(evt: Event): void {
  for (const cb of eventAppendedListeners) {
    try {
      cb(evt);
    } catch (err) {
      console.error('[swarm] onEventAppended listener threw:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization and event handling
// ---------------------------------------------------------------------------

let swarmUnlisten: UnlistenFn | null = null;
let messagesAppendedUnlisten: UnlistenFn | null = null;
let eventsAppendedUnlisten: UnlistenFn | null = null;
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

  // Audit-log delta feed — append to the ring buffer and fan out to
  // graph-level signal subscribers (lock badges, edge flashes...).
  eventsAppendedUnlisten = await listen<Event[]>(
    'swarm:events:new',
    (event) => {
      if (event.payload.length === 0) return;
      rawEvents.update((current) => appendBoundedEvents(current, event.payload));
      for (const evt of event.payload) {
        fanoutAppendedEvent(evt);
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
  if (eventsAppendedUnlisten) {
    eventsAppendedUnlisten();
    eventsAppendedUnlisten = null;
  }
  messageAppendedListeners.clear();
  eventAppendedListeners.clear();
  initialized = false;
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

/** Maximum number of messages to retain in the store */
const MAX_MESSAGES = 200;

/** Ring-buffer cap for the activity timeline. */
const MAX_EVENTS = 500;

function appendBoundedEvents(current: Event[], incoming: Event[]): Event[] {
  if (incoming.length === 0) return current;
  // Dedupe by id — the snapshot can backfill rows the delta also
  // delivered if the cursors disagree by a tick.
  const seen = new Set(current.map((e) => e.id));
  const merged = [...current];
  for (const evt of incoming) {
    if (seen.has(evt.id)) continue;
    seen.add(evt.id);
    merged.push(evt);
  }
  if (merged.length <= MAX_EVENTS) return merged;
  return merged.slice(merged.length - MAX_EVENTS);
}

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
  rawInstances.set(instanceMap);

  // Tasks: full replacement indexed by ID
  const taskMap = new Map<string, Task>();
  for (const task of update.tasks) {
    taskMap.set(task.id, task);
  }
  rawTasks.set(taskMap);

  // Messages: replace, bounded to MAX_MESSAGES, most recent first
  const sortedMessages = update.messages
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_MESSAGES);
  rawMessages.set(sortedMessages);

  // Locks: full replacement
  rawLocks.set(update.locks);

  // Annotations: full replacement (includes locks)
  rawAnnotations.set(update.annotations ?? []);

  // KV entries: full replacement
  rawKvEntries.set(update.kv ?? []);

  // Audit log: merge with existing buffer to keep the timeline coherent
  // across snapshot replays. The delta listener handles the steady-state
  // case; this branch covers cold starts and reconnects.
  if (update.events && update.events.length > 0) {
    rawEvents.update((current) =>
      appendBoundedEvents(current, update.events ?? []),
    );
  }

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
