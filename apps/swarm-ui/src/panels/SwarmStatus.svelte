<!--
  SwarmStatus.svelte — Swarm health summary bar

  Fixed bar at bottom of the canvas showing:
  {n} active | {n} stale | {n} tasks open | {n} in progress | {n} pending PTYs
  
  Compact, non-intrusive, always visible.
  Derived from swarm store and pty store values.
-->
<script lang="ts">
  import {
    activeScope,
    availableScopes,
    instances,
    scopeSelection,
    setScopeSelection,
    swarmSummary,
  } from '../stores/swarm';
  import { deregisterOfflineInstances, pendingPtyCount } from '../stores/pty';

  let clearingOffline = false;

  function handleScopeChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    setScopeSelection(target.value);
  }

  function shortScope(scope: string | null): string {
    if (!scope) return 'all scopes';
    const parts = scope.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? scope;
  }

  async function handleClearOffline(): Promise<void> {
    if (clearingOffline) return;
    clearingOffline = true;
    try {
      // `instances` is already scope-filtered, so iterating it picks up only
      // zombies the user can actually see. Passing the scope to the backend
      // still narrows the SQL sweep to the same scope for the pure
      // instance-only rows that have no live PTY in this session.
      const targetIds: string[] = [];
      for (const inst of $instances.values()) {
        if (inst.status === 'offline' || inst.status === 'stale') {
          targetIds.push(inst.id);
        }
      }
      await deregisterOfflineInstances(targetIds, $activeScope);
    } catch (err) {
      console.error('[SwarmStatus] failed to clear offline instances:', err);
    } finally {
      clearingOffline = false;
    }
  }
</script>

<div class="swarm-status-bar">
  <div class="status-group scope-group">
    <span class="status-label">scope</span>
    <select class="scope-select" value={$scopeSelection} on:change={handleScopeChange}>
      <option value="auto">auto</option>
      <option value="all">all scopes</option>
      {#each $availableScopes as scope (scope)}
        <option value={scope}>{shortScope(scope)}</option>
      {/each}
    </select>
    <span class="scope-chip">{shortScope($activeScope)}</span>
  </div>

  <span class="divider">|</span>

  <div class="status-group">
    <span class="status-dot-inline online"></span>
    <span class="status-value">{$swarmSummary.active}</span>
    <span class="status-label">active</span>
  </div>

  <span class="divider">|</span>

  <div class="status-group">
    <span class="status-dot-inline stale"></span>
    <span class="status-value">{$swarmSummary.stale}</span>
    <span class="status-label">stale</span>
  </div>

  {#if $swarmSummary.offline + $swarmSummary.stale > 0}
    <span class="divider">|</span>
    <div class="status-group offline-group">
      <span class="status-dot-inline offline"></span>
      <span class="status-value">{$swarmSummary.offline}</span>
      <span class="status-label">offline</span>
      <button
        class="clear-offline"
        disabled={clearingOffline}
        title={clearingOffline
          ? 'Clearing…'
          : 'Deregister every stale/offline instance in this scope'}
        on:click={handleClearOffline}
      >
        <!-- Trash icon mirrored from NodeHeader so the visual intent is
             consistent across per-node and bulk cleanup entry points. -->
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
        clear
      </button>
    </div>
  {/if}

  <span class="divider">|</span>

  <div class="status-group">
    <span class="status-value">{$swarmSummary.tasksOpen}</span>
    <span class="status-label">tasks open</span>
  </div>

  <span class="divider">|</span>

  <div class="status-group">
    <span class="status-value">{$swarmSummary.tasksInProgress}</span>
    <span class="status-label">in progress</span>
  </div>

  {#if $pendingPtyCount > 0}
    <span class="divider">|</span>
    <div class="status-group pending">
      <span class="status-value">{$pendingPtyCount}</span>
      <span class="status-label">pending PTYs</span>
    </div>
  {/if}

  {#if $swarmSummary.tasksDone > 0}
    <span class="divider">|</span>
    <div class="status-group">
      <span class="status-value done">{$swarmSummary.tasksDone}</span>
      <span class="status-label">done</span>
    </div>
  {/if}

  {#if $swarmSummary.tasksFailed > 0}
    <span class="divider">|</span>
    <div class="status-group">
      <span class="status-value failed">{$swarmSummary.tasksFailed}</span>
      <span class="status-label">failed</span>
    </div>
  {/if}
</div>

<style>
  .swarm-status-bar {
    position: absolute;
    bottom: 12px;
    /* Shift left by half the sidebar width so the bar stays centered within
       the visible canvas region (the sidebar overlays the right edge). */
    left: calc(50% - var(--sidebar-inset, 0px) / 2);
    transform: translateX(-50%);
    transition: left var(--sidebar-transition-duration, 460ms)
      cubic-bezier(0.22, 1, 0.36, 1);
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--node-bg, #1e1e2e);
    border: 1px solid var(--node-border, #313244);
    border-radius: 8px;
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    padding: 6px 14px;
    font-size: 12px;
    color: #a6adc8;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    z-index: 10;
    user-select: none;
    pointer-events: auto;
  }

  .status-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .scope-group {
    gap: 6px;
  }

  .status-value {
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .status-value.done {
    color: var(--status-online, #a6e3a1);
  }

  .status-value.failed {
    color: var(--edge-task-failed, #f38ba8);
  }

  .status-label {
    color: #6c7086;
  }

  .scope-select {
    min-width: 92px;
    padding: 3px 8px;
    border-radius: 6px;
    border: 1px solid var(--node-border, #313244);
    background: rgba(17, 17, 27, 0.72);
    color: var(--terminal-fg, #c0caf5);
    font-size: 11px;
    outline: none;
  }

  .scope-chip {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(137, 180, 250, 0.14);
    color: var(--status-pending, #89b4fa);
    font-size: 11px;
  }

  .divider {
    color: #313244;
  }

  .status-dot-inline {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot-inline.online {
    background: var(--status-online, #a6e3a1);
    box-shadow: 0 0 4px var(--status-online, #a6e3a1);
  }

  .status-dot-inline.stale {
    background: var(--status-stale, #f9e2af);
    box-shadow: 0 0 4px var(--status-stale, #f9e2af);
  }

  .status-dot-inline.offline {
    background: var(--status-offline, #6c7086);
  }

  .pending .status-value {
    color: var(--status-pending, #89b4fa);
  }

  .offline-group .status-value {
    color: #9399b2;
  }

  .clear-offline {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 4px;
    padding: 2px 6px;
    border: 1px solid rgba(108, 112, 134, 0.3);
    background: rgba(17, 17, 27, 0.42);
    color: #a6adc8;
    border-radius: 4px;
    font: inherit;
    font-size: 10.5px;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .clear-offline:hover:not(:disabled) {
    background: rgba(243, 139, 168, 0.14);
    border-color: rgba(243, 139, 168, 0.5);
    color: #f38ba8;
  }

  .clear-offline:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
