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
	    ViewportPortal,
	    type Connection,
	    type EdgeTypes,
	    type NodeTypes,
	  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { invoke } from '@tauri-apps/api/core';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onMount, onDestroy, tick } from 'svelte';

  // Stores (Agent 3)
  import {
    initSwarmStore,
    destroySwarmStore,
    allInstances,
    instances,
    tasks,
    messages,
    locks,
    events,
    savedLayout,
    activeScope,
  } from './stores/swarm';
	  import {
	    clearStalePtySession,
    ptySessions,
    bindings,
    initPtyStore,
    destroyPtyStore,
    killInstance,
	    killPtySession,
	    respawnInstanceInProject,
	    sendOperatorMessage,
	    writeToPty,
	  } from './stores/pty';
	  import {
	    attachInstanceToProject,
	    findProjectContainingNode,
	    findNodesInsideProject,
	    loadProjects,
	    projectMembershipTargetForNode,
	    projectMemberships,
	    projects,
	    saveProject,
	    translateNodesWithMovedProject,
	  } from './stores/projects';
  import { loadProjectAssets, normalizeProjectAssets, saveProjectAsset } from './stores/projectAssets';
  import { buildAssetContextBlock } from './lib/assetContext';
  import { buildBrowserReferenceAsset } from './lib/browserReference';

	  // Graph builder (Agent 3)
	  import { buildGraph } from './lib/graph';
	  import type {
	    Position,
	    BrowserCatalog,
	    BrowserContext,
	    BrowserSnapshot,
	    BrowserTab,
	    ProjectBoundary as ProjectBoundaryGeometry,
	    ProjectMembership,
	    ProjectAsset,
	    ProjectNodeAccent,
	    ProjectSpace,
	    Task,
	    XYFlowEdge,
	    XYFlowNode,
	  } from './lib/types';

	  // Custom node types (Agent 4)
	  import ProjectBoundary from './canvas/ProjectBoundary.svelte';
	  import BrowserNode from './nodes/BrowserNode.svelte';
	  import TerminalNode from './nodes/TerminalNode.svelte';
	  import ViewportFocus from './nodes/ViewportFocus.svelte';

  // Custom edge types (Agent 4)
  import ConnectionEdge from './edges/ConnectionEdge.svelte';

  // Panels (Agent 4)
  import AnalyzePanel from './panels/AnalyzePanel.svelte';
  import AgentCommandCenter from './panels/AgentCommandCenter.svelte';
  import ConversationPanel from './panels/ConversationPanel.svelte';
  import FrazierCodePanel from './panels/FrazierCodePanel.svelte';
  import InspectWorkspace from './panels/InspectWorkspace.svelte';
  import Launcher from './panels/Launcher.svelte';
	  import MobileAccessModal from './panels/MobileAccessModal.svelte';
	  import ProjectPage from './panels/ProjectPage.svelte';
	  import SettingsModal from './panels/SettingsModal.svelte';
  import StartupHome from './panels/StartupHome.svelte';
  import SwarmStatus from './panels/SwarmStatus.svelte';
  import TopStrip from './panels/TopStrip.svelte';
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
    clampSidebarWidth,
    loadSidebarState,
    persistSidebarCollapsed,
    persistSidebarWidth,
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
	  import { confirm } from './lib/confirm';

  // Styles
  import './styles/terminal.css';
  import darkFolderAsset from './assets/dark-folder.png';

  // -------------------------------------------------------------------
  // Node and edge type registrations for SvelteFlow
  // -------------------------------------------------------------------

  const nodeTypes: NodeTypes = {
    browser: BrowserNode,
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
  let browserContexts: BrowserContext[] = [];
  let browserTabs: BrowserTab[] = [];
  let browserSnapshots: BrowserSnapshot[] = [];
  let browserCatalogRefreshKey = '';

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
  let kitOpenSignal = 0;
  let browserOpenSignal = 0;
  let canvasQuickMenu: { x: number; y: number } | null = null;
	  let showCloseConfirm = false;
	  let frazierCodeOpen = false;
	  let inspectWorkspaceOpen = false;
	  let agentCommandCenterOpen = false;
	  let appMode: 'home' | 'canvas' = 'home';
	  let activeProjectId: string | null = null;
	  let projectPageOpen = false;
	  let pendingProjectAttachKey: string | null = null;
	  let closeRequestUnlisten: UnlistenFn | null = null;
  let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
  let compactNodeIdsUnsubscribe: (() => void) | null = null;
  let unregisterNodeWindowActions: (() => void) | null = null;
  const layoutPersistence = createLayoutPersistence();
  const COMPACT_NODE_WIDTH = 154;
  const COMPACT_NODE_HEIGHT = 54;
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
      const instanceId = node.data?.instance?.id;
      if (instanceId) {
        await killInstance(instanceId);
        return true;
      }

      if (ptyId) {
        if (node.data?.nodeType === 'pty' && node.data?.status === 'stale') {
          await clearStalePtySession(ptyId);
        } else {
          await killPtySession(ptyId);
        }
        return true;
      }

      if (
        node.data?.nodeType === 'instance' &&
        (node.data?.instance?.status === 'offline' || node.data?.instance?.status === 'stale') &&
        instanceId
      ) {
        await killInstance(instanceId);
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

  // Canvas shell state — a thin persistent mode rail on the right and a
  // floating surface that opens over the graph for Launch / Chat / Inspect.
  let activeTab: 'launch' | 'chat' | 'inspect' = 'launch';
  let analyzeOverlayOpen = false;
  const initialSidebarState = loadSidebarState();
  const MODE_RAIL_WIDTH = 86;
  const SHELL_SURFACE_GAP = 18;
  const SHELL_SURFACE_MIN_WIDTH = 540;
  let shellSurfaceWidth = Math.max(SHELL_SURFACE_MIN_WIDTH, initialSidebarState.width);
  let shellSurfaceOpen = !initialSidebarState.collapsed;
  let shellSurfaceResizing = false;

  $: shellSurfaceTitle = activeTab === 'launch'
    ? 'Launch Deck'
    : activeTab === 'chat'
      ? 'Conversation Feed'
      : 'Inspector';
  $: shellSurfaceCopy = activeTab === 'launch'
    ? 'Spawn agents and manage launch profiles.'
    : activeTab === 'chat'
      ? 'Live channel messages without leaving the canvas.'
      : 'Selected node and edge details.';
  $: shellSurfaceBadge = activeTab === 'launch'
    ? 'spawn'
    : activeTab === 'chat'
      ? 'messages'
      : hasSelection
        ? 'selection live'
        : 'selection idle';

  function setShellSurfaceOpen(next: boolean): void {
    shellSurfaceOpen = next;
    persistSidebarCollapsed(!next);
  }

  function toggleShellSurface(): void {
    setShellSurfaceOpen(!shellSurfaceOpen);
  }

  function openShellTab(tab: 'launch' | 'chat' | 'inspect'): void {
    if (tab === 'inspect') {
      activeTab = 'inspect';
      analyzeOverlayOpen = false;
      frazierCodeOpen = false;
      agentCommandCenterOpen = false;
      inspectWorkspaceOpen = true;
      setShellSurfaceOpen(false);
      return;
    }

    if (activeTab === tab && shellSurfaceOpen) {
      setShellSurfaceOpen(false);
      return;
    }
    activeTab = tab;
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
    setShellSurfaceOpen(true);
  }

  function closeAnalyzeOverlay(): void {
    analyzeOverlayOpen = false;
  }

  function toggleAnalyzeOverlay(): void {
    analyzeOverlayOpen = !analyzeOverlayOpen;
    if (analyzeOverlayOpen) {
      frazierCodeOpen = false;
      inspectWorkspaceOpen = false;
      agentCommandCenterOpen = false;
      setShellSurfaceOpen(false);
    }
  }

  function openAgentCommandCenter(): void {
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    setShellSurfaceOpen(false);
    agentCommandCenterOpen = true;
  }

  function closeAgentCommandCenter(): void {
    agentCommandCenterOpen = false;
  }

  function closeInspectWorkspace(): void {
    inspectWorkspaceOpen = false;
    if (activeTab === 'inspect') {
      activeTab = 'launch';
    }
  }

  function openFrazierCode(): void {
    analyzeOverlayOpen = false;
    showSettings = false;
    showMobileAccess = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
    setShellSurfaceOpen(false);
    frazierCodeOpen = true;
  }

  function closeFrazierCode(): void {
    frazierCodeOpen = false;
  }

  // -------------------------------------------------------------------
  // Resizable shell surface
  //
  // The floating shell keeps width persistence from the old sidebar, but the
  // graph is no longer forced to give up the entire right edge.
  // -------------------------------------------------------------------

  function startShellSurfaceResize(event: PointerEvent) {
    event.preventDefault();
    shellSurfaceResizing = true;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
  }

  function onShellSurfaceResize(event: PointerEvent) {
    if (!shellSurfaceResizing) return;
    const nextWidth =
      window.innerWidth - event.clientX - MODE_RAIL_WIDTH - SHELL_SURFACE_GAP - 14;
    shellSurfaceWidth = Math.max(
      SHELL_SURFACE_MIN_WIDTH,
      clampSidebarWidth(nextWidth),
    );
  }

  function endShellSurfaceResize(event: PointerEvent) {
    if (!shellSurfaceResizing) return;
    shellSurfaceResizing = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    persistSidebarWidth(shellSurfaceWidth);
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
      $events,
      $bindings,
      $activeScope,
      $savedLayout,
      browserContexts,
      browserTabs,
      browserSnapshots,
      $allInstances,
    ),
    $savedLayout,
    $projects,
    $projectMemberships,
    activeProjectId,
  );

  function applyBuild(
    built: { nodes: XYFlowNode[]; edges: XYFlowEdge[] },
    persistedLayout: Record<string, Position>,
    projectList: ProjectSpace[],
    membershipList: ProjectMembership[],
    preferredProjectId: string | null,
  ) {
    nodes = mergeNodes(nodes, built.nodes, persistedLayout);
    applyCompactNodeGeometry();
    nodes = applyProjectToneToNodes(nodes, projectList, membershipList, preferredProjectId);
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

  function sameProjectTone(
    left: ProjectNodeAccent | null | undefined,
    right: ProjectNodeAccent | null,
  ): boolean {
    return (left?.id ?? null) === (right?.id ?? null)
      && (left?.color ?? null) === (right?.color ?? null)
      && (left?.name ?? null) === (right?.name ?? null);
  }

  function applyProjectToneToNodes(
    currentNodes: XYFlowNode[],
    projectList: ProjectSpace[],
    membershipList: ProjectMembership[],
    preferredProjectId: string | null,
  ): XYFlowNode[] {
    if (currentNodes.length === 0) return currentNodes;

    const projectsById = new Map(projectList.map((project) => [project.id, project]));
    const toneByTarget = new Map<string, ProjectNodeAccent>();
    for (const membership of membershipList) {
      const project = projectsById.get(membership.projectId);
      if (!project) continue;
      const tone = { id: project.id, name: project.name, color: project.color };
      if (membership.projectId === preferredProjectId || !toneByTarget.has(membership.instanceId)) {
        toneByTarget.set(membership.instanceId, tone);
      }
    }

    let changed = false;
    const tonedNodes = currentNodes.map((node) => {
      const targetId = projectMembershipTargetForNode(node);
      const tone = targetId ? toneByTarget.get(targetId) ?? null : null;
      if (sameProjectTone(node.data?.project, tone)) {
        return node;
      }

      changed = true;
      return {
        ...node,
        data: {
          ...node.data,
          project: tone,
        },
      };
    });

    return changed ? tonedNodes : currentNodes;
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
	  $: activeProject = activeProjectId
	    ? $projects.find((project) => project.id === activeProjectId) ?? null
	    : null;
	  $: instanceList = Array.from($instances.values());
	  $: taskList = Array.from($tasks.values());
	  $: eventList = $events;
	  $: layoutPersistence.sync($activeScope, nodes, $savedLayout, persistLayout);
  $: setCompactNodeScope($activeScope);
  $: pruneCompactNodeIds(nodes.map((node) => node.id));
  $: refreshBrowserCatalogForCanvas($activeScope, latestBrowserEventId($events));

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

	    await Promise.all([
	      initSwarmStore(),
	      initPtyStore(),
	      loadProjects().catch((err) => {
	        console.warn('[projects] failed to load projects:', err);
	      }),
	    ]);
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

  function closeCanvasCommandMenu(): void {
    canvasQuickMenu = null;
  }

  function setCanvasMenuMessage(message: string): void {
    console.info(`[canvas-kit] ${message}`);
  }

  function handleCanvasContextMenu(event: MouseEvent): void {
    if (appMode !== 'canvas') return;
    if (isInteractiveTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.svelte-flow__pane, .svelte-flow__background')) return;
    if (
      target.closest(
        '.svelte-flow__node, .terminal-node, .browser-node, .terminal-container, .terminal-pane-anchor, [data-pty-surface], .nodrag, .nopan, .nowheel',
      )
    ) {
      return;
    }

    event.preventDefault();
    const menuWidth = 230;
    const menuHeight = 260;
    canvasQuickMenu = {
      x: Math.max(12, Math.min(event.clientX + 8, window.innerWidth - menuWidth - 12)),
      y: Math.max(42, Math.min(event.clientY + 8, window.innerHeight - menuHeight - 12)),
    };
  }

  function openLaunchDeckFromCanvasMenu(): void {
    closeCanvasCommandMenu();
    openShellTab('launch');
  }

  async function launchChromeFromCanvasMenu(): Promise<void> {
    closeCanvasCommandMenu();
    browserOpenSignal += 1;
    setCanvasMenuMessage('Browser lane opened.');
  }

  function openNoteFromCanvasMenu(): void {
    if (activeProject) {
      closeCanvasCommandMenu();
      openProject(activeProject);
      return;
    }
    setCanvasMenuMessage('Create a note inside a project so agents inherit it as context.');
  }

  function openPlanFromCanvasMenu(): void {
    openShellTab('chat');
    setCanvasMenuMessage('Plan context belongs in the active project or conversation feed.');
  }

  function openImportFromCanvasMenu(): void {
    if (activeProject) {
      closeCanvasCommandMenu();
      openProject(activeProject);
      return;
    }
    setCanvasMenuMessage('Import files through a project page so assets have a clear boundary.');
  }

  function openOrganizeFromCanvasMenu(): void {
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    agentCommandCenterOpen = false;
    inspectWorkspaceOpen = true;
    activeTab = 'inspect';
    setShellSurfaceOpen(false);
    setCanvasMenuMessage('.organize opened Inspect for the current canvas selection.');
  }

  function handleNodeClick(event: { node: XYFlowNode; event?: MouseEvent | TouchEvent }) {
    closeCanvasCommandMenu();
    setSelectedNode(event.node.id);

    if (workspaceStage !== 'closed') return;
    if (!event.node.data?.ptySession?.id) return;
    if (isInteractiveTarget(event.event?.target ?? null)) return;

    void focusNodeTerminal(event.node.id);
  }

	  function handleEdgeClick({ edge }: { edge: { id: string } }) {
    closeCanvasCommandMenu();
    setSelectedEdge(edge.id);
	  }

	  function sleep(ms: number): Promise<void> {
	    return new Promise((resolve) => window.setTimeout(resolve, ms));
	  }

	  function nodeInstanceId(node: XYFlowNode): string | null {
	    return node.data?.instance?.id ?? null;
	  }

	  function ptyIdForInstance(instanceId: string): string | null {
	    return $bindings.resolved.find(([id]) => id === instanceId)?.[1]
	      ?? nodes.find((node) => node.data?.instance?.id === instanceId)?.data?.ptySession?.id
	      ?? null;
	  }

	  function projectRoots(project: ProjectSpace): string[] {
	    return [project.root, ...project.additionalRoots].filter((entry) => entry.trim().length > 0);
	  }

		  function taskBelongsToProject(
		    project: ProjectSpace,
		    instanceId: string | null,
		    memberIds: Set<string>,
		  ): (task: Task) => boolean {
	    return (task) => {
	      if (instanceId && task.assignee === instanceId) return true;
	      if (task.assignee && memberIds.has(task.assignee)) return true;
	      const roots = projectRoots(project);
	      return (task.files ?? []).some((file) =>
	        roots.some((root) => file === root || file.startsWith(`${root}/`)),
	      );
		    };
		  }

		  function localDateSlug(date = new Date()): string {
		    const year = date.getFullYear();
		    const month = String(date.getMonth() + 1).padStart(2, '0');
		    const day = String(date.getDate()).padStart(2, '0');
		    return `${year}-${month}-${day}`;
			  }

			  function buildProjectBootstrap(project: ProjectSpace, instanceId: string, assets: ProjectAsset[] = []): string {
	    const memberIds = new Set(
	      $projectMemberships
	        .filter((entry) => entry.projectId === project.id)
	        .map((entry) => entry.instanceId),
	    );
	    memberIds.add(instanceId);
	    const projectTasks = Array.from($tasks.values())
	      .filter(taskBelongsToProject(project, instanceId, memberIds))
	      .slice(0, 8);
	    const roots = projectRoots(project);
	    const taskLines = projectTasks.length
	      ? projectTasks.map((task) => `- ${task.title} [${task.status}] id:${task.id}`).join('\n')
	      : '- No project-linked tasks yet.';
	    const extraRoots = roots.slice(1);
		    const assetBlock = buildAssetContextBlock(assets.slice(0, 8));
		    const assetLines = assetBlock || 'Project assets:\n- No project assets saved yet.';
    const browserLines = buildProjectBrowserBlock(project);
		    const workspaceRoot = `${project.root.replace(/\/+$/, '')}/workspace`;
			    const todayWorkspace = `${workspaceRoot}/${localDateSlug()}`;

			    return [
		      `[project-context] ${project.name}`,
		      `Project root: ${project.root}`,
		      `Extra roots: ${extraRoots.length ? extraRoots.join(', ') : 'none'}`,
		      `Project workspace: use or create ${workspaceRoot}. Put daily scratch plans, temporary actions, and small notes in ${todayWorkspace}. Keep durable/important project notes directly under ${workspaceRoot}.`,
		      `Notes:\n${project.notes.trim() || 'No project notes saved yet.'}`,
	      assetLines,
      browserLines,
	      `Current project tasks:\n${taskLines}`,
	      'This attachment is context sync only. Do not change cwd, channel, or filesystem assumptions because of the boundary.',
	      'Inspect the project context, then stand by/listen: poll messages/tasks and use wait_for_activity when idle.',
	    ].join('\n\n');
	  }

  function buildProjectBrowserBlock(project: ProjectSpace): string {
    const contextIds = new Set(
      $projectMemberships
        .filter((entry) => entry.projectId === project.id && entry.instanceId.startsWith('browser:'))
        .map((entry) => entry.instanceId.slice('browser:'.length)),
    );
    const projectContexts = browserContexts.filter((context) => contextIds.has(context.id));
    if (projectContexts.length === 0) {
      return 'Project browser contexts:\n- No browser contexts attached yet.';
    }

    const lines = projectContexts.slice(0, 6).map((context) => {
      const activeTab = browserTabs.find((tab) => tab.contextId === context.id && tab.active)
        ?? browserTabs.find((tab) => tab.contextId === context.id)
        ?? null;
      const label = activeTab?.title || activeTab?.url || context.startUrl || context.id;
      const url = activeTab?.url || context.startUrl || context.endpoint;
      return `- ${label} (${url}) context:${context.id}`;
    });
    return `Project browser contexts:\n${lines.join('\n')}`;
  }

  async function createBrowserReferenceAsset(
    project: ProjectSpace,
    context: BrowserContext,
  ): Promise<ProjectAsset> {
    const activeTab = browserTabs.find((tab) => tab.contextId === context.id && tab.active)
      ?? browserTabs.find((tab) => tab.contextId === context.id)
      ?? null;
    let referenceContext = context;
    let referenceTabs = browserTabs.filter((tab) => tab.contextId === context.id);
    let referenceSnapshots = browserSnapshots.filter((snapshot) => snapshot.contextId === context.id);

    if (context.status !== 'closed') {
      try {
        const catalog = await invoke<BrowserCatalog>('ui_capture_browser_snapshot', {
          scope: context.scope,
          contextId: context.id,
          tabId: activeTab?.tabId,
        });
        browserContexts = catalog.contexts ?? browserContexts;
        browserTabs = catalog.tabs ?? browserTabs;
        browserSnapshots = catalog.snapshots ?? browserSnapshots;
        referenceContext = browserContexts.find((entry) => entry.id === context.id) ?? context;
        referenceTabs = browserTabs.filter((tab) => tab.contextId === context.id);
        referenceSnapshots = browserSnapshots.filter((snapshot) => snapshot.contextId === context.id);
      } catch (err) {
        console.warn('[projects] readable browser capture failed; saving URL-only reference:', err);
      }
    }

    const asset = buildBrowserReferenceAsset({
      project,
      context: referenceContext,
      tabs: referenceTabs,
      snapshots: referenceSnapshots,
    });
    return saveProjectAsset(asset);
  }

  async function sendBrowserProjectUpdate(
    project: ProjectSpace,
    context: BrowserContext,
    referenceAsset: ProjectAsset,
  ): Promise<void> {
    const content = [
      `[project-browser] ${project.name}`,
      'The operator attached this browser tab as intentional project context.',
      `Reference asset: ${referenceAsset.title}`,
      `URL: ${referenceAsset.path ?? context.startUrl ?? context.endpoint}`,
      `Context id: ${context.id}`,
      '',
      referenceAsset.content ?? '',
      '',
      'Use this reference before searching or guessing. If it is incomplete, ask the operator for refresh/deeper capture instead of wandering off.',
    ].join('\n');

    const memberIds = $projectMemberships
      .filter((entry) => entry.projectId === project.id && !entry.instanceId.startsWith('browser:'))
      .map((entry) => entry.instanceId);
    await Promise.all(memberIds.map(async (memberId) => {
      const instance = $instances.get(memberId);
      const scope = instance?.scope ?? $activeScope;
      if (!scope) return;
      await sendOperatorMessage(scope, memberId, content).catch((err) => {
        console.warn('[projects] browser project update was not delivered:', err);
      });
    }));
  }

	  async function sendProjectBootstrap(
	    project: ProjectSpace,
	    instanceId: string,
	    ptyIdOverride: string | null = null,
	  ): Promise<void> {
	    let assets: ProjectAsset[] = [];
	    await loadProjectAssets(project.id)
	      .then((catalog) => {
	        assets = normalizeProjectAssets(catalog.assets);
	      })
	      .catch((err) => {
	        console.warn('[projects] project assets were not loaded for bootstrap:', err);
	      });
	    const content = buildProjectBootstrap(project, instanceId, assets);
	    const instance = $instances.get(instanceId);
	    const scope = instance?.scope ?? $activeScope;
	    if (scope) {
	      await sendOperatorMessage(scope, instanceId, content).catch((err) => {
	        console.warn('[projects] direct project bootstrap message was not delivered:', err);
	      });
	    }

	    const ptyId = ptyIdOverride ?? ptyIdForInstance(instanceId);
	    if (ptyId) {
	      await writeToPty(ptyId, new TextEncoder().encode(`${content}\n`)).catch((err) => {
	        console.warn('[projects] project bootstrap prompt was not typed:', err);
	      });
	    }
	  }

	  function attachableNodesInsideProject(project: ProjectSpace): XYFlowNode[] {
	    return nodes.filter((node) => {
	      if (findNodesInsideProject(project, [node]).length === 0) return false;
	      const instanceId = nodeInstanceId(node);
	      if (!instanceId) return false;
	      return !$projectMemberships.some(
	        (entry) => entry.projectId === project.id && entry.instanceId === instanceId,
	      );
	    });
	  }

	  async function attachAgentToProject(
	    project: ProjectSpace,
	    instanceId: string,
	    openPage = true,
	  ): Promise<void> {
	    await attachInstanceToProject(project.id, instanceId);
	    await sendProjectBootstrap(project, instanceId);
	    activeProjectId = project.id;
	    if (openPage) {
	      projectPageOpen = true;
	    }
	  }

	  async function syncEnclosedAgents(project: ProjectSpace): Promise<void> {
	    const attachable = attachableNodesInsideProject(project);
	    if (attachable.length === 0) {
	      activeProjectId = project.id;
	      projectPageOpen = true;
	      return;
	    }

	    const ok = await confirm({
	      title: 'Sync enclosed agents',
	      message: `Attach ${attachable.length} enclosed agent${attachable.length === 1 ? '' : 's'} to "${project.name}" and send the project context bootstrap? This does not change cwd or channel.`,
	      confirmLabel: 'Sync agents',
	    });
	    if (!ok) return;

	    for (const node of attachable) {
	      const instanceId = nodeInstanceId(node);
	      if (!instanceId) continue;
	      await attachAgentToProject(project, instanceId, false);
	    }
	    activeProjectId = project.id;
	    projectPageOpen = true;
	  }

	  async function handleNodeDragStop(event: { targetNode: XYFlowNode | null }): Promise<void> {
	    if (appMode !== 'canvas') return;
	    const node = event.targetNode;
	    if (!node) return;
	    const membershipTarget = projectMembershipTargetForNode(node);
	    if (!membershipTarget) return;

	    const project = findProjectContainingNode(node, $projects);
	    if (!project) return;

	    const attachKey = `${project.id}:${membershipTarget}`;
	    if (pendingProjectAttachKey === attachKey) return;
	    if ($projectMemberships.some(
	      (entry) => entry.projectId === project.id && entry.instanceId === membershipTarget,
	    )) {
	      return;
	    }

	    pendingProjectAttachKey = attachKey;
	    try {
      if (node.data?.browserContext) {
        await attachInstanceToProject(project.id, membershipTarget);
        const referenceAsset = await createBrowserReferenceAsset(project, node.data.browserContext);
        await sendBrowserProjectUpdate(project, node.data.browserContext, referenceAsset);
        activeProjectId = project.id;
        setCanvasMenuMessage(`Browser reference attached to ${project.name}.`);
        return;
      }

      const instanceId = node.data?.instance?.id;
      if (!instanceId) return;
	      const ok = await confirm({
	        title: 'Attach agent to project',
	        message: `Attach this agent to project "${project.name}"?\nThis shares project context with the agent. It does not change cwd, channel, or OS-level file permissions.`,
	        confirmLabel: 'Attach agent',
	      });
	      if (!ok) return;
	      await attachAgentToProject(project, instanceId);
	    } catch (err) {
	      console.error('[projects] failed to attach instance:', err);
	    } finally {
	      pendingProjectAttachKey = null;
	    }
	  }

	  async function handleProjectBoundaryGeometryChange(
	    event: CustomEvent<{ project: ProjectSpace; boundary: ProjectBoundaryGeometry }>,
	  ): Promise<void> {
	    try {
	      const saved = await saveProject({
	        ...event.detail.project,
	        boundary: event.detail.boundary,
	      });
	      nodes = translateNodesWithMovedProject(event.detail.project, saved.boundary, nodes);
	      activeProjectId = saved.id;
	      await syncEnclosedAgents(saved);
	    } catch (err) {
	      console.error('[projects] failed to save project boundary:', err);
	    }
	  }

	  function handleProjectBoundarySync(event: CustomEvent<{ project: ProjectSpace }>): void {
	    void syncEnclosedAgents(event.detail.project);
	  }

  function handlePaneClick() {
    closeCanvasCommandMenu();
    clearSelection();
    if (activeTab === 'inspect' && !inspectWorkspaceOpen) {
      activeTab = 'launch';
    }
  }

  function handleInspectorClose() {
    clearSelection();
    activeTab = 'launch';
  }

  function latestBrowserEventId(eventList: Array<{ id: number; type: string }>): number {
    let latest = 0;
    for (const event of eventList) {
      if (!event.type.startsWith('browser.')) continue;
      latest = Math.max(latest, event.id);
    }
    return latest;
  }

  async function refreshBrowserCatalogForCanvas(scope: string | null, latestEventId: number): Promise<void> {
    if (scope === null) {
      browserCatalogRefreshKey = '';
      browserContexts = [];
      browserTabs = [];
      browserSnapshots = [];
      return;
    }

    const key = `${scope}:${latestEventId}`;
    if (browserCatalogRefreshKey === key) return;
    browserCatalogRefreshKey = key;

    try {
      const catalog = await invoke<BrowserCatalog>('ui_list_browser_catalog', { scope });
      browserContexts = catalog.contexts ?? [];
      browserTabs = catalog.tabs ?? [];
      browserSnapshots = catalog.snapshots ?? [];
    } catch (err) {
      console.warn('[browser] failed to load browser catalog for canvas:', err);
    }
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
    closeCanvasCommandMenu();
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
    showMobileAccess = false;
    showSettings = true;
  }

  function openHome() {
    if (workspaceStage !== 'closed') return;
    closeCanvasCommandMenu();
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
    showMobileAccess = false;
    showSettings = false;
    appMode = 'home';
  }

	  function enterCanvas() {
	    closeCanvasCommandMenu();
	    appMode = 'canvas';
	    analyzeOverlayOpen = false;
	    frazierCodeOpen = false;
	    inspectWorkspaceOpen = false;
	    agentCommandCenterOpen = false;
	    setShellSurfaceOpen(false);
	  }

	  function openProject(project: ProjectSpace): void {
	    closeCanvasCommandMenu();
	    activeProjectId = project.id;
	    projectPageOpen = true;
	    appMode = 'canvas';
	    analyzeOverlayOpen = false;
	    frazierCodeOpen = false;
	    inspectWorkspaceOpen = false;
	    agentCommandCenterOpen = false;
	  }

	  function handleProjectOpen(event: CustomEvent<{ project: ProjectSpace }>): void {
	    openProject(event.detail.project);
	  }

	  function closeProjectPage(): void {
	    projectPageOpen = false;
	  }

	  function handleProjectDeleted(): void {
	    projectPageOpen = false;
	    activeProjectId = null;
	  }

	  async function handleProjectRespawn(
	    event: CustomEvent<{ project: ProjectSpace; instanceId: string }>,
	  ): Promise<void> {
	    const { project, instanceId } = event.detail;
	    const instance = $instances.get(instanceId);
	    const label = instance?.label
	      ?.split(/\s+/)
	      .find((token) => token.startsWith('name:'))
	      ?.slice('name:'.length)
	      .replace(/_/g, ' ')
	      || instanceId.slice(0, 8);
	    const scope = project.scope ?? project.root;
	    const ok = await confirm({
	      title: 'Respawn in project',
	      message: `Respawn ${label} in ${project.root}? This explicitly changes the restarted process working directory and project channel. Live agents must be stopped before this can run.`,
	      confirmLabel: 'Respawn',
	      danger: true,
	    });
	    if (!ok) return;

	    try {
	      const result = await respawnInstanceInProject(instanceId, project.root, scope);
	      await sleep(2200);
	      await sendProjectBootstrap(project, instanceId, result.pty_id);
	    } catch (err) {
	      console.error('[projects] failed to respawn in project:', err);
	    }
	  }

  function closeSettings() {
    showSettings = false;
  }

  function openMobileAccess() {
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
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
    const overlayOpen = showSettings || showMobileAccess || appMode === 'home' || analyzeOverlayOpen || frazierCodeOpen || inspectWorkspaceOpen || agentCommandCenterOpen;

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
        if (analyzeOverlayOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeAnalyzeOverlay();
          return;
        }
        if (frazierCodeOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeFrazierCode();
          return;
        }
        if (inspectWorkspaceOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeInspectWorkspace();
          return;
        }
        if (agentCommandCenterOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeAgentCommandCenter();
          return;
        }
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
      frazierCodeOpen = false;
      showMobileAccess = false;
      showSettings = true;
      return;
    }

  }

  function miniMapNodeColor(node: { data?: { status?: string; project?: ProjectNodeAccent | null } }): string {
    const data = node.data;
    if (!data) return '#05070a';
    if (data.project?.color) return data.project.color;

    switch (data.status) {
      case 'online':
        return '#a6e3a1';
      case 'stale':
        return '#f9e2af';
      case 'offline':
        return '#6c7086';
      case 'pending':
        return '#00f060';
      default:
        return '#05070a';
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
  style="--sidebar-inset: 0px; --sidebar-transition-duration: {shellSurfaceResizing ? '0ms' : '420ms'}; --mode-rail-width: {MODE_RAIL_WIDTH}px; --shell-surface-gap: {SHELL_SURFACE_GAP}px;"
>
  <!-- Canvas area -->
  <div
    class="canvas-area"
    class:connection-active={connectionActive}
    class:has-strip={appMode === 'canvas'}
    role="application"
    aria-label="Agent canvas"
    tabindex="-1"
    on:contextmenu={handleCanvasContextMenu}
  >
    {#if appMode === 'canvas'}
      <TopStrip
        {activeProject}
        openSignal={kitOpenSignal}
        browserOpenSignal={browserOpenSignal}
        on:openProject={handleProjectOpen}
        on:launchAgent={openLaunchDeckFromCanvasMenu}
        on:launchChrome={launchChromeFromCanvasMenu}
        on:createNote={openNoteFromCanvasMenu}
        on:plan={openPlanFromCanvasMenu}
        on:importFile={openImportFromCanvasMenu}
        on:organize={openOrganizeFromCanvasMenu}
        on:openSettings={openSettings}
      />
      {#if canvasQuickMenu}
        <div
          class="canvas-quick-menu"
          style={`left:${canvasQuickMenu.x}px; top:${canvasQuickMenu.y}px;`}
          role="menu"
          tabindex="-1"
          aria-label="Canvas quick actions"
          on:pointerdown|stopPropagation
          on:contextmenu|preventDefault
        >
          <button type="button" role="menuitem" on:click={openLaunchDeckFromCanvasMenu}>
            <span>+</span>
            <strong>Launch Agent</strong>
          </button>
          <button type="button" role="menuitem" on:click={launchChromeFromCanvasMenu}>
            <span>BR</span>
            <strong>Browser Surface</strong>
          </button>
          <button type="button" role="menuitem" on:click={() => { closeCanvasCommandMenu(); kitOpenSignal += 1; }}>
            <span>KIT</span>
            <strong>Workspace Kit</strong>
          </button>
          <button type="button" role="menuitem" on:click={openNoteFromCanvasMenu}>
            <span>N</span>
            <strong>Create Note</strong>
          </button>
          <button type="button" role="menuitem" on:click={openPlanFromCanvasMenu}>
            <span>P</span>
            <strong>Plan</strong>
          </button>
          <button type="button" role="menuitem" on:click={openOrganizeFromCanvasMenu}>
            <span>?</span>
            <strong>Inspect Canvas</strong>
          </button>
        </div>
      {/if}
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

    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      {edgeTypes}
      fitView
      onnodeclick={handleNodeClick}
	      onedgeclick={handleEdgeClick}
	      onpaneclick={handlePaneClick}
	      onnodedragstop={handleNodeDragStop}
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
	      <ViewportPortal target="back">
	        {#each $projects as project (project.id)}
	          <ProjectBoundary
	            {project}
	            active={project.id === activeProjectId}
	            on:open={handleProjectOpen}
	            on:geometryChange={handleProjectBoundaryGeometryChange}
	            on:sync={handleProjectBoundarySync}
	          />
	        {/each}
	      </ViewportPortal>
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
    {#if appMode === 'canvas'}
      <nav class="mode-rail" aria-label="Canvas surfaces">
        <div class="mode-rail-group">
          <button
            type="button"
            class="mode-btn"
            class:selected={activeTab === 'launch'}
            class:open={activeTab === 'launch' && shellSurfaceOpen}
            on:click={() => openShellTab('launch')}
            title="Launch"
            aria-pressed={activeTab === 'launch' && shellSurfaceOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span class="mode-btn-label">Launch</span>
          </button>

          <button
            type="button"
            class="mode-btn"
            class:selected={activeTab === 'chat'}
            class:open={activeTab === 'chat' && shellSurfaceOpen}
            on:click={() => openShellTab('chat')}
            title="Chat"
            aria-pressed={activeTab === 'chat' && shellSurfaceOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span class="mode-btn-label">Chat</span>
          </button>

          <button
            type="button"
            class="mode-btn"
            class:selected={activeTab === 'inspect'}
            class:open={inspectWorkspaceOpen}
            on:click={() => openShellTab('inspect')}
            title="Inspect"
            aria-pressed={inspectWorkspaceOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <span class="mode-btn-label">Inspect</span>
          </button>

          <button
            type="button"
            class="mode-btn"
            class:selected={agentCommandCenterOpen}
            class:open={agentCommandCenterOpen}
            on:click={openAgentCommandCenter}
            title="Agents"
            aria-pressed={agentCommandCenterOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
              <circle cx="12" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span class="mode-btn-label">Agents</span>
          </button>

          <button
            type="button"
            class="mode-btn"
            class:selected={analyzeOverlayOpen}
            class:open={analyzeOverlayOpen}
            on:click={toggleAnalyzeOverlay}
            title="Analyze"
            aria-pressed={analyzeOverlayOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 19h16" />
              <path d="M7 15V9" />
              <path d="M12 15V5" />
              <path d="M17 15v-3" />
            </svg>
            <span class="mode-btn-label">Analyze</span>
          </button>
        </div>

        <div class="mode-rail-group mode-rail-group--bottom">
          <button
            type="button"
            class="mode-btn mode-btn--utility"
            on:click={openMobileAccess}
            title="Mobile Access"
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
              <path d="M11 18.5h2" />
            </svg>
            <span class="mode-btn-label">Mobile</span>
          </button>

          <button
            type="button"
            class="mode-btn mode-btn--utility"
            on:click={openSettings}
            title="Settings"
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.23.77.35 1.19.35H21a2 2 0 0 1 0 4h-.09c-.42 0-.83.12-1.19.35z" />
            </svg>
            <span class="mode-btn-label">Settings</span>
          </button>

          <button
            type="button"
            class="mode-btn mode-btn--utility mode-btn--frazier"
            class:selected={frazierCodeOpen}
            class:open={frazierCodeOpen}
            on:click={openFrazierCode}
            title="FrazierCode [Agentic]"
            aria-pressed={frazierCodeOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 4 3 12l5 8" />
              <path d="M16 4l5 8-5 8" />
              <path d="M10 15h4" />
              <path d="M11 9h4" />
            </svg>
            <span class="mode-btn-label mode-btn-label--stacked">
              <span>Frazier</span>
              <span>Code</span>
              <span>[Agentic]</span>
            </span>
          </button>

          <button
            type="button"
            class="mode-btn mode-btn--utility"
            class:selected={shellSurfaceOpen}
            on:click={toggleShellSurface}
            title={shellSurfaceOpen ? 'Hide shell surface' : 'Show shell surface'}
            aria-pressed={shellSurfaceOpen}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {#if shellSurfaceOpen}
                <path d="M15 18l-6-6 6-6" />
              {:else}
                <path d="M9 18l6-6-6-6" />
              {/if}
            </svg>
            <span class="mode-btn-label">{shellSurfaceOpen ? 'Hide' : 'Show'}</span>
          </button>
        </div>
      </nav>

      <section
        class="shell-surface"
        class:open={shellSurfaceOpen}
        class:resizing={shellSurfaceResizing}
        style="width: {shellSurfaceWidth}px"
        aria-hidden={!shellSurfaceOpen}
        on:wheel|stopPropagation
        on:touchmove|stopPropagation
      >
        <div
          class="surface-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize shell surface"
          on:pointerdown={startShellSurfaceResize}
          on:pointermove={onShellSurfaceResize}
          on:pointerup={endShellSurfaceResize}
          on:pointercancel={endShellSurfaceResize}
        ></div>

        <header class="surface-header">
          <div class="surface-header-folder" aria-hidden="true">
            <img src={darkFolderAsset} alt="" />
          </div>
          <div class="surface-header-copy">
            <span class="surface-kicker">Canvas Surface</span>
            <h2>{shellSurfaceTitle}</h2>
            <p>{shellSurfaceCopy}</p>
          </div>
          <div class="surface-header-actions">
            <span class="surface-badge">{shellSurfaceBadge}</span>
            <button
              type="button"
              class="surface-action"
              on:click={toggleShellSurface}
              aria-label="Hide shell surface"
              title="Hide shell surface"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </div>
        </header>

        <div class="surface-body">
          <div class="tab-panel" class:hidden={activeTab !== 'launch'}>
            <Launcher bind:this={launcherRef} />
          </div>
          <div class="tab-panel" class:hidden={activeTab !== 'chat'}>
            <ConversationPanel />
          </div>
        </div>
      </section>
    {/if}
  </div>

  {#if showSettings}
    <SettingsModal on:close={closeSettings} />
  {/if}

	  {#if appMode === 'home'}
	    <StartupHome
	      on:enterCanvas={enterCanvas}
	      on:openSettings={openSettings}
	      on:openFrazierCode={openFrazierCode}
	      on:openProject={handleProjectOpen}
	    />
	  {/if}

	  {#if projectPageOpen && activeProject}
	    <ProjectPage
	      project={activeProject}
	      memberships={$projectMemberships}
	      instances={instanceList}
	      tasks={taskList}
	      locks={Array.from($locks.values())}
	      events={eventList}
	      on:close={closeProjectPage}
	      on:deleted={handleProjectDeleted}
	      on:respawnAgent={handleProjectRespawn}
	    />
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

  <AnalyzePanel open={analyzeOverlayOpen} on:close={closeAnalyzeOverlay} />

  <FrazierCodePanel open={frazierCodeOpen} on:close={closeFrazierCode} />

  <InspectWorkspace
    open={inspectWorkspaceOpen}
    {selectedNode}
    {selectedEdge}
    projects={$projects}
    on:close={closeInspectWorkspace}
  />

  <AgentCommandCenter
    open={agentCommandCenterOpen}
    instances={instanceList}
    tasks={taskList}
    projects={$projects}
    on:close={closeAgentCommandCenter}
    on:launchProfile={() => {
      closeAgentCommandCenter();
      activeTab = 'launch';
      setShellSurfaceOpen(true);
    }}
  />

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
  .app-root.workspace-active .mode-rail,
  .app-root.workspace-active .shell-surface {
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

  .canvas-quick-menu {
    position: absolute;
    z-index: 60;
    width: 230px;
    padding: 8px;
    display: grid;
    gap: 4px;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 8px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 28%),
      rgba(0, 0, 0, 0.88);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 18px 42px rgba(0, 0, 0, 0.54),
      0 0 28px rgba(106, 216, 255, 0.12);
    backdrop-filter: blur(22px) saturate(1.16);
    -webkit-backdrop-filter: blur(22px) saturate(1.16);
  }

  .canvas-quick-menu button {
    width: 100%;
    min-height: 36px;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0 9px;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    background: transparent;
    color: rgba(238, 250, 255, 0.9);
    text-align: left;
    cursor: pointer;
  }

  .canvas-quick-menu button:hover,
  .canvas-quick-menu button:focus-visible {
    border-color: rgba(106, 216, 255, 0.38);
    background: rgba(106, 216, 255, 0.11);
    outline: none;
  }

  .canvas-quick-menu span {
    width: 28px;
    height: 24px;
    display: inline-grid;
    place-items: center;
    border: 1px solid rgba(106, 216, 255, 0.24);
    border-radius: 4px;
    color: rgba(106, 216, 255, 0.86);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 10px;
    letter-spacing: 0;
  }

  .canvas-quick-menu strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .mode-rail {
    position: absolute;
    top: 44px;
    right: 16px;
    bottom: 108px;
    width: var(--mode-rail-width, 68px);
    padding: 12px 8px;
    box-sizing: border-box;
    border: 1px solid rgba(108, 112, 134, 0.18);
    border-radius: 20px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 28%),
      color-mix(in srgb, var(--terminal-bg, #05070a) 78%, transparent);
    backdrop-filter: blur(calc(var(--sidebar-blur, 40px) * 0.85)) saturate(1.22);
    -webkit-backdrop-filter: blur(calc(var(--sidebar-blur, 40px) * 0.85)) saturate(1.22);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    z-index: 32;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.32);
  }

  .mode-rail-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mode-rail-group--bottom {
    margin-top: auto;
  }

  .mode-btn {
    position: relative;
    width: 100%;
    min-height: 58px;
    padding: 9px 8px 8px;
    border-radius: 12px;
    border: 1px solid transparent;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 68%, transparent);
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
    overflow: hidden;
    transition:
      transform 160ms ease,
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease,
      box-shadow 160ms ease;
  }

  .mode-btn:hover {
    transform: translateY(-1px);
    background: color-mix(in srgb, var(--terminal-bg, #05070a) 68%, white 4%);
    color: var(--terminal-fg, #c0caf5);
    border-color: color-mix(in srgb, var(--status-pending, #00f060) 36%, transparent);
  }

  .mode-btn:active {
    transform: translateY(0);
  }

  .mode-btn.selected {
    color: var(--terminal-fg, #c0caf5);
  }

  .mode-btn.open {
    background: color-mix(in srgb, var(--terminal-bg, #05070a) 70%, var(--status-pending, #00f060) 8%);
    border-color: var(--node-border, rgba(255, 255, 255, 0.2));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .mode-btn--utility {
    min-height: 54px;
  }

  .mode-btn-icon,
  .mode-btn-label {
    position: relative;
    z-index: 1;
  }

  .mode-btn-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
  }

  .mode-btn-label {
    max-width: 100%;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.075em;
    line-height: 1.15;
    text-transform: uppercase;
    white-space: nowrap;
    text-align: center;
  }

  .mode-btn-label--stacked {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 8px;
    line-height: 1.05;
    letter-spacing: 0.055em;
    white-space: normal;
  }

  .mode-btn--frazier {
    min-height: 68px;
  }

  .shell-surface {
    position: absolute;
    top: 44px;
    right: calc(var(--mode-rail-width, 68px) + var(--shell-surface-gap, 18px) + 16px);
    bottom: 108px;
    max-width: calc(100vw - 144px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 24px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.03) 18%, transparent),
      color-mix(in srgb, var(--terminal-bg, #05070a) 82%, transparent);
    backdrop-filter: blur(calc(var(--sidebar-blur, 40px) + 4px)) saturate(1.2);
    -webkit-backdrop-filter: blur(calc(var(--sidebar-blur, 40px) + 4px)) saturate(1.2);
    box-shadow:
      0 28px 80px rgba(0, 0, 0, 0.36),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 31;
    opacity: 0;
    pointer-events: none;
    transform: translateX(calc(100% + 32px));
    transition:
      transform var(--sidebar-transition-duration, 420ms) cubic-bezier(0.22, 1, 0.36, 1),
      opacity 220ms ease,
      box-shadow 220ms ease;
  }

  .shell-surface.open {
    z-index: 70;
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }

  .shell-surface.resizing {
    transition: none;
  }

  .surface-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -6px;
    width: 12px;
    cursor: col-resize;
    z-index: 6;
    background: transparent;
  }

  .surface-resize-handle::after {
    content: '';
    position: absolute;
    top: 28px;
    bottom: 28px;
    left: 5px;
    width: 2px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    transition: background 120ms ease, box-shadow 120ms ease;
  }

  .surface-resize-handle:hover::after,
  .shell-surface.resizing .surface-resize-handle::after {
    background: rgba(0, 240, 96, 0.54);
    box-shadow: 0 0 12px rgba(0, 240, 96, 0.35);
  }

  .surface-header {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr) auto;
    grid-template-areas: "folder copy actions";
    align-items: center;
    column-gap: 14px;
    row-gap: 0;
    padding: 11px 14px 10px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }

  .surface-header-folder {
    grid-area: folder;
    width: 132px;
    min-width: 0;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    border-radius: 0;
    overflow: visible;
    border: 0;
    background: transparent;
    pointer-events: none;
  }

  .surface-header-folder img {
    width: 132px;
    max-height: 76px;
    height: auto;
    object-fit: contain;
    object-position: left center;
    opacity: 0.96;
    filter:
      brightness(1.22)
      contrast(1.08)
      saturate(0.9)
      drop-shadow(0 0 12px rgba(0, 240, 96, 0.12));
    mix-blend-mode: screen;
  }

  .surface-header-copy {
    grid-area: copy;
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }

  .surface-kicker {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(166, 173, 200, 0.78);
  }

  .surface-header-copy h2 {
    margin: 0;
    font-size: 19px;
    line-height: 1.05;
    font-weight: 700;
    color: var(--terminal-fg, #c0caf5);
  }

  .surface-header-copy p {
    margin: 0;
    max-width: 100%;
    font-size: 11.5px;
    line-height: 1.28;
    color: rgba(166, 173, 200, 0.86);
  }

  .surface-header-actions {
    grid-area: actions;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    min-width: max-content;
    align-self: end;
  }

  .surface-badge {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.04);
    color: var(--terminal-fg, #c0caf5);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    line-height: 1;
    text-transform: uppercase;
  }

  .surface-action {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: transparent;
    color: rgba(166, 173, 200, 0.86);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease,
      transform 160ms ease;
  }

  .surface-action:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--terminal-fg, #c0caf5);
    border-color: rgba(0, 240, 96, 0.4);
    transform: translateX(-1px);
  }

  .surface-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    overscroll-behavior: contain;
  }

  :global(.shell-surface:has(.agent-modal-backdrop)),
  :global(.surface-body:has(.agent-modal-backdrop)),
  :global(.tab-panel:has(.agent-modal-backdrop)) {
    overflow: visible;
  }

  :global(.shell-surface:has(.agent-modal-backdrop)) {
    z-index: 90;
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

  .floating-home {
    position: absolute;
    top: 42px;
    left: 14px;
    z-index: 20;
    height: 34px;
    padding: 0 13px 0 11px;
    border-radius: 10px;
    border: 1px solid rgba(108, 112, 134, 0.35);
    background: color-mix(in srgb, var(--terminal-bg, #05070a) 78%, transparent);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.08);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.08);
    color: #a6adc8;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
    transition:
      background 160ms ease,
      color 160ms ease,
      border-color 160ms ease,
      transform 160ms ease;
  }

  .floating-home:hover {
    background: rgba(49, 50, 68, 0.92);
    color: var(--terminal-fg, #c0caf5);
    border-color: rgba(0, 240, 96, 0.55);
    transform: translateY(-1px);
  }

  .floating-home:active {
    transform: translateY(0);
  }

  :global([data-theme="tron-encom-os"]) .mode-rail {
    border-radius: 0;
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 32%),
      rgba(2, 4, 8, 0.38);
    box-shadow:
      var(--glow-s, 0 0 20px rgba(255, 255, 255, 0.12)),
      inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  }

  :global([data-theme="tron-encom-os"]) .mode-btn {
    border-radius: 0;
    color: var(--fg-secondary, #aab0bb);
  }

  :global([data-theme="tron-encom-os"]) .mode-btn:hover,
  :global([data-theme="tron-encom-os"]) .mode-btn.open {
    border-color: var(--led-line, rgba(255, 255, 255, 0.6));
    background: rgba(255, 255, 255, 0.02);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.04),
      0 0 14px var(--led-halo, rgba(255, 255, 255, 0.18));
    color: var(--fg-primary, #eef3f7);
  }

  :global([data-theme="tron-encom-os"]) .mode-btn--frazier {
    color: color-mix(in srgb, #ffd94a 62%, var(--fg-secondary, #aab0bb));
  }

  :global([data-theme="tron-encom-os"]) .mode-btn--frazier:hover,
  :global([data-theme="tron-encom-os"]) .mode-btn--frazier.open {
    border-color: rgba(255, 217, 74, 0.68);
    color: #ffe66d;
    box-shadow:
      inset 0 0 0 1px rgba(255, 217, 74, 0.08),
      0 0 18px rgba(255, 166, 0, 0.24),
      0 0 28px rgba(255, 255, 255, 0.11);
  }

  :global([data-theme="tron-encom-os"]) .mode-btn-label,
  :global([data-theme="tron-encom-os"]) .surface-kicker,
  :global([data-theme="tron-encom-os"]) .surface-badge {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .shell-surface {
    border-radius: 0;
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 20%),
      rgba(2, 4, 8, 0.22);
    backdrop-filter: blur(calc(var(--sidebar-blur, 40px) + 8px)) saturate(1.05);
    -webkit-backdrop-filter: blur(calc(var(--sidebar-blur, 40px) + 8px)) saturate(1.05);
    box-shadow:
      var(--glow-s, 0 0 20px rgba(255, 255, 255, 0.12)),
      inset 0 0 0 1px rgba(255, 255, 255, 0.03),
      0 22px 90px rgba(0, 0, 0, 0.5);
  }

  :global([data-theme="tron-encom-os"]) .surface-resize-handle::after {
    background: var(--led-line-s, rgba(255, 255, 255, 0.35));
  }

  :global([data-theme="tron-encom-os"]) .surface-header {
    border-bottom-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
  }

  :global([data-theme="tron-encom-os"]) .surface-header-folder {
    border-radius: 0;
    border-color: transparent;
    background: transparent;
    box-shadow: none;
  }

  :global([data-theme="tron-encom-os"]) .surface-header-folder img {
    opacity: 1;
    filter:
      brightness(1.35)
      contrast(1.08)
      saturate(0.9)
      drop-shadow(0 0 20px rgba(255, 255, 255, 0.36))
      drop-shadow(0 0 38px rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .surface-header-copy h2 {
    color: var(--fg-primary, #eef3f7);
  }

  :global([data-theme="tron-encom-os"]) .surface-header-copy p {
    color: var(--fg-muted, #8b93a1);
  }

  :global([data-theme="tron-encom-os"]) .surface-badge,
  :global([data-theme="tron-encom-os"]) .surface-action,
  :global([data-theme="tron-encom-os"]) .floating-home {
    border-radius: 0;
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
  }

  :global([data-theme="tron-encom-os"]) .surface-badge {
    background: rgba(255, 255, 255, 0.02);
    color: var(--fg-primary, #eef3f7);
    box-shadow: 0 0 10px var(--led-halo, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .surface-action {
    color: var(--fg-primary, #eef3f7);
  }

  :global([data-theme="tron-encom-os"]) .surface-action:hover {
    background: rgba(255, 255, 255, 0.05);
    box-shadow: 0 0 10px var(--led-halo, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .floating-home {
    background: rgba(2, 4, 8, 0.22);
    color: var(--fg-primary, #eef3f7);
    box-shadow:
      var(--glow-s, 0 0 20px rgba(255, 255, 255, 0.12)),
      inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  }

  @media (max-width: 900px) {
    .mode-rail {
      top: auto;
      left: 16px;
      right: 16px;
      bottom: 16px;
      width: auto;
      padding: 8px;
      flex-direction: row;
      align-items: stretch;
      gap: 8px;
    }

    .mode-rail-group {
      flex-direction: row;
    }

    .mode-rail-group--bottom {
      margin-top: 0;
      margin-left: auto;
    }

    .mode-btn {
      width: 56px;
      min-width: 56px;
    }

    .mode-btn-label {
      display: none;
    }

    .shell-surface {
      top: 52px;
      right: 16px;
      left: 16px;
      bottom: 104px;
      width: auto !important;
      max-width: none;
      border-radius: 20px;
    }

    .surface-resize-handle {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .surface-header {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "copy actions"
        "folder folder";
      align-items: flex-start;
    }

    .surface-header-folder {
      width: 132px;
      min-width: 0;
      height: 54px;
    }

    .surface-header-actions {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
