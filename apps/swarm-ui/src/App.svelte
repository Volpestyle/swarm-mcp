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
  import MessageEdge from './edges/MessageEdge.svelte';
  import TaskEdge from './edges/TaskEdge.svelte';
  import DependencyEdge from './edges/DependencyEdge.svelte';

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
    message: MessageEdge,
    task: TaskEdge,
    dependency: DependencyEdge,
  };

  // -------------------------------------------------------------------
  // Graph state
  // -------------------------------------------------------------------

  let nodes: XYFlowNode[] = [];
  let edges: XYFlowEdge[] = [];

  // Selection state
  let selectedNodeId: string | null = null;
  let selectedEdgeId: string | null = null;
  let selectedNode: XYFlowNode | null = null;
  let selectedEdge: XYFlowEdge | null = null;
  let showInspector = false;
  let showSettings = false;

  // Reactive graph rebuild when stores change
  $: ({ nodes, edges } = buildGraph(
    $instances,
    $ptySessions,
    $tasks,
    $messages,
    $locks,
    $bindings,
  ));

  // Look up selected node/edge objects for the inspector
  $: selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  $: selectedEdge = selectedEdgeId
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;
  $: showInspector = selectedNode !== null || selectedEdge !== null;

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
      {nodes}
      {edges}
      {nodeTypes}
      {edgeTypes}
      fitView
      onnodeclick={handleNodeClick}
      onedgeclick={handleEdgeClick}
      onpaneclick={handlePaneClick}
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ animated: false }}
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
  <aside class="sidebar">
    <Launcher on:settings={openSettings} />

    {#if showInspector}
      <div class="inspector-container">
        <Inspector
          {selectedNode}
          {selectedEdge}
          on:close={handleInspectorClose}
        />
      </div>
    {/if}
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
    width: 320px;
    border-left: 1px solid var(--node-border, #313244);
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
  }

  .inspector-container {
    flex: 1;
    overflow: hidden;
  }
</style>
