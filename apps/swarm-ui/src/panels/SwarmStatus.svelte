<!--
  SwarmStatus.svelte — Swarm health summary bar

  Fixed bar at bottom of the canvas showing:
  {n} active | {n} stale | {n} tasks open | {n} in progress | {n} pending PTYs
  
  Compact, non-intrusive, always visible.
  Derived from swarm store and pty store values.
-->
<script lang="ts">
  import { swarmSummary } from '../stores/swarm';
  import { pendingPtyCount } from '../stores/pty';
</script>

<div class="swarm-status-bar">
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
