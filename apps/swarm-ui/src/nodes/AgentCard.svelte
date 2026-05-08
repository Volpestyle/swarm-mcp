<script lang="ts">
  import { tick } from 'svelte';
  import type { AgentCardMode, SwarmNodeData, Task } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import { confirm } from '../lib/confirm';
  import { clearStalePtySession, killInstance, killPtySession } from '../stores/pty';
  import AgentModeTabs from './AgentModeTabs.svelte';
  import AgentOverview from './AgentOverview.svelte';
  import TerminalPane from './TerminalPane.svelte';

  export let data: SwarmNodeData;
  export let initialMode: AgentCardMode = 'summary';

  let mode: AgentCardMode = initialMode;
  let paneRef: TerminalPane | null = null;

  $: ptyId = data.ptySession?.id ?? null;
  $: hasTerminal = Boolean(ptyId);

  export async function focus(): Promise<void> {
    if (!ptyId) return;
    mode = 'terminal';
    await tick();
    paneRef?.focus();
  }

  function setMode(next: AgentCardMode): void {
    if (next === 'terminal' && !ptyId) return;
    mode = next;
  }

  async function stopAgent(): Promise<void> {
    const instanceId = data.instance?.id ?? null;
    if (!instanceId && !ptyId) return;
    const ok = await confirm({
      title: data.status === 'stale' ? 'Clear agent surface' : 'Stop agent',
      message: instanceId
        ? 'Stop this agent process and remove it from the swarm?'
        : 'Stop this terminal session?',
      confirmLabel: data.status === 'stale' ? 'Clear' : 'Stop',
      danger: true,
    });
    if (!ok) return;

    if (instanceId) {
      await killInstance(instanceId);
      return;
    }
    if (ptyId) {
      if (data.nodeType === 'pty' && data.status === 'stale') {
        await clearStalePtySession(ptyId);
      } else {
        await killPtySession(ptyId);
      }
    }
  }

  function taskStatusClass(task: Task): string {
    return `task-status ${task.status}`;
  }
</script>

<div class="agent-card-shell">
  <AgentModeTabs active={mode} {hasTerminal} {setMode} />

  {#if mode === 'summary'}
    <AgentOverview
      {data}
      hasTerminal={Boolean(ptyId)}
      on:detail={() => setMode('work')}
      on:terminal={() => setMode(ptyId ? 'terminal' : 'work')}
      on:stop={stopAgent}
    />
  {:else if mode === 'terminal' && ptyId}
    <div class="agent-terminal-view">
      <TerminalPane bind:this={paneRef} {ptyId} on:stable={() => paneRef?.focus()} />
    </div>
  {:else if mode === 'work'}
    <section class="agent-detail-view">
      <h3>Tasks</h3>
      {#if data.assignedTasks.length === 0 && data.requestedTasks.length === 0}
        <p class="agent-empty">No tasks attached to this agent.</p>
      {:else}
        <div class="agent-task-list">
          {#each data.assignedTasks as task (task.id)}
            <div class="agent-task-row">
              <span class={taskStatusClass(task)}>{task.status}</span>
              <span class="agent-task-title">{task.title}</span>
              <span class="agent-task-meta">assigned</span>
            </div>
          {/each}
          {#each data.requestedTasks as task (task.id)}
            <div class="agent-task-row">
              <span class={taskStatusClass(task)}>{task.status}</span>
              <span class="agent-task-title">{task.title}</span>
              <span class="agent-task-meta">requested</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {:else}
    <section class="agent-detail-view">
      <h3>Context</h3>
      <div class="agent-kv-grid">
        <span>Scope</span>
        <strong>{data.instance?.scope ?? 'No swarm scope'}</strong>
        <span>Directory</span>
        <strong>{data.instance?.directory ?? data.ptySession?.cwd ?? 'No working directory'}</strong>
        <span>Listener</span>
        <strong>{data.listenerHealth.detail}</strong>
        <span>Locks</span>
        <strong>{data.locks.length === 0 ? 'No locks held' : `${data.locks.length} file(s)`}</strong>
        <span>Registered</span>
        <strong>{formatTimestamp(data.instance?.registered_at ?? null)}</strong>
        <span>Heartbeat</span>
        <strong>{formatTimestamp(data.instance?.heartbeat ?? null)}</strong>
        <span>Last Poll</span>
        <strong>{formatTimestamp(data.listenerHealth.lastPollAt)}</strong>
        <span>Wait Loop</span>
        <strong>{formatTimestamp(data.listenerHealth.lastWaitAt)}</strong>
      </div>
      {#if data.locks.length > 0}
        <div class="agent-lock-list">
          {#each data.locks as lock (lock.file)}
            <code>{lock.file}</code>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
