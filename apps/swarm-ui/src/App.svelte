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
    type Connection,
    type EdgeTypes,
    type NodeTypes,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { invoke } from '@tauri-apps/api/core';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onMount, onDestroy, tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  // Stores (Agent 3)
  import {
    initSwarmStore,
    destroySwarmStore,
    instances,
    tasks,
    messages,
    locks,
    savedLayout,
    activeScope,
  } from './stores/swarm';
  import {
    ptySessions,
    bindings,
    initPtyStore,
    destroyPtyStore,
    closePty,
    deregisterInstance,
  } from './stores/pty';

  // Graph builder (Agent 3)
  import { buildGraph } from './lib/graph';
  import type { Position, XYFlowNode, XYFlowEdge } from './lib/types';

  // Custom node types (Agent 4)
  import TerminalNode from './nodes/TerminalNode.svelte';
  import ViewportFocus from './nodes/ViewportFocus.svelte';

  // Custom edge types (Agent 4)
  import ConnectionEdge from './edges/ConnectionEdge.svelte';

  // Panels (Agent 4)
  import ConversationPanel from './panels/ConversationPanel.svelte';
  import Inspector from './panels/Inspector.svelte';
  import Launcher from './panels/Launcher.svelte';
  import MobileAccessModal from './panels/MobileAccessModal.svelte';
  import SettingsModal from './panels/SettingsModal.svelte';
  import StartupHome from './panels/StartupHome.svelte';
  import SwarmStatus from './panels/SwarmStatus.svelte';
  import FullscreenWorkspace from './panels/FullscreenWorkspace.svelte';
  import CloseConfirmModal from './panels/CloseConfirmModal.svelte';
  import ConfirmModal from './panels/ConfirmModal.svelte';
  import { mergeEdges, mergeNodes } from './lib/app/graphState';
  import { createLayoutPersistence } from './lib/app/layoutPersistence';
  import {
    applyEdgeSelection,
    applyNodeSelection,
    findNodeById,
    orderedSelectableNodeIds,
    resolveNodeTargetId,
    resolveClosableNodeId,
    resolveFullscreenTargetId,
  } from './lib/app/selection';
  import {
    loadSidebarState,
    persistSidebarCollapsed,
    persistSidebarWidth,
    resolveSidebarWidth,
  } from './lib/app/sidebar';
  import { workspaceOverlayActive } from './lib/workspaceOverlay';
  import {
    disposeAllTerminalSurfaces,
    getTerminalSurface,
  } from './lib/terminalSurface';
  import {
    compactNodeIds,
    pruneCompactNodeIds,
    registerNodeWindowActions,
    setCompactNodeScope,
    toggleCompactNode,
  } from './lib/app/nodeWindowState';

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

  // User-drawn edges created by dragging from one handle to another. These
  // aren't backed by any backend message/task/dep yet — they're visual
  // intent links. We track their IDs here so each `applyBuild()` can
  // reattach them after the merge instead of having them wiped by the
  // fresh-edges-win rebuild logic.
  const userEdgeIds = new Set<string>();
  let connectionActive = false;

  // Selection state
  let selectedNodeId: string | null = null;
  let selectedEdgeId: string | null = null;
  let selectedNode: XYFlowNode | null = null;
  let selectedEdge: XYFlowEdge | null = null;
  let hasSelection = false;
  let showMobileAccess = false;
  let showSettings = false;
  let showCloseConfirm = false;
  let appMode: 'home' | 'canvas' = 'home';
  let closeRequestUnlisten: UnlistenFn | null = null;
  let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
  let compactNodeIdsUnsubscribe: (() => void) | null = null;
  let unregisterNodeWindowActions: (() => void) | null = null;
  const layoutPersistence = createLayoutPersistence();
  const COMPACT_NODE_WIDTH = 360;
  const COMPACT_NODE_HEIGHT = 148;
  const compactRestoreSizes = new Map<string, { width?: number; height?: number }>();
  let compactNodeIdSet = new Set<string>();

  // -------------------------------------------------------------------
  // Fullscreen workspace state
  //
  // The graph stays mounted underneath the immersive overlay, but terminals no
  // longer remount between node and fullscreen. `TerminalPane` now leases a
  // persistent per-PTY surface that can move between anchors, so the app only
  // needs to decide when graph nodes should yield their terminal body to the
  // overlay.
  // -------------------------------------------------------------------
  type WorkspaceStage = 'closed' | 'opening' | 'open' | 'closing';
  type LauncherHandle = {
    launch: () => Promise<boolean>;
  };

  let workspaceStage: WorkspaceStage = 'closed';
  let workspaceInitialNodeId: string | null = null;
  let workspaceReturnNodeId: string | null = null;
  let launcherRef: LauncherHandle | null = null;
  $: workspaceActive = workspaceStage !== 'closed';
  $: workspaceOverlayStage = workspaceStage === 'closed' ? 'opening' : workspaceStage;
  // Keep graph terminals mounted during `opening` so the overlay can steal the
  // already-live PTY surface directly out of the node anchor. Once the
  // fullscreen shell is fully open we yield the graph nodes; during `closing`
  // they remount first so the live surface can move back before the overlay
  // fades away.
  $: workspaceOverlayActive.set(
    workspaceStage === 'open',
  );

  function syncNodeSelection(selectedId: string | null): void {
    nodes = applyNodeSelection(nodes, selectedId);
  }

  function syncEdgeSelection(selectedId: string | null): void {
    edges = applyEdgeSelection(edges, selectedId);
  }

  function setSelectedNode(nodeId: string | null): void {
    selectedNodeId = nodeId;
    selectedEdgeId = null;
    syncNodeSelection(nodeId);
    syncEdgeSelection(null);
  }

  function setSelectedEdge(edgeId: string | null): void {
    selectedEdgeId = edgeId;
    selectedNodeId = null;
    syncEdgeSelection(edgeId);
    syncNodeSelection(null);
  }

  function clearSelection(): void {
    selectedNodeId = null;
    selectedEdgeId = null;
    syncNodeSelection(null);
    syncEdgeSelection(null);
  }

  function cycleSelectedNode(delta: number): void {
    const ids = orderedSelectableNodeIds(nodes);
    if (ids.length === 0) return;

    const currentIndex = selectedNodeId ? ids.indexOf(selectedNodeId) : -1;
    const baseIndex = currentIndex >= 0
      ? currentIndex
      : delta > 0
        ? -1
        : 0;
    const nextIndex = (baseIndex + delta + ids.length) % ids.length;
    const nextId = ids[nextIndex];
    if (!nextId) return;

    setSelectedNode(nextId);
    void focusNodeTerminal(nextId);
  }

  async function focusNodeTerminal(nodeId: string | null): Promise<void> {
    const ptyId = findNodeById(nodes, nodeId)?.data?.ptySession?.id;
    if (!ptyId) return;

    await tick();
    getTerminalSurface(ptyId).focus();
  }

  async function closeNodeById(nodeId: string): Promise<boolean> {
    const node = findNodeById(nodes, nodeId);
    if (!node) return false;

    try {
      const ptyId = node.data?.ptySession?.id;
      if (ptyId) {
        await closePty(ptyId);
        return true;
      }

      const instanceId = node.data?.instance?.id;
      if (
        node.data?.nodeType === 'instance' &&
        (node.data?.instance?.status === 'offline' || node.data?.instance?.status === 'stale') &&
        instanceId
      ) {
        await deregisterInstance(instanceId);
        return true;
      }
    } catch (err) {
      console.error('[App] failed to close node:', err);
    }

    return false;
  }

  function openWorkspace(nodeId: string): void {
    if (workspaceStage !== 'closed') return;
    workspaceInitialNodeId = nodeId;
    workspaceStage = 'opening';
  }

  function applyCompactNodeGeometry(targetIds: Set<string> = compactNodeIdSet): void {
    if (nodes.length === 0) {
      compactRestoreSizes.clear();
      return;
    }

    const liveNodeIds = new Set(nodes.map((node) => node.id));
    for (const nodeId of compactRestoreSizes.keys()) {
      if (!liveNodeIds.has(nodeId)) {
        compactRestoreSizes.delete(nodeId);
      }
    }

    let changed = false;
    const nextNodes = nodes.map((node) => {
      const isCompact = targetIds.has(node.id);
      if (isCompact) {
        if (!compactRestoreSizes.has(node.id)) {
          compactRestoreSizes.set(node.id, {
            width: node.width,
            height: node.height,
          });
        }

        if (node.width === COMPACT_NODE_WIDTH && node.height === COMPACT_NODE_HEIGHT) {
          return node;
        }

        changed = true;
        return {
          ...node,
          width: COMPACT_NODE_WIDTH,
          height: COMPACT_NODE_HEIGHT,
        };
      }

      const restore = compactRestoreSizes.get(node.id);
      if (!restore) return node;

      compactRestoreSizes.delete(node.id);
      const nextWidth = restore.width ?? node.width;
      const nextHeight = restore.height ?? node.height;

      if (node.width === nextWidth && node.height === nextHeight) {
        return node;
      }

      changed = true;
      return {
        ...node,
        width: nextWidth,
        height: nextHeight,
      };
    });

    if (changed) {
      nodes = nextNodes;
    }
  }

  function handleWorkspaceOpen() {
    if (workspaceStage === 'opening') {
      workspaceStage = 'open';
    }
  }

  function handleWorkspaceClose(
    event: CustomEvent<{ returnNodeId: string | null }>,
  ) {
    if (workspaceStage === 'closing' || workspaceStage === 'closed') return;
    workspaceReturnNodeId = event.detail.returnNodeId;
    if (event.detail.returnNodeId) {
      setSelectedNode(event.detail.returnNodeId);
    }
    workspaceStage = 'closing';
  }

  function handleWorkspaceClosed() {
    const returnNodeId = workspaceReturnNodeId;
    workspaceStage = 'closed';
    workspaceInitialNodeId = null;
    workspaceReturnNodeId = null;
    if (returnNodeId) {
      void focusNodeTerminal(returnNodeId);
    }
  }

  // Right-panel tab state. Auto-switches to 'inspect' when a node/edge is
  // selected and back to 'launch' when selection clears. Users can still
  // override by clicking a tab directly. 'chat' shows the cross-scope
  // Conversation panel (operator broadcast + live message feed).
  let activeTab: 'launch' | 'chat' | 'inspect' = 'launch';

  // -------------------------------------------------------------------
  // Resizable sidebar
  //
  // User drags the .resize-handle on the sidebar's left edge. Width is
  // clamped and persisted to localStorage so it survives reloads.
  // -------------------------------------------------------------------

  const initialSidebarState = loadSidebarState();
  let sidebarWidth = initialSidebarState.width;
  let sidebarCollapsed = initialSidebarState.collapsed;
  let resizing = false;

  // Width actually applied to the sidebar. The user-set `sidebarWidth` is
  // preserved while collapsed so it restores to the same size on expand.
  $: effectiveSidebarWidth = sidebarCollapsed ? 0 : sidebarWidth;

  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    persistSidebarCollapsed(sidebarCollapsed);
  }

  function startSidebarResize(event: PointerEvent) {
    event.preventDefault();
    resizing = true;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function onSidebarResize(event: PointerEvent) {
    if (!resizing) return;
    sidebarWidth = resolveSidebarWidth(window.innerWidth, event.clientX);
  }

  function endSidebarResize(event: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    persistSidebarWidth(sidebarWidth);
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
      $savedLayout,
    ),
    $savedLayout,
  );

  function applyBuild(
    built: { nodes: XYFlowNode[]; edges: XYFlowEdge[] },
    persistedLayout: Record<string, Position>,
  ) {
    nodes = mergeNodes(nodes, built.nodes, persistedLayout);
    applyCompactNodeGeometry();
    // Preserve user-drawn edges across rebuilds. We keep only those whose
    // source and target nodes still exist — otherwise XYFlow will warn and
    // the edge would render as a dangling path.
    const liveNodeIds = new Set(nodes.map((node) => node.id));
    const preservedUserEdges: XYFlowEdge[] = [];
    for (const edge of edges) {
      if (!userEdgeIds.has(edge.id)) continue;
      if (!liveNodeIds.has(edge.source) || !liveNodeIds.has(edge.target)) {
        userEdgeIds.delete(edge.id);
        continue;
      }
      preservedUserEdges.push(edge);
    }
    edges = [...mergeEdges(edges, built.edges), ...preservedUserEdges];
  }

  // -------------------------------------------------------------------
  // Drag-to-connect — form a link when the user drags from a source
  // handle onto a target handle. While a drag is in-flight we toggle
  // `connectionActive` so terminal.css can paint a glow on every node's
  // handles, making valid drop targets obvious.
  // -------------------------------------------------------------------

  function handleConnectStart(): void {
    connectionActive = true;
  }

  function handleConnectEnd(): void {
    connectionActive = false;
  }

  function handleConnect(connection: Connection): void {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;

    const id = `user:${connection.source}::${connection.target}:${Date.now()}`;
    if (userEdgeIds.has(id)) return;
    userEdgeIds.add(id);

    const nextEdge: XYFlowEdge = {
      id,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? undefined,
      targetHandle: connection.targetHandle ?? undefined,
      type: undefined, // fall back to XYFlow's default bezier edge
      animated: true,
      selectable: true,
      data: undefined,
      class: 'user-connection',
    };

    // Replace any existing user edge between the same pair (regardless of
    // handle/direction) so repeated drags update rather than stacking lines.
    edges = [
      ...edges.filter((edge) => {
        if (!userEdgeIds.has(edge.id)) return true;
        const samePair =
          (edge.source === connection.source && edge.target === connection.target) ||
          (edge.source === connection.target && edge.target === connection.source);
        if (samePair) userEdgeIds.delete(edge.id);
        return !samePair;
      }),
      nextEdge,
    ];
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
  $: layoutPersistence.sync($activeScope, nodes, $savedLayout, persistLayout);
  $: setCompactNodeScope($activeScope);
  $: pruneCompactNodeIds(nodes.map((node) => node.id));

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  onMount(async () => {
    appWindow = getCurrentWindow();
    closeRequestUnlisten = await appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestAppClose();
    });
    compactNodeIdsUnsubscribe = compactNodeIds.subscribe((value) => {
      compactNodeIdSet = value;
      applyCompactNodeGeometry(value);
    });
    unregisterNodeWindowActions = registerNodeWindowActions({
      openWorkspace,
    });

    await Promise.all([initSwarmStore(), initPtyStore()]);
  });

  onDestroy(() => {
    closeRequestUnlisten?.();
    closeRequestUnlisten = null;
    compactNodeIdsUnsubscribe?.();
    compactNodeIdsUnsubscribe = null;
    unregisterNodeWindowActions?.();
    unregisterNodeWindowActions = null;
    layoutPersistence.clear();
    disposeAllTerminalSurfaces();
    destroySwarmStore();
    destroyPtyStore();
  });

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  function isInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && Boolean(target.closest('button, input, textarea, select, a, [role="button"]'));
  }

  function handleNodeClick(event: { node: XYFlowNode; event?: MouseEvent | TouchEvent }) {
    setSelectedNode(event.node.id);

    if (workspaceStage !== 'closed') return;
    if (!event.node.data?.ptySession?.id) return;
    if (isInteractiveTarget(event.event?.target ?? null)) return;

    void focusNodeTerminal(event.node.id);
  }

  function handleEdgeClick({ edge }: { edge: { id: string } }) {
    setSelectedEdge(edge.id);
  }

  function handlePaneClick() {
    clearSelection();
  }

  function handleInspectorClose() {
    clearSelection();
  }

  async function persistLayout(
    scope: string,
    nodesById: Record<string, Position>,
  ): Promise<void> {
    try {
      await invoke('ui_set_layout', {
        scope,
        layout: { nodes: nodesById },
      });
    } catch (err) {
      console.warn('[layout] failed to persist layout:', err);
    }
  }

  function openSettings() {
    showMobileAccess = false;
    showSettings = true;
  }

  function openHome() {
    if (workspaceStage !== 'closed') return;
    showMobileAccess = false;
    showSettings = false;
    appMode = 'home';
  }

  function enterCanvas() {
    appMode = 'canvas';
  }

  function closeSettings() {
    showSettings = false;
  }

  function openMobileAccess() {
    showSettings = false;
    showMobileAccess = true;
  }

  function closeMobileAccess() {
    showMobileAccess = false;
  }

  async function triggerLaunchShortcut(): Promise<void> {
    if (!launcherRef) return;
    await launcherRef.launch();
  }

  async function triggerCloseShortcut(nodeId: string): Promise<void> {
    await closeNodeById(nodeId);
  }

  function requestAppClose(): void {
    if (showCloseConfirm) return;
    showCloseConfirm = true;
  }

  function cancelAppClose(): void {
    showCloseConfirm = false;
  }

  async function confirmAppClose(): Promise<void> {
    showCloseConfirm = false;
    try {
      await invoke('ui_exit_app');
    } catch (err) {
      console.error('[App] failed to exit app:', err);
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (showCloseConfirm) return;

    const meta = event.metaKey || event.ctrlKey;
    const overlayOpen = showSettings || showMobileAccess || appMode === 'home';

    if (!event.defaultPrevented && !event.repeat && !event.isComposing) {
      const wantsLaunch =
        meta &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'n';

      if (wantsLaunch && !overlayOpen) {
        event.preventDefault();
        event.stopPropagation();
        void triggerLaunchShortcut();
        return;
      }

      const wantsClose =
        meta &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'w';

      if (wantsClose && workspaceStage === 'closed') {
        const nodeId = overlayOpen
          ? null
          : resolveClosableNodeId(event, nodes, selectedNodeId);
        event.preventDefault();
        event.stopPropagation();
        if (nodeId) {
          void triggerCloseShortcut(nodeId);
        } else {
          requestAppClose();
        }
        return;
      }

      if (workspaceStage === 'closed') {
        const wantsHome =
          meta &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 'h';

        if (wantsHome) {
          event.preventDefault();
          event.stopPropagation();
          openHome();
          return;
        }

        const wantsCycleNext =
          meta &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === ']' || event.key === '}' || event.code === 'BracketRight');

        if (wantsCycleNext && !overlayOpen) {
          event.preventDefault();
          event.stopPropagation();
          cycleSelectedNode(+1);
          return;
        }

        const wantsCyclePrevious =
          meta &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === '[' || event.key === '{' || event.code === 'BracketLeft');

        if (wantsCyclePrevious && !overlayOpen) {
          event.preventDefault();
          event.stopPropagation();
          cycleSelectedNode(-1);
          return;
        }

        const wantsCompact =
          meta &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 'm';

        if (wantsCompact && !overlayOpen) {
          const nodeId = resolveNodeTargetId(event, selectedNodeId);
          if (nodeId) {
            event.preventDefault();
            event.stopPropagation();
            toggleCompactNode(nodeId);
            return;
          }
        }

        const wantsFullscreen =
          meta &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 'f';

        if (wantsFullscreen) {
          const nodeId = resolveFullscreenTargetId(
            event,
            nodes,
            selectedNodeId,
          );
          if (nodeId) {
            event.preventDefault();
            event.stopPropagation();
            openWorkspace(nodeId);
            return;
          }
        }
      }
    }

    if (meta && event.key === ',') {
      event.preventDefault();
      showMobileAccess = false;
      showSettings = true;
      return;
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

  function handleWorkspaceCloseAgent(
    event: CustomEvent<{ nodeId: string }>,
  ): void {
    void closeNodeById(event.detail.nodeId);
  }
</script>

<svelte:window on:keydown|capture={handleWindowKeydown} />

  <div
  class="app-root"
  class:workspace-active={workspaceActive}
  style="--sidebar-inset: {effectiveSidebarWidth}px; --sidebar-transition-duration: {resizing ? '0ms' : '460ms'};"
>
  <!-- Canvas area -->
  <div class="canvas-area" class:connection-active={connectionActive}>
    {#if appMode === 'canvas'}
      <button
        type="button"
        class="floating-home"
        on:click={openHome}
        aria-label="Back to Home"
        aria-keyshortcuts="Meta+Shift+H Control+Shift+H"
        title="Back to Home"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        <span>Back</span>
      </button>
    {/if}

    {#if sidebarCollapsed}
      <button
        type="button"
        class="floating-expand"
        on:click={toggleSidebar}
        aria-label="Expand panel"
        title="Expand panel"
        transition:fly={{ x: 28, duration: 360, easing: cubicOut }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
    {/if}

    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      {edgeTypes}
      fitView
      onnodeclick={handleNodeClick}
      onedgeclick={handleEdgeClick}
      onpaneclick={handlePaneClick}
      onconnect={handleConnect}
      onconnectstart={handleConnectStart}
      onconnectend={handleConnectEnd}
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
      <ViewportFocus />
    </SvelteFlow>

    <!-- Status bar overlays the canvas bottom-center -->
    <SwarmStatus />
  </div>

  <!-- Sidebar -->
  <aside
    class="sidebar"
    class:resizing
    class:collapsed={sidebarCollapsed}
    style="width: {effectiveSidebarWidth}px"
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
          class:active={activeTab === 'chat'}
          role="tab"
          aria-selected={activeTab === 'chat'}
          on:click={() => (activeTab = 'chat')}
        >
          Chat
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
        <button
          type="button"
          class="icon-btn"
          class:active={appMode === 'home'}
          on:click={openHome}
          aria-label="Home"
          aria-pressed={appMode === 'home'}
          title="Home"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 10.5L12 3l9 7.5"/>
            <path d="M5 9.75V21h14V9.75"/>
          </svg>
        </button>
        {#if activeTab === 'launch'}
          <button
            type="button"
            class="icon-btn"
            on:click={openMobileAccess}
            aria-label="Mobile Access"
            title="Mobile Access"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="7" y="2.5" width="10" height="19" rx="2.5"/>
              <path d="M11 18.5h2"/>
            </svg>
          </button>
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
        <button
          type="button"
          class="icon-btn"
          on:click={toggleSidebar}
          aria-label="Collapse panel"
          title="Collapse panel"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="tab-panels">
      <div class="tab-panel" class:hidden={activeTab !== 'launch'}>
        <Launcher bind:this={launcherRef} />
      </div>
      <div class="tab-panel" class:hidden={activeTab !== 'chat'}>
        <ConversationPanel />
      </div>
      <div class="tab-panel" class:hidden={activeTab !== 'inspect'}>
        <Inspector {selectedNode} {selectedEdge} />
      </div>
    </div>
  </aside>

  {#if showSettings}
    <SettingsModal on:close={closeSettings} />
  {/if}

  {#if appMode === 'home'}
    <StartupHome on:enterCanvas={enterCanvas} on:openSettings={openSettings} />
  {/if}

  {#if showMobileAccess}
    <MobileAccessModal on:close={closeMobileAccess} />
  {/if}

  {#if showCloseConfirm}
    <CloseConfirmModal
      on:cancel={cancelAppClose}
      on:confirm={confirmAppClose}
    />
  {/if}

  <ConfirmModal />

  {#if workspaceActive}
    <FullscreenWorkspace
      {nodes}
      initialNodeId={workspaceInitialNodeId}
      stage={workspaceOverlayStage}
      on:closeAgent={handleWorkspaceCloseAgent}
      on:opened={handleWorkspaceOpen}
      on:close={handleWorkspaceClose}
      on:closed={handleWorkspaceClosed}
    />
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
    position: relative;
    background: transparent;
    overflow: hidden;
  }

  .app-root.workspace-active .canvas-area,
  .app-root.workspace-active .sidebar {
    user-select: none;
  }

  .canvas-area {
    flex: 1;
    width: 100%;
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
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 320px;
    height: 100%;
    box-sizing: border-box;
    border-left: 1px solid rgba(108, 112, 134, 0.18);
    background: var(--sidebar-bg, rgba(30, 30, 46, 0.20));
    backdrop-filter: blur(var(--sidebar-blur, 40px)) saturate(1.4);
    -webkit-backdrop-filter: blur(var(--sidebar-blur, 40px)) saturate(1.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    z-index: 30;
    box-shadow: -10px 0 28px rgba(0, 0, 0, 0.18);
    transition: width 460ms cubic-bezier(0.22, 1, 0.36, 1),
      border-left-color 460ms ease;
  }

  .sidebar.resizing {
    user-select: none;
    transition: none;
  }

  .sidebar.collapsed {
    border-left-color: transparent;
    pointer-events: none;
  }

  /* Inner content fade — asymmetric so it tucks under the width animation:
     on collapse it fades out fast, on expand it fades in after a delay so
     the panel has visibly started opening before content reappears. */
  .tab-bar,
  .tab-panels {
    opacity: 1;
    transition: opacity 200ms ease 100ms;
  }

  .sidebar.collapsed .tab-bar,
  .sidebar.collapsed .tab-panels {
    opacity: 0;
    pointer-events: none;
    transition: opacity 200ms ease 0ms;
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

  .sidebar.collapsed .resize-handle {
    pointer-events: none;
    display: none;
  }

  .floating-expand {
    position: absolute;
    top: 14px;
    right: 14px;
    z-index: 20;
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 8px;
    border: 1px solid rgba(108, 112, 134, 0.35);
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    color: #a6adc8;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    transition: background 0.16s ease, color 0.16s ease,
      border-color 0.16s ease, transform 0.16s ease;
  }

  .floating-expand:hover {
    background: rgba(49, 50, 68, 0.92);
    color: var(--terminal-fg, #c0caf5);
    border-color: rgba(137, 180, 250, 0.55);
    transform: translateX(-2px);
  }

  .floating-expand:active {
    transform: translateX(0);
  }

  .floating-home {
    position: absolute;
    top: 14px;
    left: 14px;
    z-index: 20;
    height: 32px;
    padding: 0 12px 0 10px;
    border-radius: 10px;
    border: 1px solid rgba(108, 112, 134, 0.35);
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.1);
    color: #a6adc8;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    transition: background 0.16s ease, color 0.16s ease,
      border-color 0.16s ease, transform 0.16s ease;
  }

  .floating-home:hover {
    background: rgba(49, 50, 68, 0.92);
    color: var(--terminal-fg, #c0caf5);
    border-color: rgba(137, 180, 250, 0.55);
    transform: translateY(-1px);
  }

  .floating-home:active {
    transform: translateY(0);
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

  .icon-btn.active {
    background: rgba(137, 180, 250, 0.12);
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
