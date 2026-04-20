<!--
  TerminalNode.svelte — Agent/PTY node card with embedded terminal

  XYFlow custom node component. Renders:
  - NodeHeader at top with role, status, controls
  - TerminalPane body when a PTY is present
  - Instance metadata card if no PTY (external instance)

  Fullscreen behavior is app-owned: App.svelte resolves Cmd/Ctrl+Shift+F
  against the selected node (falling back to the focused terminal) and mounts
  a FullscreenWorkspace overlay. This node doesn't own shortcut routing or
  requestFullscreen itself — that would only scale the node DOM and block
  tabs/splits.
-->
<script lang="ts">
  import { Handle, Position, NodeResizer } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import { workspaceOverlayActive } from '../lib/workspaceOverlay';
  import {
    compactNodeIds,
    requestNodeWorkspace,
    toggleCompactNode,
  } from '../lib/app/nodeWindowState';
  import NodeHeader from './NodeHeader.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import '../styles/terminal.css';

  // XYFlow node props
  export let id: string;
  export let data: SwarmNodeData;
  export let selected: boolean = false;

  let nodeElement: HTMLDivElement | null = null;
  let paneRef: TerminalPane | null = null;

  // Derived from data
  $: hasPty = data.ptySession !== null;
  $: ptyId = data.ptySession?.id ?? null;
  $: instance = data.instance;
  $: role = data.label;
  $: instanceId = instance?.id ?? null;
  $: status = data.status;
  $: cwd = data.ptySession?.cwd ?? instance?.directory ?? '';
  $: displayName = data.displayName ?? null;
  $: mobileControlled = Boolean(data.mobileControlled);
  $: mobileLeaseHolder = typeof data.mobileLeaseHolder === 'string'
    ? data.mobileLeaseHolder
    : null;
  $: compact = $compactNodeIds.has(id);
  $: workspaceActive = $workspaceOverlayActive;
  $: compactKindLabel = data.nodeType === 'bound'
    ? 'Agent'
    : data.nodeType === 'instance'
      ? 'External'
      : 'Shell';
  $: compactActivityLabel = instance
    ? formatTimestamp(instance.heartbeat ?? instance.registered_at)
    : formatTimestamp(data.ptySession?.started_at ?? null);
  $: compactDetail = cwd || data.ptySession?.command || instance?.label || '--';
  $: compactStatusLabel = status.charAt(0).toUpperCase() + status.slice(1);

  function handleInspect() {
    nodeElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  function handleFocus() {
    handleInspect();
    if (compact && ptyId) {
      requestNodeWorkspace(id);
      return;
    }
    paneRef?.focus();
  }

  function handleCompact() {
    handleInspect();
    toggleCompactNode(id);
  }

  function handleFullscreen() {
    if (!ptyId) return;
    handleInspect();
    requestNodeWorkspace(id);
  }

  function sideToPosition(side: string): Position {
    switch (side) {
      case 'top': return Position.Top;
      case 'right': return Position.Right;
      case 'bottom': return Position.Bottom;
      case 'left': return Position.Left;
      default: return Position.Right;
    }
  }
</script>

<div
  bind:this={nodeElement}
  class="terminal-node"
  class:selected
  class:compact
  class:mobile-controlled={mobileControlled}
  data-node-id={id}
>
  <!-- Resize handles on all four corners + edges. Only visible when the node
       is selected so they don't clutter the canvas. -->
  <NodeResizer
    minWidth={360}
    minHeight={260}
    isVisible={selected && !mobileControlled && !compact}
    lineClass="resize-line"
    handleClass="resize-handle"
  />

  <!-- Port handles on all four sides. The adaptive edge router picks
       whichever pair (source-side on this node, target-side on the other)
       produces the shortest distance, and the edge anchors on those exact
       dots. Having both source and target variants per side lets the
       drag-to-message gesture start/land anywhere. Disabled on `pty:`
       nodes (plain shells with no swarm identity). -->
  {#each ['top', 'right', 'bottom', 'left'] as side (side)}
    <Handle
      id="t-{side}"
      type="target"
      position={sideToPosition(side)}
      isConnectable={data.nodeType !== 'pty'}
    />
    <Handle
      id="s-{side}"
      type="source"
      position={sideToPosition(side)}
      isConnectable={data.nodeType !== 'pty'}
    />
  {/each}

  <NodeHeader
    {role}
    {instanceId}
    {status}
    {cwd}
    {displayName}
    nodeType={data.nodeType}
    assignedTasks={data.assignedTasks}
    locks={data.locks}
    ptyId={ptyId}
    launchToken={data.ptySession?.launch_token ?? null}
    adopted={instance?.adopted ?? true}
    {mobileControlled}
    {compact}
    mobileLeaseHolder={mobileLeaseHolder}
    on:inspect={handleInspect}
    on:focus={handleFocus}
    on:compact={handleCompact}
    on:fullscreen={handleFullscreen}
  />

  {#if compact}
    <div class="terminal-compact-card">
      <div class="compact-summary-row">
        <span class="compact-pill">{compactKindLabel}</span>
        <span class="compact-pill status {status}">{compactStatusLabel}</span>
        {#if mobileControlled}
          <span class="compact-pill">Mobile</span>
        {/if}
      </div>

      <div class="compact-stats">
        <div class="compact-stat">
          <span class="compact-stat-label">Tasks</span>
          <span class="compact-stat-value">{data.assignedTasks.length}</span>
        </div>
        <div class="compact-stat">
          <span class="compact-stat-label">Locks</span>
          <span class="compact-stat-value">{data.locks.length}</span>
        </div>
        <div class="compact-stat">
          <span class="compact-stat-label">{instance ? 'Heartbeat' : 'Started'}</span>
          <span class="compact-stat-value">{compactActivityLabel}</span>
        </div>
      </div>

      <div class="compact-detail" title={compactDetail}>
        {compactDetail}
      </div>
    </div>
  {:else if hasPty && ptyId && !workspaceActive}
    <TerminalPane
      bind:this={paneRef}
      {ptyId}
    />
  {:else if hasPty}
    <div class="terminal-suspended">
      <span class="terminal-suspended-chip">Immersive Workspace Active</span>
    </div>
  {:else if instance}
    <!-- Instance metadata card (no local PTY) -->
    <div class="instance-meta-card">
      <div class="meta-row">
        <span class="meta-label">ID</span>
        <span class="meta-value" title={instance.id}>{instance.id}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Scope</span>
        <span class="meta-value">{instance.scope}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">PID</span>
        <span class="meta-value">{instance.pid}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Directory</span>
        <span class="meta-value" title={instance.directory}>{instance.directory}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Heartbeat</span>
        <span class="meta-value">{formatTimestamp(instance.heartbeat)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Registered</span>
        <span class="meta-value">{formatTimestamp(instance.registered_at)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Label</span>
        <span class="meta-value">{instance.label ?? '--'}</span>
      </div>

      {#if data.locks.length > 0}
        <div class="meta-row" style="margin-top: 4px;">
          <span class="meta-label">Locks</span>
          <span class="meta-value">{data.locks.length} file(s)</span>
        </div>
      {/if}

      {#if data.assignedTasks.length > 0}
        <div class="meta-row">
          <span class="meta-label">Tasks</span>
          <span class="meta-value">{data.assignedTasks.length} assigned</span>
        </div>
      {/if}
    </div>
  {:else}
    <!-- PTY-only node with no instance yet -->
    <div class="instance-meta-card">
      <div class="meta-row">
        <span class="meta-label">Status</span>
        <span class="meta-value" style="color: var(--status-pending);">Waiting for instance bind...</span>
      </div>
      {#if data.ptySession?.launch_token}
        <div class="meta-row">
          <span class="meta-label">Token</span>
          <span class="meta-value">{data.ptySession.launch_token}</span>
        </div>
      {/if}
    </div>
  {/if}

</div>
