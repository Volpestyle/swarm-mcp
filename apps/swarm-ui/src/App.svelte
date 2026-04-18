<!--
  App.svelte — Main app layout with XYFlow canvas

  Root component that:
  1. Initializes swarm and PTY stores on mount
  2. Reactively builds the XYFlow graph from store state
  3. Renders the SvelteFlow canvas with custom node and edge types
  4. Manages selection state for the Inspector panel
  5. Provides the sidebar with Launcher and Inspector
  6. Overlays the SwarmStatus bar on the canvas
-->
<script lang="ts">
  import {
    SvelteFlow,
    Background,
    Controls,
    MiniMap,
    type EdgeTypes,
    type NodeTypes,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { onMount, onDestroy } from 'svelte';

  // Stores (Agent 3)
  import {
    initSwarmStore,
    destroySwarmStore,
    instances,
    tasks,
    messages,
    locks,
  } from './stores/swarm';
  import {
    ptySessions,
    bindings,
    initPtyStore,
    destroyPtyStore,
  } from './stores/pty';

  // Graph builder (Agent 3)
  import { buildGraph } from './lib/graph';
  import type { XYFlowNode, XYFlowEdge } from './lib/types';

  // Custom node types (Agent 4)
  import TerminalNode from './nodes/TerminalNode.svelte';

  // Custom edge types (Agent 4)
  import ConnectionEdge from './edges/ConnectionEdge.svelte';

  // Panels (Agent 4)
  import Inspector from './panels/Inspector.svelte';
  import Launcher from './panels/Launcher.svelte';
  import SettingsModal from './panels/SettingsModal.svelte';
  import SwarmStatus from './panels/SwarmStatus.svelte';

  // Styles
  import './styles/terminal.css';

  // -------------------------------------------------------------------
  // Node and edge type registrations for SvelteFlow
  // -------------------------------------------------------------------

  const nodeTypes: NodeTypes = {
    terminal: TerminalNode,
  };

  const edgeTypes: EdgeTypes = {
    connection: ConnectionEdge,
  };

  // -------------------------------------------------------------------
  // Graph state
  //
  // `nodes`/`edges` are bound into <SvelteFlow> so XYFlow writes drag,
  // selection, and measured-size changes straight back into these arrays.
  // When swarm state changes we merge the freshly-built graph into the
  // existing arrays instead of replacing them — that way XYFlow-owned fields
  // (position, selected, measured, width/height) survive each rebuild
  // instead of snapping back to the default grid layout.
  // -------------------------------------------------------------------

  let nodes: XYFlowNode[] = [];
  let edges: XYFlowEdge[] = [];

  // Selection state
  let selectedNodeId: string | null = null;
  let selectedEdgeId: string | null = null;
  let selectedNode: XYFlowNode | null = null;
  let selectedEdge: XYFlowEdge | null = null;
  let hasSelection = false;
  let showSettings = false;

  // Right-panel tab state. Auto-switches to 'inspect' when a node/edge is
  // selected and back to 'launch' when selection clears. Users can still
  // override by clicking a tab directly.
  let activeTab: 'launch' | 'inspect' = 'launch';

  // -------------------------------------------------------------------
  // Resizable sidebar
  //
  // User drags the .resize-handle on the sidebar's left edge. Width is
  // clamped and persisted to localStorage so it survives reloads.
  // -------------------------------------------------------------------

  const SIDEBAR_MIN = 280;
  const SIDEBAR_MAX = 900;
  const SIDEBAR_STORAGE_KEY = 'swarm-ui:sidebar-width';

  let sidebarWidth = 320;
  let resizing = false;

  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (saved) {
      const parsed = Number.parseInt(saved, 10);
      if (Number.isFinite(parsed)) {
        sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parsed));
      }
    }
  }

  function startSidebarResize(event: PointerEvent) {
    event.preventDefault();
    resizing = true;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function onSidebarResize(event: PointerEvent) {
    if (!resizing) return;
    const next = window.innerWidth - event.clientX;
    sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, next));
  }

  function endSidebarResize(event: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(sidebarWidth)));
  }

  // Reactive graph rebuild when any swarm store changes. The merge itself
  // runs inside `applyBuild()` so that reading `nodes`/`edges` doesn't
  // register as a Svelte reactive dependency of this block — otherwise the
  // `nodes = ...` assignment below would cause the block to re-run in a loop.
  $: applyBuild(
    buildGraph(
      $instances,
      $ptySessions,
      $tasks,
      $messages,
      $locks,
      $bindings,
    ),
  );

  function applyBuild(built: { nodes: XYFlowNode[]; edges: XYFlowEdge[] }) {
    nodes = mergeNodes(nodes, built.nodes);
    edges = mergeEdges(edges, built.edges);
  }

  /**
   * For each freshly-built node that already exists by id, overlay the new
   * `data` on top of the previous entry so XYFlow-owned fields (position,
   * selected, dragging, measured, width/height) survive the rebuild. New
   * nodes use their initial grid position from buildGraph; removed ones drop.
   */
  function mergeNodes(existing: XYFlowNode[], next: XYFlowNode[]): XYFlowNode[] {
    const byId = new Map(existing.map((n) => [n.id, n]));
    return next.map((fresh) => {
      const prev = byId.get(fresh.id);
      if (!prev) return fresh;
      return { ...prev, data: fresh.data };
    });
  }

  /** Preserve `selected` on edges; everything else is derived from state. */
  function mergeEdges(existing: XYFlowEdge[], next: XYFlowEdge[]): XYFlowEdge[] {
    const byId = new Map(existing.map((e) => [e.id, e]));
    return next.map((fresh) => {
      const prev = byId.get(fresh.id);
      if (!prev) return fresh;
      return prev.selected !== undefined
        ? { ...fresh, selected: prev.selected }
        : fresh;
    });
  }

  // Look up selected node/edge objects for the inspector
  $: selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  $: selectedEdge = selectedEdgeId
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;
  $: hasSelection = selectedNode !== null || selectedEdge !== null;
  $: activeTab = hasSelection ? 'inspect' : 'launch';

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  onMount(async () => {
    await Promise.all([initSwarmStore(), initPtyStore()]);
  });

  onDestroy(() => {
    destroySwarmStore();
    destroyPtyStore();
  });

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  function handleNodeClick({ node }: { node: { id: string } }) {
    selectedNodeId = node.id;
    selectedEdgeId = null;
  }

  function handleEdgeClick({ edge }: { edge: { id: string } }) {
    selectedEdgeId = edge.id;
    selectedNodeId = null;
  }

  function handlePaneClick() {
    selectedNodeId = null;
    selectedEdgeId = null;
  }

  function handleInspectorClose() {
    selectedNodeId = null;
    selectedEdgeId = null;
  }

  function openSettings() {
    showSettings = true;
  }

  function closeSettings() {
    showSettings = false;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      showSettings = true;
      return;
    }

    if (event.key === 'Escape' && showSettings) {
      event.preventDefault();
      showSettings = false;
    }
  }

  function miniMapNodeColor(node: { data?: { status?: string } }): string {
    const data = node.data;
    if (!data) return '#313244';

    switch (data.status) {
      case 'online':
        return '#a6e3a1';
      case 'stale':
        return '#f9e2af';
      case 'offline':
        return '#6c7086';
      case 'pending':
        return '#89b4fa';
      default:
        return '#313244';
    }
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div class="app-root">
  <!-- Canvas area -->
  <div class="canvas-area">
    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      {edgeTypes}
      fitView
      onnodeclick={handleNodeClick}
      onedgeclick={handleEdgeClick}
      onpaneclick={handlePaneClick}
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ animated: false }}
      deleteKey={null}
      panOnScroll={true}
      panOnScrollSpeed={1}
      zoomOnScroll={false}
      zoomOnPinch={true}
      zoomOnDoubleClick={false}
    >
      <Background />
      <Controls />
      <MiniMap
        nodeColor={miniMapNodeColor}
        maskColor="rgba(0, 0, 0, 0.7)"
        style="background: var(--node-header-bg); border: 1px solid var(--node-border); border-radius: 6px;"
      />
    </SvelteFlow>

    <!-- Status bar overlays the canvas bottom-center -->
    <SwarmStatus />
  </div>

  <!-- Sidebar -->
  <aside
    class="sidebar"
    class:resizing
    style="width: {sidebarWidth}px"
  >
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      on:pointerdown={startSidebarResize}
      on:pointermove={onSidebarResize}
      on:pointerup={endSidebarResize}
      on:pointercancel={endSidebarResize}
    ></div>
    <div class="tab-bar">
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab"
          class:active={activeTab === 'launch'}
          role="tab"
          aria-selected={activeTab === 'launch'}
          on:click={() => (activeTab = 'launch')}
        >
          Launch
        </button>
        <button
          type="button"
          class="tab"
          class:active={activeTab === 'inspect'}
          role="tab"
          aria-selected={activeTab === 'inspect'}
          on:click={() => (activeTab = 'inspect')}
        >
          Inspect
        </button>
      </div>
      <div class="tab-actions">
        {#if activeTab === 'launch'}
          <button
            type="button"
            class="icon-btn"
            on:click={openSettings}
            aria-label="Settings"
            title="Settings"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        {:else if hasSelection}
          <button
            type="button"
            class="icon-btn"
            on:click={handleInspectorClose}
            aria-label="Clear selection"
            title="Clear selection"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        {/if}
      </div>
    </div>

    <div class="tab-panels">
      <div class="tab-panel" class:hidden={activeTab !== 'launch'}>
        <Launcher />
      </div>
      <div class="tab-panel" class:hidden={activeTab !== 'inspect'}>
        <Inspector {selectedNode} {selectedEdge} />
      </div>
    </div>
  </aside>

  {#if showSettings}
    <SettingsModal on:close={closeSettings} />
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #c0caf5;
    overflow: hidden;
  }

  .app-root {
    width: 100vw;
    height: 100vh;
    display: flex;
    background: transparent;
  }

  .canvas-area {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  /* Override SvelteFlow default background */
  .canvas-area :global(.svelte-flow) {
    background: var(--canvas-bg);
  }

  .canvas-area :global(.svelte-flow__background) {
    background: var(--canvas-bg);
  }

  .sidebar {
    position: relative;
    width: 320px;
    border-left: 1px solid rgba(108, 112, 134, 0.25);
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
  }

  .sidebar.resizing {
    user-select: none;
  }

  .resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
    cursor: col-resize;
    z-index: 10;
    background: transparent;
    transition: background 0.12s ease;
  }

  .resize-handle:hover,
  .sidebar.resizing .resize-handle {
    background: rgba(137, 180, 250, 0.35);
  }

  .tab-bar {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    border-bottom: 1px solid rgba(108, 112, 134, 0.2);
    padding: 0 8px 0 0;
    flex-shrink: 0;
  }

  .tabs {
    display: flex;
    align-items: stretch;
    gap: 0;
  }

  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #6c7086;
    padding: 12px 14px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    letter-spacing: 0.02em;
    cursor: pointer;
    transition: color 0.12s ease, border-color 0.12s ease;
  }

  .tab:hover {
    color: #a6adc8;
  }

  .tab.active {
    color: var(--terminal-fg, #c0caf5);
    border-bottom-color: #89b4fa;
  }

  .tab-actions {
    display: flex;
    align-items: center;
  }

  .icon-btn {
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: #6c7086;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .icon-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--terminal-fg, #c0caf5);
  }

  .tab-panels {
    flex: 1;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .tab-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .tab-panel.hidden {
    display: none;
  }
</style>
