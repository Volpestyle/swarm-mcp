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
    scopeSelection,
    setScopeSelection,
    swarmSummary,
  } from '../stores/swarm';
  import { pendingPtyCount } from '../stores/pty';

  function handleScopeChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    setScopeSelection(target.value);
  }

  function shortScope(scope: string | null): string {
    if (!scope) return 'all scopes';
    const parts = scope.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? scope;
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
    left: 50%;
    transform: translateX(-50%);
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

  .pending .status-value {
    color: var(--status-pending, #89b4fa);
  }
</style>
