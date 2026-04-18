<!--
  NodeHeader.svelte — Shared node header chrome
  
  Displays role badge, status dot, label, CWD, task count, and control buttons.
  Used as the top bar of every TerminalNode card.
-->
<script lang="ts">
  import type { NodeType, InstanceStatus, Task } from '../lib/types';
  import { closePty, deregisterInstance, respawnInstance } from '../stores/pty';
  import { createEventDispatcher } from 'svelte';

  export let role: string = '';
  export let instanceId: string | null = null;
  export let status: InstanceStatus | 'pending' = 'offline';
  export let cwd: string = '';
  export let nodeType: NodeType = 'instance';
  export let assignedTasks: Task[] = [];
  export let ptyId: string | null = null;
  export let launchToken: string | null = null;
  /**
   * `false` while this node's instance row was UI-pre-created and the
   * child process inside the PTY hasn't yet called `swarm.register`. The
   * node is connectable (messages route via the known instance id) but
   * the child isn't guaranteed to consume them until adoption lands.
   */
  export let adopted: boolean = true;

  const dispatch = createEventDispatcher<{
    inspect: void;
    focus: void;
  }>();

  // Determine the role class for badge styling
  $: roleClass = getRoleClass(role);
  $: displayLabel = deriveDisplayLabel(instanceId, launchToken, ptyId);
  $: truncatedCwd = truncatePath(cwd, 24);
  $: activeTaskCount = assignedTasks.filter(
    (t) => t.status === 'in_progress' || t.status === 'claimed' || t.status === 'open'
  ).length;
  $: isAppOwned = nodeType === 'pty' || nodeType === 'bound';
  $: showAdopting = instanceId !== null && !adopted;
  // Only offline instance rows can be deleted safely. Live PTYs still use the
  // stop button; stale/online instance-only rows must age out or be respawned.
  $: canRemoveInstance = instanceId !== null && status === 'offline';
  // Show the respawn button only on instance-only nodes whose heartbeat has
  // aged out — meaning the owning process is gone and reviving the swarm
  // row with a fresh PTY is useful. Online externals are excluded so we
  // don't spawn a duplicate PTY competing with a live process.
  $: canRespawnInstance =
    nodeType === 'instance' &&
    instanceId !== null &&
    (status === 'offline' || status === 'stale');
  let respawning = false;

  function deriveDisplayLabel(
    instId: string | null,
    token: string | null,
    pty: string | null,
  ): string {
    if (instId) return instId.slice(0, 12);
    if (token) return 'Pending...';
    if (pty) return pty.slice(0, 8);
    return '—';
  }

  function getRoleClass(r: string): string {
    const lower = r.toLowerCase();
    if (lower.includes('planner')) return 'planner';
    if (lower.includes('implement')) return 'implementer';
    if (lower.includes('review')) return 'reviewer';
    if (lower.includes('research')) return 'researcher';
    if (lower.includes('shell') || lower === '$shell') return 'shell';
    if (!r) return 'shell';
    return 'custom';
  }

  function truncatePath(path: string, maxLen: number): string {
    if (!path) return '';
    if (path.length <= maxLen) return path;
    const parts = path.split('/');
    // Show last 2 segments with ellipsis
    if (parts.length > 2) {
      return '.../' + parts.slice(-2).join('/');
    }
    return '...' + path.slice(-(maxLen - 3));
  }

  async function handleStop() {
    if (ptyId) {
      try {
        await closePty(ptyId);
      } catch (err) {
        console.error('[NodeHeader] failed to close PTY:', err);
      }
    }
  }

  async function handleRemoveInstance() {
    if (!instanceId) return;
    try {
      await deregisterInstance(instanceId);
    } catch (err) {
      console.error('[NodeHeader] failed to deregister instance:', err);
    }
  }

  async function handleRespawnInstance() {
    if (!instanceId || respawning) return;
    respawning = true;
    try {
      await respawnInstance(instanceId);
    } catch (err) {
      console.error('[NodeHeader] failed to respawn instance:', err);
    } finally {
      respawning = false;
    }
  }
</script>

<div class="node-header">
  <span class="status-dot {status}"></span>

  {#if role}
    <span class="role-badge {roleClass}">{role}</span>
  {/if}

  <span class="node-label" title={instanceId ?? 'Pending'}>
    {displayLabel}
  </span>

  {#if truncatedCwd}
    <span class="node-cwd" title={cwd}>{truncatedCwd}</span>
  {/if}

  {#if showAdopting}
    <span
      class="adopting-badge"
      title="Instance row pre-created by swarm-ui. Waiting for the child process to call swarm.register and adopt it."
    >
      ADOPTING
    </span>
  {/if}

  {#if activeTaskCount > 0}
    <span class="task-count-badge">{activeTaskCount}</span>
  {/if}

  <div class="node-controls">
    <button
      title="Focus terminal"
      on:click|stopPropagation={() => dispatch('focus')}
    >
      <!-- Focus icon (crosshair) -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="4"/>
        <line x1="12" y1="2" x2="12" y2="6"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="2" y1="12" x2="6" y2="12"/>
        <line x1="18" y1="12" x2="22" y2="12"/>
      </svg>
    </button>

    <button
      title="Inspect details"
      on:click|stopPropagation={() => dispatch('inspect')}
    >
      <!-- Info icon -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    </button>

    {#if isAppOwned && ptyId}
      <button
        class="stop"
        title="Stop process"
        on:click|stopPropagation={handleStop}
      >
        <!-- Stop icon (square) -->
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="6" width="12" height="12" rx="1"/>
        </svg>
      </button>
    {:else}
      {#if canRespawnInstance}
        <button
          class="respawn"
          title="Relaunch this agent so it comes back online"
          disabled={respawning}
          on:click|stopPropagation={handleRespawnInstance}
        >
          <!-- Refresh / respawn icon -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      {/if}
      {#if canRemoveInstance}
        <button
          class="stop"
          title="Remove instance from swarm"
          on:click|stopPropagation={handleRemoveInstance}
        >
          <!-- Trash icon -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      {/if}
    {/if}
  </div>
</div>
