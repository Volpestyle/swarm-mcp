<!--
  FullscreenWorkspace.svelte — App-owned immersive terminal overlay

  The overlay owns fullscreen tabs + split layout, while each PTY terminal
  surface stays persistent across graph nodes and fullscreen panes. Opening the
  workspace now reuses those live surfaces instead of snapshotting and
  remounting them, which removes the old resolution handoff artifact.
-->
<script lang="ts">
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import type { XYFlowNode } from '../lib/types';
  import TerminalPane from '../nodes/TerminalPane.svelte';

  type PaneId = 'a' | 'b';
  type WorkspaceStage = 'opening' | 'open' | 'closing';

  export let nodes: XYFlowNode[];
  export let initialNodeId: string | null = null;
  export let stage: WorkspaceStage = 'opening';

  const dispatch = createEventDispatcher<{
    close: { returnNodeId: string | null };
    opened: void;
    closed: void;
  }>();

  let shellElement: HTMLDivElement | null = null;
  let paneARef: TerminalPane | null = null;
  let paneBRef: TerminalPane | null = null;
  let shellVisible = false;
  let backdropVisible = false;
  let mounted = false;
  let transitionPhase: 'opening' | 'closing' | null = null;
  let transitionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingVisible = false;

  let layout: 'single' | 'split' = 'single';
  let paneANodeId: string | null = null;
  let paneBNodeId: string | null = null;
  let focusedPane: PaneId = 'a';
  let tabMru: string[] = [];
  let paneAReady = false;
  let paneBReady = false;
  let readyPaneAKey: string | null = null;
  let readyPaneBKey: string | null = null;

  const SHELL_TRANSITION_MS = 220;
  const TRANSITION_FALLBACK_MS = SHELL_TRANSITION_MS + 80;
  const LOADING_OVERLAY_DELAY_MS = 140;

  $: tabs = deriveTabs(nodes);
  $: tabIds = tabs.map((tab) => tab.id);
  $: reconcilePanes(tabIds);
  $: trackMru(focusedPane === 'a' ? paneANodeId : paneBNodeId);
  $: nodesById = new Map(nodes.map((node) => [node.id, node]));
  $: paneANode = paneANodeId ? nodesById.get(paneANodeId) : undefined;
  $: paneBNode = paneBNodeId ? nodesById.get(paneBNodeId) : undefined;
  $: ensureDistinctSplitTabs(tabIds);
  $: livePanesMounted = stage === 'opening' || stage === 'open';
  $: showPaneLoadingWanted = livePanesMounted && !activePaneReady();
  $: if (mounted && stage === 'closing' && transitionPhase !== 'closing') {
    startClosingTransition();
  }
  $: if (!livePanesMounted) {
    paneAReady = false;
    paneBReady = false;
    readyPaneAKey = null;
    readyPaneBKey = null;
  }
  $: if (livePanesMounted && paneANodeId !== readyPaneAKey) {
    paneAReady = false;
    readyPaneAKey = paneANodeId;
  }
  $: if (livePanesMounted && layout === 'split' && paneBNodeId !== readyPaneBKey) {
    paneBReady = false;
    readyPaneBKey = paneBNodeId;
  }
  $: if (layout !== 'split') {
    paneBReady = false;
    readyPaneBKey = null;
  }
  $: syncLoadingOverlay(showPaneLoadingWanted);

  onMount(() => {
    paneANodeId = initialNodeId ?? tabs[0]?.id ?? null;
    focusedPane = 'a';
    mounted = true;

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      clearTransitionFallback();
      clearLoadingDelay();
    };
  });

  onMount(() => {
    void tick().then(() => {
      requestAnimationFrame(() => {
        startOpeningTransition();
      });
    });
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeyDown, true);
    clearTransitionFallback();
    clearLoadingDelay();
  });

  function deriveTabs(all: XYFlowNode[]): XYFlowNode[] {
    return all
      .filter((node) => node.data?.ptySession != null)
      .slice()
      .sort((a, b) => {
        const ay = a.position?.y ?? 0;
        const by = b.position?.y ?? 0;
        if (ay !== by) return ay - by;
        const ax = a.position?.x ?? 0;
        const bx = b.position?.x ?? 0;
        return ax - bx;
      });
  }

  function reconcilePanes(ids: string[]): void {
    if (ids.length === 0) {
      dispatch('close', { returnNodeId: null });
      return;
    }

    if (paneANodeId && !ids.includes(paneANodeId)) {
      paneANodeId = ids[0];
    }

    if (paneBNodeId && !ids.includes(paneBNodeId)) {
      const next = ids.find((id) => id !== paneANodeId) ?? null;
      paneBNodeId = next;
      if (!paneBNodeId && layout === 'split') {
        layout = 'single';
        focusedPane = 'a';
      }
    }
  }

  function trackMru(id: string | null): void {
    if (!id || tabMru[0] === id) return;
    tabMru = [id, ...tabMru.filter((entry) => entry !== id)].slice(0, 32);
  }

  function activeNodeIdFor(pane: PaneId): string | null {
    return pane === 'a' ? paneANodeId : paneBNodeId;
  }

  function setActiveNodeId(pane: PaneId, id: string | null): void {
    if (pane === 'a') paneANodeId = id;
    else paneBNodeId = id;
  }

  async function focusActivePane(): Promise<void> {
    await tick();
    const ref = focusedPane === 'a' ? paneARef : paneBRef;
    ref?.focus();
  }

  function clearTransitionFallback(): void {
    if (!transitionFallbackTimer) return;
    clearTimeout(transitionFallbackTimer);
    transitionFallbackTimer = null;
  }

  function clearLoadingDelay(): void {
    if (!loadingDelayTimer) return;
    clearTimeout(loadingDelayTimer);
    loadingDelayTimer = null;
  }

  function syncLoadingOverlay(shouldShow: boolean): void {
    if (!mounted) return;

    if (!shouldShow) {
      clearLoadingDelay();
      loadingVisible = false;
      return;
    }

    if (loadingVisible || loadingDelayTimer) return;
    loadingDelayTimer = setTimeout(() => {
      loadingDelayTimer = null;
      if (showPaneLoadingWanted) {
        loadingVisible = true;
      }
    }, LOADING_OVERLAY_DELAY_MS);
  }

  function scheduleTransitionFallback(phase: 'opening' | 'closing'): void {
    clearTransitionFallback();
    transitionFallbackTimer = setTimeout(() => {
      if (transitionPhase !== phase) return;
      transitionPhase = null;

      if (phase === 'opening') {
        dispatch('opened');
      } else {
        dispatch('closed');
      }
    }, TRANSITION_FALLBACK_MS);
  }

  function startOpeningTransition(): void {
    transitionPhase = 'opening';
    backdropVisible = true;
    shellVisible = true;
    scheduleTransitionFallback('opening');
  }

  function startClosingTransition(): void {
    transitionPhase = 'closing';
    backdropVisible = false;
    shellVisible = false;
    scheduleTransitionFallback('closing');
  }

  function requestClose(): void {
    dispatch('close', {
      returnNodeId: activeNodeIdFor(focusedPane) ?? paneANodeId,
    });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }

    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;

    if ((event.key === '`' || event.code === 'Backquote') && !event.shiftKey) {
      if (layout === 'split') {
        event.preventDefault();
        event.stopPropagation();
        focusedPane = focusedPane === 'a' ? 'b' : 'a';
        void focusActivePane();
      }
      return;
    }

    if (!event.shiftKey) return;

    if (event.key === '\\' || event.code === 'Backslash') {
      event.preventDefault();
      event.stopPropagation();
      toggleSplit();
      return;
    }

    if (event.key === ']' || event.code === 'BracketRight') {
      event.preventDefault();
      event.stopPropagation();
      cycleTab(focusedPane, +1);
      return;
    }

    if (event.key === '[' || event.code === 'BracketLeft') {
      event.preventDefault();
      event.stopPropagation();
      cycleTab(focusedPane, -1);
    }
  }

  function otherPane(pane: PaneId): PaneId {
    return pane === 'a' ? 'b' : 'a';
  }

  function paneTabIds(pane: PaneId): string[] {
    if (layout !== 'split') return tabIds;

    const otherActive = activeNodeIdFor(otherPane(pane));
    if (!otherActive) return tabIds;

    return tabIds.filter((id) => id !== otherActive);
  }

  function nextDistinctTab(ids: string[], excludeId: string | null): string | null {
    const available = excludeId
      ? ids.filter((id) => id !== excludeId)
      : ids.slice();
    if (available.length === 0) return null;

    return tabMru.find((id) => available.includes(id)) ?? available[0] ?? null;
  }

  function cycleTab(pane: PaneId, delta: number): void {
    const ids = paneTabIds(pane);
    if (ids.length === 0) return;

    const current = activeNodeIdFor(pane);
    const currentIndex = current ? ids.indexOf(current) : -1;
    const baseIndex = currentIndex >= 0
      ? currentIndex
      : delta > 0
        ? -1
        : 0;
    const nextIndex = (baseIndex + delta + ids.length) % ids.length;
    const nextId = ids[nextIndex];
    if (!nextId) return;

    setActiveNodeId(pane, nextId);
    void focusActivePane();
  }

  function toggleSplit(): void {
    if (layout === 'split') {
      const keep = activeNodeIdFor(focusedPane);
      paneANodeId = keep ?? paneANodeId ?? tabIds[0] ?? null;
      paneBNodeId = null;
      layout = 'single';
      focusedPane = 'a';
      void focusActivePane();
      return;
    }

    if (tabIds.length < 2) return;

    const keep = paneANodeId ?? tabIds[0];
    paneANodeId = keep;
    const mruB = tabMru.find((id) => id !== keep && tabIds.includes(id));
    const nextB =
      mruB ??
      (() => {
        const index = tabIds.indexOf(keep);
        return tabIds[(index + 1) % tabIds.length] ?? null;
      })();
    paneBNodeId = nextB;
    layout = 'split';
    focusedPane = 'b';
    void focusActivePane();
  }

  function handleTabClick(id: string): void {
    if (layout === 'split') {
      const other = otherPane(focusedPane);
      if (id === activeNodeIdFor(other)) {
        focusedPane = other;
        void focusActivePane();
        return;
      }
    }

    setActiveNodeId(focusedPane, id);
    void focusActivePane();
  }

  function handlePaneMouseDown(pane: PaneId): void {
    if (focusedPane !== pane) {
      focusedPane = pane;
      void focusActivePane();
    }
  }

  function handlePaneReady(pane: PaneId): void {
    if (pane === 'a') {
      paneAReady = true;
    } else {
      paneBReady = true;
    }

    if (pane === focusedPane) {
      void focusActivePane();
    }
  }

  function activePaneReady(): boolean {
    if (!livePanesMounted) return false;
    if (focusedPane === 'a') return paneAReady;
    if (layout !== 'split') return paneAReady;
    return paneBReady;
  }

  function nodeStatus(node: XYFlowNode | undefined): string {
    return node?.data?.status ?? 'offline';
  }

  function nodeRoleClass(node: XYFlowNode | undefined): string {
    const label = (node?.data?.label ?? '').toLowerCase();
    if (label.includes('planner')) return 'planner';
    if (label.includes('implement')) return 'implementer';
    if (label.includes('review')) return 'reviewer';
    if (label.includes('research')) return 'researcher';
    if (label.includes('shell') || label === '$shell') return 'shell';
    if (!label) return 'shell';
    return 'custom';
  }

  function ensureDistinctSplitTabs(ids: string[]): void {
    if (ids.length === 0) return;

    if (!paneANodeId || !ids.includes(paneANodeId)) {
      paneANodeId = ids[0] ?? null;
    }

    if (layout !== 'split') return;

    const nextB = nextDistinctTab(ids, paneANodeId);
    if (!nextB) {
      paneBNodeId = null;
      layout = 'single';
      focusedPane = 'a';
      return;
    }

    if (
      paneBNodeId !== nextB &&
      (paneBNodeId === paneANodeId || !paneBNodeId || !ids.includes(paneBNodeId))
    ) {
      paneBNodeId = nextB;
    }
  }

  function handleShellTransitionEnd(event: TransitionEvent): void {
    if (event.target !== shellElement || event.propertyName !== 'opacity') {
      return;
    }

    clearTransitionFallback();

    if (transitionPhase === 'opening') {
      transitionPhase = null;
      dispatch('opened');
      return;
    }

    if (transitionPhase === 'closing') {
      transitionPhase = null;
      dispatch('closed');
    }
  }
</script>

<div class="workspace-root">
  <div class="workspace-backdrop" class:visible={backdropVisible}></div>

  <div
    bind:this={shellElement}
    class="workspace-shell"
    class:visible={shellVisible}
    class:split={layout === 'split'}
    on:transitionend={handleShellTransitionEnd}
    role="dialog"
    aria-modal="true"
    aria-label="Immersive terminal workspace"
  >
    <div class="tab-strip" role="tablist" aria-label="Terminal tabs">
      {#each tabs as tab (tab.id)}
        {@const activeA = tab.id === paneANodeId}
        {@const activeB = tab.id === paneBNodeId}
        {@const active = activeA || activeB}
        <button
          type="button"
          role="tab"
          class="tab"
          class:active
          class:active-a={activeA && focusedPane === 'a'}
          class:active-b={activeB && focusedPane === 'b' && layout === 'split'}
          aria-selected={active}
          on:click={() => handleTabClick(tab.id)}
        >
          <span class="tab-status status-dot {nodeStatus(tab)}"></span>
          <span class="tab-role role-badge {nodeRoleClass(tab)}">
            {tab.data.label}
          </span>
          {#if tab.data.displayName}
            <span class="tab-id">{tab.data.displayName}</span>
          {:else if tab.data.instance?.id}
            <span class="tab-id">{tab.data.instance.id.slice(0, 8)}</span>
          {/if}
          {#if activeA && layout === 'split'}
            <span class="pane-chip">A</span>
          {/if}
          {#if activeB}
            <span class="pane-chip">B</span>
          {/if}
        </button>
      {/each}

      <div class="spacer"></div>

      <div class="layout-controls">
        <button
          type="button"
          class="layout-btn"
          class:enabled={layout === 'split'}
          title="Toggle split (Cmd+Shift+\\)"
          aria-label="Toggle split layout"
          on:click={toggleSplit}
          disabled={layout === 'single' && tabIds.length < 2}
        >
          {#if layout === 'split'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2"/>
            </svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2"/>
              <line x1="12" y1="4" x2="12" y2="20"/>
            </svg>
          {/if}
        </button>

        <button
          type="button"
          class="layout-btn"
          title="Close workspace (Esc)"
          aria-label="Close immersive workspace"
          on:click={requestClose}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="panes">
      <div
        class="pane"
        class:focused={focusedPane === 'a'}
        on:mousedown={() => handlePaneMouseDown('a')}
        role="presentation"
      >
        {#if paneANodeId}
          {#key paneANodeId}
            <div class="pane-inner">
              {#if livePanesMounted && paneANode?.data?.ptySession?.id}
                <TerminalPane
                  bind:this={paneARef}
                  ptyId={paneANode.data.ptySession.id}
                  on:ready={() => handlePaneReady('a')}
                />
              {:else}
                <div class="pane-loading-shell"></div>
              {/if}
            </div>
          {/key}
        {:else}
          <div class="pane-empty">No terminal selected</div>
        {/if}
      </div>

      {#if layout === 'split'}
        <div
          class="pane"
          class:focused={focusedPane === 'b'}
          on:mousedown={() => handlePaneMouseDown('b')}
          role="presentation"
        >
          {#if paneBNodeId}
            {#key paneBNodeId}
              <div class="pane-inner">
                {#if livePanesMounted && paneBNode?.data?.ptySession?.id}
                  <TerminalPane
                    bind:this={paneBRef}
                    ptyId={paneBNode.data.ptySession.id}
                    on:ready={() => handlePaneReady('b')}
                  />
                {:else}
                  <div class="pane-loading-shell"></div>
                {/if}
              </div>
            {/key}
          {:else}
            <div class="pane-empty">No terminal selected</div>
          {/if}
        </div>
      {/if}

      {#if loadingVisible}
        <div class="pane-loading-overlay">
          Connecting terminal…
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .workspace-root {
    position: absolute;
    inset: 0;
    z-index: 100;
    pointer-events: none;
  }

  .workspace-backdrop {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 20% 0%, rgba(137, 180, 250, 0.08), transparent 38%),
      rgba(11, 11, 17, 0.22);
    opacity: 0;
    transition: opacity 180ms ease;
  }

  .workspace-backdrop.visible {
    opacity: 1;
  }

  .workspace-shell {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: rgba(12, 12, 20, 0.96);
    color: var(--terminal-fg, #c0caf5);
    box-shadow:
      0 28px 80px rgba(0, 0, 0, 0.5),
      0 0 0 1px color-mix(in srgb, var(--node-border-selected, #89b4fa) 12%, transparent);
    opacity: 0;
    transform: translate3d(0, 12px, 0) scale(0.985);
    transition:
      opacity 180ms ease,
      transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: auto;
    will-change: opacity, transform;
  }

  .workspace-shell.visible {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }

  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 6px 10px;
    background: rgba(15, 15, 24, 0.96);
    border-bottom: 1px solid color-mix(in srgb, var(--node-border, rgba(108, 112, 134, 0.44)) 85%, transparent);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.08);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.08);
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-family: inherit;
    font-size: 12px;
    color: #a6adc8;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .tab:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--terminal-fg, #c0caf5);
  }

  .tab.active {
    background: color-mix(in srgb, var(--node-border-selected, #89b4fa) 12%, transparent);
    color: var(--terminal-fg, #c0caf5);
    border-color: color-mix(in srgb, var(--node-border-selected, #89b4fa) 30%, transparent);
  }

  .tab.active-a {
    border-color: var(--node-border-selected, #89b4fa);
    background: color-mix(in srgb, var(--node-border-selected, #89b4fa) 22%, transparent);
  }

  .tab.active-b {
    border-color: var(--badge-reviewer, #a6e3a1);
    background: color-mix(in srgb, var(--badge-reviewer, #a6e3a1) 22%, transparent);
  }

  .tab-status {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tab-role {
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 8px;
    font-weight: 600;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .tab-id {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: #6c7086;
  }

  .pane-chip {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--terminal-fg, #c0caf5);
  }

  .spacer {
    flex: 1;
  }

  .layout-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .layout-btn {
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    background: transparent;
    color: #6c7086;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .layout-btn:hover:not([disabled]) {
    background: rgba(255, 255, 255, 0.05);
    color: var(--terminal-fg, #c0caf5);
  }

  .layout-btn.enabled {
    color: var(--terminal-fg, #c0caf5);
    border-color: color-mix(in srgb, var(--node-border-selected, #89b4fa) 40%, transparent);
    background: color-mix(in srgb, var(--node-border-selected, #89b4fa) 10%, transparent);
  }

  .layout-btn[disabled] {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .panes {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr;
    min-height: 0;
    gap: 1px;
    background: var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .workspace-shell.split .panes {
    grid-template-columns: 1fr 1fr;
  }

  .pane {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: flex;
    background: var(--terminal-bg, #181825);
    outline: 2px solid transparent;
    outline-offset: -2px;
    transition: outline-color 0.12s ease;
  }

  .workspace-shell.split .pane.focused {
    outline-color: color-mix(in srgb, var(--node-border-selected, #89b4fa) 55%, transparent);
  }

  .pane-inner {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
    position: relative;
  }

  .pane-inner :global(.terminal-container) {
    flex: 1;
    border-radius: 0;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .pane-loading-shell {
    flex: 1;
    background:
      radial-gradient(circle at 18% 12%, rgba(137, 180, 250, 0.08), transparent 30%),
      linear-gradient(180deg, rgba(17, 17, 27, 0.94), rgba(12, 12, 20, 0.98));
  }

  .pane-loading-overlay {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 2;
    padding: 7px 11px;
    border-radius: 999px;
    background: rgba(15, 15, 24, 0.86);
    border: 1px solid color-mix(in srgb, var(--node-border-selected, #89b4fa) 28%, transparent);
    color: #a6adc8;
    font-size: 12px;
    letter-spacing: 0.02em;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    pointer-events: none;
  }

  .pane-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6c7086;
    font-size: 13px;
  }
</style>
