<!--
  Inspector.svelte — Selected node/edge detail panel

  Shows detail for selected node or edge:
  - Node selected: instance metadata, PTY metadata, task list, recent messages, file locks
  - Edge selected: full message history (message edge) or task detail (task edge)
  - Scrollable content area with close button to deselect
-->
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type {
    SwarmNodeData,
    ConnectionEdgeData,
    XYFlowNode,
    XYFlowEdge,
  } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import Markdown from '../lib/Markdown.svelte';

  export let selectedNode: XYFlowNode | null = null;
  export let selectedEdge: XYFlowEdge | null = null;

  // Determine what we're inspecting
  $: inspectingNode = selectedNode !== null;
  $: inspectingEdge = selectedEdge !== null && selectedNode === null;
  $: nodeData = selectedNode?.data as SwarmNodeData | null;

  // Every edge is now a unified `connection` bundling messages, tasks, and
  // dependencies between the same unordered instance pair.
  $: edgeData = selectedEdge?.data as ConnectionEdgeData | null;

  // Reference edgeData.messages directly so Svelte's reactive dep tracker
  // picks up the update. A wrapper function call would hide the read and
  // freeze messageHistory at its mount-time value.
  $: messageHistory = (inspectingEdge && edgeData?.messages) || [];

  $: tasks = edgeData?.tasks ?? [];
  $: deps = edgeData?.deps ?? [];

  // -------------------------------------------------------------------
  // Per-section delete actions. Each writes to swarm.db via a dedicated
  // Tauri command; the 500ms poll then re-emits the snapshot and the
  // Inspector re-renders with the updated edgeData. No optimistic UI.
  // -------------------------------------------------------------------

  let pendingAction: string | null = null;
  let actionError: string | null = null;

  async function handleClearMessages(): Promise<void> {
    if (!edgeData) return;
    pendingAction = 'messages';
    actionError = null;
    try {
      await invoke<number>('ui_clear_messages', {
        instanceA: edgeData.sourceInstanceId,
        instanceB: edgeData.targetInstanceId,
      });
    } catch (err) {
      actionError = `Failed to clear messages: ${err}`;
    } finally {
      pendingAction = null;
    }
  }

  async function handleUnassignTask(taskId: string): Promise<void> {
    pendingAction = `task:${taskId}`;
    actionError = null;
    try {
      await invoke<boolean>('ui_unassign_task', { taskId });
    } catch (err) {
      actionError = `Failed to unassign task: ${err}`;
    } finally {
      pendingAction = null;
    }
  }

  async function handleRemoveDependency(
    dependentTaskId: string,
    dependencyTaskId: string,
  ): Promise<void> {
    pendingAction = `dep:${dependencyTaskId}->${dependentTaskId}`;
    actionError = null;
    try {
      await invoke<boolean>('ui_remove_dependency', {
        dependentTaskId,
        dependencyTaskId,
      });
    } catch (err) {
      actionError = `Failed to remove dependency: ${err}`;
    } finally {
      pendingAction = null;
    }
  }

  function statusBadgeColor(status: string): string {
    switch (status) {
      case 'online': return 'var(--status-online)';
      case 'stale': return 'var(--status-stale)';
      case 'offline': return 'var(--status-offline)';
      case 'pending': return 'var(--status-pending)';
      case 'open': case 'claimed': return 'var(--edge-task-open)';
      case 'in_progress': return 'var(--edge-task-in-progress)';
      case 'done': return 'var(--edge-task-done)';
      case 'failed': return 'var(--edge-task-failed)';
      case 'cancelled': case 'blocked': return 'var(--edge-task-cancelled)';
      default: return '#6c7086';
    }
  }
</script>

<div class="inspector">
  <div class="inspector-body">
    {#if inspectingNode && nodeData}
      <!-- ===== Node Inspection ===== -->

      <!-- Instance metadata -->
      {#if nodeData.instance}
        <section>
          <h4>Instance</h4>
          <div class="detail-grid">
            <span class="detail-label">ID</span>
            <span class="detail-value mono">{nodeData.instance.id}</span>

            <span class="detail-label">Status</span>
            <span class="detail-value">
              <span class="inline-badge" style="color: {statusBadgeColor(nodeData.instance.status)}">
                {nodeData.instance.status}
              </span>
            </span>

            <span class="detail-label">Scope</span>
            <span class="detail-value">{nodeData.instance.scope}</span>

            <span class="detail-label">PID</span>
            <span class="detail-value mono">{nodeData.instance.pid}</span>

            <span class="detail-label">Directory</span>
            <span class="detail-value mono" title={nodeData.instance.directory}>
              {nodeData.instance.directory}
            </span>

            <span class="detail-label">Label</span>
            <span class="detail-value">{nodeData.instance.label ?? '--'}</span>

            <span class="detail-label">Heartbeat</span>
            <span class="detail-value">{formatTimestamp(nodeData.instance.heartbeat)}</span>

            <span class="detail-label">Registered</span>
            <span class="detail-value">{formatTimestamp(nodeData.instance.registered_at)}</span>
          </div>
        </section>
      {/if}

      <!-- PTY metadata -->
      {#if nodeData.ptySession}
        <section>
          <h4>PTY Session</h4>
          <div class="detail-grid">
            <span class="detail-label">PTY ID</span>
            <span class="detail-value mono">{nodeData.ptySession.id}</span>

            <span class="detail-label">Command</span>
            <span class="detail-value mono">{nodeData.ptySession.command}</span>

            <span class="detail-label">CWD</span>
            <span class="detail-value mono" title={nodeData.ptySession.cwd}>
              {nodeData.ptySession.cwd}
            </span>

            <span class="detail-label">Started</span>
            <span class="detail-value">{formatTimestamp(nodeData.ptySession.started_at)}</span>

            {#if nodeData.ptySession.exit_code !== null}
              <span class="detail-label">Exit Code</span>
              <span class="detail-value" style="color: {nodeData.ptySession.exit_code === 0 ? 'var(--status-online)' : 'var(--edge-task-failed)'}">
                {nodeData.ptySession.exit_code}
              </span>
            {/if}

            {#if nodeData.ptySession.launch_token}
              <span class="detail-label">Token</span>
              <span class="detail-value mono">{nodeData.ptySession.launch_token}</span>
            {/if}
          </div>
        </section>
      {/if}

      <!-- Assigned tasks -->
      {#if nodeData.assignedTasks.length > 0}
        <section>
          <h4>Assigned Tasks ({nodeData.assignedTasks.length})</h4>
          <div class="task-list">
            {#each nodeData.assignedTasks as task (task.id)}
              <div class="task-item">
                <span class="inline-badge" style="color: {statusBadgeColor(task.status)}">
                  {task.status}
                </span>
                <span class="task-title">{task.title}</span>
                <span class="task-type">{task.type}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Requested tasks -->
      {#if nodeData.requestedTasks.length > 0}
        <section>
          <h4>Requested Tasks ({nodeData.requestedTasks.length})</h4>
          <div class="task-list">
            {#each nodeData.requestedTasks as task (task.id)}
              <div class="task-item">
                <span class="inline-badge" style="color: {statusBadgeColor(task.status)}">
                  {task.status}
                </span>
                <span class="task-title">{task.title}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- File locks -->
      {#if nodeData.locks.length > 0}
        <section>
          <h4>File Locks ({nodeData.locks.length})</h4>
          <div class="lock-list">
            {#each nodeData.locks as lock}
              <div class="lock-item mono">{lock.file}</div>
            {/each}
          </div>
        </section>
      {/if}

    {:else if inspectingEdge && edgeData}
      <!-- ===== Edge Inspection =====
           Every selected edge is now a unified connection bundling every
           relationship between the two endpoints: messages either way,
           shared tasks, and task-level dependencies. -->

      <section class="endpoints">
        <div class="detail-grid">
          <span class="detail-label">A</span>
          <span class="detail-value mono">{edgeData.sourceInstanceId.slice(0, 12)}</span>
          <span class="detail-label">B</span>
          <span class="detail-value mono">{edgeData.targetInstanceId.slice(0, 12)}</span>
        </div>
      </section>

      {#if actionError}
        <div class="error-banner">{actionError}</div>
      {/if}

      {#if messageHistory.length > 0}
        <section>
          <div class="section-head">
            <h4>Messages ({messageHistory.length})</h4>
            <button
              class="delete-btn"
              disabled={pendingAction === 'messages'}
              on:click={handleClearMessages}
            >
              {pendingAction === 'messages' ? 'Clearing…' : 'Clear history'}
            </button>
          </div>
          <div class="message-list">
            {#each messageHistory as msg (msg.id)}
              <div class="message-item">
                <div class="message-meta">
                  <span class="message-sender mono">{msg.sender.slice(0, 8)}</span>
                  <span class="message-arrow">-&gt;</span>
                  <span class="message-recipient mono">{msg.recipient?.slice(0, 8) ?? 'broadcast'}</span>
                  <span class="message-time">{formatTimestamp(msg.created_at)}</span>
                </div>
                <div class="message-content">
                  <Markdown content={msg.content} />
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if tasks.length > 0}
        <section>
          <h4>Tasks ({tasks.length})</h4>
          <div class="task-list">
            {#each tasks as task (task.id)}
              <div class="task-row">
                <span class="inline-badge" style="color: {statusBadgeColor(task.status)}">
                  {task.status}
                </span>
                <span class="task-title" title={task.description ?? ''}>{task.title}</span>
                <span class="task-type">{task.type}</span>
                <button
                  class="delete-btn small"
                  disabled={pendingAction === `task:${task.id}`}
                  on:click={() => handleUnassignTask(task.id)}
                  title="Unassign this task (clears the assignee)"
                >
                  {pendingAction === `task:${task.id}` ? '…' : 'Unassign'}
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if deps.length > 0}
        <section>
          <h4>Dependencies ({deps.length})</h4>
          <div class="task-list">
            {#each deps as dep (dep.dependencyTaskId + dep.dependentTaskId)}
              <div class="task-row">
                <span
                  class="inline-badge"
                  style:color={dep.satisfied ? 'var(--edge-dep-satisfied)' : 'var(--edge-dep-blocked)'}
                >
                  {dep.satisfied ? 'satisfied' : 'blocked'}
                </span>
                <span class="task-title mono">{dep.dependencyTaskId.slice(0, 8)} → {dep.dependentTaskId.slice(0, 8)}</span>
                <button
                  class="delete-btn small"
                  disabled={pendingAction === `dep:${dep.dependencyTaskId}->${dep.dependentTaskId}`}
                  on:click={() => handleRemoveDependency(dep.dependentTaskId, dep.dependencyTaskId)}
                  title="Remove this dependency from the dependent task"
                >
                  {pendingAction === `dep:${dep.dependencyTaskId}->${dep.dependentTaskId}` ? '…' : 'Remove'}
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if messageHistory.length === 0 && tasks.length === 0 && deps.length === 0}
        <div class="empty-state">No activity on this connection</div>
      {/if}

    {:else}
      <div class="empty-state">
        Select a node or edge to inspect
      </div>
    {/if}
  </div>
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    color: var(--terminal-fg, #c0caf5);
  }

  .inspector-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
  }

  section {
    margin-bottom: 16px;
  }

  h4 {
    font-size: 11px;
    font-weight: 600;
    color: #a6adc8;
    margin: 0 0 8px 0;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(108, 112, 134, 0.18);
  }

  section.endpoints {
    margin-bottom: 12px;
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .section-head h4 {
    flex: 1;
    margin: 0;
    padding-bottom: 0;
    border: none;
  }

  .delete-btn {
    background: transparent;
    border: 1px solid rgba(243, 139, 168, 0.35);
    color: var(--edge-task-failed, #f38ba8);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .delete-btn.small {
    padding: 2px 6px;
    font-size: 9.5px;
  }

  .delete-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--edge-task-failed) 15%, transparent);
    border-color: var(--edge-task-failed);
  }

  .delete-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .error-banner {
    margin-bottom: 10px;
    padding: 6px 8px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--edge-task-failed) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--edge-task-failed) 35%, transparent);
    color: var(--edge-task-failed);
    font-size: 11px;
  }

  .task-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px solid rgba(108, 112, 134, 0.12);
  }

  .task-row:last-child {
    border-bottom: none;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    font-size: 12px;
  }

  .detail-label {
    color: #6c7086;
    font-weight: 500;
  }

  .detail-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .inline-badge {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
  }

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .task-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    font-size: 12px;
  }

  .task-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-type {
    color: #6c7086;
    font-size: 10px;
    text-transform: uppercase;
  }

  .lock-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lock-item {
    padding: 2px 0;
    font-size: 11px;
    color: #a6adc8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .message-item {
    padding: 6px 0;
    border-bottom: 1px solid var(--node-border, #313244);
  }

  .message-item:last-child {
    border-bottom: none;
  }

  .message-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: #6c7086;
    margin-bottom: 4px;
  }

  .message-sender {
    color: var(--edge-message, #89b4fa);
  }

  .message-arrow {
    color: #6c7086;
  }

  .message-recipient {
    color: var(--badge-reviewer, #a6e3a1);
  }

  .message-time {
    margin-left: auto;
  }

  .message-content {
    font-size: 12px;
    line-height: 1.4;
    color: #a6adc8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty-state {
    text-align: center;
    color: #6c7086;
    font-size: 12px;
    padding: 20px 0;
  }
</style>
