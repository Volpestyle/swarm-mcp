<!--
  Inspector.svelte — Selected node/edge detail panel

  Shows detail for selected node or edge:
  - Node selected: instance metadata, PTY metadata, task list, recent messages, file locks
  - Edge selected: full message history (message edge) or task detail (task edge)
  - Scrollable content area with close button to deselect
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type {
    SwarmNodeData,
    MessageEdgeData,
    TaskEdgeData,
    DependencyEdgeData,
    XYFlowNode,
    XYFlowEdge,
    Task,
    Message,
  } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import { getMessagesBetween, getTask } from '../stores/swarm';

  export let selectedNode: XYFlowNode | null = null;
  export let selectedEdge: XYFlowEdge | null = null;

  const dispatch = createEventDispatcher<{ close: void }>();

  // Determine what we're inspecting
  $: inspectingNode = selectedNode !== null;
  $: inspectingEdge = selectedEdge !== null && selectedNode === null;
  $: nodeData = selectedNode?.data as SwarmNodeData | null;

  // Edge data typed by edge type
  $: edgeData = selectedEdge?.data as
    | MessageEdgeData
    | TaskEdgeData
    | DependencyEdgeData
    | null;
  $: dependencyEdgeData = edgeData?.edgeType === 'dependency' ? edgeData : null;

  // Resolve message history for message edges
  $: messageHistory = resolveMessageHistory();

  function resolveMessageHistory(): Message[] {
    if (!inspectingEdge || !selectedEdge) return [];
    const d = edgeData;
    if (!d || d.edgeType !== 'message') return [];
    // Extract instance IDs from edge source/target node IDs
    const sourceId = extractInstanceId(selectedEdge.source);
    const targetId = extractInstanceId(selectedEdge.target);
    if (!sourceId || !targetId) return [];
    return getMessagesBetween(sourceId, targetId);
  }

  // Resolve full task detail for task edges
  $: taskDetail = resolveTaskDetail();

  function resolveTaskDetail(): Task | null {
    if (!inspectingEdge || !edgeData) return null;
    if (edgeData.edgeType === 'task') {
      return (edgeData as TaskEdgeData).task;
    }
    if (edgeData.edgeType === 'dependency') {
      const depData = edgeData as DependencyEdgeData;
      return getTask(depData.dependencyTaskId) ?? null;
    }
    return null;
  }

  function extractInstanceId(nodeId: string): string | null {
    // Node IDs are formatted as "bound:{id}", "instance:{id}", or "pty:{id}"
    const parts = nodeId.split(':');
    return parts.length > 1 ? parts.slice(1).join(':') : null;
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
  <div class="inspector-header">
    <span class="inspector-title">
      {#if inspectingNode}
        Node Details
      {:else if inspectingEdge}
        Edge Details
      {:else}
        Inspector
      {/if}
    </span>
    <button class="close-btn" on:click={() => dispatch('close')} title="Close inspector">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>

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
      <!-- ===== Edge Inspection ===== -->

      {#if edgeData.edgeType === 'message'}
        <!-- Message edge: full message history -->
        <section>
          <h4>Messages ({messageHistory.length})</h4>
          <div class="message-list">
            {#each messageHistory as msg (msg.id)}
              <div class="message-item">
                <div class="message-meta">
                  <span class="message-sender mono">{msg.sender.slice(0, 8)}</span>
                  <span class="message-arrow">-></span>
                  <span class="message-recipient mono">{msg.recipient?.slice(0, 8) ?? 'broadcast'}</span>
                  <span class="message-time">{formatTimestamp(msg.created_at)}</span>
                </div>
                <div class="message-content">{msg.content}</div>
              </div>
            {/each}
            {#if messageHistory.length === 0}
              <div class="empty-state">No messages found</div>
            {/if}
          </div>
        </section>

      {:else if edgeData.edgeType === 'task' && taskDetail}
        <!-- Task edge: full task detail -->
        <section>
          <h4>Task Detail</h4>
          <div class="detail-grid">
            <span class="detail-label">ID</span>
            <span class="detail-value mono">{taskDetail.id}</span>

            <span class="detail-label">Title</span>
            <span class="detail-value">{taskDetail.title}</span>

            <span class="detail-label">Status</span>
            <span class="detail-value">
              <span class="inline-badge" style="color: {statusBadgeColor(taskDetail.status)}">
                {taskDetail.status}
              </span>
            </span>

            <span class="detail-label">Type</span>
            <span class="detail-value">{taskDetail.type}</span>

            <span class="detail-label">Requester</span>
            <span class="detail-value mono">{taskDetail.requester}</span>

            <span class="detail-label">Assignee</span>
            <span class="detail-value mono">{taskDetail.assignee ?? '--'}</span>

            {#if taskDetail.priority !== 0}
              <span class="detail-label">Priority</span>
              <span class="detail-value">{taskDetail.priority}</span>
            {/if}

            <span class="detail-label">Created</span>
            <span class="detail-value">{formatTimestamp(taskDetail.created_at)}</span>

            <span class="detail-label">Updated</span>
            <span class="detail-value">{formatTimestamp(taskDetail.updated_at)}</span>
          </div>

          {#if taskDetail.description}
            <div class="task-description">
              <h5>Description</h5>
              <p>{taskDetail.description}</p>
            </div>
          {/if}

          {#if taskDetail.result}
            <div class="task-description">
              <h5>Result</h5>
              <p>{taskDetail.result}</p>
            </div>
          {/if}

          {#if taskDetail.files.length > 0}
            <div class="task-files">
              <h5>Files ({taskDetail.files.length})</h5>
              {#each taskDetail.files as file}
                <div class="lock-item mono">{file}</div>
              {/each}
            </div>
          {/if}

          {#if taskDetail.depends_on.length > 0}
            <div class="task-deps">
              <h5>Dependencies</h5>
              {#each taskDetail.depends_on as depId}
                <div class="lock-item mono">{depId}</div>
              {/each}
            </div>
          {/if}
        </section>

      {:else if edgeData.edgeType === 'dependency'}
        <!-- Dependency edge detail -->
        <section>
          <h4>Dependency</h4>
          <div class="detail-grid">
            <span class="detail-label">Status</span>
            <span class="detail-value">
              <span class="inline-badge" style:color={dependencyEdgeData?.satisfied ? 'var(--edge-dep-satisfied)' : 'var(--edge-dep-blocked)'}>
                {dependencyEdgeData?.satisfied ? 'Satisfied' : 'Blocked'}
              </span>
            </span>

            <span class="detail-label">Dep Task</span>
            <span class="detail-value mono">{dependencyEdgeData?.dependencyTaskId}</span>

            <span class="detail-label">Dependent</span>
            <span class="detail-value mono">{dependencyEdgeData?.dependentTaskId}</span>
          </div>

          {#if taskDetail}
            <div class="task-description" style="margin-top: 8px;">
              <h5>{taskDetail.title}</h5>
              <p>{taskDetail.description || 'No description'}</p>
            </div>
          {/if}
        </section>
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
    height: 100%;
    overflow: hidden;
    background: var(--node-bg, #1e1e2e);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    color: var(--terminal-fg, #c0caf5);
  }

  .inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--node-border, #313244);
    flex-shrink: 0;
  }

  .inspector-title {
    font-size: 13px;
    font-weight: 600;
  }

  .close-btn {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: #6c7086;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.1s ease, color 0.1s ease;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--terminal-fg, #c0caf5);
  }

  .inspector-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
  }

  section {
    margin-bottom: 16px;
  }

  h4 {
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0 0 8px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--node-border, #313244);
  }

  h5 {
    font-size: 11px;
    font-weight: 600;
    color: #a6adc8;
    margin: 8px 0 4px 0;
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
    font-family: Menlo, Monaco, 'Cascadia Code', monospace;
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

  .task-description {
    font-size: 12px;
    line-height: 1.5;
  }

  .task-description p {
    margin: 4px 0;
    color: #a6adc8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .lock-list, .task-files, .task-deps {
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
