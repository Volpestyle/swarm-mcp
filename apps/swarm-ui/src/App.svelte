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
	    setScopeSelection,
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
	    broadcastOperatorMessage,
	    sendOperatorMessage,
	    spawnShell,
	    writeToPty,
	  } from './stores/pty';
	  import {
	    attachInstanceToProject,
	    DEFAULT_PROJECT_COLOR,
	    findProjectContainingNode,
	    findNodesInsideProject,
	    loadProjects,
	    projectMembershipTargetForNode,
	    projectMemberships,
	    projects,
	    saveProject,
	    translateNodesWithMovedProject,
	  } from './stores/projects';
  import {
    createProjectNoteAsset,
    loadProjectAssets,
    normalizeProjectAssets,
    projectAssets,
    projectInventory,
    saveProjectAsset,
  } from './stores/projectAssets';
  import { startupPreferences } from './stores/startup';
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
		    CanvasAppSurface,
		    CanvasMission,
	    ChromeTabCandidate,
	    ProjectBoundary as ProjectBoundaryGeometry,
	    ProjectMembership,
	    ProjectAsset,
	    ProjectInventoryEntry,
	    ProjectNodeAccent,
	    ProjectSpace,
	    Task,
	    XYFlowEdge,
	    XYFlowNode,
	  } from './lib/types';

		  // Custom node types (Agent 4)
		  import ProjectBoundary from './canvas/ProjectBoundary.svelte';
		  import AppSurfaceNode from './nodes/AppSurfaceNode.svelte';
		  import BrowserNode from './nodes/BrowserNode.svelte';
		  import MissionNode from './nodes/MissionNode.svelte';
	  import TerminalNode from './nodes/TerminalNode.svelte';
	  import ViewportFocus from './nodes/ViewportFocus.svelte';

  // Custom edge types (Agent 4)
  import ConnectionEdge from './edges/ConnectionEdge.svelte';

  // Panels (Agent 4)
  import AnalyzePanel from './panels/AnalyzePanel.svelte';
  import AgentCommandCenter from './panels/AgentCommandCenter.svelte';
  import AreaCaptureOverlay from './panels/AreaCaptureOverlay.svelte';
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
  import MajordomoArchitect from './panels/MajordomoArchitect.svelte';
  import ProviderLaunchOverlay from './panels/ProviderLaunchOverlay.svelte';
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
  import { requestNodeFocus } from './lib/app/focus';
  import {
    PRIMARY_AGENT_PROVIDER_CHOICES,
    type AgentProviderChoice,
  } from './lib/agentProviders';
  import {
    formatLaunchPreflightFailure,
    preflightLaunchCommand,
  } from './lib/launchPreflight';
  import { projectTasksForProject } from './lib/taskBoardModel';
  import { resolveHarnessCommand } from './stores/harnessAliases';
  import {
    areaCaptureBaseName,
    buildAreaCaptureMetadata,
    createAreaCaptureDraft,
    isPngDataUrl,
    type AreaCaptureDraft,
    type AreaCaptureProof,
  } from './lib/areaCapture';
  import {
    appIdentityFromProvenance,
    browserPreviewIdentity,
    type BuildProvenance,
  } from './lib/appIdentity';
  import {
    buildSessionCloseoutMarkdown,
    buildSessionCloseoutPacket,
    fallbackCloseoutQuestions,
    shouldRunCloseout,
    type CloseoutTrigger,
  } from './lib/sessionCloseout';
  import {
    applyRuntimeTweakState,
    parseRuntimeTweakCommand,
    runtimeTweakCssVariables,
    type RuntimeTweakState,
  } from './lib/runtimeTweaks';

	  // Styles
  import './styles/terminal.css';
	  import packageInfo from '../package.json';
	  import darkFolderAsset from './assets/dark-folder.png';
	  import chromeLogo from './assets/app-icons/chrome-logo.png';
	  import notesLogo from './assets/app-icons/apple-notes-icon.png';
	  import obsidianLogo from './assets/app-icons/obsidian-logo.png';

  // -------------------------------------------------------------------
  // Node and edge type registrations for SvelteFlow
  // -------------------------------------------------------------------

	  const nodeTypes: NodeTypes = {
	    appSurface: AppSurfaceNode,
	    browser: BrowserNode,
	    mission: MissionNode,
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
	  let canvasAppSurfaces: CanvasAppSurface[] = [];
	  let canvasMissions: CanvasMission[] = [];

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
  let majordomoCollapsed = true;
	  let kitOpenSignal = 0;
		  let browserOpenSignal = 0;
		  let appRailBusy: string | null = null;
		  let appRailError = '';
	  let appRailCollapsed = false;
	  let chromeRailMenuOpen = false;
	  let chromeTabsLoading = false;
	  let chromeTabCandidates: ChromeTabCandidate[] = [];
	  let selectedChromeTabIds = new Set<string>();
	  let canvasQuickMenu: { x: number; y: number } | null = null;
  let canvasProviderMenu: { x: number; y: number; harness: string | null } | null = null;
  let canvasProviderChoice: AgentProviderChoice | null = null;
  let canvasProviderError = '';
  let canvasProviderLaunching = false;
  let canvasProjectAssetLoadKey = '';
  let canvasItemMutation = false;
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
  const proofSessionId = Date.now().toString(36);
  const COMPACT_NODE_WIDTH = 154;
  const COMPACT_NODE_HEIGHT = 54;
  const compactRestoreSizes = new Map<string, { width?: number; height?: number }>();
  let compactNodeIdSet = new Set<string>();
  let areaCaptureDraft: AreaCaptureDraft | null = null;
  let areaCaptureSaving = false;
  let areaCaptureStatus = '';
  let savedAreaCapturePaths: string[] = [];
  let closeoutSaving = false;
  let runtimeTweakState: RuntimeTweakState = { pending: [], accepted: [] };
  let runtimeTweakStatus = '';
  $: runtimeTweakStyle = Object.entries(runtimeTweakCssVariables(runtimeTweakState))
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');

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
    hasInternalModal?: () => boolean;
  };
  type AppRailId = 'chrome' | 'notes' | 'obsidian';
  type AppRailItem = {
    id: AppRailId;
    name: string;
    detail: string;
    icon: string;
    title: string;
  };
  type CanvasProjectItemKind = 'note' | 'plan' | 'folder' | 'asset';
  type CanvasProjectItem = {
    id: string;
    assetId: string | null;
    kind: CanvasProjectItemKind;
    title: string;
    subtitle: string;
    path: string | null;
    content: string | null;
    activeCount: number;
    logo: string | null;
    agentLogo: string | null;
	  };
	  const APP_RAIL_ITEMS: AppRailItem[] = [
	    {
	      id: 'chrome',
	      name: 'Chrome',
	      detail: 'Launch a fresh managed Chrome surface on the canvas.',
	      icon: chromeLogo,
	      title: 'Fresh Chrome canvas surface',
	    },
	    {
	      id: 'notes',
	      name: 'Note',
	      detail: 'Create a markdown note file and open it as a canvas document.',
	      icon: notesLogo,
	      title: 'Create markdown note on the canvas',
	    },
	    {
	      id: 'obsidian',
	      name: 'Obsidian',
	      detail: 'Open Obsidian and mark it as visible operator context.',
	      icon: obsidianLogo,
	      title: 'Open Obsidian on the canvas',
	    },
	  ];
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
	      const browserContext = node.data?.browserContext;
	      const appSurface = node.data?.appSurface;
	      if (browserContext) {
	        const catalog = await invoke<BrowserCatalog>('ui_delete_browser_context', {
	          scope: browserContext.scope,
	          contextId: browserContext.id,
	        });
	        applyBrowserCatalogToCanvas({
	          catalog,
	          focusContextId: null,
	          message: 'Browser surface deleted from the canvas.',
	        });
	        return true;
	      }

	      if (appSurface) {
	        closeAppSurface(appSurface.id);
	        return true;
	      }

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

  function shellSurfaceHasInternalModal(): boolean {
    return Boolean(launcherRef?.hasInternalModal?.());
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
	      canvasAppSurfaces,
	      canvasMissions,
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
      const missionProject = node.data?.mission?.projectId
        ? projectsById.get(node.data.mission.projectId) ?? null
        : null;
      const missionTone = missionProject
        ? { id: missionProject.id, name: missionProject.name, color: missionProject.color }
        : null;
      const targetId = projectMembershipTargetForNode(node);
      const tone = missionTone ?? (targetId ? toneByTarget.get(targetId) ?? null : null);
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
  $: if (activeProject && canvasProjectAssetLoadKey !== activeProject.id) {
    void loadCanvasProjectAssets(activeProject);
  }
  $: activeProjectAssets = activeProject
    ? $projectAssets.filter((asset) => asset.projectId === activeProject.id)
    : [];
  $: activeProjectInventory = activeProject
    ? $projectInventory.filter((entry) => entry.projectId === activeProject.id)
    : [];
	  $: canvasProjectItems = buildCanvasProjectItems(
	    activeProject,
	    activeProjectAssets,
	    activeProjectInventory,
	  );
	  $: selectedChromeTabCount = selectedChromeTabIds.size;
	  $: appRailScopeLabel = ($activeScope || activeProject?.scope || activeProject?.root || $startupPreferences.selectedDirectory || '').trim() || 'Select a channel';
	  $: canvasProviderChoice = PRIMARY_AGENT_PROVIDER_CHOICES.find(
    (choice) => choice.harness === (canvasProviderMenu?.harness ?? ''),
  ) ?? null;
	  $: instanceList = Array.from($instances.values());
	  $: taskList = Array.from($tasks.values());
	  $: eventList = $events;
	  $: canvasMissions = buildCanvasMissions(activeProject, taskList, instanceList, $projectMemberships);
	  $: layoutPersistence.sync($activeScope, nodes, $savedLayout, persistLayout);
  $: setCompactNodeScope($activeScope);
  $: pruneCompactNodeIds(nodes.map((node) => node.id));
  $: refreshBrowserCatalogForCanvas($activeScope, latestBrowserEventId($events));

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

	  onMount(async () => {
	    (window as unknown as {
	      __SWARM_UI_PROOF__?: Record<string, unknown>;
	    }).__SWARM_UI_PROOF__ = {
	      snapshot: appProofSnapshot,
	      captureRegion: captureRegionForProof,
	      startAreaCapture,
	      runCloseout: saveSessionCloseout,
	      applyTweak: handleRuntimeTweakCommand,
	    };
	    window.addEventListener('swarm-browser-catalog', handleBrowserCatalogWindowEvent);
	    window.addEventListener('swarm-app-surface-close', handleAppSurfaceCloseEvent);
	    window.addEventListener('swarm-app-surface-document-saved', handleAppSurfaceDocumentSavedEvent);
	    if (isTauriRuntime()) {
      appWindow = getCurrentWindow();
      closeRequestUnlisten = await appWindow.onCloseRequested((event) => {
        event.preventDefault();
        requestAppClose();
      });
    }
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

  function isTauriRuntime(): boolean {
    return typeof window !== 'undefined'
      && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  }

	  onDestroy(() => {
	    delete (window as unknown as {
	      __SWARM_UI_PROOF__?: Record<string, unknown>;
	    }).__SWARM_UI_PROOF__;
	    window.removeEventListener('swarm-browser-catalog', handleBrowserCatalogWindowEvent);
	    window.removeEventListener('swarm-app-surface-close', handleAppSurfaceCloseEvent);
	    window.removeEventListener('swarm-app-surface-document-saved', handleAppSurfaceDocumentSavedEvent);
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
    canvasProviderMenu = null;
    canvasProviderError = '';
  }

  function setCanvasMenuMessage(message: string): void {
    console.info(`[canvas-kit] ${message}`);
  }

  function isCanvasBackgroundEvent(event: MouseEvent): boolean {
    if (appMode !== 'canvas') return false;
    if (isInteractiveTarget(event.target)) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.svelte-flow__pane, .svelte-flow__background')) return false;
    if (
      target.closest(
        '.svelte-flow__node, .terminal-node, .browser-node, .terminal-container, .terminal-pane-anchor, [data-pty-surface], .nodrag, .nopan, .nowheel',
      )
    ) {
      return false;
    }

    return true;
  }

  function clampCanvasMenuPosition(event: MouseEvent, width: number, height: number): { x: number; y: number } {
    return {
      x: Math.max(12, Math.min(event.clientX + 8, window.innerWidth - width - 12)),
      y: Math.max(42, Math.min(event.clientY + 8, window.innerHeight - height - 12)),
    };
  }

  function handleCanvasContextMenu(event: MouseEvent): void {
    if (!isCanvasBackgroundEvent(event)) return;
    event.preventDefault();
    canvasProviderMenu = null;
    canvasQuickMenu = clampCanvasMenuPosition(event, 230, 260);
  }

  function handleCanvasDoubleClick(event: MouseEvent): void {
    if (!isCanvasBackgroundEvent(event)) return;
    event.preventDefault();
    openCanvasProviderPicker(event);
  }

  function openCanvasProviderPicker(event?: MouseEvent): void {
    canvasQuickMenu = null;
    canvasProviderError = '';
    analyzeOverlayOpen = false;
    frazierCodeOpen = false;
    inspectWorkspaceOpen = false;
    agentCommandCenterOpen = false;
    setShellSurfaceOpen(false);
    const menuWidth = 520;
    const menuHeight = 540;
    const position = event
      ? clampCanvasMenuPosition(event, menuWidth, menuHeight)
      : {
        x: Math.max(16, Math.round(window.innerWidth / 2 - menuWidth / 2)),
        y: Math.max(76, Math.round(window.innerHeight / 2 - menuHeight / 2)),
      };
    canvasProviderMenu = {
      ...position,
      harness: null,
    };
  }

  function selectCanvasProvider(choice: AgentProviderChoice): void {
    if (!canvasProviderMenu) return;
    canvasProviderError = '';
    canvasProviderMenu = {
      ...canvasProviderMenu,
      harness: choice.harness,
    };
  }

  function backToCanvasProviderPicker(): void {
    if (!canvasProviderMenu) return;
    canvasProviderError = '';
    canvasProviderMenu = {
      ...canvasProviderMenu,
      harness: null,
    };
  }

  function canvasLaunchCwd(): string {
    const selectedDirectory = $startupPreferences.selectedDirectory.trim();
    const activeScopeBase = ($activeScope ?? '').split('#')[0]?.trim() ?? '';
    return activeProject?.root || selectedDirectory || activeScopeBase;
  }

  function canvasLaunchScope(cwd: string): string {
    return $activeScope?.trim() || activeProject?.scope || cwd;
  }

  function canvasLaunchName(harness: string, role: string): string {
    return `${harness}_${role}_${Date.now().toString(36).slice(-5)}`
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .slice(0, 32);
  }

  function projectIdFromCanvasRoot(root: string): string {
    const slug = root
      .trim()
      .split('/')
      .filter(Boolean)
      .slice(-2)
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42);
    return `canvas-${slug || Date.now().toString(36)}`;
  }

  async function defaultCanvasProjectRoot(): Promise<string> {
    const selectedDirectory = $startupPreferences.selectedDirectory.trim();
    const activeScopeBase = ($activeScope ?? '').split('#')[0]?.trim() ?? '';
    if (selectedDirectory.startsWith('/')) return selectedDirectory;
    if (activeScopeBase.startsWith('/')) return activeScopeBase;
    try {
      return await invoke<string>('ui_default_project_root');
    } catch {
      return '/Users/mathewfrazier/Desktop';
    }
  }

  async function ensureCanvasProject(): Promise<ProjectSpace> {
    if (activeProject) return activeProject;
    const root = await defaultCanvasProjectRoot();
    const existing = $projects.find((project) => project.root === root) ?? $projects[0] ?? null;
    if (existing) {
      activeProjectId = existing.id;
      return existing;
    }

    const now = Date.now();
    const project = await saveProject({
      id: projectIdFromCanvasRoot(root),
      name: 'Canvas Notes',
      root,
      color: DEFAULT_PROJECT_COLOR,
      additionalRoots: [],
      notes: 'Canvas-created notes, plans, folders, and project assets.',
      scope: root,
      boundary: {
        x: 96,
        y: 104,
        width: 860,
        height: 540,
      },
      createdAt: now,
      updatedAt: now,
    });
    activeProjectId = project.id;
    appMode = 'canvas';
    return project;
  }

  function nextCanvasNoteTitle(project: ProjectSpace): string {
    const count = $projectAssets.filter(
      (asset) => asset.projectId === project.id && asset.kind === 'note',
    ).length;
    return `Canvas Note ${count + 1}`;
  }

  function canvasPlanContent(project: ProjectSpace): string {
    return [
      `# ${project.name} Plan`,
      '',
      '## Current Intention',
      '',
      '- Capture plan updates here so agents can see the project direction.',
      '- Broadcast important changes in the shared swarm channel.',
      '',
      '## Swarm Disclosure',
      '',
      `Project: ${project.name}`,
      `Channel: ${project.scope || project.root}`,
    ].join('\n');
  }

  async function createCanvasTextAsset(kind: 'note' | 'plan'): Promise<ProjectAsset | null> {
    if (canvasItemMutation) return null;
    canvasItemMutation = true;
    try {
      const project = await ensureCanvasProject();
      const isPlan = kind === 'plan';
      const title = isPlan ? `${project.name} Plan` : nextCanvasNoteTitle(project);
      const content = isPlan ? canvasPlanContent(project) : `# ${title}\n\n`;
      const asset = await createProjectNoteAsset(project.id, title, content);
      await loadProjectAssets(project.id).catch((err) => {
        console.warn('[projects] created note asset but refresh failed:', err);
      });
      activeProjectId = project.id;
      projectPageOpen = false;
      appMode = 'canvas';
      upsertCanvasDocumentSurface(project, asset);
      setCanvasMenuMessage(`${isPlan ? 'Plan' : 'Note'} created on canvas: ${asset.path ?? asset.title}`);
      return asset;
    } catch (err) {
      setCanvasMenuMessage(`Create ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      canvasItemMutation = false;
    }
  }

  function itemKindForAsset(asset: ProjectAsset): CanvasProjectItemKind {
    if (asset.kind === 'note') {
      return /plan|roadmap|spec|steps?/i.test(`${asset.title} ${asset.path ?? ''}`) ? 'plan' : 'note';
    }
    if (asset.kind === 'protocol' || asset.kind === 'reference') return 'plan';
    if (asset.kind === 'folder') return 'folder';
    return 'asset';
  }

  function itemEmoji(kind: CanvasProjectItemKind): string {
    if (kind === 'note') return '📝';
    if (kind === 'plan') return '📋';
    if (kind === 'folder') return '▣';
    return '◇';
  }

  function buildCanvasProjectItems(
    project: ProjectSpace | null,
    assets: ProjectAsset[],
    inventory: ProjectInventoryEntry[],
  ): CanvasProjectItem[] {
    if (!project) return [];
    const items = new Map<string, CanvasProjectItem>();
    const aiLogo = PRIMARY_AGENT_PROVIDER_CHOICES.find((choice) => choice.harness === 'codex')?.logoUrl ?? null;
    for (const asset of assets.filter((entry) => entry.projectId === project.id)) {
      const kind = itemKindForAsset(asset);
      items.set(asset.id, {
        id: asset.id,
        assetId: asset.id,
        kind,
        title: asset.title,
        subtitle: asset.path ? asset.path.split('/').pop() ?? asset.kind : asset.kind,
        path: asset.path,
        content: asset.content,
        activeCount: Math.max(1, asset.content?.trim() ? 1 : 0),
        logo: kind === 'folder' ? darkFolderAsset : null,
        agentLogo: kind === 'folder' ? null : aiLogo,
      });
    }

    const roots = new Set([project.root, ...project.additionalRoots]);
    for (const root of roots) {
      if (!root) continue;
      const key = `root:${root}`;
      items.set(key, {
        id: key,
        assetId: null,
        kind: 'folder',
        title: root.split('/').filter(Boolean).pop() ?? root,
        subtitle: 'project root',
        path: root,
        content: null,
        activeCount: inventory.filter((entry) => entry.path.startsWith(root)).length,
        logo: darkFolderAsset,
        agentLogo: null,
      });
    }

    const planCandidates = inventory.filter((entry) =>
      entry.projectId === project.id
      && entry.entryType === 'file'
      && ['md', 'markdown', 'txt'].includes(entry.extension)
      && /plan|spec|roadmap|todo|tasks?/i.test(entry.name)
    );
    for (const entry of planCandidates.slice(0, 4)) {
      const key = `plan:${entry.path}`;
      if (items.has(key)) continue;
      items.set(key, {
        id: key,
        assetId: null,
        kind: 'plan',
        title: entry.name,
        subtitle: entry.extension || 'text',
        path: entry.path,
        content: null,
        activeCount: 1,
        logo: null,
        agentLogo: aiLogo,
      });
    }

    return [...items.values()].sort((left, right) => {
      const rank = { plan: 0, note: 1, folder: 2, asset: 3 };
      return rank[left.kind] - rank[right.kind] || left.title.localeCompare(right.title);
    });
  }

  function canvasProjectItemStyle(project: ProjectSpace, index: number): string {
    const itemWidth = 236;
    const itemGap = 18;
    const usableWidth = Math.max(260, project.boundary.width - 56);
    const columns = Math.max(1, Math.floor((usableWidth + itemGap) / (itemWidth + itemGap)));
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = project.boundary.x + 28 + column * (itemWidth + itemGap);
    const top = project.boundary.y + 116 + row * 118;
    return `left:${left}px; top:${top}px; width:${itemWidth}px; --project-color:${project.color};`;
  }

  function buildCanvasMissions(
    project: ProjectSpace | null,
    allTasks: Task[],
    allAgents: Array<{ id: string; status: CanvasMission['agents'][number]['status']; label: string | null }>,
    memberships: ProjectMembership[],
  ): CanvasMission[] {
    if (!project) return [];
    const memberIds = new Set(
      memberships
        .filter((entry) => entry.projectId === project.id)
        .map((entry) => entry.instanceId),
    );
    const projectTasks = projectTasksForProject(allTasks, project, memberIds);
    const projectAgents = allAgents
      .filter((agent) => memberIds.has(agent.id))
      .map((agent) => ({ id: agent.id, status: agent.status, label: agent.label }));
    const activeCount = projectTasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress').length;
    const openCount = projectTasks.filter((task) => task.status === 'open' || task.status === 'blocked' || task.status === 'approval_required').length;

    return [{
      id: `mission:${project.id}`,
      projectId: project.id,
      scope: project.scope || project.root,
      root: project.root,
      title: project.name || 'Mission',
      summary: activeCount > 0
        ? `${activeCount} active task${activeCount === 1 ? '' : 's'} in motion.`
        : `${openCount} ready task${openCount === 1 ? '' : 's'} in this project.`,
      status: 'active',
      color: project.color,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      tasks: projectTasks,
      agents: projectAgents,
    }];
  }

  function canvasItemPreview(item: CanvasProjectItem): string {
    const content = item.content?.replace(/^#\s+.+$/m, '').trim();
    if (content) return content.slice(0, 96);
    return item.path ?? item.subtitle;
  }

  function handleCanvasProjectItemClick(project: ProjectSpace, item: CanvasProjectItem): void {
    activeProjectId = project.id;
    const asset = item.assetId
      ? $projectAssets.find((entry) => entry.id === item.assetId) ?? null
      : null;
    if (asset && (item.kind === 'note' || item.kind === 'plan')) {
      upsertCanvasDocumentSurface(project, asset);
      setCanvasMenuMessage(`${item.title} opened as a canvas document.`);
      return;
    }
    setCanvasMenuMessage(`${item.title} selected in ${project.name}. Opening the project surface.`);
    openProject(project);
  }

  async function loadCanvasProjectAssets(project: ProjectSpace): Promise<void> {
    canvasProjectAssetLoadKey = project.id;
    try {
      await loadProjectAssets(project.id);
    } catch (err) {
      console.warn('[projects] failed to load canvas project assets:', err);
    }
  }

  async function launchCanvasProviderRole(role: string): Promise<void> {
    const providerChoice = canvasProviderChoice;
    if (!providerChoice || canvasProviderLaunching) return;

    const cwd = canvasLaunchCwd();
    if (!cwd || !cwd.startsWith('/')) {
      canvasProviderError = 'Set a project or starting location before launching from the canvas.';
      return;
    }

    canvasProviderLaunching = true;
    canvasProviderError = '';
    try {
      const command = resolveHarnessCommand(providerChoice.harness);
      const commandPreflight = await preflightLaunchCommand({
        command,
        cwd,
        harness: providerChoice.harness,
        commandSource: 'Canvas provider picker',
      });
      if (!commandPreflight.ok) {
        canvasProviderError = formatLaunchPreflightFailure(commandPreflight);
        return;
      }

      const result = await spawnShell(cwd, {
        harness: providerChoice.harness,
        harnessCommand: command,
        role,
        scope: canvasLaunchScope(cwd),
        label: `origin:canvas_quick company:${providerChoice.company.replace(/\s+/g, '_')}`,
        name: canvasLaunchName(providerChoice.harness, role),
        bootstrapInstructions: `Launched from the canvas provider picker as ${providerChoice.label}. Adopt role:${role}, register with the swarm, read current channel state, and wait for operator or task direction after your initial readiness note.`,
        launchPreflight: commandPreflight,
      });

      const focusNodeId = result.instance_id
        ? `bound:${result.instance_id}`
        : `pty:${result.pty_id}`;
      requestNodeFocus(focusNodeId);
      closeCanvasCommandMenu();
    } catch (err) {
      canvasProviderError = `Launch failed: ${err}`;
    } finally {
      canvasProviderLaunching = false;
    }
  }

  function openLaunchDeckFromCanvasMenu(): void {
    openCanvasProviderPicker();
  }

  type BrowserCatalogUpdate = {
    catalog: BrowserCatalog;
    focusContextId?: string | null;
    message?: string | null;
  };

  function browserScopeForCanvas(): string | null {
    const scope = ($activeScope || activeProject?.scope || activeProject?.root || $startupPreferences.selectedDirectory || '').trim();
    if (!scope) return null;
    if ($activeScope !== scope) {
      setScopeSelection(scope);
    }
    return scope;
  }

  function applyBrowserCatalogToCanvas(update: BrowserCatalogUpdate): void {
    browserContexts = update.catalog.contexts ?? [];
    browserTabs = update.catalog.tabs ?? [];
    browserSnapshots = update.catalog.snapshots ?? [];
    browserCatalogRefreshKey = '';
    if (update.focusContextId) {
      requestNodeFocus(`browser:${update.focusContextId}`);
      setSelectedNode(`browser:${update.focusContextId}`);
    }
    if (update.message) {
      setCanvasMenuMessage(update.message);
    }
  }

  function handleBrowserCatalogEvent(event: CustomEvent<BrowserCatalogUpdate>): void {
    applyBrowserCatalogToCanvas(event.detail);
  }

  function handleBrowserCatalogWindowEvent(event: Event): void {
    applyBrowserCatalogToCanvas((event as CustomEvent<BrowserCatalogUpdate>).detail);
  }

  async function openFreshChromeOnCanvas(message = 'Fresh Chrome surface launched on the canvas.'): Promise<void> {
    const scope = browserScopeForCanvas();
    if (!scope) {
      appRailError = 'Choose a project or channel before launching Chrome.';
      return;
    }
    const previousIds = new Set(browserContexts.map((context) => context.id));
    appRailBusy = 'chrome';
    appRailError = '';
    try {
      const catalog = await invoke<BrowserCatalog>('ui_open_browser_context', {
        scope,
        url: 'https://www.google.com',
        headless: true,
      });
      const focusContext = catalog.contexts.find((context) => !previousIds.has(context.id))
        ?? catalog.contexts[0]
        ?? null;
      applyBrowserCatalogToCanvas({ catalog, focusContextId: focusContext?.id ?? null, message });
      chromeRailMenuOpen = false;
      await broadcastOperatorMessage(scope, `[app] Chrome managed browser surface is visible on the canvas as browser:${focusContext?.id ?? 'new'}. Agents can inspect it through swarm://browser / browser_contexts.`).catch((err) => {
        console.warn('[browser] app-surface broadcast failed:', err);
      });
    } catch (err) {
      appRailError = err instanceof Error ? err.message : String(err);
    } finally {
      appRailBusy = null;
    }
  }

  function toggleAppRailCollapsed(): void {
    appRailCollapsed = !appRailCollapsed;
    if (appRailCollapsed) {
      chromeRailMenuOpen = false;
    }
  }

  function toggleChromeRailMenu(): void {
    chromeRailMenuOpen = !chromeRailMenuOpen;
    appRailError = '';
  }

  async function loadChromeTabsForRail(): Promise<void> {
    const scope = browserScopeForCanvas();
    if (!scope) {
      appRailError = 'Choose a project or channel before importing Chrome.';
      return;
    }
    chromeTabsLoading = true;
    appRailBusy = 'chrome';
    appRailError = '';
    try {
      chromeTabCandidates = await invoke<ChromeTabCandidate[]>('ui_list_chrome_tabs');
      const nextSelection = new Set<string>();
      for (const tab of chromeTabCandidates) {
        if (tab.active) nextSelection.add(tab.id);
      }
      if (nextSelection.size === 0 && chromeTabCandidates[0]) {
        nextSelection.add(chromeTabCandidates[0].id);
      }
      selectedChromeTabIds = nextSelection;
    } catch (err) {
      appRailError = err instanceof Error ? err.message : String(err);
    } finally {
      appRailBusy = null;
      chromeTabsLoading = false;
    }
  }

  function toggleChromeTabSelection(tabId: string): void {
    const next = new Set(selectedChromeTabIds);
    if (next.has(tabId)) {
      next.delete(tabId);
    } else {
      next.add(tabId);
    }
    selectedChromeTabIds = next;
  }

  async function importSelectedChromeTabsToCanvas(): Promise<void> {
    const scope = browserScopeForCanvas();
    if (!scope) {
      appRailError = 'Choose a project or channel before importing Chrome.';
      return;
    }
    const selectedTabs = chromeTabCandidates.filter((tab) => selectedChromeTabIds.has(tab.id));
    if (selectedTabs.length === 0) {
      appRailError = 'Select at least one Chrome tab to import.';
      return;
    }
    const previousIds = new Set(browserContexts.map((context) => context.id));
    appRailBusy = 'chrome';
    appRailError = '';
    try {
      const catalog = await invoke<BrowserCatalog>('ui_import_chrome_tabs', {
        scope,
        tabs: selectedTabs,
        headless: true,
      });
      const focusContext = catalog.contexts.find((context) => !previousIds.has(context.id))
        ?? catalog.contexts[0]
        ?? null;
      applyBrowserCatalogToCanvas({
        catalog,
        focusContextId: focusContext?.id ?? null,
        message: `${selectedTabs.length} Chrome tab${selectedTabs.length === 1 ? '' : 's'} imported into one managed canvas surface.`,
      });
      chromeRailMenuOpen = false;
      await broadcastOperatorMessage(scope, `[app] Imported ${selectedTabs.length} Chrome tab${selectedTabs.length === 1 ? '' : 's'} into browser:${focusContext?.id ?? 'new'} on the canvas. Agents can inspect it through swarm://browser / browser_contexts.`).catch((err) => {
        console.warn('[browser] import broadcast failed:', err);
      });
    } catch (err) {
      appRailError = err instanceof Error ? err.message : String(err);
    } finally {
      appRailBusy = null;
    }
  }

  async function launchChromeFromCanvasMenu(): Promise<void> {
    closeCanvasCommandMenu();
    await openFreshChromeOnCanvas();
  }

  function upsertAppSurface(surface: CanvasAppSurface): void {
    canvasAppSurfaces = [
      surface,
      ...canvasAppSurfaces.filter((entry) => entry.id !== surface.id),
    ];
    requestNodeFocus(`app:${surface.id}`);
    setSelectedNode(`app:${surface.id}`);
  }

  async function launchNativeAppSurface(item: AppRailItem): Promise<void> {
    const scope = browserScopeForCanvas();
    appRailBusy = item.id;
    appRailError = '';
    try {
      await invoke('ui_launch_native_app', { appId: item.id });
      const now = Date.now();
      const surface: CanvasAppSurface = {
        id: `${item.id}-${now}`,
        appId: item.id,
        name: item.name,
        detail: item.detail,
        icon: item.icon,
        scope,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        document: null,
      };
      upsertAppSurface(surface);
      if (scope) {
        await broadcastOperatorMessage(scope, `[app] ${item.name} is open and represented on the canvas as app:${surface.id}. Treat it as operator-visible context; direct automation needs an app-specific bridge.`).catch((err) => {
          console.warn('[apps] native app broadcast failed:', err);
        });
      }
    } catch (err) {
      appRailError = err instanceof Error ? err.message : String(err);
    } finally {
      appRailBusy = null;
    }
  }

  async function launchAppRailItem(item: AppRailItem): Promise<void> {
    if (item.id === 'chrome') {
      toggleChromeRailMenu();
      return;
    }
    if (item.id === 'notes') {
      appRailBusy = item.id;
      appRailError = '';
      try {
        await createCanvasTextAsset('note');
      } catch (err) {
        appRailError = err instanceof Error ? err.message : String(err);
      } finally {
        appRailBusy = null;
      }
      return;
    }
    await launchNativeAppSurface(item);
  }

  function closeAppSurface(surfaceId: string): void {
    canvasAppSurfaces = canvasAppSurfaces.filter((surface) => surface.id !== surfaceId);
    if (selectedNodeId === `app:${surfaceId}`) {
      clearSelection();
    }
    setCanvasMenuMessage('Canvas app surface removed.');
  }

  function isPlanAsset(asset: ProjectAsset): boolean {
    return /plan|roadmap|spec|steps?/i.test(`${asset.title} ${asset.path ?? ''}`);
  }

  function documentSurfaceId(asset: ProjectAsset): string {
    return `document-${asset.id}`;
  }

  function upsertCanvasDocumentSurface(project: ProjectSpace, asset: ProjectAsset): void {
    const now = Date.now();
    const existing = canvasAppSurfaces.find((surface) => surface.id === documentSurfaceId(asset));
    const filename = asset.path?.split('/').pop() ?? 'workspace note';
    const surface: CanvasAppSurface = {
      id: documentSurfaceId(asset),
      appId: 'note',
      name: asset.title,
      detail: `${isPlanAsset(asset) ? 'Canvas plan' : 'Canvas note'} saved as ${filename}`,
      icon: notesLogo,
      scope: project.scope || project.root,
      status: 'open',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      document: {
        assetId: asset.id,
        projectId: asset.projectId,
        kind: isPlanAsset(asset) ? 'plan' : 'note',
        title: asset.title,
        path: asset.path,
        content: asset.content,
      },
    };
    upsertAppSurface(surface);
  }

  function handleAppSurfaceDocumentSavedEvent(event: Event): void {
    const detail = (event as CustomEvent<{ surfaceId: string; asset: ProjectAsset }>).detail;
    if (!detail?.surfaceId || !detail.asset) return;
    canvasAppSurfaces = canvasAppSurfaces.map((surface) => {
      if (surface.id !== detail.surfaceId || !surface.document) return surface;
      return {
        ...surface,
        name: detail.asset.title,
        updatedAt: Date.now(),
        document: {
          ...surface.document,
          title: detail.asset.title,
          path: detail.asset.path,
          content: detail.asset.content,
        },
      };
    });
  }

  function handleAppSurfaceCloseEvent(event: Event): void {
    const detail = (event as CustomEvent<{ surfaceId: string }>).detail;
    if (detail?.surfaceId) {
      closeAppSurface(detail.surfaceId);
    }
  }

  async function openNoteFromCanvasMenu(): Promise<void> {
    closeCanvasCommandMenu();
    await createCanvasTextAsset('note');
  }

  async function openPlanFromCanvasMenu(): Promise<void> {
    closeCanvasCommandMenu();
    const asset = await createCanvasTextAsset('plan');
    const project = asset ? $projects.find((entry) => entry.id === asset.projectId) ?? activeProject : null;
    if (!asset || !project) return;
    const scope = project.scope || project.root;
    await broadcastOperatorMessage(scope, `[plan] ${asset.title} is visible on the project canvas at ${asset.path ?? 'workspace note asset'}.`).catch((err) => {
      console.warn('[projects] plan broadcast failed:', err);
    });
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

  function currentSurfaceIds(): string[] {
    const surfaces = new Set<string>();
    if (appMode === 'home') surfaces.add('home');
    if (appMode === 'canvas') surfaces.add('canvas');
    if (projectPageOpen) surfaces.add('project-page');
    if (showSettings) surfaces.add('settings');
    if (areaCaptureDraft) surfaces.add('area-report-capture');
    if (canvasAppSurfaces.some((surface) => surface.document)) surfaces.add('canvas-notes');
    surfaces.add('majordomo');
    return [...surfaces].sort();
  }

  function appProofSnapshot() {
    const reportTargets = [...document.querySelectorAll<HTMLElement>('[data-report-target], [data-testid]')]
      .slice(0, 180)
      .map((element) => ({
        testId: element.dataset.testid ?? null,
        reportTarget: element.dataset.reportTarget ?? null,
        text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 180),
        bounds: element.getBoundingClientRect().toJSON(),
      }));
    return {
      mode: appMode,
      proofSessionId,
      activeProject: activeProject
        ? { id: activeProject.id, name: activeProject.name, root: activeProject.root }
        : null,
      visiblePanels: {
        shellSurfaceOpen,
        projectPageOpen,
        showSettings,
        showMobileAccess,
        areaCaptureOpen: Boolean(areaCaptureDraft),
        analyzeOverlayOpen,
        agentCommandCenterOpen,
      },
      selectedNodeId,
      selectedEdgeId,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        status: node.data?.status ?? null,
        instanceId: node.data?.instance?.id ?? null,
        ptyId: node.data?.ptySession?.id ?? null,
      })),
      appSurfaces: canvasAppSurfaces.map((surface) => ({
        id: surface.id,
        appId: surface.appId,
        name: surface.name,
        documentPath: surface.document?.path ?? null,
      })),
      reportTargets,
      runtimeTweaks: runtimeTweakCssVariables(runtimeTweakState),
      savedAreaCapturePaths,
    };
  }

  function wrapCanvasText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
  ): void {
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    let lineCount = 0;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width > maxWidth && line) {
        context.fillText(line, x, y + lineCount * lineHeight);
        line = word;
        lineCount += 1;
        if (lineCount >= maxLines) return;
      } else {
        line = next;
      }
    }
    if (line && lineCount < maxLines) {
      context.fillText(line, x, y + lineCount * lineHeight);
    }
  }

  async function captureRegionForProof(input: Partial<AreaCaptureDraft> = {}): Promise<AreaCaptureProof> {
    const draft = createAreaCaptureDraft({
      sessionId: proofSessionId,
      dateKey: localDateSlug(),
      ...input,
    });
    const width = Math.max(240, Math.round(draft.bounds.width));
    const height = Math.max(180, Math.round(draft.bounds.height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const warnings = [
      'DOM-rendered app-region proof; native WebView pixels and OS-level screenshots were not used',
    ];
    if (!context) {
      return {
        dataUrl: '',
        proofLevel: 'app-region-partial',
        warnings: [...warnings, 'canvas 2d context unavailable'],
      };
    }

    const target = draft.testId
      ? document.querySelector<HTMLElement>(`[data-testid="${draft.testId}"]`)
      : draft.featureId
        ? document.querySelector<HTMLElement>(`[data-report-target="${draft.featureId}"]`)
        : document.elementFromPoint(draft.bounds.x + draft.bounds.width / 2, draft.bounds.y + draft.bounds.height / 2);
    const targetText = (target?.textContent ?? document.body.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 1400);

    context.fillStyle = '#090b10';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#17202a';
    context.fillRect(12, 12, width - 24, height - 24);
    context.strokeStyle = '#ff3d52';
    context.lineWidth = 3;
    context.strokeRect(14, 14, width - 28, height - 28);
    context.fillStyle = '#ffd27f';
    context.font = '700 14px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(draft.surfaceId ?? 'app-region', 26, 40);
    context.fillStyle = '#e8eef8';
    context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    wrapCanvasText(context, targetText || draft.note || 'No DOM text inside selected region.', 26, 68, width - 52, 18, Math.max(4, Math.floor((height - 90) / 18)));

    return {
      dataUrl: canvas.toDataURL('image/png'),
      proofLevel: target ? 'app-region-dom' : 'app-region-partial',
      warnings,
    };
  }

  function startAreaCapture(input: Partial<AreaCaptureDraft> = {}): void {
    closeCanvasCommandMenu();
    areaCaptureStatus = '';
    areaCaptureDraft = createAreaCaptureDraft({
      sessionId: proofSessionId,
      dateKey: localDateSlug(),
      surfaceId: appMode === 'home' ? 'home' : 'canvas',
      ...input,
    });
  }

  function updateAreaCaptureDraft(next: AreaCaptureDraft): void {
    areaCaptureDraft = next;
  }

  function cancelAreaCapture(): void {
    areaCaptureDraft = null;
    areaCaptureStatus = '';
    areaCaptureSaving = false;
  }

  async function confirmAreaCapture(): Promise<void> {
    if (!areaCaptureDraft || areaCaptureSaving) return;
    areaCaptureSaving = true;
    areaCaptureStatus = 'Capturing app-region DOM proof...';
    try {
      const proof = await captureRegionForProof(areaCaptureDraft);
      if (!proof.dataUrl || !isPngDataUrl(proof.dataUrl)) {
        throw new Error('capture did not produce a valid PNG data URL');
      }
      const label = areaCaptureDraft.featureId ?? areaCaptureDraft.surfaceId ?? areaCaptureDraft.targetKind;
      const baseName = areaCaptureBaseName(savedAreaCapturePaths.length + 1, label);
      const metadata = buildAreaCaptureMetadata(areaCaptureDraft, proof);
      if (isTauriRuntime()) {
        const result = await invoke<{
          ok: boolean;
          pngPath: string;
          markdownPath: string;
          jsonPath: string;
        }>('ui_save_area_capture', {
          dateKey: areaCaptureDraft.dateKey,
          sessionId: areaCaptureDraft.sessionId,
          baseName,
          pngDataUrl: proof.dataUrl,
          metadata,
        });
        savedAreaCapturePaths = [...savedAreaCapturePaths, result.pngPath, result.markdownPath, result.jsonPath];
        areaCaptureStatus = 'Saved learning capture.';
      } else {
        savedAreaCapturePaths = [...savedAreaCapturePaths, `browser-preview:${baseName}.png`];
        areaCaptureStatus = 'Browser preview capture generated but not written by Tauri.';
      }
      areaCaptureDraft = null;
    } catch (err) {
      areaCaptureStatus = `Capture failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      areaCaptureSaving = false;
    }
  }

  async function currentAppIdentityForCloseout() {
    if (isTauriRuntime()) {
      const provenance = await invoke<BuildProvenance>('ui_build_provenance');
      return appIdentityFromProvenance(provenance);
    }
    return browserPreviewIdentity(packageInfo.version, '/Users/mathewfrazier/Desktop/swarm-mcp-lab');
  }

  async function saveSessionCloseout(trigger: CloseoutTrigger): Promise<void> {
    if (!shouldRunCloseout(trigger) || closeoutSaving) return;
    closeoutSaving = true;
    try {
      const identity = await currentAppIdentityForCloseout();
      const packet = buildSessionCloseoutPacket({
        sessionId: proofSessionId,
        endedAt: new Date().toISOString(),
        endKind: trigger,
        appIdentity: identity,
        projectRoot: activeProject?.root ?? '',
        scopeOrChannel: $activeScope ?? activeProject?.scope ?? '',
        surfaceIds: currentSurfaceIds(),
        areaCaptures: savedAreaCapturePaths,
        visualAtlasPath: 'output/visual-atlas/latest',
        majordomoRuntime: {
          harness: 'fallback',
          model: null,
          provider: null,
          instanceId: null,
          ptyId: null,
          questionStatus: 'fallback-only',
          cleanupStatus: 'not-needed',
        },
      });
      const questions = fallbackCloseoutQuestions(packet.areaCaptures);
      const markdown = buildSessionCloseoutMarkdown(packet, questions);
      if (isTauriRuntime()) {
        await invoke('ui_save_session_closeout', {
          dateKey: localDateSlug(),
          sessionId: proofSessionId,
          markdown,
          packet,
        });
      }
    } catch (err) {
      console.warn('[closeout] failed to save session closeout:', err);
    } finally {
      closeoutSaving = false;
    }
  }

  function handleRuntimeTweakCommand(commandText: string): string {
    try {
      const command = parseRuntimeTweakCommand(commandText);
      runtimeTweakState = applyRuntimeTweakState(runtimeTweakState, command);
      runtimeTweakStatus = command.kind === 'accept'
        ? 'Accepted runtime tweaks for this session.'
        : command.kind === 'reset'
          ? 'Cleared pending runtime tweaks.'
          : `Applied ${command.label} ${command.kind} tweak.`;
      return runtimeTweakStatus;
    } catch (err) {
      runtimeTweakStatus = err instanceof Error ? err.message : String(err);
      return runtimeTweakStatus;
    }
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
    if (shellSurfaceOpen && !shellSurfaceHasInternalModal()) {
      setShellSurfaceOpen(false);
    }
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
	    void saveSessionCloseout('project-close');
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
    await saveSessionCloseout('app-ui-quit');
    try {
      await invoke('ui_exit_app');
    } catch (err) {
      console.error('[App] failed to exit app:', err);
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (showCloseConfirm) return;

    const meta = event.metaKey || event.ctrlKey;
    const majordomoOverlayOpen = appMode === 'canvas' && !majordomoCollapsed;
    const overlayOpen = showSettings
      || showMobileAccess
      || appMode === 'home'
      || analyzeOverlayOpen
      || frazierCodeOpen
      || inspectWorkspaceOpen
      || agentCommandCenterOpen
      || majordomoOverlayOpen;

    if (!event.defaultPrevented && !event.repeat && !event.isComposing) {
      if (event.key === 'Escape' && shellSurfaceOpen && !overlayOpen && !shellSurfaceHasInternalModal()) {
        event.preventDefault();
        event.stopPropagation();
        setShellSurfaceOpen(false);
        return;
      }

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
  style="--sidebar-inset: 0px; --sidebar-transition-duration: {shellSurfaceResizing ? '0ms' : '420ms'}; --mode-rail-width: {MODE_RAIL_WIDTH}px; --shell-surface-gap: {SHELL_SURFACE_GAP}px; {runtimeTweakStyle}"
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
    on:dblclick={handleCanvasDoubleClick}
  >
    {#if appMode === 'canvas'}
	      <TopStrip
	        {activeProject}
        openSignal={kitOpenSignal}
        browserOpenSignal={browserOpenSignal}
        on:openProject={handleProjectOpen}
	        on:launchAgent={openLaunchDeckFromCanvasMenu}
	        on:launchChrome={launchChromeFromCanvasMenu}
	        on:browserCatalog={handleBrowserCatalogEvent}
	        on:createNote={openNoteFromCanvasMenu}
        on:plan={openPlanFromCanvasMenu}
        on:importFile={openImportFromCanvasMenu}
        on:organize={openOrganizeFromCanvasMenu}
	        on:openSettings={openSettings}
	      />
	      <nav
	        class="app-left-rail"
	        class:collapsed={appRailCollapsed}
	        aria-label="Canvas apps"
	        on:pointerdown|stopPropagation
	      >
	        <button
	          type="button"
	          class="app-left-rail-toggle"
	          title={appRailCollapsed ? 'Expand app bar' : 'Collapse app bar'}
	          aria-label={appRailCollapsed ? 'Expand app bar' : 'Collapse app bar'}
	          on:click={toggleAppRailCollapsed}
	        >
	          <span aria-hidden="true">{appRailCollapsed ? '›' : '‹'}</span>
	        </button>
	        {#each APP_RAIL_ITEMS as item (item.id)}
	          <button
	            type="button"
	            class:busy={appRailBusy === item.id}
	            class:active={item.id === 'chrome' && chromeRailMenuOpen}
	            title={item.title}
	            aria-label={item.title}
	            on:click={() => launchAppRailItem(item)}
	          >
	            <img src={item.icon} alt="" aria-hidden="true" />
	            <span>{item.name}</span>
	          </button>
	        {/each}
	        {#if appRailError}
	          <p title={appRailError}>{appRailError}</p>
	        {/if}
	      </nav>
	      {#if chromeRailMenuOpen && !appRailCollapsed}
	        <div class="chrome-rail-popover" role="dialog" tabindex="-1" aria-label="Chrome canvas options" on:pointerdown|stopPropagation>
	          <header>
	            <img src={chromeLogo} alt="" aria-hidden="true" />
	            <div>
	              <strong>Chrome Canvas</strong>
	              <span>{appRailScopeLabel}</span>
	            </div>
	          </header>
	          <div class="chrome-rail-actions">
	            <button type="button" disabled={appRailBusy === 'chrome'} on:click={() => openFreshChromeOnCanvas('Fresh Chrome tab is now a managed canvas surface.')}>
	              New Tab
	            </button>
	            <button type="button" disabled={chromeTabsLoading || appRailBusy === 'chrome'} on:click={loadChromeTabsForRail}>
	              {chromeTabsLoading ? 'Reading...' : 'Import'}
	            </button>
	          </div>
	          {#if chromeTabCandidates.length > 0}
	            <div class="chrome-tab-checklist" aria-label="Chrome tabs to import">
	              {#each chromeTabCandidates as tab (tab.id)}
	                <label class:active={selectedChromeTabIds.has(tab.id)}>
	                  <input
	                    type="checkbox"
	                    checked={selectedChromeTabIds.has(tab.id)}
	                    on:change={() => toggleChromeTabSelection(tab.id)}
	                  />
	                  <span>
	                    <strong>{tab.title || tab.url}</strong>
	                    <em>{tab.url}</em>
	                  </span>
	                </label>
	              {/each}
	            </div>
	            <button
	              type="button"
	              class="chrome-import-selected"
	              disabled={appRailBusy === 'chrome' || selectedChromeTabCount === 0}
	              on:click={importSelectedChromeTabsToCanvas}
	            >
	              Import {selectedChromeTabCount} selected
	            </button>
	          {/if}
	        </div>
	      {/if}
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
      {#if canvasProviderMenu}
        <ProviderLaunchOverlay
          floating
          x={canvasProviderMenu.x}
          y={canvasProviderMenu.y}
          selectedHarness={canvasProviderMenu.harness}
          launching={canvasProviderLaunching}
          error={canvasProviderError}
          onProviderSelect={selectCanvasProvider}
          onBack={backToCanvasProviderPicker}
          onRoleSelect={(role) => launchCanvasProviderRole(role)}
          onClose={closeCanvasCommandMenu}
        />
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
        {#if activeProject && canvasProjectItems.length > 0}
	          {#each canvasProjectItems as item, index (item.id)}
            <button
              type="button"
              class="project-canvas-item project-canvas-item--{item.kind}"
              class:working={item.activeCount > 0}
              style={canvasProjectItemStyle(activeProject, index)}
              title={item.path ?? item.title}
              on:pointerdown|stopPropagation
	              on:click={() => handleCanvasProjectItemClick(activeProject, item)}
            >
              <span class="project-canvas-item-glow" aria-hidden="true"></span>
              <span class="project-canvas-item-icon" aria-hidden="true">
                {#if item.logo}
                  <img src={item.logo} alt="" />
                {:else}
                  {itemEmoji(item.kind)}
                {/if}
              </span>
              <span class="project-canvas-item-copy">
                <strong>{item.title}</strong>
                <em>{canvasItemPreview(item)}</em>
              </span>
              <span class="project-canvas-item-count" aria-label={`${item.activeCount} linked item${item.activeCount === 1 ? '' : 's'}`}>
                {item.activeCount}
              </span>
              {#if item.agentLogo}
                <img class="project-canvas-ai-logo" src={item.agentLogo} alt="" aria-hidden="true" />
              {/if}
            </button>
          {/each}
        {/if}
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
      <MajordomoArchitect
        {activeProject}
        bind:collapsed={majordomoCollapsed}
        autoStart={isTauriRuntime()}
        runtimeTweakStatus={runtimeTweakStatus}
        onRuntimeTweak={handleRuntimeTweakCommand}
        onStartAreaCapture={() => startAreaCapture({
          surfaceId: 'majordomo',
          featureId: 'majordomo.ask-button',
          targetKind: 'majordomo',
          targetIsMajordomo: true,
        })}
      />
    {/if}
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

          <button
            type="button"
            class="mode-btn"
            class:selected={Boolean(areaCaptureDraft)}
            class:open={Boolean(areaCaptureDraft)}
            data-testid="area-report-start"
            data-report-target="area-report-start"
            on:click={() => startAreaCapture({ surfaceId: 'canvas', targetKind: 'canvas-region' })}
            title="Report Area"
            aria-pressed={Boolean(areaCaptureDraft)}
          >
            <svg class="mode-btn-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7V5a1 1 0 0 1 1-1h2" />
              <path d="M17 4h2a1 1 0 0 1 1 1v2" />
              <path d="M20 17v2a1 1 0 0 1-1 1h-2" />
              <path d="M7 20H5a1 1 0 0 1-1-1v-2" />
              <path d="M8 12h8" />
            </svg>
            <span class="mode-btn-label">Report</span>
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

  {#if areaCaptureDraft}
    <AreaCaptureOverlay
      draft={areaCaptureDraft}
      saving={areaCaptureSaving}
      status={areaCaptureStatus}
      onCancel={cancelAreaCapture}
      onConfirm={confirmAreaCapture}
      onChange={updateAreaCaptureDraft}
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
	  .app-root.workspace-active .app-left-rail,
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

	  .app-left-rail {
	    position: absolute;
	    left: 14px;
	    top: 86px;
	    z-index: 18;
	    width: 62px;
	    padding: 9px 7px;
	    display: grid;
	    gap: 9px;
	    border: 1px solid rgba(255, 255, 255, 0.16);
	    border-radius: 18px;
	    background:
	      linear-gradient(180deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.035)),
	      rgba(5, 8, 13, 0.7);
	    box-shadow:
	      0 0 0 1px rgba(255, 255, 255, 0.06) inset,
	      0 22px 48px rgba(0, 0, 0, 0.4),
	      0 0 38px rgba(96, 149, 255, 0.12);
	    backdrop-filter: blur(18px);
	  }

	  .app-left-rail.collapsed {
	    width: 42px;
	    padding: 7px 5px;
	  }

	  .app-left-rail button {
	    width: 48px;
	    min-height: 55px;
	    display: grid;
	    justify-items: center;
	    gap: 4px;
	    border: 1px solid rgba(255, 255, 255, 0.11);
	    border-radius: 14px;
	    padding: 6px 4px;
	    background: rgba(255, 255, 255, 0.055);
	    color: rgba(236, 244, 252, 0.86);
	    cursor: pointer;
	    transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
	  }

	  .app-left-rail.collapsed button:not(.app-left-rail-toggle) {
	    display: none;
	  }

	  .app-left-rail .app-left-rail-toggle {
	    width: 48px;
	    min-height: 28px;
	    border-color: rgba(255, 255, 255, 0.2);
	    background: rgba(255, 255, 255, 0.08);
	  }

	  .app-left-rail.collapsed .app-left-rail-toggle {
	    width: 30px;
	  }

	  .app-left-rail button:hover,
	  .app-left-rail button:focus-visible {
	    transform: translateX(2px);
	    border-color: rgba(255, 255, 255, 0.42);
	    background: rgba(255, 255, 255, 0.1);
	    box-shadow: 0 0 24px rgba(112, 170, 255, 0.24);
	    outline: none;
	  }

	  .app-left-rail button.active {
	    border-color: rgba(255, 255, 255, 0.72);
	    box-shadow:
	      0 0 0 1px rgba(255, 255, 255, 0.18) inset,
	      0 0 28px rgba(255, 255, 255, 0.2),
	      0 0 36px rgba(250, 203, 75, 0.18);
	  }

	  .app-left-rail button.busy {
	    animation: railPulse 0.9s ease-in-out infinite alternate;
	  }

	  .app-left-rail img {
	    width: 30px;
	    height: 30px;
	    object-fit: contain;
	    filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.18));
	  }

	  .app-left-rail span {
	    max-width: 100%;
	    overflow: hidden;
	    text-overflow: ellipsis;
	    white-space: nowrap;
	    font-size: 9px;
	    letter-spacing: 0;
	  }

	  .app-left-rail p {
	    width: 48px;
	    max-height: 58px;
	    margin: 0;
	    overflow: hidden;
	    color: rgba(255, 180, 180, 0.92);
	    font-size: 9px;
	    line-height: 1.25;
	  }

	  .chrome-rail-popover {
	    position: absolute;
	    left: 88px;
	    top: 86px;
	    z-index: 19;
	    width: min(360px, calc(100vw - 118px));
	    max-height: min(68vh, 540px);
	    display: grid;
	    gap: 10px;
	    padding: 12px;
	    border: 1px solid rgba(250, 203, 75, 0.42);
	    border-radius: 8px;
	    background:
	      linear-gradient(180deg, rgba(250, 203, 75, 0.08), transparent 34%),
	      rgba(8, 8, 9, 0.9);
	    color: rgba(255, 250, 230, 0.94);
	    box-shadow:
	      0 0 0 1px rgba(255, 255, 255, 0.06) inset,
	      0 20px 62px rgba(0, 0, 0, 0.58),
	      0 0 34px rgba(250, 203, 75, 0.16);
	    backdrop-filter: blur(18px) saturate(1.12);
	    -webkit-backdrop-filter: blur(18px) saturate(1.12);
	  }

	  .chrome-rail-popover header {
	    display: grid;
	    grid-template-columns: 36px minmax(0, 1fr);
	    gap: 9px;
	    align-items: center;
	  }

	  .chrome-rail-popover header img {
	    width: 34px;
	    height: 34px;
	    object-fit: contain;
	  }

	  .chrome-rail-popover strong,
	  .chrome-tab-checklist strong {
	    display: block;
	    overflow: hidden;
	    color: rgba(255, 246, 205, 0.98);
	    font-size: 12px;
	    text-overflow: ellipsis;
	    white-space: nowrap;
	  }

	  .chrome-rail-popover header span,
	  .chrome-tab-checklist em {
	    display: block;
	    overflow: hidden;
	    color: rgba(250, 203, 75, 0.66);
	    font-size: 10px;
	    font-style: normal;
	    text-overflow: ellipsis;
	    white-space: nowrap;
	  }

	  .chrome-rail-actions {
	    display: grid;
	    grid-template-columns: repeat(2, minmax(0, 1fr));
	    gap: 8px;
	  }

	  .chrome-rail-actions button,
	  .chrome-import-selected {
	    min-height: 34px;
	    border: 1px solid rgba(250, 203, 75, 0.34);
	    border-radius: 7px;
	    background: rgba(250, 203, 75, 0.08);
	    color: rgba(255, 250, 230, 0.94);
	    font: inherit;
	    font-size: 11px;
	    cursor: pointer;
	  }

	  .chrome-rail-actions button:hover:not(:disabled),
	  .chrome-import-selected:hover:not(:disabled) {
	    border-color: rgba(255, 255, 255, 0.7);
	    box-shadow: 0 0 18px rgba(250, 203, 75, 0.2);
	  }

	  .chrome-rail-actions button:disabled,
	  .chrome-import-selected:disabled {
	    cursor: default;
	    opacity: 0.5;
	  }

	  .chrome-tab-checklist {
	    display: grid;
	    gap: 6px;
	    max-height: 258px;
	    overflow-y: auto;
	    padding-right: 2px;
	  }

	  .chrome-tab-checklist label {
	    display: grid;
	    grid-template-columns: 18px minmax(0, 1fr);
	    gap: 8px;
	    align-items: center;
	    border: 1px solid rgba(255, 255, 255, 0.1);
	    border-radius: 7px;
	    background: rgba(0, 0, 0, 0.24);
	    padding: 7px;
	  }

	  .chrome-tab-checklist label.active {
	    border-color: rgba(250, 203, 75, 0.58);
	    background: rgba(250, 203, 75, 0.1);
	  }

	  .chrome-tab-checklist input {
	    accent-color: #facb4b;
	  }

	  @keyframes railPulse {
	    from {
	      box-shadow: 0 0 14px rgba(112, 170, 255, 0.16);
	    }
	    to {
	      box-shadow: 0 0 28px rgba(112, 170, 255, 0.38);
	    }
	  }

	  .project-canvas-item {
    position: absolute;
    z-index: 3;
    width: 236px;
    min-height: 96px;
    padding: 12px;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) 30px;
    gap: 10px;
    align-items: center;
    border: 2px solid color-mix(in srgb, var(--project-color, #8bd5ff) 72%, rgba(255, 255, 255, 0.32));
    border-radius: 8px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--project-color, #8bd5ff) 16%, transparent), rgba(255, 255, 255, 0.04) 44%, rgba(8, 12, 18, 0.58)),
      rgba(5, 8, 14, 0.48);
    color: rgba(242, 250, 255, 0.94);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.05) inset,
	      0 0 30px color-mix(in srgb, var(--project-color, #8bd5ff) 30%, transparent),
      0 14px 30px rgba(0, 0, 0, 0.34);
    backdrop-filter: blur(18px) saturate(1.18);
    -webkit-backdrop-filter: blur(18px) saturate(1.18);
    text-align: left;
    cursor: pointer;
  }

  .project-canvas-item:hover,
  .project-canvas-item:focus-visible {
    outline: none;
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--project-color, #8bd5ff) 86%, white 14%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color, #8bd5ff) 30%, transparent) inset,
      0 0 34px color-mix(in srgb, var(--project-color, #8bd5ff) 40%, transparent),
      0 18px 38px rgba(0, 0, 0, 0.42);
  }

  .project-canvas-item.working .project-canvas-item-glow {
    position: absolute;
    inset: -8px;
    border-radius: 12px;
    pointer-events: none;
    box-shadow: 0 0 30px color-mix(in srgb, var(--project-color, #8bd5ff) 44%, transparent);
    opacity: 0.78;
  }

	  .project-canvas-item-icon {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--project-color, #8bd5ff) 40%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.24);
    font-size: 21px;
    line-height: 1;
  }

	  .project-canvas-item-icon img {
    width: 38px;
    height: 32px;
    object-fit: contain;
    filter: drop-shadow(0 0 12px color-mix(in srgb, var(--project-color, #8bd5ff) 42%, transparent));
  }

  .project-canvas-item-copy {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .project-canvas-item-copy strong,
  .project-canvas-item-copy em {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-canvas-item-copy strong {
    white-space: nowrap;
    font-size: 12px;
    line-height: 1.15;
    letter-spacing: 0;
  }

  .project-canvas-item-copy em {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    color: rgba(216, 230, 238, 0.68);
    font-size: 10px;
    font-style: normal;
    line-height: 1.25;
  }

  .project-canvas-item-count {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--project-color, #8bd5ff) 58%, transparent);
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(245, 252, 255, 0.95);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 10px;
    font-weight: 800;
    box-shadow: 0 0 16px color-mix(in srgb, var(--project-color, #8bd5ff) 24%, transparent);
  }

  .project-canvas-ai-logo {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.82);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.36),
      0 0 14px color-mix(in srgb, var(--project-color, #8bd5ff) 36%, transparent);
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
