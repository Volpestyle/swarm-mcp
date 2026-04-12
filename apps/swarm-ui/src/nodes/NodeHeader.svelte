<!--
  NodeHeader.svelte — Shared node header chrome
  
  Displays role badge, status dot, label, CWD, task count, and control buttons.
  Used as the top bar of every TerminalNode card.
-->
<script lang="ts">
  import type { NodeType, InstanceStatus, Task } from '../lib/types';
  import { closePty } from '../stores/pty';
  import { createEventDispatcher } from 'svelte';

  export let role: string = '';
  export let instanceId: string | null = null;
  export let status: InstanceStatus | 'pending' = 'offline';
  export let cwd: string = '';
  export let nodeType: NodeType = 'instance';
  export let assignedTasks: Task[] = [];
  export let ptyId: string | null = null;

  const dispatch = createEventDispatcher<{
    inspect: void;
    focus: void;
  }>();

  // Determine the role class for badge styling
  $: roleClass = getRoleClass(role);
  $: displayLabel = instanceId ? instanceId.slice(0, 12) : 'Pending...';
  $: truncatedCwd = truncatePath(cwd, 24);
  $: activeTaskCount = assignedTasks.filter(
    (t) => t.status === 'in_progress' || t.status === 'claimed' || t.status === 'open'
  ).length;
  $: isAppOwned = nodeType === 'pty' || nodeType === 'bound';

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
    {/if}
  </div>
</div>
