<!--
  TerminalNode.svelte — Agent/PTY node card with embedded terminal

  XYFlow custom node component. Renders:
  - NodeHeader at top with role, status, controls
  - ghostty-web/xterm.js terminal if PTY is present
  - Instance metadata card if no PTY (external instance)
  
  Terminal lifecycle:
  - onMount: create terminal, subscribe to PTY data events, replay buffer
  - ResizeObserver: detect container size changes -> pty_resize
  - Terminal onData: user keyboard input -> writeToPty
  - onDestroy: clean up terminal, unsubscribe from events
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, NodeResizer } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import {
    createTerminal,
    destroyTerminal,
    writeToTerminal,
  } from '../lib/terminal';
  import type { TerminalHandle } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import {
    subscribeToPty,
    subscribeToPtyExit,
    writeToPty,
    resizePty,
    getPtyBuffer,
  } from '../stores/pty';
  import NodeHeader from './NodeHeader.svelte';
  import '../styles/terminal.css';

  // XYFlow node props
  export let id: string;
  export let data: SwarmNodeData;
  export let selected: boolean = false;

  // Terminal state
  let nodeElement: HTMLDivElement | null = null;
  let terminalContainer: HTMLElement;
  let terminalHandle: TerminalHandle | null = null;
  let terminalInputUnlisten: (() => void) | null = null;
  let dataUnlisten: (() => void) | null = null;
  let exitUnlisten: (() => void) | null = null;
  let exitCode: number | null = null;
  let disposed = false;

  // Derived from data
  $: hasPty = data.ptySession !== null;
  $: ptyId = data.ptySession?.id ?? null;
  $: instance = data.instance;
  $: role = data.label;
  $: instanceId = instance?.id ?? null;
  $: status = data.status;
  $: cwd = data.ptySession?.cwd ?? instance?.directory ?? '';

  onMount(async () => {
    if (!hasPty || !ptyId || !terminalContainer) return;
    await initTerminal();
  });

  onDestroy(() => {
    cleanupTerminal();
  });

  async function initTerminal() {
    if (!terminalContainer || !ptyId) return;

    const handle = await createTerminal(terminalContainer, {
      fontSize: 13,
    });

    if (disposed) {
      handle.dispose();
      return;
    }

    terminalHandle = handle;
    const boundPtyId = ptyId;

    // Wire user keyboard input -> PTY stdin
    const encoder = new TextEncoder();
    terminalInputUnlisten = handle.onData((input: string) => {
      void writeToPty(boundPtyId, encoder.encode(input));
    });

    // Replay ring-buffered output so reconnects/remounts keep scrollback
    try {
      const buffer = await getPtyBuffer(boundPtyId);
      if (!disposed && buffer.length > 0) {
        writeToTerminal(handle, buffer);
      }
    } catch (err) {
      console.debug('[TerminalNode] buffer replay skipped:', err);
    }

    // Subscribe to live PTY output
    try {
      dataUnlisten = await subscribeToPty(boundPtyId, (bytes) => {
        if (terminalHandle) writeToTerminal(terminalHandle, bytes);
      });
    } catch (err) {
      console.error('[TerminalNode] failed to subscribe to PTY data:', err);
    }

    try {
      exitUnlisten = await subscribeToPtyExit(boundPtyId, (code) => {
        exitCode = code;
      });
    } catch (err) {
      console.error('[TerminalNode] failed to subscribe to PTY exit:', err);
    }

    // ghostty-web's FitAddon (loaded inside createTerminal) observes the
    // container and resizes the grid using the renderer's real charWidth /
    // charHeight. We just forward the resulting size to the PTY.
    handle.onResize(({ cols, rows }) => {
      void resizePty(boundPtyId, cols, rows);
    });
  }

  function handleInspect() {
    nodeElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  function handleFocus() {
    handleInspect();

    const focusTarget = terminalContainer?.querySelector(
      'textarea, .xterm-helper-textarea, [tabindex]'
    ) as HTMLElement | null;
    focusTarget?.focus();
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

  function cleanupTerminal() {
    disposed = true;
    if (terminalInputUnlisten) {
      terminalInputUnlisten();
      terminalInputUnlisten = null;
    }
    if (dataUnlisten) {
      dataUnlisten();
      dataUnlisten = null;
    }
    if (exitUnlisten) {
      exitUnlisten();
      exitUnlisten = null;
    }
    if (terminalHandle) {
      destroyTerminal(terminalHandle);
      terminalHandle = null;
    }
  }
</script>

<div bind:this={nodeElement} class="terminal-node" class:selected data-node-id={id}>
  <!-- Resize handles on all four corners + edges. Only visible when the node
       is selected so they don't clutter the canvas. -->
  <NodeResizer
    minWidth={360}
    minHeight={260}
    isVisible={selected}
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
    nodeType={data.nodeType}
    assignedTasks={data.assignedTasks}
    ptyId={ptyId}
    launchToken={data.ptySession?.launch_token ?? null}
    adopted={instance?.adopted ?? true}
    on:inspect={handleInspect}
    on:focus={handleFocus}
  />

  {#if hasPty}
    <!-- Terminal view: nodrag/nopan/nowheel tell XYFlow to leave mouse/scroll
         events alone so ghostty can handle clicks, selection, and scrollback -->
    <div
      class="terminal-container nodrag nopan nowheel"
      bind:this={terminalContainer}
    >
      {#if exitCode !== null}
        <div class="exit-overlay">
          Process exited with code {exitCode}
        </div>
      {/if}
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

<style>
  .exit-overlay {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: var(--edge-task-cancelled, #6c7086);
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 11px;
    pointer-events: none;
    z-index: 5;
  }
</style>
