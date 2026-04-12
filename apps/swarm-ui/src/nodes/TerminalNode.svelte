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
  import { Handle, Position } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import {
    createTerminal,
    destroyTerminal,
    isExtendedHandle,
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
  let dataUnlisten: (() => void) | null = null;
  let exitUnlisten: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let exitCode: number | null = null;

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

    // Create the terminal display
    terminalHandle = createTerminal(terminalContainer, {
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Cascadia Code", monospace',
    });

    // Wire up user input -> PTY stdin
    if (isExtendedHandle(terminalHandle)) {
      terminalHandle.onData((input: string) => {
        if (ptyId) {
          const encoder = new TextEncoder();
          void writeToPty(ptyId, encoder.encode(input));
        }
      });
    }

    // Replay existing buffer contents (for reconnect/remount)
    try {
      const buffer = await getPtyBuffer(ptyId);
      if (buffer.length > 0 && terminalHandle) {
        writeToTerminal(terminalHandle, buffer);
      }
    } catch (err) {
      // Non-fatal: buffer may not be available
      console.debug('[TerminalNode] buffer replay skipped:', err);
    }

    // Subscribe to live PTY output data
    try {
      const unlisten = await subscribeToPty(ptyId, (bytes: Uint8Array) => {
        if (terminalHandle) {
          writeToTerminal(terminalHandle, bytes);
        }
      });
      dataUnlisten = unlisten;
    } catch (err) {
      console.error('[TerminalNode] failed to subscribe to PTY data:', err);
    }

    // Subscribe to PTY exit events
    try {
      const unlisten = await subscribeToPtyExit(ptyId, (code: number | null) => {
        exitCode = code;
      });
      exitUnlisten = unlisten;
    } catch (err) {
      console.error('[TerminalNode] failed to subscribe to PTY exit:', err);
    }

    // ResizeObserver to track container dimensions -> pty_resize
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!terminalHandle || !ptyId) continue;
        // Estimate cols/rows from container dimensions
        const { width, height } = entry.contentRect;
        const charWidth = 7.8; // approximate for 13px Menlo
        const lineHeight = 17; // approximate
        const cols = Math.max(1, Math.floor(width / charWidth));
        const rows = Math.max(1, Math.floor(height / lineHeight));
        terminalHandle.resize(cols, rows);
        void resizePty(ptyId, cols, rows);
      }
    });
    resizeObserver.observe(terminalContainer);
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

  function cleanupTerminal() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
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
  <!-- Source handle (left) for incoming edges -->
  <Handle type="target" position={Position.Left} />

  <NodeHeader
    {role}
    {instanceId}
    {status}
    {cwd}
    nodeType={data.nodeType}
    assignedTasks={data.assignedTasks}
    ptyId={ptyId}
    on:inspect={handleInspect}
    on:focus={handleFocus}
  />

  {#if hasPty}
    <!-- Terminal view -->
    <div class="terminal-container" bind:this={terminalContainer}>
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

  <!-- Target handle (right) for outgoing edges -->
  <Handle type="source" position={Position.Right} />
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
