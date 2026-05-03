<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { ProjectSpace } from '../lib/types';
  import { startupPreferences, startupThemeProfile } from '../stores/startup';
  import { activeScope, instances } from '../stores/swarm';
  import {
    DEFAULT_PROJECT_COLOR,
    ensureProjectFolder,
    loadProjects,
    projectMemberships,
    projects,
    saveProject,
  } from '../stores/projects';
  import darkFolderAsset from '../assets/dark-folder.png';

  type ResourceLaneId = 'projects' | 'notes' | 'media' | 'plans' | 'markdown' | 'skills' | 'browser';
  type ProjectCreateMode = 'choose' | 'scratch' | 'existing';

  type BrowserContext = {
    id: string;
    scope: string;
    endpoint: string;
    profileDir: string;
    pid?: number | null;
    startUrl: string;
    status: string;
    ownerInstanceId?: string | null;
    createdAt: number;
    updatedAt: number;
  };

  type BrowserTab = {
    contextId: string;
    tabId: string;
    tabType: string;
    url: string;
    title: string;
    active: boolean;
    updatedAt: number;
  };

  type BrowserSnapshot = {
    id: string;
    contextId: string;
    tabId: string;
    url: string;
    title: string;
    text: string;
    screenshotPath?: string | null;
    createdBy?: string | null;
    createdAt: number;
  };

  type BrowserCatalog = {
    contexts: BrowserContext[];
    tabs: BrowserTab[];
    snapshots: BrowserSnapshot[];
  };

  type BuildProvenance = {
    appVersion: string;
    buildProfile: string;
    runKind: string;
    gitBranch: string;
    gitCommit: string;
    gitDirty: boolean;
    buildUnix?: number | null;
    executableModifiedUnix?: number | null;
    executablePath: string;
    appBundlePath?: string | null;
    currentWorkingDirectory: string;
    sourceRoot: string;
    manifestDir: string;
  };

  type ResourceLane = {
    id: ResourceLaneId;
    label: string;
    detail: string;
    enabled: boolean;
    iconLabel: string;
  };

  export let activeProject: ProjectSpace | null = null;
  export let openSignal = 0;
  export let browserOpenSignal = 0;

  const dispatch = createEventDispatcher<{
    openProject: { project: ProjectSpace };
    launchAgent: void;
    launchChrome: void;
    createNote: void;
    plan: void;
    importFile: void;
    organize: void;
    openSettings: void;
  }>();

  const resourceLanes: ResourceLane[] = [
    { id: 'projects', label: 'Projects', detail: 'Open or add project context spaces.', enabled: true, iconLabel: 'Projects folder' },
    { id: 'notes', label: 'Notes', detail: 'Project notes live inside each project page.', enabled: true, iconLabel: 'Notes folder' },
    { id: 'media', label: 'Media', detail: 'Attach image and asset folders through project roots.', enabled: true, iconLabel: 'Media folder' },
    { id: 'plans', label: 'Plan Docs', detail: 'Specs and phase docs belong in project-linked roots.', enabled: true, iconLabel: 'Plans folder' },
    { id: 'markdown', label: '.md Files', detail: 'Markdown is readable once linked by project path.', enabled: true, iconLabel: 'Markdown folder' },
    { id: 'skills', label: '/skills', detail: 'Skill folder management needs its own bridge.', enabled: false, iconLabel: 'Skills folder' },
    { id: 'browser', label: 'Browser', detail: 'Launch a managed browser context surface.', enabled: true, iconLabel: 'Browser folder' },
  ];

  $: themeName = $startupThemeProfile?.name ?? 'Theme';
  $: themeId = $startupThemeProfile?.id ?? '';
  $: channelLabel = $activeScope || $startupPreferences.selectedDirectory || 'no channel';
  $: browserScope = $activeScope || $startupPreferences.selectedDirectory || '';
  $: instanceCount = $instances.size;

  let kitOpen = false;
  let activeLane: ResourceLaneId = 'projects';
  let kitMessage = '';
  let defaultProjectRoot = '';
  let projectCreateModalOpen = false;
  let projectCreateMode: ProjectCreateMode = 'choose';
  let projectMutation = false;
  let projectError: string | null = null;
  let browserError: string | null = null;
  let browserLoading = false;
  let browserCatalogScope = '';
  let browserContexts: BrowserContext[] = [];
  let browserTabs: BrowserTab[] = [];
  let browserSnapshots: BrowserSnapshot[] = [];
  let selectedBrowserContextId = '';
  let selectedBrowserContext: BrowserContext | null = null;
  let selectedBrowserTabs: BrowserTab[] = [];
  let selectedBrowserSnapshots: BrowserSnapshot[] = [];
  let browserUrlDraft = 'https://www.google.com';
  let draftProjectName = '';
  let draftProjectRoot = '';
  let draftProjectNotes = '';
  let buildProvenance: BuildProvenance | null = null;
  let buildProvenanceError: string | null = null;
  let lastOpenSignal = openSignal;
  let lastBrowserOpenSignal = browserOpenSignal;

  $: provenanceModeLabel = buildProvenance ? runKindLabel(buildProvenance.runKind) : 'PREVIEW';
  $: provenanceInline = buildProvenance
    ? provenanceLabel(buildProvenance)
    : 'Tauri provenance unavailable';
  $: provenanceTitle = buildProvenance
    ? provenanceTooltip(buildProvenance)
    : buildProvenanceError ?? 'Running outside the Tauri shell.';
  $: provenanceIsBundle = buildProvenance?.runKind === 'app-bundle';
  $: provenanceIsDev = buildProvenance?.runKind === 'tauri-dev';
  $: activeLaneDetail = resourceLanes.find((lane) => lane.id === activeLane)?.detail ?? '';
  $: projectCards = $projects.map((project) => ({
    project,
    stats: projectStats(project),
  }));
  $: if (browserContexts.length && !browserContexts.some((context) => context.id === selectedBrowserContextId)) {
    selectedBrowserContextId = browserContexts[0].id;
  }
  $: if (!browserContexts.length && selectedBrowserContextId) {
    selectedBrowserContextId = '';
  }
  $: selectedBrowserContext = browserContexts.find((context) => context.id === selectedBrowserContextId) ?? browserContexts[0] ?? null;
  $: selectedBrowserTabs = selectedBrowserContext
    ? browserTabs.filter((tab) => tab.contextId === selectedBrowserContext.id)
    : [];
  $: selectedBrowserSnapshots = selectedBrowserContext
    ? browserSnapshots.filter((snapshot) => snapshot.contextId === selectedBrowserContext.id)
    : [];
  $: if (kitOpen && activeLane === 'browser' && browserScope && browserCatalogScope !== browserScope && !browserLoading) {
    void loadBrowserCatalog();
  }
  $: if (openSignal !== lastOpenSignal) {
    lastOpenSignal = openSignal;
    kitOpen = true;
    projectError = null;
  }
  $: if (browserOpenSignal !== lastBrowserOpenSignal) {
    lastBrowserOpenSignal = browserOpenSignal;
    kitOpen = true;
    activeLane = 'browser';
    browserError = null;
    projectError = null;
    kitMessage = 'Browser contexts loaded from the active channel.';
    void loadBrowserCatalog();
  }

  onMount(() => {
    void loadBuildProvenance();
    void loadDefaultProjectRoot();
    void loadProjects().catch((err) => {
      console.warn('[TopStrip] failed to load project spaces:', err);
    });
  });

  function toggleKit(): void {
    kitOpen = !kitOpen;
    projectError = null;
  }

  function closeKit(): void {
    kitOpen = false;
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      projectCreateModalOpen = false;
      kitOpen = false;
    }
  }

  async function loadDefaultProjectRoot(): Promise<void> {
    try {
      defaultProjectRoot = await invoke<string>('ui_default_project_root');
    } catch (err) {
      console.warn('[TopStrip] failed to resolve default project root:', err);
      defaultProjectRoot = $startupPreferences.selectedDirectory;
    }
  }

  async function loadBuildProvenance(): Promise<void> {
    try {
      buildProvenance = await invoke<BuildProvenance>('ui_build_provenance');
      buildProvenanceError = null;
    } catch (err) {
      buildProvenance = null;
      buildProvenanceError = err instanceof Error ? err.message : String(err);
      console.warn('[TopStrip] failed to load build provenance:', err);
    }
  }

  function runKindLabel(runKind: string): string {
    if (runKind === 'app-bundle') return 'BUNDLE';
    if (runKind === 'tauri-dev') return 'DEV';
    if (runKind === 'release-binary') return 'RELEASE';
    return 'DEBUG';
  }

  function shortCommit(commit: string): string {
    if (!commit || commit === 'unknown') return 'unknown';
    return commit.slice(0, 7);
  }

  function compactBranch(branch: string): string {
    if (!branch || branch === 'unknown') return 'unknown';
    if (branch.length <= 24) return branch;
    return `...${branch.slice(-21)}`;
  }

  function compactPath(path: string): string {
    const normalized = path.replace('/Users/mathewfrazier/', '~/');
    const appIndex = normalized.lastIndexOf('.app');
    if (appIndex >= 0) {
      const prefix = normalized.slice(0, appIndex + 4);
      const parts = prefix.split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    }
    const targetIndex = normalized.lastIndexOf('/target/');
    if (targetIndex >= 0) {
      return normalized.slice(targetIndex + 1);
    }
    const parts = normalized.split('/').filter(Boolean);
    return parts.slice(-3).join('/');
  }

  function stampLabel(seconds?: number | null): string {
    if (!seconds) return 'no stamp';
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return 'bad stamp';
    return date.toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function isoStamp(seconds?: number | null): string {
    if (!seconds) return 'unknown';
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toISOString();
  }

  function provenanceLabel(provenance: BuildProvenance): string {
    const path = provenance.appBundlePath || provenance.executablePath;
    const dirty = provenance.gitDirty ? '*' : '';
    const stamp = stampLabel(provenance.executableModifiedUnix ?? provenance.buildUnix);
    return `${compactBranch(provenance.gitBranch)}@${shortCommit(provenance.gitCommit)}${dirty} / ${compactPath(path)} / ${stamp}`;
  }

  function provenanceTooltip(provenance: BuildProvenance): string {
    return [
      `Mode: ${runKindLabel(provenance.runKind)} (${provenance.runKind}, ${provenance.buildProfile})`,
      `Version: ${provenance.appVersion}`,
      `Branch: ${provenance.gitBranch}`,
      `Commit: ${provenance.gitCommit}${provenance.gitDirty ? ' (dirty at build)' : ''}`,
      `Build stamp: ${isoStamp(provenance.buildUnix)}`,
      `Executable modified: ${isoStamp(provenance.executableModifiedUnix)}`,
      `Executable path: ${provenance.executablePath}`,
      `App bundle path: ${provenance.appBundlePath ?? 'none'}`,
      `Working directory: ${provenance.currentWorkingDirectory}`,
      `Source root: ${provenance.sourceRoot}`,
    ].join('\n');
  }

  function validateDirectory(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Project root is required.';
    if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) {
      return 'Project root must be an absolute path.';
    }
    return null;
  }

  function projectNameFromDirectory(directory: string): string {
    const trimmed = directory.trim().replace(/\/+$/, '');
    const parts = trimmed.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Untitled Project';
  }

  function projectIdFromName(name: string): string {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'project';
    return `${slug}-${Date.now().toString(36)}`;
  }

  function projectSlugFromName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 42) || 'untitled-project';
  }

  function suggestedProjectRoot(name: string): string {
    const base = (defaultProjectRoot || $startupPreferences.selectedDirectory || '').trim().replace(/\/+$/, '');
    const rootBase = base || '/Users/mathewfrazier/Desktop';
    return `${rootBase}/${projectSlugFromName(name)}`;
  }

  function findProjectByRoot(root: string): ProjectSpace | null {
    const trimmed = root.trim().replace(/\/+$/, '');
    return $projects.find((project) => project.root.replace(/\/+$/, '') === trimmed) ?? null;
  }

  function selectLane(lane: ResourceLane): void {
    activeLane = lane.id;
    projectError = null;
    browserError = null;
    if (lane.id === 'browser') {
      kitMessage = 'Browser contexts loaded from the active channel.';
      void loadBrowserCatalog();
      return;
    }
    if (!lane.enabled) {
      kitMessage = `${lane.label} is staged for a later bridge.`;
      return;
    }
    kitMessage = lane.id === 'projects'
      ? 'Pick a project or add one from this canvas menu.'
      : `${lane.label} rides through the selected project context for now.`;
  }

  function openProject(project: ProjectSpace): void {
    activeLane = 'projects';
    closeKit();
    dispatch('openProject', { project });
  }

  function projectStats(project: ProjectSpace): { state: 'active' | 'idle' | 'offline'; label: string } {
    const members = $projectMemberships.filter((entry) => entry.projectId === project.id);
    const memberInstances = members
      .map((entry) => $instances.get(entry.instanceId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const online = memberInstances.filter((instance) => instance.status === 'online').length;
    const stale = memberInstances.filter((instance) => instance.status === 'stale').length;
    const state = online > 0 ? 'active' : stale > 0 ? 'idle' : 'offline';
    return {
      state,
      label: members.length === 1 ? '1 agent' : `${members.length} agents`,
    };
  }

  function openActiveProject(): void {
    if (activeProject) {
      openProject(activeProject);
      return;
    }
    activeLane = 'projects';
    kitMessage = 'Select a project first.';
  }

  function dispatchKitAction(action: 'launchAgent' | 'launchChrome' | 'createNote' | 'plan' | 'importFile' | 'organize' | 'openSettings'): void {
    if (action === 'launchChrome') {
      activeLane = 'browser';
      browserError = null;
      kitMessage = 'Browser contexts loaded from the active channel.';
      void loadBrowserCatalog();
      return;
    }
    closeKit();
    dispatch(action);
  }

  function applyBrowserCatalog(catalog: BrowserCatalog): void {
    browserContexts = catalog.contexts ?? [];
    browserTabs = catalog.tabs ?? [];
    browserSnapshots = catalog.snapshots ?? [];
  }

  async function loadBrowserCatalog(): Promise<void> {
    if (!browserScope) {
      browserError = 'No active channel.';
      return;
    }
    browserCatalogScope = browserScope;
    browserLoading = true;
    browserError = null;
    try {
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_list_browser_catalog', { scope: browserScope }));
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function refreshBrowserCatalog(): Promise<void> {
    if (!browserScope) {
      browserError = 'No active channel.';
      return;
    }
    browserCatalogScope = browserScope;
    browserLoading = true;
    browserError = null;
    try {
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_refresh_browser_catalog', { scope: browserScope }));
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function openManagedBrowserContext(): Promise<void> {
    if (!browserScope) {
      browserError = 'No active channel.';
      return;
    }
    const url = browserUrlDraft.trim() || 'about:blank';
    browserLoading = true;
    browserError = null;
    try {
      const catalog = await invoke<BrowserCatalog>('ui_open_browser_context', {
        scope: browserScope,
        url,
      });
      applyBrowserCatalog(catalog);
      kitMessage = 'Managed browser context launched.';
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function importFrontChromeTab(): Promise<void> {
    if (!browserScope) {
      browserError = 'No active channel.';
      return;
    }
    browserLoading = true;
    browserError = null;
    try {
      const catalog = await invoke<BrowserCatalog>('ui_import_front_chrome_tab', { scope: browserScope });
      applyBrowserCatalog(catalog);
      kitMessage = 'Active Chrome tab imported into a managed browser context.';
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function closeManagedBrowserContext(): Promise<void> {
    if (!browserScope || !selectedBrowserContext) {
      browserError = 'Select a browser context first.';
      return;
    }
    browserLoading = true;
    browserError = null;
    try {
      const catalog = await invoke<BrowserCatalog>('ui_close_browser_context', {
        scope: browserScope,
        contextId: selectedBrowserContext.id,
      });
      applyBrowserCatalog(catalog);
      kitMessage = 'Managed browser context closed.';
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function captureBrowserSnapshot(): Promise<void> {
    if (!browserScope || !selectedBrowserContext) {
      browserError = 'Select a browser context first.';
      return;
    }
    const activeTab = selectedBrowserTabs.find((tab) => tab.active) ?? selectedBrowserTabs[0] ?? null;
    browserLoading = true;
    browserError = null;
    try {
      const catalog = await invoke<BrowserCatalog>('ui_capture_browser_snapshot', {
        scope: browserScope,
        contextId: selectedBrowserContext.id,
        tabId: activeTab?.tabId,
      });
      applyBrowserCatalog(catalog);
      kitMessage = 'Browser snapshot captured.';
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  function selectBrowserContext(contextId: string): void {
    selectedBrowserContextId = contextId;
  }

  function browserTitle(context: BrowserContext): string {
    const activeTab = browserTabs.find((tab) => tab.contextId === context.id && tab.active);
    return activeTab?.title || activeTab?.url || context.startUrl || context.id;
  }

  function browserSubline(context: BrowserContext): string {
    const tabCount = browserTabs.filter((tab) => tab.contextId === context.id).length;
    const snapshotCount = browserSnapshots.filter((snapshot) => snapshot.contextId === context.id).length;
    return `${tabCount} tab${tabCount === 1 ? '' : 's'} · ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'}`;
  }

  function openProjectCreateModal(mode: ProjectCreateMode = 'choose'): void {
    projectCreateModalOpen = true;
    projectCreateMode = mode;
    projectError = null;
    if (mode === 'scratch') {
      const name = activeProject?.name || 'New Project';
      draftProjectName = name;
      draftProjectRoot = suggestedProjectRoot(name);
      draftProjectNotes = '';
    } else if (mode === 'existing') {
      draftProjectRoot = $startupPreferences.selectedDirectory || activeProject?.root || defaultProjectRoot;
      draftProjectName = projectNameFromDirectory(draftProjectRoot);
      draftProjectNotes = '';
    }
  }

  function closeProjectCreateModal(): void {
    projectCreateModalOpen = false;
    projectCreateMode = 'choose';
  }

  function handleDraftProjectNameInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    draftProjectName = target.value;
    if (projectCreateMode === 'scratch') {
      draftProjectRoot = suggestedProjectRoot(target.value);
    }
  }

  function handleDraftProjectRootInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    draftProjectRoot = target.value;
    if (!draftProjectName.trim()) {
      draftProjectName = projectNameFromDirectory(target.value);
    }
  }

  async function createOrOpenProject(
    root: string,
    options: { name?: string; notes?: string; ensureFolder?: boolean } = {},
  ): Promise<ProjectSpace | null> {
    const trimmedRoot = root.trim();
    const error = validateDirectory(trimmedRoot);
    if (error) {
      projectError = error;
      return null;
    }

    projectMutation = true;
    projectError = null;
    try {
      const projectRoot = options.ensureFolder
        ? await ensureProjectFolder(trimmedRoot)
        : trimmedRoot;
      const existing = findProjectByRoot(projectRoot);
      if (existing) {
        openProject(existing);
        return existing;
      }

      const name = options.name?.trim() || projectNameFromDirectory(projectRoot);
      const now = Date.now();
      const project = await saveProject({
        id: projectIdFromName(name),
        name,
        root: projectRoot,
        color: DEFAULT_PROJECT_COLOR,
        additionalRoots: [],
        notes: options.notes?.trim() ?? '',
        scope: projectRoot,
        boundary: {
          x: 96 + ($projects.length % 4) * 44,
          y: 104 + ($projects.length % 3) * 38,
          width: 860,
          height: 540,
        },
        createdAt: now,
        updatedAt: now,
      });
      openProject(project);
      return project;
    } catch (err) {
      projectError = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      projectMutation = false;
    }
  }

  async function submitProjectCreateModal(): Promise<void> {
    const project = await createOrOpenProject(draftProjectRoot, {
      name: draftProjectName,
      notes: draftProjectNotes,
      ensureFolder: projectCreateMode === 'scratch',
    });
    if (project) {
      closeProjectCreateModal();
    }
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<header class="top-strip" data-theme-id={themeId} aria-label="swarm-ui status strip">
  <div class="strip-left">
    <span class="brand-mark">
      {#if themeId === 'tron-encom-os'}
        ENCOM · COMMAND DECK
      {:else}
        swarm-ui
      {/if}
    </span>
    <span class="brand-sep" aria-hidden="true">·</span>
    <span class="brand-theme">{themeName}</span>

    <div class="kit-menu-shell">
      <button
        type="button"
        class="kit-menu-button"
        aria-haspopup="menu"
        aria-expanded={kitOpen}
        title="Workspace kit"
        on:click={toggleKit}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M4 12h16" />
          <path d="M4 17h16" />
        </svg>
        <span>Kit</span>
      </button>

      {#if kitOpen}
        <div class="kit-dropdown" role="menu" aria-label="Workspace kit">
          <div class="kit-dropdown-head">
            <div>
              <strong>Workspace Kit</strong>
              <span>{activeProject?.name ?? 'No project selected'}</span>
            </div>
            <button type="button" class="kit-icon-btn" aria-label="Add project" on:click={() => openProjectCreateModal('choose')}>
              +
            </button>
          </div>

          <div class="kit-action-grid" aria-label="Workspace actions">
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('launchAgent')}>
              <strong>Launch Agent</strong>
              <span>Open launch deck</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('launchChrome')}>
              <strong>Browser Surface</strong>
              <span>Managed context lane</span>
            </button>
            <button type="button" role="menuitem" on:click={() => openProjectCreateModal('choose')}>
              <strong>Project</strong>
              <span>Import or create</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('createNote')}>
              <strong>Create a note</strong>
              <span>{activeProject ? activeProject.name : 'Needs project'}</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('plan')}>
              <strong>Plan</strong>
              <span>Protocol/chat lane</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('importFile')}>
              <strong>Import File</strong>
              <span>Project assets</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('organize')}>
              <strong>.organize</strong>
              <span>Inspect canvas</span>
            </button>
            <button type="button" role="menuitem" on:click={() => dispatchKitAction('openSettings')}>
              <strong>Settings</strong>
              <span>Canvas settings</span>
            </button>
          </div>

          <div class="kit-lane-list" aria-label="Resource lanes">
            {#each resourceLanes as lane (lane.id)}
              <button
                type="button"
                role="menuitem"
                class="kit-lane"
                class:active={activeLane === lane.id}
                class:disabled={!lane.enabled}
                title={lane.detail}
                on:click={() => selectLane(lane)}
              >
                <img src={darkFolderAsset} alt="" aria-hidden="true" />
                <span>{lane.label}</span>
                {#if !lane.enabled}
                  <em>later</em>
                {/if}
              </button>
            {/each}
          </div>

          {#if activeLane === 'projects'}
            <div class="kit-project-list" aria-label="Saved projects">
              <button
                type="button"
                class="project-theme-card project-theme-card--add"
                style="--project-color:#ffffff;"
                on:click={() => openProjectCreateModal('choose')}
              >
                <span class="project-photo project-photo--add">
                  <b aria-hidden="true">+</b>
                </span>
                <strong>Add Project</strong>
                <span>Create or import</span>
              </button>
              {#each projectCards as card (card.project.id)}
                <button
                  type="button"
                  class="project-theme-card"
                  class:current={activeProject?.id === card.project.id}
                  style={`--project-color:${card.project.color};`}
                  on:click={() => openProject(card.project)}
                >
                  <span class="project-photo">
                    <img src={darkFolderAsset} alt="" aria-hidden="true" />
                  </span>
                  <strong>{card.project.name}</strong>
                  <span>{card.project.root}</span>
                  <em class={`agent-pill agent-pill--${card.stats.state}`}>
                    <i></i>{card.stats.label}
                  </em>
                </button>
              {/each}
            </div>
          {:else if activeLane === 'browser'}
            <div class="browser-resource-panel" aria-label="Browser contexts">
              <header class="browser-panel-head">
                <div>
                  <strong>Browser</strong>
                  <span>{browserScope || 'No channel'}</span>
                </div>
                <div class="browser-panel-actions">
                  <button type="button" disabled={browserLoading || !browserScope} on:click={openManagedBrowserContext}>
                    Open URL
                  </button>
                  <button type="button" disabled={browserLoading || !browserScope} on:click={importFrontChromeTab}>
                    Import Tab
                  </button>
                  <button type="button" disabled={browserLoading || !browserScope} on:click={refreshBrowserCatalog}>
                    Refresh
                  </button>
                  <button
                    type="button"
                    disabled={browserLoading || !selectedBrowserContext || selectedBrowserContext.status === 'closed'}
                    on:click={captureBrowserSnapshot}
                  >
                    Snapshot
                  </button>
                  <button
                    type="button"
                    disabled={browserLoading || !selectedBrowserContext || selectedBrowserContext.status === 'closed'}
                    on:click={closeManagedBrowserContext}
                  >
                    Close
                  </button>
                </div>
              </header>

              {#if browserError}
                <p class="kit-error">{browserError}</p>
              {/if}

              <input
                class="browser-url-input mono"
                type="text"
                bind:value={browserUrlDraft}
                placeholder="https://example.com"
                on:keydown={(event) => {
                  if (event.key === 'Enter') void openManagedBrowserContext();
                }}
              />

              {#if browserLoading}
                <div class="browser-empty">Loading...</div>
              {:else if browserContexts.length === 0}
                <div class="browser-empty">No browser contexts</div>
              {:else}
                <div class="browser-context-grid">
                  {#each browserContexts as context (context.id)}
                    <button
                      type="button"
                      class="browser-context-card"
                      class:current={selectedBrowserContext?.id === context.id}
                      on:click={() => selectBrowserContext(context.id)}
                    >
                      <span class={`browser-status browser-status--${context.status}`}>{context.status}</span>
                      <strong>{browserTitle(context)}</strong>
                      <span class="mono">{context.endpoint}</span>
                      <em>{browserSubline(context)}</em>
                    </button>
                  {/each}
                </div>

                {#if selectedBrowserContext}
                  <div class="browser-detail">
                    <div class="browser-detail-column">
                      <strong>Tabs</strong>
                      {#if selectedBrowserTabs.length === 0}
                        <span>No tabs recorded</span>
                      {:else}
                        {#each selectedBrowserTabs as tab (tab.tabId)}
                          <div class="browser-row">
                            <b>{tab.title || tab.url || tab.tabId}</b>
                            <span>{tab.url}</span>
                          </div>
                        {/each}
                      {/if}
                    </div>

                    <div class="browser-detail-column">
                      <strong>Snapshots</strong>
                      {#if selectedBrowserSnapshots.length === 0}
                        <span>No snapshots recorded</span>
                      {:else}
                        {#each selectedBrowserSnapshots.slice(0, 4) as snapshot (snapshot.id)}
                          <div class="browser-row">
                            <b>{snapshot.title || snapshot.url || snapshot.id}</b>
                            <span>{snapshot.text}</span>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  </div>
                {/if}
              {/if}
            </div>
          {:else}
            <div class="kit-resource-panel">
              <strong>{resourceLanes.find((lane) => lane.id === activeLane)?.label}</strong>
              <span>{activeLaneDetail}</span>
              <button type="button" on:click={openActiveProject}>Open Selected Project</button>
            </div>
          {/if}

          {#if kitMessage}
            <p class="kit-message">{kitMessage}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="strip-right">
    <span
      class={`strip-cell provenance-cell ${provenanceIsBundle ? 'provenance-cell--bundle' : ''} ${provenanceIsDev ? 'provenance-cell--dev' : ''}`}
    >
      <em>{provenanceModeLabel}</em>
      <span class="strip-cell-value mono" title={provenanceTitle}>{provenanceInline}</span>
    </span>
    <span class="strip-cell">
      <em>CHANNEL</em>
      <span class="strip-cell-value mono" title={channelLabel}>{channelLabel}</span>
    </span>
    <span class="strip-cell">
      <em>NODES</em>
      <span class="strip-cell-value mono">{instanceCount}</span>
    </span>
  </div>

  {#if projectCreateModalOpen}
    <div class="project-modal-backdrop">
      <button
        type="button"
        class="project-modal-dismiss"
        aria-label="Close project dialog"
        on:click={closeProjectCreateModal}
      ></button>
      <div class="project-modal" role="dialog" aria-modal="true" aria-label="Add project">
        <header class="project-modal-header">
          <div>
            <h3>
              {projectCreateMode === 'choose'
                ? 'Create a new project'
                : projectCreateMode === 'scratch'
                  ? 'Start from scratch'
                  : 'Use an existing folder'}
            </h3>
            <p>
              {projectCreateMode === 'choose'
                ? 'Keep roots, notes, files, and agent membership together from the canvas.'
                : projectCreateMode === 'scratch'
                  ? 'Name the context and choose the project root.'
                  : 'Point the canvas at a folder you already work from.'}
            </p>
          </div>
          <button class="kit-icon-btn" type="button" aria-label="Close project dialog" on:click={closeProjectCreateModal}>×</button>
        </header>

        {#if projectCreateMode === 'choose'}
          <div class="project-choice-list">
            <button class="project-choice" type="button" on:click={() => openProjectCreateModal('scratch')}>
              <span>+</span>
              <strong>Start from scratch</strong>
              <small>Set up a new project context with a suggested folder.</small>
            </button>
            <button class="project-choice" type="button" disabled title="Import needs a separate metadata importer.">
              <span>I</span>
              <strong>Import project</strong>
              <small>Bring in external project metadata later.</small>
            </button>
            <button class="project-choice" type="button" on:click={() => openProjectCreateModal('existing')}>
              <span>F</span>
              <strong>Use an existing folder</strong>
              <small>Turn the current working directory into a project space.</small>
            </button>
          </div>
        {:else}
          <div class="project-modal-body">
            <label for="top-project-name">Name</label>
            <input
              id="top-project-name"
              class="kit-input"
              type="text"
              placeholder="Project name"
              value={draftProjectName}
              on:input={handleDraftProjectNameInput}
            />

            <label for="top-project-root">Project root</label>
            <input
              id="top-project-root"
              class="kit-input mono"
              type="text"
              placeholder={defaultProjectRoot || '/Users/you/Desktop/project'}
              value={draftProjectRoot}
              on:input={handleDraftProjectRootInput}
            />

            <label for="top-project-notes">Instructions / notes</label>
            <textarea
              id="top-project-notes"
              class="kit-input text-area"
              rows="5"
              placeholder="Optional project context, constraints, or handoff notes."
              bind:value={draftProjectNotes}
            ></textarea>

            {#if projectError}
              <p class="kit-error">{projectError}</p>
            {/if}

            <div class="project-modal-actions">
              <button type="button" class="kit-secondary-btn" on:click={closeProjectCreateModal}>Cancel</button>
              <button
                type="button"
                class="kit-primary-btn"
                disabled={projectMutation || !draftProjectRoot.trim()}
                on:click={submitProjectCreateModal}
              >
                {projectMutation
                  ? 'Creating...'
                  : projectCreateMode === 'scratch'
                    ? 'Create Folder + Project'
                    : 'Create Project'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</header>

<style>
  .top-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 25;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.32));
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 78%, transparent);
    backdrop-filter: blur(14px) saturate(1.08);
    -webkit-backdrop-filter: blur(14px) saturate(1.08);
    color: var(--terminal-fg, #c0caf5);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    pointer-events: none;
    user-select: none;
  }

  .strip-left,
  .strip-right {
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
    min-width: 0;
  }

  .kit-menu-shell {
    position: relative;
    display: inline-flex;
    pointer-events: auto;
  }

  .kit-menu-button,
  .kit-icon-btn,
  .kit-resource-panel button,
  .kit-secondary-btn,
  .kit-primary-btn {
    font: inherit;
    cursor: pointer;
  }

  .kit-menu-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 78%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 72%, transparent);
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 78%, transparent);
    padding: 0 8px;
  }

  .kit-menu-button:hover,
  .kit-menu-button[aria-expanded="true"] {
    border-color: color-mix(in srgb, var(--status-pending, #89b4fa) 54%, transparent);
    color: var(--terminal-fg, #c0caf5);
  }

  .kit-menu-button span {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .kit-dropdown {
    position: fixed;
    top: 28px;
    left: 50%;
    z-index: 70;
    width: min(1060px, calc(100vw - 52px));
    max-height: min(72vh, 680px);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border: 1px solid color-mix(in srgb, var(--node-border, rgba(108, 112, 134, 0.42)) 82%, transparent);
    border-top: 0;
    border-radius: 0 0 14px 14px;
    background: color-mix(in srgb, var(--node-header-bg, #2d2d2d) 82%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--terminal-fg, #c0caf5) 8%, transparent),
      0 24px 82px rgba(0, 0, 0, 0.56);
    backdrop-filter: blur(22px) saturate(1.18);
    -webkit-backdrop-filter: blur(22px) saturate(1.18);
    pointer-events: auto;
    transform: translateX(-50%);
    transform-origin: top center;
    animation: kitDrop 260ms cubic-bezier(0.16, 1, 0.3, 1);
    overflow: auto;
  }

  @keyframes kitDrop {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-10px) scaleY(0.94);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scaleY(1);
    }
  }

  .kit-dropdown-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .kit-dropdown-head div,
  .kit-resource-panel {
    min-width: 0;
  }

  .kit-dropdown-head strong,
  .kit-resource-panel strong,
  .kit-project-list strong {
    display: block;
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
    font-weight: 700;
  }

  .kit-dropdown-head span,
  .kit-resource-panel span,
  .kit-project-list span,
  .kit-message {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 58%, transparent);
    font-size: 10px;
    line-height: 1.4;
  }

  .kit-icon-btn {
    width: 26px;
    height: 26px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 78%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--terminal-fg, #c0caf5);
  }

  .kit-action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 7px;
  }

  .kit-action-grid button {
    min-width: 0;
    min-height: 56px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 4px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 62%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 52%, transparent);
    color: inherit;
    padding: 8px 10px;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .kit-action-grid button:hover {
    border-color: color-mix(in srgb, var(--status-pending, #89b4fa) 54%, transparent);
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 72%, var(--status-pending, #89b4fa) 5%);
  }

  .kit-action-grid strong {
    color: var(--terminal-fg, #c0caf5);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .kit-action-grid span {
    max-width: 100%;
    overflow: hidden;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 56%, transparent);
    font-size: 9.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kit-lane-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
    gap: 7px;
  }

  .kit-lane {
    min-width: 0;
    min-height: 76px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 60%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 54%, transparent);
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 74%, transparent);
    padding: 8px 8px;
    font: inherit;
    cursor: pointer;
  }

  .kit-lane img {
    width: 42px;
    height: 30px;
    object-fit: contain;
    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--status-pending, #89b4fa) 34%, transparent));
  }

  .kit-lane:hover,
  .kit-lane.active {
    border-color: color-mix(in srgb, var(--status-pending, #89b4fa) 50%, transparent);
    color: var(--terminal-fg, #c0caf5);
  }

  .kit-lane.disabled {
    opacity: 0.56;
  }

  .kit-lane em {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 46%, transparent);
    font-size: 9px;
    font-style: normal;
    text-transform: uppercase;
  }

  .kit-project-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    justify-content: stretch;
    gap: 10px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 1px 4px;
  }

  .project-theme-card {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 8px;
    width: 100%;
    min-height: 156px;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 42%, rgba(255, 255, 255, 0.18));
    border-radius: 8px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--project-color, #ffffff) 8%, transparent), transparent 54%),
      rgba(0, 0, 0, 0.56);
    color: inherit;
    padding: 9px;
    text-align: center;
    cursor: pointer;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.035),
      0 0 22px color-mix(in srgb, var(--project-color, #ffffff) 10%, transparent);
    transition: border-color 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease;
  }

  .project-theme-card:hover,
  .project-theme-card.current {
    border-color: #ffffff;
    transform: translateY(-2px);
    box-shadow:
      0 0 0 2px rgba(255, 255, 255, 0.94),
      0 0 18px rgba(255, 255, 255, 0.58),
      0 0 42px color-mix(in srgb, var(--project-color, #ffffff) 32%, transparent),
      inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  }

  .project-photo {
    grid-column: 1 / -1;
    height: 72px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 42%, rgba(255, 255, 255, 0.2));
    border-radius: 7px;
    background:
      radial-gradient(circle at 50% 26%, color-mix(in srgb, var(--project-color, #ffffff) 24%, transparent), transparent 48%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.055), transparent 60%),
      rgba(0, 0, 0, 0.66);
    box-shadow:
      inset 0 0 16px color-mix(in srgb, var(--project-color, #ffffff) 16%, transparent),
      0 0 16px color-mix(in srgb, var(--project-color, #ffffff) 12%, transparent);
  }

  .project-photo img {
    width: 58px;
    height: 42px;
    object-fit: contain;
    filter: drop-shadow(0 0 14px color-mix(in srgb, var(--project-color, #ffffff) 42%, transparent));
  }

  .project-photo--add b {
    color: #ffffff;
    font-size: 40px;
    font-weight: 900;
    line-height: 1;
    text-shadow:
      0 0 10px rgba(255, 255, 255, 0.74),
      0 0 26px rgba(255, 255, 255, 0.36);
  }

  .project-theme-card > span:not(.project-photo) {
    grid-column: 1 / -1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }

  .project-theme-card strong {
    grid-column: 1 / -1;
    align-self: center;
    color: var(--terminal-fg, #c0caf5);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .agent-pill {
    align-self: center;
    justify-self: center;
    grid-column: 1 / -1;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 38%, transparent);
    border-radius: 999px;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 64%, transparent);
    font-size: 9px;
    font-style: normal;
    padding: 3px 7px;
    text-transform: uppercase;
  }

  .agent-pill i {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--status-offline, #f38ba8);
    box-shadow: 0 0 10px currentColor;
  }

  .agent-pill--active i {
    background: var(--status-online, #a6e3a1);
  }

  .agent-pill--idle i {
    background: var(--status-pending, #f9e2af);
  }

  .kit-resource-panel button,
  .browser-panel-actions button,
  .kit-secondary-btn,
  .kit-primary-btn {
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 72%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--terminal-fg, #c0caf5);
    padding: 7px 10px;
  }

  .kit-resource-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 64%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 50%, transparent);
    padding: 10px;
  }

  .browser-resource-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 64%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 50%, transparent);
    padding: 10px;
  }

  .browser-panel-head,
  .browser-panel-actions {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .browser-panel-head strong,
  .browser-detail-column strong {
    display: block;
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .browser-panel-head span,
  .browser-detail-column > span,
  .browser-empty {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 58%, transparent);
    font-size: 10px;
    line-height: 1.4;
  }

  .browser-panel-actions {
    flex: 0 0 auto;
  }

  .browser-panel-actions button:disabled {
    cursor: default;
    opacity: 0.48;
  }

  .browser-url-input {
    min-width: 0;
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 62%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.34);
    color: var(--terminal-fg, #c0caf5);
    font: inherit;
    font-size: 10px;
    padding: 7px 8px;
  }

  .browser-url-input:focus {
    border-color: color-mix(in srgb, var(--status-online, #a6e3a1) 62%, transparent);
    outline: none;
  }

  .browser-context-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(188px, 1fr));
    gap: 8px;
  }

  .browser-context-card {
    min-width: 0;
    min-height: 104px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 62%, transparent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.42);
    color: inherit;
    padding: 9px;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .browser-context-card:hover,
  .browser-context-card.current {
    border-color: color-mix(in srgb, var(--status-online, #a6e3a1) 62%, transparent);
    box-shadow: 0 0 22px color-mix(in srgb, var(--status-online, #a6e3a1) 14%, transparent);
  }

  .browser-context-card strong {
    width: 100%;
    overflow: hidden;
    color: var(--terminal-fg, #c0caf5);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-context-card span,
  .browser-context-card em {
    max-width: 100%;
    overflow: hidden;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 58%, transparent);
    font-size: 9px;
    font-style: normal;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-status {
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 2px 6px;
    text-transform: uppercase;
  }

  .browser-status--open {
    color: var(--status-online, #a6e3a1) !important;
  }

  .browser-status--closed {
    color: var(--status-offline, #f38ba8) !important;
  }

  .browser-detail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
  }

  .browser-detail-column {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .browser-row {
    min-width: 0;
    display: grid;
    gap: 2px;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 46%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.34);
    padding: 7px;
  }

  .browser-row b,
  .browser-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-row b {
    color: var(--terminal-fg, #c0caf5);
    font-size: 10px;
  }

  .browser-row span {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 54%, transparent);
    font-size: 9px;
  }

  .project-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.56);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    pointer-events: auto;
  }

  .project-modal-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .project-modal {
    position: relative;
    z-index: 1;
    width: min(560px, 94vw);
    max-height: min(82vh, 760px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.42));
    border-radius: 12px;
    background: var(--node-header-bg, #2d2d2d);
    box-shadow: 0 24px 88px rgba(0, 0, 0, 0.58);
    pointer-events: auto;
  }

  .project-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 18px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 72%, transparent);
  }

  .project-modal-header h3 {
    margin: 0;
    color: var(--terminal-fg, #c0caf5);
    font-size: 19px;
    font-weight: 650;
  }

  .project-modal-header p {
    margin: 6px 0 0;
    max-width: 54ch;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 62%, transparent);
    font-size: 12px;
    line-height: 1.45;
  }

  .project-choice-list,
  .project-modal-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 18px 18px;
    overflow-y: auto;
  }

  .project-choice {
    min-height: 78px;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 2px 10px;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 72%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 56%, transparent);
    color: inherit;
    padding: 10px;
    text-align: left;
    cursor: pointer;
  }

  .project-choice:disabled {
    cursor: default;
    opacity: 0.52;
  }

  .project-choice span {
    grid-row: 1 / span 2;
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 70%, transparent);
    border-radius: 6px;
  }

  .project-choice strong {
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
  }

  .project-choice small {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 58%, transparent);
    font-size: 10.5px;
    line-height: 1.35;
  }

  .project-modal-body label {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 62%, transparent);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .kit-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--node-border, #6c7086) 82%, transparent);
    border-radius: 6px;
    background: var(--terminal-bg, #1e1e1e);
    color: var(--terminal-fg, #c0caf5);
    font: inherit;
    font-size: 12px;
    padding: 8px 10px;
    outline: none;
  }

  .text-area {
    min-height: 112px;
    resize: vertical;
    line-height: 1.45;
  }

  .kit-error {
    margin: 0;
    color: color-mix(in srgb, var(--edge-task-failed, #f38ba8) 84%, white 8%);
    font-size: 11px;
  }

  .project-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .kit-primary-btn {
    border-color: color-mix(in srgb, var(--status-pending, #89b4fa) 60%, transparent);
    background: color-mix(in srgb, var(--status-pending, #89b4fa) 16%, transparent);
  }

  .kit-primary-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .strip-right {
    flex: 1 1 auto;
    justify-content: flex-end;
    overflow: hidden;
  }

  .brand-mark {
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 88%, transparent);
  }

  .brand-sep {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 36%, transparent);
  }

  .brand-theme {
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 60%, transparent);
    font-size: 10px;
  }

  .strip-cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .strip-cell em {
    font-style: normal;
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 50%, transparent);
  }

  .strip-cell-value {
    color: var(--terminal-fg, #c0caf5);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provenance-cell {
    flex: 1 1 auto;
    justify-content: flex-end;
  }

  .provenance-cell .strip-cell-value {
    max-width: min(520px, 40vw);
  }

  .provenance-cell--dev .strip-cell-value {
    color: color-mix(in srgb, var(--status-online, #a6e3a1) 82%, var(--terminal-fg, #c0caf5));
  }

  .provenance-cell--bundle .strip-cell-value {
    color: color-mix(in srgb, var(--status-pending, #f9e2af) 84%, var(--terminal-fg, #c0caf5));
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  @media (max-width: 1120px) {
    .brand-theme {
      display: none;
    }

    .provenance-cell .strip-cell-value {
      max-width: 260px;
    }
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .top-strip {
    background: var(--bg-base, #000);
    border-bottom: 1px solid var(--led-line, #d8dde6);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow: 0 1px 0 0 var(--led-halo, rgba(255, 255, 255, 0.08));
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .brand-mark {
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
    letter-spacing: 0.22em;
  }

  :global([data-theme="tron-encom-os"]) .brand-sep,
  :global([data-theme="tron-encom-os"]) .brand-theme,
  :global([data-theme="tron-encom-os"]) .strip-cell em {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .strip-cell-value {
    color: var(--fg-primary, #f5f7fa);
  }
</style>
