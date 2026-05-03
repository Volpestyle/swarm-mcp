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
    Annotation,
    AgentRuntimeProfile,
    Event,
    KvEntry,
    SwarmNodeData,
    ConnectionEdgeData,
    XYFlowNode,
    XYFlowEdge,
  } from '../lib/types';
  import { buildAssetContextBlock } from '../lib/assetContext';
  import { formatTimestamp } from '../lib/time';
  import { agentIdentityFromLabel, mergeAgentLabelTokens } from '../lib/agentIdentity';
  import { isSystemMessage } from '../lib/messages';
  import { buildTaskTree, type TaskTreeRow } from '../lib/tasks';
  import Markdown from '../lib/Markdown.svelte';
  import {
    appendSkillSuggestion,
    skillSuggestionsForHarness,
  } from '../lib/skillSuggestions';
  import { agentRuntimeProfiles } from '../stores/agentProfiles';
  import {
    assetAttachments,
    projectAssets,
  } from '../stores/projectAssets';
  import {
    annotations,
    events as eventsStore,
    kvEntries,
    instances,
    tasks as taskStore,
  } from '../stores/swarm';

  export let selectedNode: XYFlowNode | null = null;
  export let selectedEdge: XYFlowEdge | null = null;

  // Determine what we're inspecting
  $: inspectingNode = selectedNode !== null;
  $: inspectingEdge = selectedEdge !== null && selectedNode === null;
  $: nodeData = selectedNode?.data as SwarmNodeData | null;

  // Every edge is now a unified `connection` bundling messages, tasks, and
  // dependencies between the same unordered instance pair.
  $: edgeData = selectedEdge?.data as ConnectionEdgeData | null;

  let identityFormSourceKey = '';
  let identityName = '';
  let identityRole = '';
  let identityPersona = '';
  let identityMission = '';
  let identitySkills = '';
  let identityPermissions = '';
  let identitySaving = false;
  let identitySaved = false;
  let identityError: string | null = null;

  $: syncIdentityForm(nodeData, $agentRuntimeProfiles);
  $: identitySkillSuggestions = skillSuggestionsForHarness(
    nodeData?.agentDisplay.provider || nodeData?.ptySession?.command || nodeData?.label || '',
  );
  $: attachedAssets = nodeData?.instance
    ? $projectAssets.filter((asset) =>
        $assetAttachments.some(
          (entry) =>
            entry.assetId === asset.id &&
            entry.targetType === 'agent' &&
            entry.targetId === nodeData?.instance?.id,
        ),
      )
    : [];
  $: attachedAssetContext = buildAssetContextBlock(attachedAssets);

  function syncIdentityForm(
    node: SwarmNodeData | null,
    runtimeProfiles: Record<string, AgentRuntimeProfile>,
  ): void {
    const instance = node?.instance ?? null;
    const sourceKey = instance
      ? `${instance.id}:${instance.label ?? ''}:${runtimeProfiles[instance.id]?.updatedAt ?? 0}`
      : '';

    if (sourceKey === identityFormSourceKey) return;
    identityFormSourceKey = sourceKey;
    identitySaved = false;
    identityError = null;

    if (!instance || !node) {
      identityName = '';
      identityRole = '';
      identityPersona = '';
      identityMission = '';
      identitySkills = '';
      identityPermissions = '';
      return;
    }

    const labelIdentity = agentIdentityFromLabel(instance.label ?? null);
    const runtime = runtimeProfiles[instance.id] ?? null;
    identityName = runtime?.name || labelIdentity.name || node.displayName || '';
    identityRole = runtime?.role || labelIdentity.role || node.label || '';
    identityPersona = runtime?.persona || labelIdentity.persona || '';
    identityMission = runtime?.mission || labelIdentity.mission || '';
    identitySkills = runtime?.skills || labelIdentity.skills || '';
    identityPermissions = runtime?.permissions || labelIdentity.permissions || '';
  }

  function appendIdentitySkillSuggestion(value: string): void {
    identitySkills = appendSkillSuggestion(identitySkills, value);
  }

  // Reference edgeData.messages directly so Svelte's reactive dep tracker
  // picks up the update. A wrapper function call would hide the read and
  // freeze messageHistory at its mount-time value.
  $: rawMessageHistory = (inspectingEdge && edgeData?.messages) || [];
  $: systemMessageCount = rawMessageHistory.filter(isSystemMessage).length;
  let hideSystemMessages = false;
  $: messageHistory = hideSystemMessages
    ? rawMessageHistory.filter((m) => !isSystemMessage(m))
    : rawMessageHistory;

  $: tasks = edgeData?.tasks ?? [];
  $: deps = edgeData?.deps ?? [];

  // Parent/subtask hierarchy. Each list builds an independent tree from
  // its own subset of tasks; tasks whose parent is in the global map but
  // missing from the subset get an externalParent for breadcrumbing.
  $: assignedTaskTree = buildTaskTree(
    nodeData?.assignedTasks ?? [],
    $taskStore,
  );
  $: requestedTaskTree = buildTaskTree(
    nodeData?.requestedTasks ?? [],
    $taskStore,
  );
  $: edgeTaskTree = buildTaskTree(tasks, $taskStore);

  function indentStyle(depth: number): string {
    return `padding-left: ${depth * 14}px;`;
  }

  function externalParentLabel(parent: { title: string }): string {
    const t = parent.title;
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }

  // -------------------------------------------------------------------
  // Coordination (KV) section state. Filter to the selected scope when a
  // node or edge is selected; otherwise show every non-`ui/*` entry.
  // -------------------------------------------------------------------

  $: selectedScope = deriveSelectedScope(nodeData, edgeData, $instances);
  $: visibleKv = filterKvByScope($kvEntries, selectedScope);

  let kvCollapsed = false;
  let expandedKvKeys = new Set<string>();

  function deriveSelectedScope(
    node: SwarmNodeData | null,
    edge: ConnectionEdgeData | null,
    instMap: Map<string, { scope: string }>,
  ): string | null {
    if (node?.instance?.scope) return node.instance.scope;
    if (edge) {
      const source = instMap.get(edge.sourceInstanceId);
      if (source?.scope) return source.scope;
      const target = instMap.get(edge.targetInstanceId);
      if (target?.scope) return target.scope;
    }
    return null;
  }

  function filterKvByScope(entries: KvEntry[], scope: string | null): KvEntry[] {
    if (!scope) return entries;
    return entries.filter((entry) => entry.scope === scope);
  }

  function kvRowKey(entry: KvEntry): string {
    return `${entry.scope}::${entry.key}`;
  }

  function toggleKvRow(entry: KvEntry): void {
    const key = kvRowKey(entry);
    const next = new Set(expandedKvKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedKvKeys = next;
  }

  function isKvExpanded(entry: KvEntry, expanded: Set<string>): boolean {
    return expanded.has(kvRowKey(entry));
  }

  function kvSummary(value: string): string {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  }

  function kvDetail(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  // -------------------------------------------------------------------
  // Context (annotations) section. When a node is selected, filter to
  // rows where instance_id === node.instance.id; otherwise filter by
  // selected scope, falling back to all entries.
  // -------------------------------------------------------------------

  $: visibleAnnotations = filterAnnotations(
    $annotations,
    nodeData?.instance?.id ?? null,
    selectedScope,
  );
  $: annotationsByType = groupAnnotationsByType(visibleAnnotations);
  $: annotationTypeOrder = orderTypes([...annotationsByType.keys()]);

  function filterAnnotations(
    rows: Annotation[],
    instanceId: string | null,
    scope: string | null,
  ): Annotation[] {
    if (instanceId) return rows.filter((a) => a.instance_id === instanceId);
    if (scope) return rows.filter((a) => a.scope === scope);
    return rows;
  }

  function groupAnnotationsByType(rows: Annotation[]): Map<string, Annotation[]> {
    const map = new Map<string, Annotation[]>();
    for (const row of rows) {
      const group = map.get(row.type);
      if (group) group.push(row);
      else map.set(row.type, [row]);
    }
    return map;
  }

  // Lock first (it's the high-frequency type), then everything else
  // alphabetically so the section stays predictable as new types appear.
  function orderTypes(types: string[]): string[] {
    const known = ['lock', 'finding', 'warning', 'bug', 'todo', 'note'];
    const seen = new Set(types);
    const ordered: string[] = [];
    for (const t of known) {
      if (seen.has(t)) {
        ordered.push(t);
        seen.delete(t);
      }
    }
    return [...ordered, ...[...seen].sort()];
  }

  function annotationTypeColor(type: string): string {
    switch (type) {
      case 'lock': return 'var(--status-stale, #f9e2af)';
      case 'finding': return 'var(--edge-message, #89b4fa)';
      case 'warning': return 'var(--status-stale, #f9e2af)';
      case 'bug': return 'var(--edge-task-failed, #f38ba8)';
      case 'todo': return 'var(--edge-task-open, #fab387)';
      case 'note': return '#a6adc8';
      default: return '#a6adc8';
    }
  }

  // -------------------------------------------------------------------
  // Activity section. Filter chips for the five event categories;
  // selected scope filters by event.scope to match KV/Context behavior.
  // -------------------------------------------------------------------

  type EventCategory = 'message' | 'task' | 'kv' | 'context' | 'instance';

  const ACTIVITY_CATEGORIES: { id: EventCategory; label: string; color: string }[] = [
    { id: 'message',  label: 'messages',  color: 'var(--edge-message, #89b4fa)' },
    { id: 'task',     label: 'tasks',     color: 'var(--edge-task-in-progress, #f9e2af)' },
    { id: 'kv',       label: 'kv',        color: 'var(--badge-reviewer, #a6e3a1)' },
    { id: 'context',  label: 'context',   color: 'var(--edge-task-open, #fab387)' },
    { id: 'instance', label: 'instances', color: '#a6adc8' },
  ];

  let activityCollapsed = false;
  let activityFilter: Set<EventCategory> = new Set(
    ACTIVITY_CATEGORIES.map((c) => c.id),
  );
  let expandedEventIds = new Set<number>();

  function categoryOf(type: string): EventCategory | null {
    if (type.startsWith('message.')) return 'message';
    if (type.startsWith('task.')) return 'task';
    if (type.startsWith('kv.')) return 'kv';
    if (type.startsWith('context.')) return 'context';
    if (type.startsWith('instance.')) return 'instance';
    return null;
  }

  function toggleCategory(cat: EventCategory): void {
    const next = new Set(activityFilter);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    activityFilter = next;
  }

  $: visibleEvents = filterEvents($eventsStore, activityFilter, selectedScope);

  function filterEvents(
    rows: Event[],
    chips: Set<EventCategory>,
    scope: string | null,
  ): Event[] {
    const out: Event[] = [];
    for (const row of rows) {
      if (scope && row.scope !== scope) continue;
      const cat = categoryOf(row.type);
      if (!cat || !chips.has(cat)) continue;
      out.push(row);
    }
    // Newest first — store keeps the natural append order.
    return out.slice().reverse();
  }

  function toggleEventRow(evt: Event): void {
    const next = new Set(expandedEventIds);
    if (next.has(evt.id)) next.delete(evt.id);
    else next.add(evt.id);
    expandedEventIds = next;
  }

  function eventColor(type: string): string {
    const cat = categoryOf(type);
    if (!cat) return '#a6adc8';
    const found = ACTIVITY_CATEGORIES.find((c) => c.id === cat);
    return found?.color ?? '#a6adc8';
  }

  function shortId(value: string | null): string {
    if (!value) return '';
    return value.length > 12 ? value.slice(0, 8) : value;
  }

  function eventSummary(evt: Event): string {
    if (!evt.payload) return '';
    try {
      const parsed = JSON.parse(evt.payload);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.status === 'string') return `→ ${obj.status}`;
        if (typeof obj.title === 'string') return obj.title.slice(0, 40);
        if (typeof obj.recipients === 'number') return `${obj.recipients} recipient(s)`;
        if (typeof obj.length === 'number') return `len ${obj.length}`;
      }
      return '';
    } catch {
      return evt.payload.slice(0, 40);
    }
  }

  function eventDetail(evt: Event): string {
    if (!evt.payload) return '(no payload)';
    try {
      return JSON.stringify(JSON.parse(evt.payload), null, 2);
    } catch {
      return evt.payload;
    }
  }

  async function handleSaveIdentity(): Promise<void> {
    const instance = nodeData?.instance ?? null;
    if (!instance || identitySaving) return;

    identitySaving = true;
    identitySaved = false;
    identityError = null;

    try {
      const nextLabel = mergeAgentLabelTokens(instance.label ?? null, {
        name: identityName,
        role: identityRole,
        persona: identityPersona,
      });

      await invoke<boolean>('ui_set_instance_label', {
        instanceId: instance.id,
        label: nextLabel,
      });

      agentRuntimeProfiles.save({
        instanceId: instance.id,
        name: identityName.trim(),
        role: identityRole.trim(),
        persona: identityPersona.trim(),
        mission: identityMission.trim(),
        skills: identitySkills.trim(),
        permissions: identityPermissions.trim(),
        updatedAt: Date.now(),
      });

      identitySaved = true;
    } catch (err) {
      identityError = `Failed to save identity: ${err}`;
    } finally {
      identitySaving = false;
    }
  }

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

      <section>
        <div class="section-head">
          <h4>Agent Identity</h4>
          {#if nodeData.instance}
            <button
              class="delete-btn identity-save"
              disabled={identitySaving}
              on:click={handleSaveIdentity}
            >
              {identitySaving ? 'Saving...' : identitySaved ? 'Saved' : 'Save'}
            </button>
          {/if}
        </div>

        {#if identityError}
          <div class="error-banner">{identityError}</div>
        {/if}

        {#if nodeData.instance}
          <div class="identity-form">
            <label>
              <span>Name</span>
              <input class="identity-input" bind:value={identityName} />
            </label>
            <label>
              <span>Role</span>
              <input class="identity-input" bind:value={identityRole} />
            </label>
            <label>
              <span>Persona</span>
              <input class="identity-input" bind:value={identityPersona} />
            </label>
            <label class="identity-wide">
              <span>Mission</span>
              <textarea class="identity-input identity-textarea" bind:value={identityMission}></textarea>
            </label>
            <label class="identity-wide">
              <span>Skills</span>
              <textarea class="identity-input identity-textarea" bind:value={identitySkills}></textarea>
              <div class="skill-suggestion-row" aria-label="Skill suggestions">
                {#each identitySkillSuggestions as suggestion (suggestion.id)}
                  <button
                    type="button"
                    class="suggestion-chip"
                    title={suggestion.value}
                    on:click={() => appendIdentitySkillSuggestion(suggestion.value)}
                  >
                    {suggestion.label}
                  </button>
                {/each}
              </div>
            </label>
            <label class="identity-wide">
              <span>Permissions</span>
              <textarea class="identity-input identity-textarea" bind:value={identityPermissions}></textarea>
            </label>
          </div>
        {:else}
          <div class="empty-state">No registered agent identity yet</div>
        {/if}
      </section>

      <section>
        <h4>Listener Health</h4>
        <div class="detail-grid">
          <span class="detail-label">State</span>
          <span class="detail-value">
            <span class="inline-badge" style="color: {statusBadgeColor(nodeData.status)}">
              {nodeData.listenerHealth.label}
            </span>
          </span>

          <span class="detail-label">Detail</span>
          <span class="detail-value">{nodeData.listenerHealth.detail}</span>

          <span class="detail-label">Unread</span>
          <span class="detail-value">{nodeData.listenerHealth.unreadMessages}</span>

          <span class="detail-label">Active Tasks</span>
          <span class="detail-value">{nodeData.listenerHealth.activeTaskCount}</span>

          <span class="detail-label">Last Poll</span>
          <span class="detail-value">{formatTimestamp(nodeData.listenerHealth.lastPollAt)}</span>

          <span class="detail-label">Wait Loop</span>
          <span class="detail-value">{formatTimestamp(nodeData.listenerHealth.lastWaitAt)}</span>
        </div>
      </section>

      {#if nodeData.instance}
        <section>
          <h4>Attached Assets</h4>
          {#if attachedAssets.length === 0}
            <div class="empty-state">No project assets attached.</div>
          {:else}
            <div class="asset-list">
              {#each attachedAssets as asset (asset.id)}
                <div class="asset-row">
                  <span>{asset.kind}</span>
                  <strong>{asset.title}</strong>
                  {#if asset.path}
                    <code>{asset.path}</code>
                  {/if}
                </div>
              {/each}
            </div>
            <pre class="asset-context">{attachedAssetContext}</pre>
          {/if}
        </section>
      {/if}

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

            <span class="detail-label">Channel</span>
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
      {#if assignedTaskTree.length > 0}
        <section>
          <h4>Assigned Tasks ({assignedTaskTree.length})</h4>
          <div class="task-list">
            {#each assignedTaskTree as row (row.task.id)}
              {#if row.externalParent}
                <div class="task-breadcrumb" style={indentStyle(row.depth)}>
                  ↑ parent: {externalParentLabel(row.externalParent)}
                </div>
              {/if}
              <div class="task-item" style={indentStyle(row.depth)}>
                {#if row.depth > 0}<span class="task-connector mono">└─</span>{/if}
                <span class="inline-badge" style="color: {statusBadgeColor(row.task.status)}">
                  {row.task.status}
                </span>
                <span class="task-title">{row.task.title}</span>
                <span class="task-type">{row.task.type}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Requested tasks -->
      {#if requestedTaskTree.length > 0}
        <section>
          <h4>Requested Tasks ({requestedTaskTree.length})</h4>
          <div class="task-list">
            {#each requestedTaskTree as row (row.task.id)}
              {#if row.externalParent}
                <div class="task-breadcrumb" style={indentStyle(row.depth)}>
                  ↑ parent: {externalParentLabel(row.externalParent)}
                </div>
              {/if}
              <div class="task-item" style={indentStyle(row.depth)}>
                {#if row.depth > 0}<span class="task-connector mono">└─</span>{/if}
                <span class="inline-badge" style="color: {statusBadgeColor(row.task.status)}">
                  {row.task.status}
                </span>
                <span class="task-title">{row.task.title}</span>
              </div>
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

      {#if rawMessageHistory.length > 0}
        <section>
          <div class="section-head">
            <h4>
              Messages ({messageHistory.length}{hideSystemMessages && systemMessageCount > 0
                ? ` · ${systemMessageCount} hidden`
                : ''})
            </h4>
            {#if systemMessageCount > 0}
              <label class="hide-system-toggle" title="Hide [auto] and [signal:*] messages">
                <input
                  type="checkbox"
                  bind:checked={hideSystemMessages}
                />
                hide system
              </label>
            {/if}
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
              {@const sysMsg = isSystemMessage(msg)}
              <div class="message-item" class:system={sysMsg}>
                <div class="message-meta">
                  {#if sysMsg}
                    <span class="system-badge" title="Swarm-internal event, not a peer message">
                      SYSTEM
                    </span>
                  {/if}
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

      {#if edgeTaskTree.length > 0}
        <section>
          <h4>Tasks ({edgeTaskTree.length})</h4>
          <div class="task-list">
            {#each edgeTaskTree as row (row.task.id)}
              {#if row.externalParent}
                <div class="task-breadcrumb" style={indentStyle(row.depth)}>
                  ↑ parent: {externalParentLabel(row.externalParent)}
                </div>
              {/if}
              <div class="task-row" style={indentStyle(row.depth)}>
                {#if row.depth > 0}<span class="task-connector mono">└─</span>{/if}
                <span class="inline-badge" style="color: {statusBadgeColor(row.task.status)}">
                  {row.task.status}
                </span>
                <span class="task-title" title={row.task.description ?? ''}>{row.task.title}</span>
                <span class="task-type">{row.task.type}</span>
                <button
                  class="delete-btn small"
                  disabled={pendingAction === `task:${row.task.id}`}
                  on:click={() => handleUnassignTask(row.task.id)}
                  title="Unassign this task (clears the assignee)"
                >
                  {pendingAction === `task:${row.task.id}` ? '…' : 'Unassign'}
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

      {#if rawMessageHistory.length === 0 && edgeTaskTree.length === 0 && deps.length === 0}
        <div class="empty-state">No activity on this connection</div>
      {/if}

    {:else}
      <div class="empty-state">
        Select a node or edge to inspect
      </div>
    {/if}

    {#if visibleAnnotations.length > 0}
      <section class="context-section">
        <h4>
          Context ({visibleAnnotations.length}{nodeData?.instance ? '' : selectedScope ? '' : ' · all channels'})
        </h4>
        <div class="annotation-groups">
          {#each annotationTypeOrder as type (type)}
            {@const rows = annotationsByType.get(type) ?? []}
            <div class="annotation-group">
              <div class="annotation-group-head">
                <span
                  class="type-chip"
                  style:color={annotationTypeColor(type)}
                  style:border-color={annotationTypeColor(type)}
                >
                  {type}
                </span>
                <span class="annotation-group-count">{rows.length}</span>
              </div>
              <div class="annotation-list">
                {#each rows as ann (ann.id)}
                  <div class="annotation-item">
                    {#if type === 'lock'}
                      <div class="annotation-file mono" title={ann.file}>{ann.file}</div>
                    {:else}
                      <div class="annotation-meta">
                        <span class="annotation-file mono" title={ann.file}>{ann.file}</span>
                        <span class="annotation-time">{formatTimestamp(ann.created_at)}</span>
                      </div>
                      <div class="annotation-content"><Markdown content={ann.content} /></div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if $eventsStore.length > 0}
      <section class="activity-section">
        <button
          type="button"
          class="kv-toggle"
          on:click={() => (activityCollapsed = !activityCollapsed)}
          aria-expanded={!activityCollapsed}
        >
          <span class="kv-caret" class:open={!activityCollapsed}>▸</span>
          <span class="kv-title">
            Activity ({visibleEvents.length}{selectedScope ? '' : ' · all channels'})
          </span>
        </button>
        {#if !activityCollapsed}
          <div class="activity-chips">
            {#each ACTIVITY_CATEGORIES as cat (cat.id)}
              {@const on = activityFilter.has(cat.id)}
              <button
                type="button"
                class="activity-chip"
                class:active={on}
                style:color={on ? cat.color : '#6c7086'}
                style:border-color={on ? cat.color : 'rgba(108, 112, 134, 0.4)'}
                on:click={() => toggleCategory(cat.id)}
              >
                {cat.label}
              </button>
            {/each}
          </div>
          {#if visibleEvents.length === 0}
            <div class="activity-empty">No events match the current filter.</div>
          {:else}
            <div class="activity-list">
              {#each visibleEvents as evt (evt.id)}
                {@const expanded = expandedEventIds.has(evt.id)}
                <div class="activity-row" class:expanded>
                  <button
                    type="button"
                    class="activity-row-head"
                    on:click={() => toggleEventRow(evt)}
                  >
                    <span class="activity-time">{formatTimestamp(evt.created_at)}</span>
                    <span class="activity-type" style:color={eventColor(evt.type)}>
                      {evt.type}
                    </span>
                    <span class="activity-actor mono" title={evt.actor ?? ''}>
                      {shortId(evt.actor)}
                    </span>
                    <span class="activity-arrow">›</span>
                    <span class="activity-subject mono" title={evt.subject ?? ''}>
                      {shortId(evt.subject)}
                    </span>
                    <span class="activity-summary">{eventSummary(evt)}</span>
                  </button>
                  {#if expanded}
                    <pre class="activity-detail mono">{eventDetail(evt)}</pre>
                    {#if !selectedScope}
                      <div class="kv-meta">channel: <span class="mono">{evt.scope}</span></div>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </section>
    {/if}

    {#if visibleKv.length > 0}
      <section class="kv-section">
        <button
          type="button"
          class="kv-toggle"
          on:click={() => (kvCollapsed = !kvCollapsed)}
          aria-expanded={!kvCollapsed}
        >
          <span class="kv-caret" class:open={!kvCollapsed}>▸</span>
          <span class="kv-title">
            Coordination (KV) ({visibleKv.length}{selectedScope ? '' : ' · all channels'})
          </span>
        </button>
        {#if !kvCollapsed}
          <div class="kv-list">
            {#each visibleKv as entry (kvRowKey(entry))}
              {@const expanded = isKvExpanded(entry, expandedKvKeys)}
              <div class="kv-row" class:expanded>
                <button
                  type="button"
                  class="kv-row-head"
                  on:click={() => toggleKvRow(entry)}
                  title={`updated ${formatTimestamp(entry.updated_at)}`}
                >
                  <span class="kv-key mono">{entry.key}</span>
                  {#if !expanded}
                    <span class="kv-value-summary mono">{kvSummary(entry.value)}</span>
                  {/if}
                </button>
                {#if expanded}
                  <pre class="kv-value-detail mono">{kvDetail(entry.value)}</pre>
                  {#if !selectedScope}
                    <div class="kv-meta">channel: <span class="mono">{entry.scope}</span></div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
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

  .identity-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .identity-form label {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .identity-form label span {
    color: #6c7086;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .identity-wide {
    grid-column: 1 / -1;
  }

  .identity-input {
    min-width: 0;
    width: 100%;
    border: 1px solid rgba(108, 112, 134, 0.35);
    border-radius: 6px;
    background: rgba(17, 17, 27, 0.72);
    color: var(--terminal-fg, #c0caf5);
    padding: 7px 8px;
    font: inherit;
    font-size: 12px;
    line-height: 1.35;
  }

  .identity-input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--node-border-selected, #89b4fa) 60%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--node-border-selected, #89b4fa) 16%, transparent);
  }

  .identity-textarea {
    min-height: 62px;
    resize: vertical;
  }

  .skill-suggestion-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .suggestion-chip {
    border: 1px solid rgba(108, 112, 134, 0.26);
    border-radius: 999px;
    background: rgba(17, 17, 27, 0.2);
    color: #a6adc8;
    padding: 3px 8px;
    font-size: 10px;
    line-height: 1.2;
    cursor: pointer;
  }

  .suggestion-chip:hover {
    border-color: rgba(137, 180, 250, 0.5);
    color: #cdd6f4;
  }

  .identity-save {
    border-color: color-mix(in srgb, var(--status-online, #a6e3a1) 38%, transparent);
    color: var(--status-online, #a6e3a1);
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

  .task-connector {
    color: #6c7086;
    font-size: 11px;
    flex-shrink: 0;
    margin-right: 2px;
  }

  .task-breadcrumb {
    color: #6c7086;
    font-size: 10px;
    font-style: italic;
    padding: 2px 0;
    border-bottom: none;
  }

  .annotation-groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .annotation-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .annotation-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .annotation-group-count {
    color: #6c7086;
    font-size: 10px;
  }

  .type-chip {
    display: inline-block;
    border: 1px solid;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: transparent;
  }

  .annotation-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .annotation-item {
    padding: 3px 0;
    font-size: 11px;
    border-bottom: 1px solid rgba(108, 112, 134, 0.1);
  }

  .annotation-item:last-child {
    border-bottom: none;
  }

  .annotation-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .annotation-file {
    color: #a6adc8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .annotation-time {
    color: #6c7086;
    font-size: 10px;
    flex-shrink: 0;
  }

  .annotation-content {
    color: #cdd6f4;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
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

  .message-item.system {
    background: rgba(108, 112, 134, 0.08);
    border-left: 2px solid #6c7086;
    padding-left: 8px;
    margin-left: -8px;
  }

  .message-item.system .message-content {
    color: #7a7f99;
  }

  .system-badge {
    display: inline-block;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(108, 112, 134, 0.2);
    color: #a6adc8;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    border: 1px solid rgba(108, 112, 134, 0.4);
  }

  .hide-system-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: #6c7086;
    cursor: pointer;
    user-select: none;
  }

  .hide-system-toggle input {
    margin: 0;
    cursor: pointer;
    accent-color: #6c7086;
  }

  .hide-system-toggle:hover {
    color: #a6adc8;
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

  .context-section,
  .kv-section,
  .activity-section {
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid rgba(108, 112, 134, 0.18);
  }

  .activity-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }

  .activity-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid;
    background: transparent;
    font-size: 9.5px;
    font-weight: 600;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: opacity 0.12s ease;
  }

  .activity-chip.active {
    opacity: 1;
  }

  .activity-chip:not(.active) {
    opacity: 0.55;
  }

  .activity-empty {
    color: #6c7086;
    font-size: 11px;
    padding: 4px 0;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .activity-row {
    border-radius: 3px;
  }

  .activity-row.expanded {
    background: rgba(108, 112, 134, 0.06);
  }

  .activity-row-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: transparent;
    border: none;
    padding: 3px 6px;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    overflow: hidden;
  }

  .activity-row-head:hover {
    background: rgba(108, 112, 134, 0.1);
  }

  .activity-time {
    color: #6c7086;
    font-size: 9.5px;
    flex-shrink: 0;
    width: 56px;
  }

  .activity-type {
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .activity-actor {
    color: #a6adc8;
    font-size: 10px;
    flex-shrink: 0;
  }

  .activity-arrow {
    color: #6c7086;
    font-size: 10px;
    flex-shrink: 0;
  }

  .activity-subject {
    color: #a6adc8;
    font-size: 10px;
    flex-shrink: 0;
  }

  .activity-summary {
    color: #6c7086;
    font-size: 10px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-detail {
    margin: 0;
    padding: 4px 8px 6px 8px;
    font-size: 10.5px;
    line-height: 1.4;
    color: #cdd6f4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
  }

  .kv-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: transparent;
    border: none;
    padding: 0 0 8px 0;
    color: #a6adc8;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }

  .kv-toggle:hover {
    color: var(--terminal-fg, #c0caf5);
  }

  .kv-caret {
    display: inline-block;
    color: #6c7086;
    font-size: 9px;
    transition: transform 0.12s ease;
  }

  .kv-caret.open {
    transform: rotate(90deg);
  }

  .kv-title {
    flex: 1;
  }

  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .kv-row {
    border-radius: 3px;
  }

  .kv-row.expanded {
    background: rgba(108, 112, 134, 0.06);
  }

  .kv-row-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: none;
    padding: 4px 6px;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    overflow: hidden;
  }

  .kv-row-head:hover {
    background: rgba(108, 112, 134, 0.1);
  }

  .kv-key {
    color: var(--edge-message, #89b4fa);
    flex-shrink: 0;
    font-size: 11px;
  }

  .kv-value-summary {
    color: #a6adc8;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .kv-value-detail {
    margin: 0;
    padding: 6px 8px 8px 8px;
    font-size: 11px;
    line-height: 1.4;
    color: #cdd6f4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow: auto;
  }

  .kv-meta {
    padding: 0 8px 6px 8px;
    color: #6c7086;
    font-size: 10px;
  }

  .asset-list {
    display: grid;
    gap: 6px;
  }

  .asset-row {
    display: grid;
    gap: 3px;
    border: 1px solid rgba(108, 112, 134, 0.22);
    background: rgba(108, 112, 134, 0.06);
    padding: 8px;
  }

  .asset-row span {
    color: var(--edge-message, #89b4fa);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .asset-row strong {
    color: #cdd6f4;
    font-size: 12px;
  }

  .asset-row code,
  .asset-context {
    color: #a6adc8;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    overflow-wrap: anywhere;
  }

  .asset-context {
    margin: 8px 0 0;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    border: 1px solid rgba(108, 112, 134, 0.18);
    background: rgba(0, 0, 0, 0.18);
    padding: 8px;
  }

  /* ── Tron Encom OS overrides ──────────────────────────────────────────
     White-LED hairlines, sharp corners, uppercase HUD type. The mock's
     sidebar has manila-folder rows with status pills on the right; here
     we keep the existing structure and re-skin the chrome. */
  :global([data-theme="tron-encom-os"]) .inspector {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) h4 {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
    border-bottom: 1px solid var(--led-line, #d8dde6);
    padding-bottom: 6px;
  }

  :global([data-theme="tron-encom-os"]) .delete-btn {
    border-radius: 0;
    background: rgba(255, 58, 76, 0.1);
    border: 1px solid var(--c-red, #ff3a4c);
    color: var(--c-red, #ff3a4c);
    box-shadow: 0 0 4px rgba(255, 58, 76, 0.25);
  }

  :global([data-theme="tron-encom-os"]) .delete-btn:hover:not(:disabled) {
    background: rgba(255, 58, 76, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .error-banner {
    border-radius: 0;
    background: rgba(255, 58, 76, 0.1);
    border: 1px solid var(--c-red, #ff3a4c);
    color: var(--c-red, #ff3a4c);
  }

  :global([data-theme="tron-encom-os"]) .task-row {
    border-bottom: 1px solid var(--led-line-s, rgba(216, 221, 230, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .detail-label {
    color: var(--fg-secondary, #8a94a0);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 10.5px;
  }

  :global([data-theme="tron-encom-os"]) input,
  :global([data-theme="tron-encom-os"]) textarea {
    border-radius: 0;
    background: var(--bg-input, #02040a);
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) button {
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
</style>
