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
    allInstances,
    availableScopes,
    instances,
    scopeSelection,
    setScopeSelection,
    swarmSummary,
  } from '../stores/swarm';
  import { formatScopeLabel } from '../stores/startup';
  import {
    bindings,
    clearStalePtySession,
    deregisterOfflineInstances,
    killAllAgentSessions,
    pendingPtyCount,
    ptySessions,
  } from '../stores/pty';
  import { confirm } from '../lib/confirm';
  import { isOrphanAgentPty, ptyMatchesScope } from '../lib/ptyRecovery';

  let clearingOffline = false;
  let killingAll = false;
  let orphanPtyCount = 0;

  $: orphanPtyCount = [...$ptySessions.values()].filter(
    (pty) => isOrphanAgentPty(pty, $allInstances, $bindings) && ptyMatchesScope(pty, $activeScope),
  ).length;

  function handleScopeChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    setScopeSelection(target.value);
  }

  function shortScope(scope: string | null): string {
    return formatScopeLabel(scope);
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
      for (const pty of $ptySessions.values()) {
        if (!isOrphanAgentPty(pty, $allInstances, $bindings)) continue;
        if (!ptyMatchesScope(pty, $activeScope)) continue;
        await clearStalePtySession(pty.id);
      }
      await deregisterOfflineInstances(targetIds, $activeScope);
    } catch (err) {
      console.error('[SwarmStatus] failed to clear offline instances:', err);
    } finally {
      clearingOffline = false;
    }
  }

  async function handleKillAllInScope(): Promise<void> {
    if (killingAll) return;
    const targets = Array.from($instances.values());
    if (targets.length === 0) return;
    const channelLabel = shortScope($activeScope);
    const ok = await confirm({
      title: 'Kill agents',
      message: `Kill ${targets.length} agent${targets.length === 1 ? '' : 's'} in ${channelLabel}? This SIGTERMs their processes and clears every row.`,
      confirmLabel: 'Kill all',
      danger: true,
    });
    if (!ok) return;
    killingAll = true;
    try {
      await killAllAgentSessions($activeScope, targets.map((instance) => instance.id));
    } catch (err) {
      console.error('[SwarmStatus] kill-all failed:', err);
    } finally {
      killingAll = false;
    }
  }
</script>

<div class="swarm-status-bar">
  <div class="status-group scope-group">
    <span class="status-label">channel</span>
    <select class="scope-select" value={$scopeSelection} on:change={handleScopeChange}>
      <option value="auto">auto</option>
      <option value="all">all channels</option>
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
    {#if $instances.size > 0}
      <button
        class="kill-all"
        disabled={killingAll}
        title={killingAll
          ? 'Killing…'
          : `SIGTERM every agent in ${shortScope($activeScope)} and clear their rows`}
        on:click={handleKillAllInScope}
      >
        <!-- Skull-ish glyph: circle + bones. Visually distinct from the
             trash icon on the clear-offline button next to it so the
             destructive intent doesn't blend in. -->
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2a8 8 0 0 0-8 8v4a4 4 0 0 0 2 3.46V21a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3.54A4 4 0 0 0 20 14v-4a8 8 0 0 0-8-8z"/>
          <circle cx="9" cy="12" r="1.25"/>
          <circle cx="15" cy="12" r="1.25"/>
          <path d="M10 18h4"/>
        </svg>
        kill all
      </button>
    {/if}
  </div>

  <span class="divider">|</span>

  <div class="status-group">
    <span class="status-dot-inline stale"></span>
    <span class="status-value">{$swarmSummary.stale}</span>
    <span class="status-label">stale</span>
  </div>

  {#if $swarmSummary.offline + $swarmSummary.stale + orphanPtyCount > 0}
    <span class="divider">|</span>
    <div class="status-group offline-group">
      <span class="status-dot-inline offline"></span>
      <span class="status-value">{$swarmSummary.offline}</span>
      <span class="status-label">offline</span>
      {#if orphanPtyCount > 0}
        <span class="status-label">+ {orphanPtyCount} orphan PTY{orphanPtyCount === 1 ? '' : 's'}</span>
      {/if}
      <button
        class="clear-offline"
        disabled={clearingOffline}
        title={clearingOffline
          ? 'Clearing…'
          : 'Clear every stale/offline instance and orphan PTY in this channel'}
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

  .kill-all {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    margin-left: 8px;
    min-width: 92px;
    min-height: 40px;
    padding: 6px 12px;
    /* Borrow the danger palette from .clear-offline:hover so the idle state
       already signals "this is destructive" — user said the existing red X
       didn't read as a nuke button, so this one leans harder. */
    border: 1px solid rgba(243, 139, 168, 0.45);
    background: rgba(243, 139, 168, 0.08);
    color: #f38ba8;
    border-radius: 4px;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .kill-all svg {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    filter: drop-shadow(0 0 5px rgba(243, 139, 168, 0.35));
  }

  .kill-all:hover:not(:disabled) {
    background: rgba(243, 139, 168, 0.2);
    border-color: rgba(243, 139, 168, 0.7);
    color: #f5a1b6;
  }

  .kill-all:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Tron Encom OS overrides ──────────────────────────────────────────
     Pill chips become sharp white-LED HUD readouts; status bar background
     goes pure black with hairline + halo. */
  :global([data-theme="tron-encom-os"]) .swarm-status-bar {
    background: var(--bg-base, #000);
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      0 0 12px rgba(255, 255, 255, 0.18);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    color: var(--fg-secondary, #8a94a0);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
  }

  :global([data-theme="tron-encom-os"]) .status-value {
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .status-label {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .divider {
    color: var(--fg-muted, #4a5260);
  }

  :global([data-theme="tron-encom-os"]) .scope-chip {
    border-radius: 0;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--accent, #ffffff);
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.18);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .scope-select {
    border-radius: 0;
    background: var(--bg-input, #02040a);
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  :global([data-theme="tron-encom-os"]) .clear-offline,
  :global([data-theme="tron-encom-os"]) .kill-all {
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .clear-offline {
    background: transparent;
    border-color: var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .kill-all {
    background: rgba(255, 58, 76, 0.12);
    border-width: 2px;
    border-color: var(--c-red, #ff3a4c);
    color: var(--c-red, #ff3a4c);
    box-shadow:
      0 0 10px rgba(255, 58, 76, 0.34),
      inset 0 0 0 1px rgba(255, 58, 76, 0.16);
  }

  :global([data-theme="tron-encom-os"]) .kill-all svg {
    width: 19px;
    height: 19px;
    filter:
      drop-shadow(0 0 5px rgba(255, 58, 76, 0.68))
      drop-shadow(0 0 12px rgba(255, 58, 76, 0.28));
  }

  :global([data-theme="tron-encom-os"]) .status-value.done {
    color: var(--c-tron, #c6ff3d);
    text-shadow: 0 0 4px rgba(198, 255, 61, 0.5);
  }

  :global([data-theme="tron-encom-os"]) .status-value.failed {
    color: var(--c-red, #ff3a4c);
    text-shadow: 0 0 4px rgba(255, 58, 76, 0.5);
  }

  :global([data-theme="tron-encom-os"]) .status-dot-inline.online {
    background: var(--accent, #ffffff);
    box-shadow: 0 0 6px var(--accent, #ffffff);
  }
</style>
