<!--
  NodeHeader.svelte — Shared node header chrome
  
  Displays role badge, status dot, label, CWD, task count, and control buttons.
  Used as the top bar of every TerminalNode card.
-->
<script lang="ts">
  import type {
    AgentListenerHealth,
    Lock,
    NodeType,
    InstanceStatus,
    Task,
  } from '../lib/types';
  import { clearStalePtySession, killInstance, killPtySession, respawnInstance } from '../stores/pty';
  import { confirm } from '../lib/confirm';
  import { defaultPersonaForRole } from '../lib/persona';
  import { createEventDispatcher } from 'svelte';

  export let role: string = '';
  export let instanceId: string | null = null;
  export let status: InstanceStatus | 'pending' = 'offline';
  export let cwd: string = '';
  export let nodeType: NodeType = 'instance';
  export let assignedTasks: Task[] = [];
  export let locks: Lock[] = [];
  export let unreadMessages: number = 0;
  export let listenerHealth: AgentListenerHealth = {
    status: 'unknown',
    label: 'Unverified',
    detail: 'No listener telemetry has been observed yet.',
    lastPollAt: null,
    lastWaitAt: null,
    lastWaitReturnAt: null,
    unreadMessages: 0,
    activeTaskCount: 0,
  };
  export let ptyId: string | null = null;
  export let launchToken: string | null = null;
  /**
   * Optional friendly identifier set at launch time. Takes priority over the
   * instance UUID prefix in the header label.
   */
  export let displayName: string | null = null;
  export let persona: string | null = null;
  export let provider: string | null = null;
  export let mobileControlled: boolean = false;
  export let mobileLeaseHolder: string | null = null;
  export let compact: boolean = false;
  export let projectColor: string = '';
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
    compact: void;
    fullscreen: void;
  }>();

  // Determine the role class for badge styling
  $: roleClass = getRoleClass(role);
  $: displayLabel = deriveDisplayLabel(displayName, instanceId, launchToken, ptyId);
  $: identityEmoji = persona?.trim() || defaultPersonaForRole(role);
  $: providerLabel = provider?.trim() || 'agent';
  $: cwdLabel = formatCwdLabel(cwd);
  $: statusLabel = getStatusLabel(status);
  $: hierarchyNumber = `#${deriveAgentNumber(instanceId ?? displayName ?? launchToken ?? ptyId ?? role ?? providerLabel)}`;
  $: activeTaskCount = assignedTasks.filter(
    (t) => t.status === 'in_progress' || t.status === 'claimed' || t.status === 'open'
  ).length;
  $: lockCount = locks.length;
  $: lockTooltip = lockCount > 0
    ? locks.map((l) => l.file).join('\n')
    : '';
  $: isAppOwned = nodeType === 'pty' || nodeType === 'bound';
  $: showAdopting = instanceId !== null && !adopted;
  // Disconnected instance-only rows can be deleted safely once they are no
  // longer online. Live PTYs still use the stop button.
  $: canRemoveInstance =
    nodeType === 'instance' &&
    instanceId !== null &&
    (status === 'offline' || status === 'stale');
  $: isClearableStalePty = nodeType === 'pty' && ptyId !== null && status === 'stale';
  // Show the respawn button only on instance-only nodes whose heartbeat has
  // aged out — meaning the owning process is gone and reviving the swarm
  // row with a fresh PTY is useful. Online externals are excluded so we
  // don't spawn a duplicate PTY competing with a live process.
  $: canRespawnInstance =
    nodeType === 'instance' &&
    instanceId !== null &&
    (status === 'offline' || status === 'stale');
  $: canClose = Boolean(ptyId) || canRemoveInstance;
  $: canFullscreen = Boolean(ptyId);
  $: closeLabel = !canClose
    ? 'Close unavailable for this node'
    : isClearableStalePty
      ? 'Clear stale node'
      : 'Close agent window';
  let respawning = false;
  $: mobileTooltip = mobileLeaseHolder
    ? `Controlled from mobile (${mobileLeaseHolder})`
    : 'Controlled from mobile';
  $: listenerTooltip = listenerHealth.detail;

  function deriveDisplayLabel(
    name: string | null,
    instId: string | null,
    token: string | null,
    pty: string | null,
  ): string {
    if (name) return name;
    if (instId) return instId.slice(0, 12);
    if (token) return 'Pending...';
    if (pty) return pty.slice(0, 8);
    return '—';
  }

  function getStatusLabel(s: InstanceStatus | 'pending'): string {
    switch (s) {
      case 'online': return 'Online';
      case 'stale': return 'Stale';
      case 'offline': return 'Offline';
      case 'pending': return 'Connecting';
      default: return 'Offline';
    }
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

  function formatCwdLabel(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length <= 2) return trimmed;
    return parts.slice(-2).join('/');
  }

  function deriveAgentNumber(value: string | null): number {
    if (!value) return 1;
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) % 97;
    }
    return hash + 1;
  }

  async function handleStop() {
    if (ptyId) {
      try {
        if (isClearableStalePty) {
          await clearStalePtySession(ptyId);
          return;
        }
        await killPtySession(ptyId);
      } catch (err) {
        console.error('[NodeHeader] failed to kill PTY session tree:', err);
      }
    }
  }

  async function handleRemoveInstance() {
    if (!instanceId) return;
    // Always use the real kill path here. If kill fails, keep the row visible
    // so the operator does not get a false sense that the agent is dead.
    const ok = await confirm({
      title: 'Kill agent',
      message: 'Kill this agent and remove it from the swarm?',
      confirmLabel: 'Kill',
      danger: true,
    });
    if (!ok) return;
    try {
      await killInstance(instanceId);
    } catch (err) {
      console.error('[NodeHeader] kill failed:', err);
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

  async function handleTrafficClose() {
    if (ptyId) {
      await handleStop();
      return;
    }

    if (canRemoveInstance) {
      await handleRemoveInstance();
    }
  }
</script>

<div
  class="node-header"
  class:project-accented={Boolean(projectColor)}
>
  <div class="traffic-lights" role="group" aria-label="Window controls">
    <button
      type="button"
      class="light red"
      title={closeLabel}
      aria-label={closeLabel}
      disabled={!canClose}
      on:click|stopPropagation={handleTrafficClose}
    ></button>
    <button
      type="button"
      class="light yellow"
      class:active={compact}
      title={compact ? 'Expand card' : 'Compact card (Cmd/Ctrl+Shift+M)'}
      aria-label={compact ? 'Expand card' : 'Compact card'}
      on:click|stopPropagation={() => dispatch('compact')}
    ></button>
    <button
      type="button"
      class="light green"
      title={canFullscreen ? 'Open immersive workspace (Cmd/Ctrl+Shift+F)' : 'Fullscreen unavailable for this node'}
      aria-label="Open immersive workspace"
      disabled={!canFullscreen}
      on:click|stopPropagation={() => dispatch('fullscreen')}
    ></button>
  </div>

  <button
    type="button"
    class="node-agent-chip"
    class:compact-active={compact}
    title={compact ? 'Expand agent card' : 'Collapse to agent chip'}
    aria-label={compact ? 'Expand agent card' : 'Collapse agent card'}
    on:click|stopPropagation={() => dispatch('compact')}
  >
    {#if projectColor}
      <span class="node-project-square" aria-hidden="true"></span>
    {/if}
    <span class="node-agent-emoji" aria-hidden="true">{identityEmoji}</span>
    <span class="node-agent-copy">
      <strong title={instanceId ?? 'Pending'}>{displayLabel}</strong>
      <em>{providerLabel}{role ? ` / ${role}` : ''}</em>
    </span>
    <span class="node-agent-rank" title="Hierarchy slot pending">{hierarchyNumber}</span>
  </button>

  {#if role}
    <span class="role-badge {roleClass}">{role}</span>
  {/if}

  {#if cwd}
    <span class="node-cwd" title={cwd}>{cwdLabel}</span>
  {/if}

  {#if mobileControlled}
    <span class="mobile-lease-badge" title={mobileTooltip}>
      <svg
        class="mobile-lease-icon"
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
        <rect x="7" y="2" width="10" height="20" rx="2" ry="2"></rect>
        <line x1="12" y1="18" x2="12.01" y2="18"></line>
      </svg>
      Mobile
    </span>
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

  {#if unreadMessages > 0}
    <span
      class="unread-badge"
      title={`${unreadMessages} unread swarm message${unreadMessages === 1 ? '' : 's'} waiting for this agent to poll`}
    >
      {unreadMessages} unread
    </span>
  {/if}

  <span
    class="listener-badge {listenerHealth.status}"
    title={listenerTooltip}
  >
    {listenerHealth.label}
  </span>

  {#if lockCount > 0}
    <span class="lock-badge" title={`Locked: ${lockTooltip}`}>
      <svg
        class="lock-icon"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="11" width="16" height="10" rx="2"/>
        <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
      </svg>
      {lockCount}
    </span>
  {/if}

  <!-- Connection status on the right, matching the ghostty-web demo's
       "● Connected" indicator. Status dot + text label together. -->
  <div class="connection-status" title={instanceId ?? 'Pending'}>
    <span class="connection-dot {status}"></span>
    <span class="connection-text">{statusLabel}</span>
  </div>

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
          title="Remove disconnected instance from swarm"
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
