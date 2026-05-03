<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
	  import type {
	    ProjectSpace,
	    RecoveryScopeSummary,
	    RecoverySessionItem,
	    RolePresetSummary,
    ThemeProfile,
    ThemeProfileId,
  } from '../lib/types';
  import AgentLibraryPanel from './AgentLibraryPanel.svelte';
  import {
    builtInThemeProfiles,
    defaultHomeSection,
    formatScopeLabel,
    recoveryScopeSummaries,
    recoverySessionItems,
    startupPreferences,
  } from '../stores/startup';
  import { agentProfiles } from '../stores/agentProfiles';
  import { activeScope, setScopeSelection } from '../stores/swarm';
  import {
    clearStalePtySession,
    killInstance,
    getRolePresets,
    respawnInstance,
  } from '../stores/pty';
  import { confirm } from '../lib/confirm';
  import {
    STANDARD_AGENT_ROLE_PRESETS,
    rolePresetForRole,
  } from '../lib/agentRolePresets';
  import {
    MAY_FIRST_ARCHIVED_PHASES,
    MAY_FIRST_MVP_SLICES,
    MAY_FIRST_NORTH_STAR_STEPS,
    MAY_FIRST_OVERHAUL_STAGES,
    MAY_FIRST_OVERHAUL_SUMMARY,
  } from '../lib/mayFirstOverhaulPlan';
  import { harnessAliases, HARNESS_NAMES } from '../stores/harnessAliases';
	  import { launchProfiles } from '../stores/launchProfiles';
	  import {
	    DEFAULT_PROJECT_COLOR,
	    ensureProjectFolder,
	    loadProjects,
	    projects,
	    saveProject,
	  } from '../stores/projects';
  import darkFolderUrl from '../assets/dark-folder.png';
  import frazierCodeTronUrl from '../assets/fraziercode-tron-2.jpg';

  type HomeSection = 'start' | 'launch' | 'projects' | 'sessions' | 'agents' | 'diagnostics' | 'dictionary' | 'about' | 'settings';
  type ResourceLaneId = 'projects' | 'notes' | 'media' | 'plans' | 'markdown' | 'skills' | 'browser';
  type ProjectCreateMode = 'choose' | 'scratch' | 'existing';

  type HomeNavItem = {
    id: HomeSection;
    label: string;
    meta: string;
    icon: string;
  };

  type ResourceLane = {
    id: ResourceLaneId;
    label: string;
    detail: string;
    icon: string;
    enabled: boolean;
  };

  type ScopeEntry = {
    scope: RecoveryScopeSummary;
    items: RecoverySessionItem[];
    hasLayout: boolean;
  };

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

	  const dispatch = createEventDispatcher<{
	    enterCanvas: void;
	    openSettings: void;
	    openProject: { project: ProjectSpace };
	    openFrazierCode: void;
	  }>();

  const navItems: HomeNavItem[] = [
    { id: 'start', label: 'Start', meta: 'Open the all-channel desktop', icon: '◇' },
    { id: 'launch', label: 'Launch', meta: 'Previous start setup, channel, and launch defaults', icon: '◒' },
    { id: 'sessions', label: 'Sessions & Layouts', meta: 'Reopen, recover, or clear past scopes', icon: '◈' },
    { id: 'agents', label: 'Agents', meta: 'Saved personas, context, mission, and permissions', icon: '◉' },
    { id: 'diagnostics', label: 'Diagnostics', meta: 'Cleanup actions and harness visibility', icon: '◎' },
    { id: 'dictionary', label: 'Dictionary', meta: 'Terms, tools, commands, and settings reference', icon: '◫' },
    { id: 'about', label: 'About', meta: 'What swarm, swarm-mcp, and swarm-ui are', icon: '◐' },
    { id: 'settings', label: 'Settings', meta: 'Theme, startup, and recovery controls', icon: '◌' },
  ];

  const resourceLanes: ResourceLane[] = [
    {
      id: 'projects',
      label: 'Projects',
      detail: 'Roots, notes, files, and attached agents.',
      icon: 'P',
      enabled: true,
    },
    {
      id: 'notes',
      label: 'Notes',
      detail: 'Persistent project notes and handoff context.',
      icon: 'N',
      enabled: true,
    },
    {
      id: 'media',
      label: 'Media',
      detail: 'Images and assets linked to project work.',
      icon: 'M',
      enabled: true,
    },
    {
      id: 'plans',
      label: 'Plan Docs',
      detail: 'Specs, runbooks, and phase plans.',
      icon: 'D',
      enabled: true,
    },
    {
      id: 'markdown',
      label: '.md Files',
      detail: 'Markdown files agents can inspect by path.',
      icon: '#',
      enabled: true,
    },
    {
      id: 'skills',
      label: '/skills',
      detail: 'Skill folders need a safer management pass.',
      icon: 'S',
      enabled: false,
    },
    {
      id: 'browser',
      label: 'Browser',
      detail: 'Managed Chrome contexts agents can read and control.',
      icon: 'B',
      enabled: true,
    },
  ];

  // Encom doctrine: chrome is monochrome white LED. Accent colors are reserved
  // for status, imagery, and the single warm Start action.

  let activeSection: HomeSection = 'start';
  let resourceLibraryExpanded = false;
  let activeResource: ResourceLaneId = 'projects';
  let initializedSection = false;
  let rolePresets: RolePresetSummary[] = [];
  let startError: string | null = null;
	  let diagnosticsMessage: string | null = null;
	  let projectError: string | null = null;
	  let projectMutation = false;
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
  let projectCreateModalOpen = false;
  let projectCreateMode: ProjectCreateMode = 'choose';
  let draftProjectName = '';
  let draftProjectRoot = '';
  let draftProjectNotes = '';
	  let sweepingOrphans = false;
  let clearingScope: string | null = null;
  let clearingLayoutScope: string | null = null;
  let nukingEverything = false;
  let mutatingSessionId: string | null = null;
  let layoutScopes: RecoveryScopeSummary[] = [];
  let scopeEntries: ScopeEntry[] = [];
  let diagnostics = {
    sessionCount: 0,
    layoutScopeCount: 0,
    orphanCount: 0,
    adoptingCount: 0,
  };

  let selectedDirectory = '';
  let defaultProjectRoot = '';
  let harness = '';
  let role = '';
  let startScopeOverride = '';
  let themeProfileId = '';
  let selectedLaunchProfileId = '';
  let backgroundOpacity = 68;
  let effectiveBackgroundOpacity = 0.68;
  let currentTheme: ThemeProfile | undefined;
  let startScopeDescription = {
    title: 'Pick a starting location',
    subtitle: 'Start Fresh will mint a new isolated scope once the project path is set.',
  };

  const harnessOptions = HARNESS_NAMES;

  $: selectedDirectory = $startupPreferences.selectedDirectory;
  $: harness = $startupPreferences.launchDefaults.harness;
  $: role = $startupPreferences.launchDefaults.role;
  $: themeProfileId = $startupPreferences.themeProfileId;
  $: selectedLaunchProfileId = $startupPreferences.selectedLaunchProfileId;
  $: selectedLaunchProfile =
    $launchProfiles.find((profile) => profile.id === selectedLaunchProfileId) ?? null;
  $: currentTheme = builtInThemeProfiles.find((profile) => profile.id === themeProfileId);
  $: effectiveBackgroundOpacity =
    $startupPreferences.backgroundOpacityOverride ??
    currentTheme?.appearance.defaultBackgroundOpacity ??
    0.68;
  $: backgroundOpacity = Math.round(effectiveBackgroundOpacity * 100);
  $: if (!initializedSection) {
    activeSection = $defaultHomeSection as HomeSection;
    initializedSection = true;
  }

  $: layoutScopes = $recoveryScopeSummaries.filter((scope) => scope.layoutNodeCount > 0);
  $: scopeEntries = buildScopeEntries($recoverySessionItems, $recoveryScopeSummaries);
  $: diagnostics = {
    sessionCount: $recoverySessionItems.length,
    layoutScopeCount: layoutScopes.length,
    orphanCount: $recoverySessionItems.filter((item) => !item.adopted && item.status !== 'adopting').length,
    adoptingCount: $recoverySessionItems.filter((item) => item.status === 'adopting').length,
  };
  $: startScopeDescription = buildStartScopeDescription(selectedDirectory, startScopeOverride);
  $: activeResourceLane = resourceLanes.find((lane) => lane.id === activeResource) ?? {
    id: 'projects',
    label: 'Projects',
    detail: 'Roots, notes, files, and attached agents.',
    icon: 'P',
    enabled: true,
  };
  $: browserScope = $activeScope || selectedDirectory || defaultProjectRoot || '';
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
  $: if (activeSection === 'projects' && activeResource === 'browser' && browserScope && browserCatalogScope !== browserScope && !browserLoading) {
    void loadBrowserCatalog();
  }

	  onMount(async () => {
	    startScopeOverride = '';
	    void loadDefaultProjectRoot();
	    void loadProjects().catch((err) => {
	      console.warn('[StartupHome] failed to load project spaces:', err);
	    });

	    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[StartupHome] failed to load role presets:', err);
      rolePresets = STANDARD_AGENT_ROLE_PRESETS.map((preset) => ({ role: preset.role }));
    }
  });

  function buildScopeEntries(
    sessions: RecoverySessionItem[],
    scopes: RecoveryScopeSummary[],
  ): ScopeEntry[] {
    const byScope = new Map<string, ScopeEntry>(
      scopes.map((scope) => [
        scope.scope,
        { scope, items: [], hasLayout: scope.layoutNodeCount > 0 },
      ]),
    );
    for (const session of sessions) {
      const entry = byScope.get(session.scope);
      if (entry) {
        entry.items.push(session);
      }
    }
    // Include scopes that only have a saved layout AND/OR only have sessions.
    // Drop scopes that have neither (shouldn't happen, but be defensive).
    return [...byScope.values()].filter((entry) => entry.items.length > 0 || entry.hasLayout);
  }

  function validateDirectory(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Starting location is required.';
    if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) {
      return 'Starting location must be an absolute path.';
    }
    return null;
  }

  function shortId(value: string): string {
    return value.slice(0, 8);
  }

  function formatScopePath(scope: string): string {
    if (scope.includes('#fresh-')) {
      return `${scope.split('#fresh-')[0] ?? scope} (fresh)`;
    }
    return scope;
  }

  function sessionTokens(label: string | null): string[] {
    return label?.split(/\s+/).filter(Boolean) ?? [];
  }

	  function buildFreshScope(directory: string): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    return `${directory}#fresh-${stamp.toLowerCase()}`;
	  }

	  function projectNameFromDirectory(directory: string): string {
	    const trimmed = directory.trim().replace(/\/+$/, '');
	    const parts = trimmed.split('/').filter(Boolean);
	    const last = parts[parts.length - 1];
	    return last || 'Untitled Project';
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
    const base = (defaultProjectRoot || selectedDirectory || '').trim().replace(/\/+$/, '');
    const rootBase = base || '/Users/mathewfrazier/Desktop';
    return `${rootBase}/${projectSlugFromName(name)}`;
  }

  function selectResourceLane(lane: ResourceLane): void {
    activeResource = lane.id;
    activeSection = 'projects';
    projectError = null;
    browserError = null;
    if (lane.id === 'browser') {
      void loadBrowserCatalog();
      return;
    }
    projectError = lane.enabled
      ? null
      : `${lane.label} is parked for a later bridge. Project spaces stay the active lane for now.`;
  }

  function openWorkspaceKit(): void {
    activeSection = 'projects';
    resourceLibraryExpanded = false;
  }

  function selectProjectsLane(): void {
    const projectsLane = resourceLanes.find((lane) => lane.id === 'projects');
    if (projectsLane) {
      selectResourceLane(projectsLane);
    }
  }

  function applyBrowserCatalog(catalog: BrowserCatalog): void {
    browserContexts = catalog.contexts ?? [];
    browserTabs = catalog.tabs ?? [];
    browserSnapshots = catalog.snapshots ?? [];
  }

  async function loadBrowserCatalog(): Promise<void> {
    if (!browserScope) {
      browserError = 'Pick a channel or starting location first.';
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
      browserError = 'Pick a channel or starting location first.';
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
      browserError = 'Pick a channel or starting location first.';
      return;
    }

    const url = browserUrlDraft.trim() || 'about:blank';
    browserLoading = true;
    browserError = null;
    try {
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_open_browser_context', {
        scope: browserScope,
        url,
      }));
    } catch (err) {
      browserError = err instanceof Error ? err.message : String(err);
    } finally {
      browserLoading = false;
    }
  }

  async function importFrontChromeTab(): Promise<void> {
    if (!browserScope) {
      browserError = 'Pick a channel or starting location first.';
      return;
    }

    browserLoading = true;
    browserError = null;
    try {
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_import_front_chrome_tab', { scope: browserScope }));
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
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_close_browser_context', {
        scope: browserScope,
        contextId: selectedBrowserContext.id,
      }));
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
      applyBrowserCatalog(await invoke<BrowserCatalog>('ui_capture_browser_snapshot', {
        scope: browserScope,
        contextId: selectedBrowserContext.id,
        tabId: activeTab?.tabId,
      }));
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
    return `${tabCount} tab${tabCount === 1 ? '' : 's'} / ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'}`;
  }

  function openProjectCreateModal(mode: ProjectCreateMode = 'choose'): void {
    projectCreateModalOpen = true;
    projectCreateMode = mode;
    projectError = null;
    if (mode === 'scratch') {
      const name = projectNameFromDirectory(selectedDirectory || defaultProjectRoot || 'New Project');
      draftProjectName = name === 'Desktop' ? 'New Project' : name;
      draftProjectRoot = suggestedProjectRoot(draftProjectName);
      draftProjectNotes = '';
    } else if (mode === 'existing') {
      draftProjectRoot = selectedDirectory.trim() || defaultProjectRoot;
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

	  async function loadDefaultProjectRoot(): Promise<void> {
	    try {
	      const root = await invoke<string>('ui_default_project_root');
	      defaultProjectRoot = root;
	      if (!selectedDirectory.trim()) {
	        startupPreferences.setSelectedDirectory(root);
	      }
	    } catch (err) {
	      console.warn('[StartupHome] failed to resolve default project root:', err);
	      defaultProjectRoot = selectedDirectory.trim();
	    }
	  }

  function buildStartScopeDescription(directory: string | null | undefined, override: string | null | undefined): {
    title: string;
    subtitle: string;
  } {
    const explicitScope = (override ?? '').trim();
    if (explicitScope) {
      return {
        title: `Open ${formatScopeLabel(explicitScope, 2)}`,
        subtitle: `Canvas and launcher will follow ${formatScopePath(explicitScope)} until you intentionally override it again.`,
      };
    }

    const trimmedDirectory = (directory ?? '').trim();
    if (!trimmedDirectory) {
      return {
        title: 'Pick a starting location',
        subtitle: 'Start Fresh will mint a new isolated scope once the project path is set.',
      };
    }

    return {
      title: `Mint ${formatScopeLabel(trimmedDirectory, 1)} fresh`,
      subtitle: `Canvas enters a clean isolated scope under ${trimmedDirectory}. Existing sessions stay recoverable from Home.`,
    };
  }

  function rememberScopeContext(scope: string, directory: string): void {
    setScopeSelection(scope);
    startupPreferences.setLaunchDefaults({ scope: '' });
    if (directory.trim()) {
      startupPreferences.setSelectedDirectory(directory.trim());
      startupPreferences.addRecentDirectory(directory.trim());
    }
  }

  function handleDirectoryInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setSelectedDirectory(target.value);
  }

  function handleHarnessChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setLaunchDefaults({ harness: target.value });
  }

  function handleRoleChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setLaunchDefaults({ role: target.value });
  }

  function handleLaunchProfileChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    const profile = $launchProfiles.find((entry) => entry.id === target.value) ?? null;
    startupPreferences.setSelectedLaunchProfileId(target.value);
    if (profile) {
      startupPreferences.setLaunchDefaults({
        harness: profile.harness,
        role: profile.defaultRole,
      });
    }
  }

  function handleStartScopeInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    startScopeOverride = target.value;
  }

  function clearStartScopeOverride(): void {
    startScopeOverride = '';
  }

  function handleThemeChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setThemeProfile(target.value as ThemeProfileId);
  }

  function handleOpacityInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setBackgroundOpacityOverride(Number(target.value) / 100);
  }

  function applyRecentDirectory(directory: string): void {
    startupPreferences.setSelectedDirectory(directory);
    startError = null;
  }

  function enterCanvas(): void {
    dispatch('enterCanvas');
  }

  function openSettings(): void {
    dispatch('openSettings');
  }

  function openFrazierCode(): void {
    dispatch('openFrazierCode');
  }

  function handleLaunchProfile(): void {
    diagnosticsMessage = null;
    enterCanvas();
  }

  async function handleOpenProjectPrimary(): Promise<void> {
    projectError = null;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: selectedDirectory.trim() || defaultProjectRoot || undefined,
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (typeof selectedPath === 'string' && selectedPath.trim()) {
        startupPreferences.setSelectedDirectory(selectedPath);
        await createOrOpenProject(selectedPath);
        return;
      }
    } catch (err) {
      console.warn('[StartupHome] native project picker unavailable, falling back to project dialog:', err);
    }

    openProjectCreateModal('existing');
  }

  function handleStartFromPlan(): void {
    activeSection = 'agents';
  }

  function handleResumeRunningAgents(): void {
    if (diagnostics.sessionCount > 0) {
      enterCanvas();
      return;
    }
    activeSection = 'sessions';
  }

	  function handleStartFresh(): void {
    const trimmedDirectory = selectedDirectory.trim();
    const error = validateDirectory(trimmedDirectory);
    if (error) {
      startError = error;
      return;
    }

    const explicitScope = startScopeOverride.trim();
    const derivedScope = explicitScope || buildFreshScope(trimmedDirectory);
    startupPreferences.setSelectedDirectory(trimmedDirectory);
    startupPreferences.addRecentDirectory(trimmedDirectory);
    startupPreferences.setLaunchDefaults({
      harness,
      role,
      scope: '',
    });
    setScopeSelection(derivedScope);
    diagnosticsMessage = null;
    startError = null;
	    enterCanvas();
	  }

	  function findProjectByRoot(root: string): ProjectSpace | null {
	    const trimmed = root.trim().replace(/\/+$/, '');
	    return $projects.find((project) => project.root.replace(/\/+$/, '') === trimmed) ?? null;
	  }

	  async function createOrOpenProject(
    root: string,
    options: { name?: string; notes?: string; ensureFolder?: boolean } = {},
  ): Promise<ProjectSpace | null> {
	    const trimmedDirectory = root.trim();
	    const error = validateDirectory(trimmedDirectory);
	    if (error) {
	      projectError = error;
	      return null;
	    }

	    projectMutation = true;
	    projectError = null;
	    try {
	      const projectRoot = options.ensureFolder
	        ? await ensureProjectFolder(trimmedDirectory)
	        : trimmedDirectory;
	      const existing = findProjectByRoot(projectRoot);
	      if (existing) {
	        openProject(existing);
	        return existing;
	      }

	      const name = options.name?.trim() || projectNameFromDirectory(projectRoot);
	      const explicitScope = startScopeOverride.trim();
	      const now = Date.now();
	      const project = await saveProject({
	        id: projectIdFromName(name),
	        name,
	        root: projectRoot,
	        color: DEFAULT_PROJECT_COLOR,
	        additionalRoots: [],
	        notes: options.notes?.trim() ?? '',
	        scope: explicitScope || projectRoot,
	        boundary: {
	          x: 80 + ($projects.length % 4) * 44,
	          y: 90 + ($projects.length % 3) * 38,
	          width: 860,
	          height: 540,
	        },
	        createdAt: now,
	        updatedAt: now,
	      });
	      rememberScopeContext(project.scope ?? project.root, project.root);
	      diagnosticsMessage = null;
	      dispatch('openProject', { project });
	      return project;
	    } catch (err) {
	      projectError = err instanceof Error ? err.message : String(err);
	      return null;
	    } finally {
	      projectMutation = false;
	    }
	  }

	  async function handleOpenProjectPath(): Promise<void> {
	    await createOrOpenProject(selectedDirectory);
	  }

	  function openProject(project: ProjectSpace): void {
	    rememberScopeContext(project.scope ?? project.root, project.root);
	    diagnosticsMessage = null;
	    projectError = null;
	    enterCanvas();
	    dispatch('openProject', { project });
	  }

	  function openScope(scope: string, directory = ''): void {
    rememberScopeContext(scope, directory);
    diagnosticsMessage = null;
    enterCanvas();
  }

  /**
   * Tear down a recovery row the user has explicitly asked to remove.
   *
   * Orphan PTY-only rows go through the daemon's `pty_close` path so stale
   * canvas nodes disappear without being framed as a process kill. Instance
   * rows still use `ui_kill_instance` so externally-adopted agents (Claude
   * processes spawned by another tab or from a Terminal.app window) are
   * actually SIGTERM'd and not just dropped from the swarm.db rows. Together
   * those two paths cover the main failure modes cleanly:
   *   - Stale binder resolution pointing at a dead PTY.
   *   - Fresh heartbeat from a server-side adopter keeping the row Online
   *     past the stale window (the kill flips it to dead).
   *   - Live PTY the user has explicitly confirmed they want stopped.
   *   - Externally-adopted instance whose pid is in swarm.db but whose
   *     PTY this UI session never bound to — the old force-deregister
   *     silently skipped these and left zombies behind (see memory note
   *     `close_path_asymmetry.md`).
   *
   * The backend best-efforts a PTY close via the binder, SIGTERMs the
   * recorded pid, waits 1.5s, SIGKILLs if still alive, then cascades the
   * row deletion (tasks/locks/messages). Unadopted placeholder rows
   * (pid=0) are effectively a no-op kill + deregister, which is the
   * correct behaviour.
   *
   * Callers must confirm destructive intent themselves — `removeSessionRow`
   * does; `nukeEverythingAndStart` does at the scope level;
   * `handleSessionAction` only reaches here for `cleanup_orphan` and
   * `remove` which are already user-initiated.
   *
   * Do not fall back to force-deregister on kill failure. If the process
   * could not be terminated, the row must stay visible so the operator can
   * see that the session may still be alive.
   */
  async function tearDownSessionRow(session: RecoverySessionItem): Promise<void> {
    if (session.kind === 'orphan_pty' && session.ptyId) {
      await clearStalePtySession(session.ptyId);
      return;
    }
    if (session.instanceId) {
      await killInstance(session.instanceId);
      return;
    }
    throw new Error(`No teardown target for recovery row ${session.id}`);
  }

  async function handleSessionAction(session: RecoverySessionItem): Promise<void> {
    if (mutatingSessionId) return;
    mutatingSessionId = session.id;
    diagnosticsMessage = null;
    try {
      switch (session.action) {
        case 'open_scope':
          openScope(session.scope, session.directory);
          break;
        case 'respawn':
          if (!session.instanceId) {
            throw new Error('No instance row is available to respawn.');
          }
          await respawnInstance(session.instanceId);
          rememberScopeContext(session.scope, session.directory);
          enterCanvas();
          break;
        case 'remove':
        case 'cleanup_orphan':
          await tearDownSessionRow(session);
          diagnosticsMessage = session.action === 'cleanup_orphan'
            ? 'Orphan placeholder cleaned up.'
            : 'Session removed.';
          break;
      }
    } catch (err) {
      diagnosticsMessage = `Action failed: ${err}`;
      console.error('[StartupHome] session action failed:', err);
    } finally {
      mutatingSessionId = null;
    }
  }

  async function clearScope(scope: string, sessions: RecoverySessionItem[]): Promise<void> {
    if (clearingScope) return;
    // Previous behaviour: only deregister stale/offline rows, leaving any
    // live external adopters running. That made the scope-level X button
    // feel broken when users saw live agents still reporting into a scope
    // they had just "cleared". Now we tear down every row in the scope and
    // the backend kill path SIGTERM/SIGKILLs the recorded pid.
    const liveSessions = sessions.filter(
      (session) =>
        session.status === 'online' ||
        session.status === 'adopting' ||
        (session.kind === 'instance' && Boolean(session.ptyId)),
    );
    if (liveSessions.length > 0) {
      const ok = await confirm({
        title: 'Clear scope',
        message: `${formatScopeLabel(scope)} has ${liveSessions.length} live terminal${
          liveSessions.length === 1 ? '' : 's'
        }. Kill them and clear the scope?`,
        confirmLabel: 'Kill & clear',
        danger: true,
      });
      if (!ok) return;
    }
    clearingScope = scope;
    diagnosticsMessage = null;
    try {
      let killed = 0;
      for (const session of sessions) {
        try {
          await tearDownSessionRow(session);
          killed += 1;
        } catch (err) {
          console.warn('[StartupHome] row teardown during clearScope failed:', err);
        }
      }
      diagnosticsMessage = `Cleared ${killed} of ${sessions.length} session${
        sessions.length === 1 ? '' : 's'
      } in ${formatScopeLabel(scope)}.`;
    } catch (err) {
      diagnosticsMessage = `Channel cleanup failed: ${err}`;
      console.error('[StartupHome] failed to clear scope:', err);
    } finally {
      clearingScope = null;
    }
  }

  async function clearScopeLayout(scope: string): Promise<void> {
    if (clearingLayoutScope) return;
    clearingLayoutScope = scope;
    diagnosticsMessage = null;
    try {
      await invoke('ui_set_layout', { scope, layout: { nodes: {} } });
      diagnosticsMessage = `Discarded saved layout for ${formatScopeLabel(scope)}.`;
    } catch (err) {
      diagnosticsMessage = `Layout cleanup failed: ${err}`;
      console.error('[StartupHome] failed to clear layout:', err);
    } finally {
      clearingLayoutScope = null;
    }
  }

  async function removeSessionRow(session: RecoverySessionItem): Promise<void> {
    if (mutatingSessionId) return;
    // Live sessions get a confirm — tearing them down stops the running terminal.
    if (
      session.status === 'online' ||
      session.status === 'adopting' ||
      (session.kind === 'instance' && Boolean(session.ptyId))
    ) {
      const label = session.displayName ?? shortId(session.id);
      const ok = await confirm({
        title: 'Remove session',
        message: `${label} has a live terminal. Stop it and remove from Home?`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    mutatingSessionId = session.id;
    diagnosticsMessage = null;
    try {
      await tearDownSessionRow(session);
      diagnosticsMessage = `Removed ${session.displayName ?? shortId(session.id)}.`;
    } catch (err) {
      diagnosticsMessage = `Remove failed: ${err}`;
      console.error('[StartupHome] failed to remove session row:', err);
    } finally {
      mutatingSessionId = null;
    }
  }

  async function copyText(value: string, label: string): Promise<void> {
    diagnosticsMessage = null;
    try {
      await navigator.clipboard.writeText(value);
      diagnosticsMessage = `Copied ${label}.`;
    } catch (err) {
      diagnosticsMessage = `Copy failed: ${err}`;
    }
  }

  async function nukeEverythingAndStart(): Promise<void> {
    if (nukingEverything) return;
    const trimmedDirectory = selectedDirectory.trim();
    const error = validateDirectory(trimmedDirectory);
    if (error) {
      startError = error;
      activeSection = 'start';
      return;
    }

    const liveItems = $recoverySessionItems.filter(
      (item) =>
        item.status === 'online' ||
        item.status === 'adopting' ||
        (item.kind === 'instance' && Boolean(item.ptyId)),
    );
    const removableCount = $recoverySessionItems.length - liveItems.length;
    const parts: string[] = [];
    if (liveItems.length > 0) parts.push(`${liveItems.length} live terminal${liveItems.length === 1 ? '' : 's'}`);
    if (removableCount > 0) parts.push(`${removableCount} stale/offline row${removableCount === 1 ? '' : 's'}`);
    if (layoutScopes.length > 0) parts.push(`${layoutScopes.length} saved layout${layoutScopes.length === 1 ? '' : 's'}`);

    if (parts.length > 0) {
      const summary = parts.join(', ');
      const verb = liveItems.length > 0 ? 'stop and clear' : 'clear';
      const ok = await confirm({
        title: 'Clear & Quickstart',
        message: `Clear & Quickstart will ${verb} ${summary}, then drop into a blank canvas. Continue?`,
        confirmLabel: 'Clear & start',
        danger: true,
      });
      if (!ok) return;
    }

    nukingEverything = true;
    diagnosticsMessage = null;
    startError = null;
    try {
      // Iterate every row and apply tearDownSessionRow — it picks the right
      // primitive per row: closePty for orphan PTYs and ui_kill_instance for
      // instance rows. Bulk deregistration enumerates by heartbeat and skips
      // bound/fresh rows, so it cannot deliver the "clear everything" promise
      // by itself.
      const rowsToClear = [...$recoverySessionItems];
      for (const item of rowsToClear) {
        try {
          await tearDownSessionRow(item);
        } catch (err) {
          console.warn('[StartupHome] tear-down during nuke failed:', err);
        }
      }
      await invoke('ui_sweep_unadopted_orphans').catch((err) => {
        console.warn('[StartupHome] orphan sweep during nuke failed:', err);
      });

      // Drop saved layouts for every scope so the fresh canvas doesn't inherit
      // stale positions from a prior session.
      for (const layoutScope of layoutScopes) {
        await invoke('ui_set_layout', {
          scope: layoutScope.scope,
          layout: { nodes: {} },
        }).catch((err) => {
          console.warn('[StartupHome] failed clearing layout during nuke:', err);
        });
      }

      handleStartFresh();
    } catch (err) {
      diagnosticsMessage = `Clear & Quickstart failed: ${err}`;
      console.error('[StartupHome] nukeEverythingAndStart failed:', err);
    } finally {
      nukingEverything = false;
    }
  }

  async function sweepOrphans(): Promise<void> {
    if (sweepingOrphans) return;
    sweepingOrphans = true;
    diagnosticsMessage = null;
    try {
      const removed = await invoke<number>('ui_sweep_unadopted_orphans');
      diagnosticsMessage = removed > 0
        ? `Removed ${removed} orphan placeholder row${removed === 1 ? '' : 's'}.`
        : 'No stale orphan placeholders were found.';
    } catch (err) {
      diagnosticsMessage = `Orphan sweep failed: ${err}`;
      console.error('[StartupHome] failed to sweep orphans:', err);
    } finally {
      sweepingOrphans = false;
    }
  }

  function actionLabel(session: RecoverySessionItem): string {
    switch (session.action) {
      case 'open_scope':
        return 'Open Channel';
      case 'respawn':
        return 'Respawn';
      case 'remove':
        return 'Remove';
      case 'cleanup_orphan':
        return session.kind === 'orphan_pty' ? 'Clear stale' : 'Cleanup Orphan';
    }
  }
</script>

<div class="home-overlay">
  <div class="home-shell">
    <aside class="home-nav">
      <div class="nav-top">
        <div class="brand-block">
          <p class="eyebrow">swarm-ui</p>
          <h1>Home</h1>
        </div>

        <nav class="section-nav" aria-label="Home sections">
          <div class="nav-resource-group">
            <button
              type="button"
              class="nav-group-toggle"
              class:active={activeSection === 'projects'}
              aria-expanded={resourceLibraryExpanded}
              on:click={openWorkspaceKit}
            >
              <span>Workspace Kit</span>
              <span class="nav-chevron" class:open={resourceLibraryExpanded}>›</span>
            </button>
            {#if resourceLibraryExpanded}
              <div class="resource-nav-list" aria-label="Workspace resources">
                {#each resourceLanes as lane (lane.id)}
                  <div class="resource-nav-row" class:active={activeSection === 'projects' && activeResource === lane.id}>
                    <button
                      type="button"
                      class="resource-nav-main"
                      title={lane.detail}
                      on:click={() => selectResourceLane(lane)}
                    >
                      <span class="nav-icon" aria-hidden="true">{lane.icon}</span>
                      <span class="resource-nav-copy">
                        <span class="nav-label">{lane.label}</span>
                        {#if !lane.enabled}
                          <span class="soon-label">later</span>
                        {/if}
                      </span>
                    </button>
                    {#if lane.id === 'projects'}
                      <button
                        type="button"
                        class="resource-add-btn"
                        title="Add project"
                        aria-label="Add project"
                        on:click={() => openProjectCreateModal('choose')}
                      >
                        +
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          {#each navItems as item (item.id)}
            <button
              class:active={activeSection === item.id}
              title={item.meta}
              on:click={() => (activeSection = item.id)}
            >
              <span class="nav-icon" aria-hidden="true">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
            </button>
          {/each}
        </nav>
      </div>

      <div class="nav-footer">
        <div class="nav-stat">
          <span class="stat-value">{diagnostics.sessionCount}</span>
          <span class="stat-label">session rows</span>
        </div>
        <div class="nav-stat">
          <span class="stat-value">{diagnostics.layoutScopeCount}</span>
          <span class="stat-label">layout scopes</span>
        </div>
      </div>
    </aside>

    <section class="home-content">
      <div class="content-header">
        <h2>
          {#if activeSection === 'start'}
            Start
          {:else if activeSection === 'launch'}
            Launch
          {:else if activeSection === 'projects'}
            {activeResource === 'projects' ? 'Project Spaces' : activeResourceLane.label}
          {:else if activeSection === 'sessions'}
            Sessions &amp; Layouts
          {:else if activeSection === 'agents'}
            Agents
          {:else if activeSection === 'diagnostics'}
            Diagnostics
          {:else if activeSection === 'dictionary'}
            Dictionary
          {:else if activeSection === 'about'}
            About
          {:else}
            Settings
          {/if}
        </h2>

        <div class="header-actions">
          <span class="header-chip">{currentTheme?.name ?? 'Theme'}</span>
          {#if activeSection === 'start'}
            <button class="ghost-btn" type="button" on:click={() => (activeSection = 'launch')}>Launch setup</button>
          {:else if activeSection === 'projects'}
            <button class="primary-btn" type="button" disabled={projectMutation} on:click={() => openProjectCreateModal('choose')}>
              {projectMutation ? 'Opening...' : 'Add Project'}
            </button>
          {:else if activeSection === 'settings'}
            <button class="primary-btn" type="button" on:click={openSettings}>Open settings</button>
          {/if}
        </div>
      </div>

      <div class="summary-strip" aria-label="Home summary">
        <span class="summary-item"><em>{diagnostics.sessionCount}</em> sessions</span>
        <span class="summary-item"><em>{diagnostics.layoutScopeCount}</em> layouts</span>
        <span class="summary-item"><em>{$projects.length}</em> projects</span>
        <span class="summary-item"><em>{$agentProfiles.length}</em> agents</span>
        <span class="summary-item">launch <em>{harness || 'shell'}{role ? ` · ${role}` : ''}</em></span>
      </div>

      {#if activeSection === 'start'}
        <div class="start-grid" aria-label="Start">
          <section class="start-command-panel">
            <div class="start-copy">
              <span class="start-kicker">Project Command Deck</span>
              <h3>Open a project. Turn plans into tasks. Launch agents.</h3>
              <p>
                The normal path is project first: pick the repo, shape the tasks, then let task-bound agents report back with real listener and status proof.
              </p>
            </div>
            <div class="start-actions">
              <button class="primary-btn primary-btn--large" type="button" disabled={projectMutation} on:click={handleOpenProjectPrimary}>
                {projectMutation ? 'Opening...' : 'Open Project'}
              </button>
              <button class="ghost-btn ghost-btn--large" type="button" on:click={handleStartFromPlan}>
                Start From Plan
              </button>
              <button class="ghost-btn ghost-btn--large" type="button" on:click={handleResumeRunningAgents}>
                Resume Running Agents
              </button>
            </div>
            <div class="start-loop-strip" aria-label="May 1st loop">
              {#each ['Open Project', 'Project Cockpit', 'Task Board', 'Task-Bound Agents'] as step, index (step)}
                <span>{index + 1}. {step}</span>
              {/each}
            </div>
            <div class="start-secondary-actions">
              <button class="inline-btn" type="button" on:click={enterCanvas}>
                Enter Canvas
              </button>
              <button class="inline-btn" type="button" on:click={() => (activeSection = 'launch')}>
                Advanced Launch
              </button>
            </div>
            {#if startError}
              <p class="error-text">{startError}</p>
            {/if}
          </section>

          <section class="frazier-start-card" aria-label="FrazierCode Agentic">
            <button type="button" class="frazier-preview" on:click={openFrazierCode}>
              <img src={frazierCodeTronUrl} alt="FrazierCode Agentic Tron concept art" />
              <span class="frazier-preview-glass">
                <strong>FrazierCode <span>[Agentic]</span></strong>
                <small>Open archive window</small>
              </span>
            </button>
            <div class="frazier-start-copy">
              <span class="start-kicker">Prominent, not primary</span>
              <h3>FrazierCode lives in its own window.</h3>
              <p>The credit and archive stay one click away, while startup now leads with the operational desktop.</p>
            </div>
          </section>
        </div>
      {:else if activeSection === 'launch'}
        <div class="content-grid launch-grid">
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Launch Setup</h3>
                <p>The previous Start controls live here now: working directory, channel behavior, harness, role, and launch profile.</p>
              </div>
              <span class="status-chip muted">{startScopeDescription.title}</span>
            </div>

            <label for="start-directory">Starting Location</label>
            <input
              id="start-directory"
              class="text-input mono"
              type="text"
              bind:value={selectedDirectory}
              placeholder={defaultProjectRoot || '/Users/mathewfrazier/Desktop'}
              on:input={handleDirectoryInput}
            />

            {#if $startupPreferences.recentDirectories.length > 0}
              <div class="chip-row">
                {#each $startupPreferences.recentDirectories as directory (directory)}
                  <button class="chip chip--path mono" type="button" on:click={() => applyRecentDirectory(directory)}>
                    {directory}
                  </button>
                {/each}
              </div>
            {/if}

            <div class="inline-grid">
              <div>
                <label for="start-harness">Harness</label>
                <select id="start-harness" class="text-input" value={harness} on:change={handleHarnessChange}>
                  {#each harnessOptions as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="start-role">Role</label>
                <select id="start-role" class="text-input" value={role} on:change={handleRoleChange}>
                  <option value="">No role preset</option>
                  {#each rolePresets as preset (preset.role)}
                    <option value={preset.role}>{rolePresetForRole(preset.role).label} ({preset.role})</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="inline-grid">
              <div>
                <label for="start-channel">Channel Override</label>
                <input
                  id="start-channel"
                  class="text-input mono"
                  type="text"
                  value={startScopeOverride}
                  placeholder="leave blank to mint a fresh channel"
                  on:input={handleStartScopeInput}
                />
              </div>
              <div>
                <label for="launch-profile">Launch Profile</label>
                <select
                  id="launch-profile"
                  class="text-input"
                  value={selectedLaunchProfileId}
                  on:change={handleLaunchProfileChange}
                >
                  <option value="">Manual defaults</option>
                  {#each $launchProfiles as profile (profile.id)}
                    <option value={profile.id}>{profile.name}</option>
                  {/each}
                </select>
              </div>
            </div>

            <p class="field-hint">{startScopeDescription.subtitle}</p>
            {#if selectedLaunchProfile}
              <p class="field-hint">Launch Profile: {selectedLaunchProfile.description}</p>
            {/if}
            {#if startError}
              <p class="error-text">{startError}</p>
            {/if}

            <div class="footer-actions">
              <button class="primary-btn primary-btn--large" type="button" on:click={handleStartFresh}>
                Start Fresh
              </button>
              <button class="ghost-btn" type="button" on:click={clearStartScopeOverride}>
                Clear channel override
              </button>
              <button class="ghost-btn" type="button" on:click={enterCanvas}>
                Enter current canvas
              </button>
              <button class="ghost-btn ghost-btn--danger" type="button" disabled={nukingEverything} on:click={nukeEverythingAndStart}>
                {nukingEverything ? 'Clearing...' : 'Clear & Quickstart'}
              </button>
            </div>
          </article>
        </div>
      {:else if activeSection === 'projects'}
        <div class="content-grid">
          <article class="panel-card panel-card--wide resource-picker">
            <div class="card-heading">
              <div>
                <h3>Workspace Kit</h3>
                <p>Pick the resource lane first, then open or add the exact context the agents should carry.</p>
              </div>
              <span class="status-chip muted">{activeResourceLane.label}</span>
            </div>

            <div class="resource-choice-grid" aria-label="Workspace resources">
              {#each resourceLanes as lane (lane.id)}
                <button
                  type="button"
                  class="resource-choice"
                  class:active={activeResource === lane.id}
                  class:disabled={!lane.enabled}
                  on:click={() => selectResourceLane(lane)}
                >
                  <span class="resource-choice-icon resource-choice-icon--image" aria-hidden="true">
                    <img src={darkFolderUrl} alt="" />
                  </span>
                  <span>
                    <strong>{lane.label}</strong>
                    <small>{lane.detail}</small>
                  </span>
                  {#if !lane.enabled}
                    <em>later</em>
                  {/if}
                </button>
              {/each}
              <button
                type="button"
                class="resource-choice resource-choice--add"
                disabled={projectMutation}
                on:click={() => openProjectCreateModal('choose')}
              >
                <span class="resource-choice-icon resource-choice-icon--image" aria-hidden="true">
                  <img src={darkFolderUrl} alt="" />
                </span>
                <span>
                  <strong>Add Project</strong>
                  <small>Start from scratch or use an existing folder.</small>
                </span>
              </button>
            </div>
          </article>

          {#if activeResource === 'projects'}
            <article class="panel-card panel-card--wide">
              <div class="card-heading">
                <div>
                  <h3>Project Root</h3>
                  <p>Projects are context spaces: roots, notes, files, assets, and agent membership. They do not sandbox or silently move running agents.</p>
                </div>
                <span class="status-chip muted">default {defaultProjectRoot || 'resolving...'}</span>
              </div>

              <input
                id="project-directory"
                class="text-input mono"
                type="text"
                bind:value={selectedDirectory}
                placeholder={defaultProjectRoot || '/Users/you/Desktop'}
                on:input={handleDirectoryInput}
              />

              {#if $startupPreferences.recentDirectories.length > 0}
                <div class="chip-row">
                  {#each $startupPreferences.recentDirectories as directory (directory)}
                    <button class="chip chip--path mono" type="button" on:click={() => applyRecentDirectory(directory)}>
                      {directory}
                    </button>
                  {/each}
                </div>
              {/if}

              {#if projectError}
                <p class="error-text">{projectError}</p>
              {/if}

              <div class="footer-actions">
                <button
                  class="primary-btn"
                  type="button"
                  disabled={projectMutation}
                  on:click={() => openProjectCreateModal('choose')}
                >
                  {projectMutation ? 'Opening...' : 'Add Project'}
                </button>
                <button
                  class="ghost-btn"
                  type="button"
                  disabled={projectMutation}
                  on:click={handleOpenProjectPath}
                >
                  Open Selected Folder
                </button>
              </div>
            </article>

            <article class="panel-card panel-card--wide">
              <div class="card-heading">
                <div>
                  <h3>Saved Project Spaces</h3>
                  <p>Open a project page, inspect linked agents/tasks, or use its boundary on the canvas to sync context.</p>
                </div>
                <span class="status-chip muted">{$projects.length}</span>
              </div>

              {#if $projects.length === 0}
                <p class="field-hint">No project spaces saved yet. Add one and the first boundary appears immediately.</p>
              {:else}
                <div class="project-grid project-grid--chooser">
                  {#each $projects as project (project.id)}
                    <button class="project-tile" type="button" on:click={() => openProject(project)}>
                      <span>
                        <strong>{project.name}</strong>
                        <small class="mono">{project.root}</small>
                      </span>
                      <span class="pill-row">
                        <span class="meta-pill">{project.additionalRoots.length + 1} roots</span>
                        {#if project.notes}
                          <span class="meta-pill pulse">notes</span>
                        {/if}
                      </span>
                    </button>
                  {/each}
                  <button class="project-tile project-tile--add" type="button" on:click={() => openProjectCreateModal('choose')}>
                    <span>
                      <strong>Add Project</strong>
                      <small>Choose scratch or existing folder</small>
                    </span>
                  </button>
                </div>
              {/if}
            </article>
          {:else if activeResource === 'browser'}
            <article class="panel-card panel-card--wide browser-bridge-card">
              <div class="card-heading">
                <div>
                  <h3>Browser</h3>
                  <p>Launch managed Chrome or import your front Chrome tab into a controlled swarm copy for this channel.</p>
                </div>
                <span class="status-chip muted">{browserScope || 'no channel'}</span>
              </div>

              <div class="browser-url-row">
                <input
                  class="text-input mono"
                  type="text"
                  bind:value={browserUrlDraft}
                  placeholder="https://example.com"
                  on:keydown={(event) => {
                    if (event.key === 'Enter') void openManagedBrowserContext();
                  }}
                />
              </div>

              <div class="browser-toolbar">
                <button
                  class="primary-btn"
                  type="button"
                  disabled={browserLoading || !browserScope}
                  on:click={openManagedBrowserContext}
                >
                  {browserLoading ? 'Working...' : 'Open URL'}
                </button>
                <button
                  class="ghost-btn"
                  type="button"
                  disabled={browserLoading || !browserScope}
                  on:click={importFrontChromeTab}
                >
                  Import Active Tab
                </button>
                <button
                  class="ghost-btn"
                  type="button"
                  disabled={browserLoading || !browserScope}
                  on:click={refreshBrowserCatalog}
                >
                  Refresh
                </button>
                <button
                  class="ghost-btn"
                  type="button"
                  disabled={browserLoading || !selectedBrowserContext || selectedBrowserContext.status === 'closed'}
                  on:click={captureBrowserSnapshot}
                >
                  Capture Snapshot
                </button>
                <button
                  class="ghost-btn ghost-btn--danger"
                  type="button"
                  disabled={browserLoading || !selectedBrowserContext || selectedBrowserContext.status === 'closed'}
                  on:click={closeManagedBrowserContext}
                >
                  Close
                </button>
              </div>

              {#if browserError}
                <p class="error-text">{browserError}</p>
              {/if}

              {#if browserLoading}
                <p class="field-hint">Loading browser contexts...</p>
              {:else if browserContexts.length === 0}
                <p class="field-hint">No browser contexts for this channel yet.</p>
              {:else}
                <div class="browser-context-grid">
                  {#each browserContexts as context (context.id)}
                    <button
                      type="button"
                      class="browser-context-card"
                      class:active={selectedBrowserContext?.id === context.id}
                      on:click={() => selectBrowserContext(context.id)}
                    >
                      <span class={`browser-status browser-status--${context.status}`}>{context.status}</span>
                      <strong>{browserTitle(context)}</strong>
                      <small class="mono">{context.endpoint}</small>
                      <em>{browserSubline(context)}</em>
                    </button>
                  {/each}
                </div>

                {#if selectedBrowserContext}
                  <div class="browser-detail-grid">
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
            </article>
          {:else}
            <article class="panel-card panel-card--wide resource-preview">
              <div class="card-heading">
                <div>
                  <h3>{activeResourceLane.label}</h3>
                  <p>{activeResourceLane.detail}</p>
                </div>
                <span class="status-chip muted">staged</span>
              </div>
              <p class="field-hint">
                This lane belongs in the same top-level project kit, but the working implementation should land after the project picker is calm. For now, use the Project Page notes and roots to attach this context to agents.
              </p>
              <button class="ghost-btn" type="button" on:click={selectProjectsLane}>
                Back to Projects
              </button>
            </article>
          {/if}
        </div>
      {:else if activeSection === 'sessions'}
        <div class="stack-list">
          {#if scopeEntries.length === 0}
            <article class="empty-card">
              <h3>Nothing to recover yet</h3>
              <p>Saved layouts and session rows will land here once you spawn your first scope.</p>
            </article>
          {:else}
            {#each scopeEntries as group (group.scope.scope)}
              <article class="scope-card" class:scope-card--layout-only={group.hasLayout && group.items.length === 0}>
                <div class="scope-card-header">
                  <div class="card-copy">
                    <div class="card-title-row">
                      <h3>{formatScopeLabel(group.scope.scope)}</h3>
                      {#if group.hasLayout && group.items.length === 0}
                        <span class="status-chip muted">layout only</span>
                      {/if}
                    </div>
                    <p class="mono">{group.scope.scope}</p>
                    <div class="pill-row">
                      {#if group.hasLayout}
                        <span class="meta-pill pulse">{group.scope.layoutNodeCount} saved positions</span>
                      {/if}
                      {#if group.items.length > 0}
                        <span class="meta-pill">{group.items.length} rows</span>
                      {/if}
                    </div>
                  </div>
                  <div class="scope-actions">
                    {#if group.scope.liveCount > 0}
                      <span class="status-chip online">{group.scope.liveCount} live</span>
                    {/if}
                    {#if group.scope.staleCount > 0}
                      <span class="status-chip warn">{group.scope.staleCount} stale</span>
                    {/if}
                    {#if group.scope.offlineCount > 0}
                      <span class="status-chip muted">{group.scope.offlineCount} offline</span>
                    {/if}
                    {#if group.scope.adoptingCount > 0}
                      <span class="status-chip pending">{group.scope.adoptingCount} adopting</span>
                    {/if}
                  </div>
                </div>

                <div class="scope-toolbar">
                  <button
                    class="primary-btn"
                    type="button"
                    on:click={() => openScope(group.scope.scope, '')}
                  >
                    Open scope
                  </button>
                  <button
                    class="inline-btn"
                    type="button"
                    on:click={() => copyText(group.scope.scope, 'scope path')}
                    title="Copy scope path to clipboard"
                  >
                    Copy path
                  </button>
                  <span class="toolbar-spacer" aria-hidden="true"></span>
                  {#if group.items.filter((s) => s.status === 'stale' || s.status === 'offline').length > 0}
                    <button
                      class="inline-btn"
                      type="button"
                      disabled={clearingScope === group.scope.scope}
                      on:click={() => clearScope(group.scope.scope, group.items)}
                      title="Clear stale rows and orphan PTYs in this scope"
                    >
                      {clearingScope === group.scope.scope ? 'Clearing…' : 'Clear stale'}
                    </button>
                  {/if}
                  {#if group.hasLayout}
                    <button
                      class="inline-btn inline-btn--danger"
                      type="button"
                      disabled={clearingLayoutScope === group.scope.scope}
                      title="Discard saved graph positions for this scope."
                      on:click={() => clearScopeLayout(group.scope.scope)}
                    >
                      {clearingLayoutScope === group.scope.scope ? 'Discarding…' : 'Discard layout'}
                    </button>
                  {/if}
                </div>

                {#if group.items.length > 0}
                  <div class="session-list">
                    {#each group.items as session (session.id)}
                      <div class="session-row">
                        <div class="session-copy">
                          <div class="session-title-row">
                            <strong>{session.displayName ?? shortId(session.id)}</strong>
                            {#if session.status === 'adopting'}
                              <span class="status-chip pending">adopting</span>
                            {:else}
                              <span class={`status-chip ${session.status}`}>{session.status}</span>
                            {/if}
                            {#if session.harness}
                              <span class="meta-pill">{session.harness}</span>
                            {/if}
                            {#if !session.adopted && session.status !== 'adopting'}
                              <span class="status-chip muted">orphan</span>
                            {/if}
                          </div>
                          <p class="mono">{session.directory || 'No working directory recorded'}</p>
                          {#if sessionTokens(session.label).length > 0}
                            <div class="token-row">
                              {#each sessionTokens(session.label) as token (token)}
                                <span class="meta-pill">{token}</span>
                              {/each}
                            </div>
                          {:else}
                            <p class="field-hint">No label tokens stored on this row.</p>
                          {/if}
                        </div>

                        <div class="session-row-actions">
                          <button
                            class="primary-btn primary-btn--sm"
                            type="button"
                            disabled={mutatingSessionId === session.id}
                            on:click={() => handleSessionAction(session)}
                          >
                            {actionLabel(session)}
                          </button>
                          <button
                            class="icon-btn"
                            type="button"
                            aria-label={session.kind === 'orphan_pty' ? 'Copy PTY ID' : 'Copy instance ID'}
                            title={session.kind === 'orphan_pty'
                              ? `Copy PTY ID (${session.id})`
                              : `Copy instance ID (${session.id})`}
                            on:click={() => copyText(session.id, session.kind === 'orphan_pty' ? 'PTY ID' : 'instance ID')}
                          >
                            <span aria-hidden="true">⧉</span>
                          </button>
                          <button
                            class="icon-btn icon-btn--danger"
                            type="button"
                            aria-label="Remove row from recovery list"
                            title={session.kind === 'orphan_pty'
                              ? 'Clear stale PTY from the canvas'
                              : session.ptyId
                                ? 'Stop terminal and remove row'
                                : 'Remove row from recovery list'}
                            disabled={mutatingSessionId === session.id}
                            on:click={() => removeSessionRow(session)}
                          >
                            <span aria-hidden="true">×</span>
                          </button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </article>
            {/each}
          {/if}
        </div>
      {:else if activeSection === 'agents'}
        <div class="content-grid settings-grid">
          <article class="panel-card panel-card--wide agents-overhaul-card">
            <div class="card-heading agents-overhaul-heading">
              <div>
                <span class="start-kicker">Active overhaul plan</span>
                <h3>{MAY_FIRST_OVERHAUL_SUMMARY.name}</h3>
                <p>{MAY_FIRST_OVERHAUL_SUMMARY.correction}. The app direction is project-first, with old Phase 4/5/6/7 work archived as source material.</p>
              </div>
              <div class="agents-overhaul-scope">
                <span>repo</span>
                <code>{MAY_FIRST_OVERHAUL_SUMMARY.repo}</code>
                <span>scope</span>
                <code>{MAY_FIRST_OVERHAUL_SUMMARY.scope}</code>
              </div>
            </div>

            <div class="agents-plan-spine" aria-label="May 1st product spine">
              {#each MAY_FIRST_OVERHAUL_SUMMARY.authority.split(' -> ') as spineStep, index (`home-spine-${spineStep}`)}
                <span>{index + 1}. {spineStep}</span>
              {/each}
            </div>
          </article>

          <article class="panel-card panel-card--wide agents-plan-board">
            <div class="card-heading">
              <div>
                <h3>MVP Slices</h3>
                <p>Slice 0-4 are the current build path. Slice 5 is the safety pass before expanding surfaces.</p>
              </div>
            </div>
            <div class="agents-slice-grid">
              {#each MAY_FIRST_MVP_SLICES as slice (slice.id)}
                <section class="agents-slice-card agents-slice-card--{slice.status}">
                  <div>
                    <span>{slice.id}</span>
                    <em>{slice.status}</em>
                  </div>
                  <strong>{slice.title}</strong>
                  <p>{slice.goal}</p>
                  <ul>
                    {#each slice.build.slice(0, 3) as item (item)}
                      <li>{item}</li>
                    {/each}
                  </ul>
                </section>
              {/each}
            </div>
          </article>

          <article class="panel-card agents-stage-card">
            <div class="card-heading">
              <div>
                <h3>Stage Map</h3>
                <p>Logical stages, not calendar estimates.</p>
              </div>
            </div>
            <div class="agents-stage-list">
              {#each MAY_FIRST_OVERHAUL_STAGES as stage (stage.id)}
                <details open={stage.id === 'Stage 0' || stage.id === 'Stage 1' || stage.id === 'Stage 2'}>
                  <summary>
                    <span>{stage.id}</span>
                    <strong>{stage.title}</strong>
                  </summary>
                  <p>{stage.purpose}</p>
                  <small>{stage.proof}</small>
                </details>
              {/each}
            </div>
          </article>

          <article class="panel-card agents-stage-card">
            <div class="card-heading">
              <div>
                <h3>North-Star Demo</h3>
                <p>The operator-visible acceptance story.</p>
              </div>
            </div>
            <ol class="agents-north-star">
              {#each MAY_FIRST_NORTH_STAR_STEPS as step, index (step)}
                <li><span>{index + 1}</span>{step}</li>
              {/each}
            </ol>
          </article>

          <article class="panel-card panel-card--wide agents-archive-card">
            <div class="card-heading">
              <div>
                <h3>Archived Phase Lane</h3>
                <p>{MAY_FIRST_OVERHAUL_SUMMARY.archiveRule}</p>
              </div>
            </div>
            <div class="agents-archive-grid">
              {#each MAY_FIRST_ARCHIVED_PHASES as phase (phase.name)}
                <section>
                  <strong>{phase.name}</strong>
                  <span>{phase.status}</span>
                  <p>{phase.useNow}</p>
                </section>
              {/each}
            </div>
          </article>

          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Agent Library</h3>
                <p>Saved profiles can carry working directory, mission, persona, skills, context, memory, and a profile-specific launch command for Codex or Claude permission posture.</p>
              </div>
            </div>

            <AgentLibraryPanel on:launchProfile={handleLaunchProfile} />
          </article>
        </div>
      {:else if activeSection === 'diagnostics'}
        <div class="content-grid">
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Recovery Health</h3>
                <p>Fast visibility into the rows and layouts that can still affect your next launch.</p>
              </div>
            </div>
            <div class="metrics-grid">
              <div><span>{diagnostics.sessionCount}</span><p class="metric-label">session rows</p></div>
              <div><span>{diagnostics.layoutScopeCount}</span><p class="metric-label">layout scopes</p></div>
              <div><span>{diagnostics.orphanCount}</span><p class="metric-label">orphans</p></div>
              <div><span>{diagnostics.adoptingCount}</span><p class="metric-label">adopting</p></div>
            </div>
            <button class="primary-btn" type="button" disabled={sweepingOrphans} on:click={sweepOrphans}>
              Sweep Unadopted Orphans
            </button>
          </article>

          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Harness Aliases</h3>
                <p>Actual commands that will be auto-typed when a harness-backed node starts.</p>
              </div>
            </div>
            <div class="alias-list">
              {#each HARNESS_NAMES as harnessName (harnessName)}
                <div class="alias-row">
                  <span class="alias-name">{harnessName}</span>
                  <code class="alias-command mono">{$harnessAliases[harnessName]}</code>
                </div>
              {/each}
            </div>
            <p class="field-hint">Edit alias commands in Settings when a path changes.</p>
          </article>

          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Channel Snapshot</h3>
                <p>Path-aware labels keep `/Desktop/auto` separate from a literal `auto` scope.</p>
              </div>
            </div>
            <div class="stack-mini">
              {#each $recoveryScopeSummaries as scope (scope.scope)}
                <div class="mini-row">
                  <span>{formatScopeLabel(scope.scope)}</span>
                  <span>{scope.sessionCount} sessions</span>
                  <span>{scope.layoutNodeCount} layout nodes</span>
                </div>
              {/each}
            </div>
          </article>
        </div>

        {#if diagnosticsMessage}
          <p class="message-text">{diagnosticsMessage}</p>
        {/if}
      {:else if activeSection === 'dictionary'}
        <div class="content-grid">

          <!-- Core Concepts -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Core Concepts</h3>
                <p>The vocabulary the swarm system and this UI are built on.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row">
                <span><strong>scope</strong></span>
                <span>Shared swarm boundary. Sessions in the same scope see each other. Defaults to the git root of <code>directory</code>, or <code>directory</code> itself when no git root exists. Different scopes are completely isolated swarms.</span>
              </div>
              <div class="mini-row">
                <span><strong>instance</strong></span>
                <span>A registered coding-agent session. Each <code>register</code> call creates a row with a UUID and a heartbeat. Instances expire after 30s without a heartbeat.</span>
              </div>
              <div class="mini-row">
                <span><strong>PTY</strong></span>
                <span>A pseudo-terminal process managed by swarm-ui. Each graph node is backed by a PTY running the harness command.</span>
              </div>
              <div class="mini-row">
                <span><strong>harness</strong></span>
                <span>The command launched inside a PTY node (e.g. <code>flux</code>, <code>codex</code>, <code>shell</code>). Configure aliases in Settings → Harness Commands.</span>
              </div>
              <div class="mini-row">
                <span><strong>role</strong></span>
                <span>A convention in a label token (<code>role:planner</code>, <code>role:implementer</code>, etc.). Not enforced by the server — agents learn roles through AGENTS.md or prompts.</span>
              </div>
              <div class="mini-row">
                <span><strong>label</strong></span>
                <span>Free-form identity text on a registered instance. Recommended: space-separated tokens like <code>provider:codex-cli role:planner team:api</code>.</span>
              </div>
              <div class="mini-row">
                <span><strong>orphan</strong></span>
                <span>A session row not yet adopted by a running PTY. Happens when swarm-ui restarts before re-attaching to existing processes. Orphan rows can be swept from Diagnostics.</span>
              </div>
              <div class="mini-row">
                <span><strong>adoption</strong></span>
                <span>swarm-ui re-attaching to an existing running process after a restart. The row shows <em>adopting</em> while in progress; once bound it becomes <em>online</em>.</span>
              </div>
              <div class="mini-row">
                <span><strong>layout</strong></span>
                <span>Saved XY positions of nodes on the canvas, keyed by scope. Persisted server-side so they survive app restarts. Discard from Sessions &amp; Layouts.</span>
              </div>
            </div>
          </article>

          <!-- MCP Tools -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>MCP Tools</h3>
                <p>Exposed by swarm-mcp to any connected coding-agent host. Names are namespaced by the client (e.g. <code>swarm_register</code> or <code>mcp__swarm__register</code>).</p>
              </div>
            </div>

            <p class="dict-group-label">Registry</p>
            <div class="stack-mini">
              <div class="mini-row"><span><code>register</code></span><span>Join the swarm. Starts heartbeat + notification poller. Call this first in every session.</span></div>
              <div class="mini-row"><span><code>deregister</code></span><span>Leave gracefully. Releases tasks and locks.</span></div>
              <div class="mini-row"><span><code>list_instances</code></span><span>List all live instances in scope.</span></div>
              <div class="mini-row"><span><code>remove_instance</code></span><span>Forcefully remove another instance and release its tasks/locks.</span></div>
              <div class="mini-row"><span><code>whoami</code></span><span>Get this instance's swarm UUID.</span></div>
            </div>

            <p class="dict-group-label">Messaging</p>
            <div class="stack-mini">
              <div class="mini-row"><span><code>send_message</code></span><span>Send a direct message to a specific instance by ID.</span></div>
              <div class="mini-row"><span><code>broadcast</code></span><span>Message all other instances in scope.</span></div>
              <div class="mini-row"><span><code>poll_messages</code></span><span>Read unread messages and mark them read.</span></div>
              <div class="mini-row"><span><code>wait_for_activity</code></span><span>Block until new messages, task changes, KV changes, or instance changes arrive. Use as an idle loop for autonomous agents.</span></div>
            </div>

            <p class="dict-group-label">Tasks</p>
            <div class="stack-mini">
              <div class="mini-row"><span><code>request_task</code></span><span>Post a task. Types: <code>review</code>, <code>implement</code>, <code>fix</code>, <code>test</code>, <code>research</code>, <code>other</code>. Supports <code>priority</code>, <code>depends_on</code>, <code>idempotency_key</code>, <code>approval_required</code>.</span></div>
              <div class="mini-row"><span><code>request_task_batch</code></span><span>Create multiple tasks atomically. Supports <code>$N</code> references for intra-batch dependencies.</span></div>
              <div class="mini-row"><span><code>claim_task</code></span><span>Claim an open task. Prevents double-claiming.</span></div>
              <div class="mini-row"><span><code>update_task</code></span><span>Transition to <code>in_progress</code>, <code>done</code>, <code>failed</code>, or <code>cancelled</code>. Attach a result.</span></div>
              <div class="mini-row"><span><code>approve_task</code></span><span>Approve an <code>approval_required</code> task → <code>open</code>/<code>claimed</code> (or <code>blocked</code> if deps unmet).</span></div>
              <div class="mini-row"><span><code>get_task</code></span><span>Get full details of a task.</span></div>
              <div class="mini-row"><span><code>list_tasks</code></span><span>Filter by status, assignee, or requester. Sorted by priority descending.</span></div>
            </div>

            <p class="dict-group-label">Context &amp; Locks</p>
            <div class="stack-mini">
              <div class="mini-row"><span><code>annotate</code></span><span>Share findings, warnings, bugs, or notes on a file. Non-lock annotations TTL: 24h.</span></div>
              <div class="mini-row"><span><code>lock_file</code></span><span>Acquire an exclusive file lock. Others should skip that file until released.</span></div>
              <div class="mini-row"><span><code>unlock_file</code></span><span>Release a lock. Also released automatically when the session expires.</span></div>
              <div class="mini-row"><span><code>check_file</code></span><span>Read annotations and current locks before editing a file.</span></div>
              <div class="mini-row"><span><code>search_context</code></span><span>Search annotations by file path or content.</span></div>
            </div>

            <p class="dict-group-label">Key-Value</p>
            <div class="stack-mini">
              <div class="mini-row"><span><code>kv_get</code></span><span>Get a value by key.</span></div>
              <div class="mini-row"><span><code>kv_set</code></span><span>Set a key visible to all instances.</span></div>
              <div class="mini-row"><span><code>kv_delete</code></span><span>Delete a key.</span></div>
              <div class="mini-row"><span><code>kv_list</code></span><span>List keys, optionally filtered by prefix.</span></div>
            </div>
          </article>

          <!-- CLI Commands -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>CLI Commands</h3>
                <p>Run from any shell. Useful when you can't speak MCP — scripts, CI, operator terminal.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span><code>inspect</code></span><span>Unified dump: instances, tasks, KV, locks, recent messages.</span></div>
              <div class="mini-row"><span><code>messages</code></span><span>Peek at messages without marking read.</span></div>
              <div class="mini-row"><span><code>send --to &lt;id&gt;</code></span><span>Send a message as a specific instance.</span></div>
              <div class="mini-row"><span><code>broadcast</code></span><span>Message all instances in scope.</span></div>
              <div class="mini-row"><span><code>kv get/set/del/list</code></span><span>Key-value operations.</span></div>
              <div class="mini-row"><span><code>lock / unlock</code></span><span>File lock operations.</span></div>
              <div class="mini-row"><span><code>ui spawn</code></span><span>Enqueue a new node on the running canvas.</span></div>
              <div class="mini-row"><span><code>ui prompt</code></span><span>Send a prompt to an agent's terminal.</span></div>
              <div class="mini-row"><span><code>ui move</code></span><span>Move a node to XY coordinates. Persists to layout.</span></div>
              <div class="mini-row"><span><code>ui organize</code></span><span>Reorganize nodes (currently: <code>--kind grid</code>).</span></div>
              <div class="mini-row"><span><code>ui list</code></span><span>List queued/running/completed UI commands.</span></div>
              <div class="mini-row"><span><code>--scope, --as, --json</code></span><span>Pin scope; act as instance; machine-readable output.</span></div>
            </div>
          </article>

          <!-- Keyboard Shortcuts -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Keyboard Shortcuts</h3>
                <p>Available in the canvas view.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span><code>⌘N</code></span><span>Open launcher / spawn new node.</span></div>
              <div class="mini-row"><span><code>⌘W</code></span><span>Close selected node. No selection → quit app.</span></div>
              <div class="mini-row"><span><code>⌘⇧H</code></span><span>Return to Home.</span></div>
              <div class="mini-row"><span><code>⌘⇧]</code></span><span>Cycle to next node.</span></div>
              <div class="mini-row"><span><code>⌘⇧[</code></span><span>Cycle to previous node.</span></div>
              <div class="mini-row"><span><code>⌘⇧M</code></span><span>Toggle compact mode on focused/selected node.</span></div>
              <div class="mini-row"><span><code>⌘⇧F</code></span><span>Open fullscreen workspace for selected node.</span></div>
              <div class="mini-row"><span><code>⌘,</code></span><span>Open Settings modal.</span></div>
            </div>
          </article>

          <!-- Task Statuses -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Task Statuses</h3>
                <p>Lifecycle of a task through the coordination system.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span><code>open</code></span><span>Ready to be claimed.</span></div>
              <div class="mini-row"><span><code>claimed</code></span><span>Reserved by an instance; not yet started.</span></div>
              <div class="mini-row"><span><code>in_progress</code></span><span>Actively being worked on.</span></div>
              <div class="mini-row"><span><code>blocked</code></span><span>Waiting on upstream tasks. Auto-unblocks when all <code>depends_on</code> tasks complete.</span></div>
              <div class="mini-row"><span><code>approval_required</code></span><span>Gated — must be approved via <code>approve_task</code> before work begins.</span></div>
              <div class="mini-row"><span><code>done</code></span><span>Completed successfully. Cleaned up after 24h.</span></div>
              <div class="mini-row"><span><code>failed</code></span><span>Marked failed. Downstream <code>depends_on</code> tasks are auto-cancelled.</span></div>
              <div class="mini-row"><span><code>cancelled</code></span><span>Cancelled manually or by upstream failure cascade.</span></div>
            </div>
          </article>

          <!-- Auto-cleanup TTLs -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Auto-Cleanup TTLs</h3>
                <p>How long things live in the shared database.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span>Stale instances</span><span>30s (no heartbeat)</span></div>
              <div class="mini-row"><span>Messages</span><span>1 hour</span></div>
              <div class="mini-row"><span>Done/failed/cancelled tasks</span><span>24 hours</span></div>
              <div class="mini-row"><span>Non-lock annotations</span><span>24 hours</span></div>
              <div class="mini-row"><span>Lock annotations</span><span>Cleared when session expires or deregisters</span></div>
            </div>
          </article>

          <!-- Settings Fields -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Settings Reference</h3>
                <p>Fields in the Settings modal and Home's Start panel.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span>Starting Location</span><span>Default working directory for new nodes. Required before Start Fresh.</span></div>
              <div class="mini-row"><span>Default Harness</span><span>The command launched in new PTY nodes (<code>flux</code>, <code>codex</code>, <code>shell</code>, etc.).</span></div>
              <div class="mini-row"><span>Default Role</span><span>Label token appended to new node labels on spawn (e.g. <code>role:planner</code>).</span></div>
              <div class="mini-row"><span>Channel Override</span><span>Pin the next Start Fresh to an explicit channel string instead of minting a fresh timestamped one.</span></div>
              <div class="mini-row"><span>Harness Aliases</span><span>Shell commands auto-typed into a PTY when a harness-backed node starts. Edit in Settings when paths change.</span></div>
              <div class="mini-row"><span>Theme Profile</span><span>Built-in palette for chrome and terminal colours. See-through and blur are independently overridable.</span></div>
              <div class="mini-row"><span>Default Home Section</span><span>Which section opens first when you return to Home.</span></div>
            </div>
          </article>

        </div>
      {:else if activeSection === 'about'}
        <div class="content-grid">

          <!-- Hero -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>The Swarm Project</h3>
                <p>A coordination layer for running multiple AI coding agents side-by-side on the same machine.</p>
              </div>
              <span class="status-chip muted">local-first</span>
            </div>
            <div class="stack-mini">
              <div class="mini-row">
                <span>Core idea</span>
                <span>Multiple coding-agent sessions (Claude Code, Codex, opencode…) share a single SQLite database and a simple message-passing protocol. Agents can discover each other, exchange messages, delegate tasks, coordinate file locks, and leave annotations — without any cloud infrastructure.</span>
              </div>
              <div class="mini-row">
                <span>No daemon</span>
                <span>Each agent session spawns its own MCP server process via stdio. They all share one SQLite file at <code>~/.swarm-mcp/swarm.db</code> using WAL mode + busy timeout. No central service to keep running.</span>
              </div>
              <div class="mini-row">
                <span>Roles are conventions</span>
                <span>The server doesn't enforce planner/implementer semantics. Agents learn them through <code>AGENTS.md</code>, the bundled skill, or a prompt. Labels are free-form text tokens.</span>
              </div>
            </div>
          </article>

          <!-- swarm-mcp -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>swarm-mcp</h3>
                <p>The MCP server. Each coding-agent host runs one per session, connected via stdio.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span>What it does</span><span>Exposes coordination primitives as MCP tools: registration, messaging, task delegation, file locks, annotations, and shared KV.</span></div>
              <div class="mini-row"><span>How it runs</span><span>Standalone TypeScript process started by the host (<code>bun run src/index.ts</code> or <code>dist/*.js</code> under Node 20+).</span></div>
              <div class="mini-row"><span>Database</span><span><code>~/.swarm-mcp/swarm.db</code> by default. Override with <code>SWARM_DB_PATH</code>. All sessions share one file; SQLite WAL + 3s busy timeout handles concurrent writes.</span></div>
              <div class="mini-row"><span>Heartbeat</span><span>10s interval. Instance rows expire after 30s without one. A fresh <code>register</code> call will reuse the same scope/directory.</span></div>
              <div class="mini-row"><span>Notifications</span><span>5s background poller updates <code>swarm://inbox</code>, <code>swarm://tasks</code>, and <code>swarm://instances</code> for hosts that support resource update notifications.</span></div>
              <div class="mini-row"><span>CLI</span><span>Same binary, non-MCP subcommands. Useful from scripts, CI, or any terminal that can't speak MCP.</span></div>
              <div class="mini-row"><span>MCP Prompts</span><span><code>swarm:setup</code> — guides through registration. <code>swarm:protocol</code> — applies the recommended coordination workflow for the session.</span></div>
            </div>
          </article>

          <!-- swarm-ui -->
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>swarm-ui</h3>
                <p>The Tauri desktop app — this window. A live graph canvas over the running swarm.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span>Canvas</span><span>SvelteFlow graph where each node is a PTY terminal. Edges show message flows and task relationships. Nodes are draggable; layout persists per scope.</span></div>
              <div class="mini-row"><span>Nodes</span><span>Each node holds a PTY running a harness command. Terminal surfaces persist across resize, compact toggle, and fullscreen — no remount, no lost history.</span></div>
              <div class="mini-row"><span>Sidebar</span><span>Three tabs: <em>Launch</em> (spawn nodes), <em>Chat</em> (operator broadcast + live message feed), <em>Inspect</em> (selected node/edge details).</span></div>
              <div class="mini-row"><span>UI commands</span><span>swarm-ui polls a <code>ui_commands</code> table. The <code>swarm-mcp ui *</code> CLI subcommands enqueue work there, letting scripts drive the canvas from outside the app.</span></div>
              <div class="mini-row"><span>Channels</span><span>The active channel determines which instances appear on the canvas. Switch from Home → Sessions &amp; Layouts. Canvas layout is channel-specific too.</span></div>
              <div class="mini-row"><span>Close paths</span><span><code>closePty</code> = graceful PTY exit. <code>deregisterInstance</code> = drop stale/offline row. <code>killInstance</code> (red icon) = SIGTERM/SIGKILL the process + cascade row deletion. Use kill for externally-adopted or stuck instances.</span></div>
            </div>
          </article>

          <!-- Data Flow -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Data Flow</h3>
                <p>How the pieces connect at runtime.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span>Agent session</span><span>Calls <code>register</code> → gets a UUID. Heartbeats every 10s. Calls <code>poll_messages</code> + <code>list_tasks</code> to stay in sync. Coordinates via message/task/lock tools.</span></div>
              <div class="mini-row"><span>swarm-ui</span><span>Polls the same SQLite DB on a tight loop (Tauri Rust side). Forwards state to the Svelte frontend via Tauri events. Writes back layout and UI commands through invoke handlers.</span></div>
              <div class="mini-row"><span>CLI</span><span>Reads/writes the same DB directly. Useful for scripting or inspecting swarm state from outside any agent or UI session.</span></div>
              <div class="mini-row"><span>Shared DB</span><span>Single source of truth. WAL mode means readers don't block writers. All primitives (messages, tasks, locks, KV, instances, layout) live in one file.</span></div>
              <div class="mini-row"><span>MCP resources</span><span><code>swarm://inbox</code>, <code>swarm://tasks</code>, <code>swarm://instances</code>, and <code>swarm://context?file=…</code> are live views into the DB, refreshed by the background poller.</span></div>
            </div>
          </article>

          <!-- Docs -->
          <article class="panel-card panel-card--wide">
            <div class="card-heading">
              <div>
                <h3>Docs &amp; Conventions</h3>
                <p>Reference docs shipped with the project under <code>docs/</code>.</p>
              </div>
            </div>
            <div class="stack-mini">
              <div class="mini-row"><span><code>getting-started.md</code></span><span>First-run walkthrough — install, config, first register, verify cross-agent messaging.</span></div>
              <div class="mini-row"><span><code>roles-and-teams.md</code></span><span>Role conventions, multi-team workflows, DAG patterns, termination protocol, and AGENTS.md snippets.</span></div>
              <div class="mini-row"><span><code>agents-planner.md</code></span><span>Drop-in AGENTS.md for planner sessions (plans work, delegates, reviews results).</span></div>
              <div class="mini-row"><span><code>agents-implementer.md</code></span><span>Drop-in AGENTS.md for implementer sessions (claims tasks, edits code, sends back for review).</span></div>
              <div class="mini-row"><span><code>generic-AGENTS.md</code></span><span>Generalist AGENTS.md — no role specialization.</span></div>
              <div class="mini-row"><span><code>install-skill.md</code></span><span>Host-specific install paths for the bundled swarm skill.</span></div>
              <div class="mini-row"><span><code>skills/swarm-mcp</code></span><span>Installable skill — stronger per-session coordination guidance than AGENTS.md alone.</span></div>
            </div>
          </article>

        </div>
      {:else}
        <div class="content-grid settings-grid">
          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Current Defaults</h3>
                <p>What the next Home entry and in-canvas launcher are currently set up to use.</p>
              </div>
            </div>

            <div class="stack-mini">
              <div class="mini-row">
                <span>Starting location</span>
                <span class="mono">{selectedDirectory || 'Not set'}</span>
              </div>
              <div class="mini-row">
                <span>Default harness</span>
                <span>{harness || 'shell'}</span>
              </div>
              <div class="mini-row">
                <span>Default role</span>
                <span>{role || 'No role'}</span>
              </div>
              <div class="mini-row">
                <span>Launcher channel override</span>
                <span>{$startupPreferences.launchDefaults.scope || 'Follow active channel'}</span>
              </div>
            </div>
          </article>

          <article class="panel-card panel-card--accent">
            <div class="card-heading">
              <div>
                <h3>Standard Settings</h3>
                <p>Theme profile, harness aliases, startup defaults, and deeper recovery controls live in the settings modal.</p>
              </div>
            </div>
            <div class="flow-list">
              <div class="flow-step">
                <span class="flow-index">1</span>
                <div>
                  <strong>Theme profile</strong>
                  <p>Built-in chrome and terminal palettes with separate see-through and blur overrides.</p>
                </div>
              </div>
              <div class="flow-step">
                <span class="flow-index">2</span>
                <div>
                  <strong>Harness commands</strong>
                  <p>Real alias paths for Claude, Codex, and any other configured harness.</p>
                </div>
              </div>
              <div class="flow-step">
                <span class="flow-index">3</span>
                <div>
                  <strong>Recovery controls</strong>
                  <p>Bulk stale cleanup, orphan sweeps, recent history, and diagnostics.</p>
                </div>
              </div>
            </div>
            <button class="primary-btn" type="button" on:click={openSettings}>Open Settings</button>
          </article>
        </div>
      {/if}

      {#if diagnosticsMessage && activeSection !== 'diagnostics'}
        <p class="message-text">{diagnosticsMessage}</p>
      {/if}
    </section>
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
          <div class="project-modal-title-row">
            {#if projectCreateMode !== 'choose'}
              <button class="icon-btn" type="button" aria-label="Back to project choices" on:click={() => openProjectCreateModal('choose')}>
                ‹
              </button>
            {/if}
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
                  ? 'A project keeps roots, notes, files, and agent membership together without moving live agents.'
                  : projectCreateMode === 'scratch'
                    ? 'Name the context and pick the folder path agents should treat as the project root.'
                    : 'Point swarm-ui at a folder you already work from.'}
              </p>
            </div>
          </div>
          <button class="icon-btn" type="button" aria-label="Close project dialog" on:click={closeProjectCreateModal}>×</button>
        </header>

        {#if projectCreateMode === 'choose'}
          <div class="project-choice-list">
            <button class="project-choice" type="button" on:click={() => openProjectCreateModal('scratch')}>
              <span class="project-choice-icon">+</span>
              <span>
                <strong>Start from scratch</strong>
                <small>Set up a new project context with a suggested folder.</small>
              </span>
              <em>›</em>
            </button>
            <button class="project-choice" type="button" disabled title="Import will need a separate chat/project importer.">
              <span class="project-choice-icon">I</span>
              <span>
                <strong>Import project</strong>
                <small>Bring in external project metadata later.</small>
              </span>
              <em>later</em>
            </button>
            <button class="project-choice" type="button" on:click={() => openProjectCreateModal('existing')}>
              <span class="project-choice-icon">F</span>
              <span>
                <strong>Use an existing folder</strong>
                <small>Turn the selected working directory into a project space.</small>
              </span>
              <em>›</em>
            </button>
          </div>
        {:else}
          <div class="project-modal-body">
            <div class="form-field">
              <label for="draft-project-name">Name</label>
              <input
                id="draft-project-name"
                class="text-input"
                type="text"
                placeholder="Project name"
                value={draftProjectName}
                on:input={handleDraftProjectNameInput}
              />
            </div>

            <div class="form-field">
              <label for="draft-project-root">Project root</label>
              <input
                id="draft-project-root"
                class="text-input mono"
                type="text"
                placeholder={defaultProjectRoot || '/Users/you/Desktop/project'}
                value={draftProjectRoot}
                on:input={handleDraftProjectRootInput}
              />
            </div>

            <div class="form-field">
              <label for="draft-project-notes">Instructions / notes</label>
              <textarea
                id="draft-project-notes"
                class="text-input text-area"
                rows="5"
                placeholder="Optional project context, constraints, or handoff notes."
                bind:value={draftProjectNotes}
              ></textarea>
            </div>

            {#if projectError}
              <p class="error-text">{projectError}</p>
            {/if}

            <div class="modal-actions">
              <button class="ghost-btn" type="button" on:click={closeProjectCreateModal}>Cancel</button>
              <button
                class="primary-btn"
                type="button"
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
</div>

<style>
  /* ---------------------------------------------------------------------------
   * StartupHome — minimalist restyle.
   * Flat surfaces, 12px radius matching .terminal-node, no radial gradients,
   * no gradient buttons, tighter spacing so the layout stays open and calm.
   * --------------------------------------------------------------------------- */

  .home-overlay {
    position: absolute;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: stretch;
    justify-content: center;
    padding: 20px;
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 92%, black);
    backdrop-filter: blur(var(--surface-blur, 20px));
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px));
  }

  .home-shell {
    width: min(1280px, 100%);
    min-height: 100%;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 16px;
  }

  .home-nav,
  .home-content {
    border: 1px solid var(--node-border, #1a1a1a);
    background: var(--node-header-bg, #2d2d2d);
    border-radius: 12px;
  }

  .home-nav {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 20px 16px;
    gap: 20px;
  }

  .nav-top {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .brand-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .brand-block h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--terminal-fg, #d4d4d4);
  }

  .content-header h2,
  .panel-card h3,
  .scope-card h3,
  .empty-card h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
  }

  .eyebrow {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #d4d4d4) 50%, transparent);
  }

  .field-hint,
  .hint-line,
  .panel-card p,
  .scope-card p,
  .empty-card p {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: color-mix(in srgb, var(--terminal-fg) 60%, transparent);
  }

  .section-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-resource-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 58%, transparent);
  }

  .nav-group-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 58%, transparent);
    color: var(--terminal-fg, #d4d4d4);
    padding: 8px 10px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .nav-group-toggle:hover,
  .nav-group-toggle.active {
    background: color-mix(in srgb, var(--terminal-bg) 78%, transparent);
    border-color: color-mix(in srgb, var(--status-pending) 44%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .nav-chevron {
    display: inline-flex;
    transform: rotate(0deg);
    transition: transform 0.12s ease;
  }

  .nav-chevron.open {
    transform: rotate(90deg);
  }

  .resource-nav-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .resource-nav-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 4px;
    border: 1px solid transparent;
    border-radius: 8px;
  }

  .resource-nav-row.active {
    background: color-mix(in srgb, var(--terminal-bg) 88%, transparent);
    border-color: color-mix(in srgb, var(--status-pending) 36%, transparent);
  }

  .resource-nav-main,
  .resource-add-btn {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }

  .resource-nav-main {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    text-align: left;
  }

  .resource-nav-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .resource-add-btn {
    width: 26px;
    height: 26px;
    margin-right: 4px;
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
  }

  .resource-add-btn:hover {
    color: var(--terminal-fg, #d4d4d4);
    border-color: color-mix(in srgb, var(--status-pending) 52%, transparent);
  }

  .soon-label {
    border: 1px solid color-mix(in srgb, var(--node-border) 72%, transparent);
    border-radius: 999px;
    padding: 1px 5px;
    color: color-mix(in srgb, var(--terminal-fg) 46%, transparent);
    font-size: 9px;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .section-nav button,
  .chip,
  .primary-btn,
  .ghost-btn,
  .inline-btn,
  .icon-btn {
    font: inherit;
  }

  .section-nav > button {
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    text-align: left;
    padding: 8px 10px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .section-nav > button:hover {
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .section-nav > button.active {
    background: color-mix(in srgb, var(--terminal-bg) 90%, transparent);
    border-color: color-mix(in srgb, var(--status-pending) 36%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .nav-icon {
    width: 20px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: color-mix(in srgb, var(--status-pending) 78%, var(--terminal-fg));
  }

  .nav-label {
    font-size: 13px;
    font-weight: 500;
  }

  .nav-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--node-border) 72%, transparent);
  }

  .nav-stat {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 2px;
  }

  .stat-value {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 14px;
    color: var(--terminal-fg, #d4d4d4);
  }

  .stat-label {
    font-size: 11px;
    color: color-mix(in srgb, var(--terminal-fg) 54%, transparent);
  }

  .home-content {
    padding: 20px 22px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .content-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .content-header h2 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .header-chip {
    border: 1px solid color-mix(in srgb, var(--node-border) 80%, transparent);
    border-radius: 6px;
    padding: 3px 8px;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .summary-strip {
    display: flex;
    gap: 16px;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--node-border) 80%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
    flex-wrap: wrap;
  }

  .summary-item {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: color-mix(in srgb, var(--terminal-fg) 60%, transparent);
  }

  .summary-item em {
    font-style: normal;
    font-weight: 600;
    color: var(--terminal-fg, #d4d4d4);
  }

  .content-grid,
  .metrics-grid,
  .settings-grid {
    display: grid;
    gap: 14px;
  }

  .start-grid {
    min-height: min(62vh, 680px);
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(280px, 0.95fr);
    gap: 14px;
    align-items: stretch;
  }

  .start-command-panel,
  .frazier-start-card {
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--terminal-fg) 6%, transparent),
      0 24px 70px rgba(0, 0, 0, 0.28);
  }

  .start-command-panel {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 28px;
    padding: 34px;
  }

  .start-copy,
  .frazier-start-copy {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .start-kicker {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--status-pending) 74%, var(--terminal-fg));
  }

  .start-copy h3,
  .frazier-start-copy h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
    font-weight: 650;
    letter-spacing: 0;
  }

  .start-copy h3 {
    max-width: 680px;
    font-size: 46px;
    line-height: 1.02;
  }

  .start-copy p,
  .frazier-start-copy p {
    margin: 0;
    max-width: 620px;
    color: color-mix(in srgb, var(--terminal-fg) 64%, transparent);
    font-size: 13px;
    line-height: 1.5;
  }

  .start-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .start-loop-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .start-loop-strip span {
    min-height: 36px;
    display: flex;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-left: 3px solid color-mix(in srgb, var(--status-pending) 72%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 68%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 74%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    line-height: 1.25;
    padding: 7px 9px;
  }

  .start-secondary-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .frazier-start-card {
    display: grid;
    grid-template-rows: minmax(220px, 1fr) auto;
    overflow: hidden;
  }

  .frazier-preview {
    position: relative;
    min-height: 0;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    background: #000;
    color: var(--terminal-fg, #d4d4d4);
    padding: 0;
    cursor: pointer;
    overflow: hidden;
  }

  .frazier-preview img {
    width: 100%;
    height: 100%;
    min-height: 220px;
    object-fit: cover;
    opacity: 0.86;
    filter: saturate(0.96) contrast(1.08);
    transition: transform 0.18s ease, opacity 0.18s ease;
  }

  .frazier-preview:hover img {
    transform: scale(1.025);
    opacity: 0.96;
  }

  .frazier-preview-glass {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    text-align: left;
  }

  .frazier-preview-glass strong {
    min-width: 0;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .frazier-preview-glass strong span {
    color: color-mix(in srgb, #ffd94a 82%, var(--terminal-fg));
  }

  .frazier-preview-glass small {
    flex: 0 0 auto;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-size: 10px;
    text-transform: uppercase;
  }

  .frazier-start-copy {
    padding: 18px;
  }

  .frazier-start-copy h3 {
    font-size: 20px;
    line-height: 1.05;
  }

  .content-grid,
  .settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .panel-card,
  .scope-card,
  .empty-card {
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--terminal-bg) 52%, transparent);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    min-width: 0;
  }

  .panel-card--hero {
    min-height: 0;
  }

  .panel-card--accent,
  .panel-card--wide {
    grid-column: 1 / -1;
  }

  .card-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .card-heading h3,
  .scope-card-header h3,
  .empty-card h3 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  .agents-overhaul-card {
    gap: 16px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--status-online, #00f060) 11%, transparent), transparent 46%),
      color-mix(in srgb, var(--terminal-bg) 56%, transparent);
  }

  .agents-overhaul-heading {
    align-items: start;
  }

  .agents-overhaul-heading h3 {
    margin-top: 6px;
    font-size: clamp(22px, 3vw, 34px);
    line-height: 1;
  }

  .agents-overhaul-scope {
    min-width: min(360px, 100%);
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px 10px;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--node-border) 68%, transparent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    padding: 10px;
  }

  .agents-overhaul-scope span,
  .agents-slice-card div span,
  .agents-slice-card div em,
  .agents-stage-list summary span,
  .agents-archive-grid span {
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-style: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .agents-overhaul-scope code {
    min-width: 0;
    overflow-wrap: anywhere;
    color: color-mix(in srgb, var(--status-pending, #89b4fa) 78%, var(--terminal-fg));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }

  .agents-plan-spine {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 8px;
  }

  .agents-plan-spine span {
    min-height: 34px;
    display: flex;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--status-online, #00f060) 38%, transparent);
    border-left: 3px solid var(--status-online, #00f060);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.24);
    color: var(--terminal-fg, #d4d4d4);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    padding: 7px 10px;
  }

  .agents-slice-grid,
  .agents-archive-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 10px;
  }

  .agents-slice-card,
  .agents-archive-grid section,
  .agents-stage-list details,
  .agents-north-star li {
    border: 1px solid color-mix(in srgb, var(--node-border) 68%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 58%, transparent);
  }

  .agents-slice-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-left: 3px solid var(--status-online, #00f060);
    padding: 12px;
  }

  .agents-slice-card--next {
    border-left-color: var(--status-pending, #89b4fa);
  }

  .agents-slice-card--done {
    border-left-color: var(--status-online, #00f060);
  }

  .agents-slice-card--follow-up {
    border-left-color: var(--status-warning, #f9e2af);
  }

  .agents-slice-card div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .agents-slice-card strong,
  .agents-stage-list summary strong,
  .agents-archive-grid strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 13px;
  }

  .agents-slice-card ul {
    margin: 0;
    padding-left: 18px;
  }

  .agents-slice-card li,
  .agents-stage-list p,
  .agents-stage-list small,
  .agents-archive-grid p,
  .agents-north-star li {
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-size: 12px;
    line-height: 1.45;
  }

  .agents-stage-list {
    display: grid;
    gap: 8px;
  }

  .agents-stage-list details {
    padding: 10px 12px;
  }

  .agents-stage-list summary {
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    cursor: pointer;
  }

  .agents-stage-list p,
  .agents-stage-list small {
    display: block;
    margin: 8px 0 0 80px;
  }

  .agents-north-star {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .agents-north-star li {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 7px 10px;
  }

  .agents-north-star span {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--status-online, #00f060) 42%, transparent);
    border-radius: 999px;
    color: var(--status-online, #00f060);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
  }

  .agents-archive-grid section {
    border-left: 3px solid var(--status-pending, #89b4fa);
    padding: 12px;
  }

  .agents-archive-grid span {
    display: block;
    margin: 4px 0 6px;
    color: color-mix(in srgb, var(--status-pending, #89b4fa) 82%, var(--terminal-fg));
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .card-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    display: block;
    margin-bottom: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
  }

  .text-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--node-border) 82%, transparent);
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--terminal-bg, #1e1e1e);
    color: var(--terminal-fg, #d4d4d4);
    outline: none;
    font-size: 13px;
  }

  .text-input:focus {
    border-color: color-mix(in srgb, var(--status-pending) 60%, transparent);
  }

  .mono,
  code {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  .scope-card p.mono,
  .session-copy p.mono {
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .inline-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .chip-row,
  .scope-actions,
  .session-title-row,
  .pill-row,
  .token-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .chip,
  .status-chip,
  .meta-pill {
    border-radius: 6px;
    padding: 3px 7px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.04em;
  }

  .chip {
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    cursor: pointer;
  }

  .chip:hover {
    color: var(--terminal-fg, #d4d4d4);
    border-color: color-mix(in srgb, var(--status-pending) 40%, transparent);
  }

  .chip--path {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-chip,
  .meta-pill {
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 68%, transparent);
  }

  .status-chip.pending {
    border-color: color-mix(in srgb, var(--status-pending) 54%, transparent);
    color: var(--status-pending);
  }

  .status-chip.warn,
  .status-chip.stale {
    border-color: color-mix(in srgb, var(--status-stale) 54%, transparent);
    color: var(--status-stale);
  }

  .status-chip.offline,
  .status-chip.muted {
    color: var(--status-offline);
  }

  .status-chip.online {
    border-color: color-mix(in srgb, var(--status-online) 54%, transparent);
    color: var(--status-online);
  }

  .meta-pill.pulse {
    border-color: color-mix(in srgb, var(--status-pending) 54%, transparent);
    color: color-mix(in srgb, var(--status-pending) 90%, white 8%);
  }

  .primary-btn,
  .ghost-btn,
  .inline-btn,
  .icon-btn {
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .primary-btn,
  .ghost-btn {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
  }

  .primary-btn {
    border: 1px solid color-mix(in srgb, var(--status-pending) 60%, transparent);
    background: color-mix(in srgb, var(--status-pending) 18%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .primary-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--status-pending) 28%, transparent);
    border-color: color-mix(in srgb, var(--status-pending) 78%, transparent);
  }

  .primary-btn--sm {
    padding: 5px 10px;
    font-size: 12px;
  }

  .primary-btn--large {
    padding: 12px 18px;
    font-size: 14px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }

  .ghost-btn--large {
    padding: 12px 18px;
    font-size: 14px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }

  .ghost-btn,
  .inline-btn {
    border: 1px solid color-mix(in srgb, var(--node-border) 80%, transparent);
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 82%, transparent);
  }

  .ghost-btn:hover:not(:disabled),
  .inline-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    color: var(--terminal-fg, #d4d4d4);
    border-color: color-mix(in srgb, var(--status-pending) 40%, transparent);
  }

  .ghost-btn--danger,
  .inline-btn--danger {
    color: color-mix(in srgb, var(--edge-task-failed) 90%, var(--terminal-fg));
  }

  .ghost-btn--danger:hover:not(:disabled),
  .inline-btn--danger:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--edge-task-failed) 64%, transparent);
    background: color-mix(in srgb, var(--edge-task-failed) 14%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 96%, white 8%);
  }

  .inline-btn {
    padding: 5px 10px;
    font-size: 12px;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 14px;
    line-height: 1;
    border: 1px solid color-mix(in srgb, var(--node-border) 80%, transparent);
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 70%, transparent);
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--terminal-fg, #d4d4d4);
    border-color: color-mix(in srgb, var(--status-pending) 40%, transparent);
  }

  .icon-btn--danger:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--edge-task-failed) 58%, transparent);
    background: color-mix(in srgb, var(--edge-task-failed) 18%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 98%, white 6%);
  }

  .primary-btn:disabled,
  .ghost-btn:disabled,
  .inline-btn:disabled,
  .icon-btn:disabled {
    opacity: 0.48;
    cursor: default;
  }

  .scope-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--node-border) 68%, transparent);
  }

  .toolbar-spacer {
    flex: 1 1 auto;
  }

  .stack-list,
  .session-list,
  .stack-mini,
  .alias-list,
  .flow-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }

  .resource-choice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
    gap: 8px;
  }

  .resource-choice,
  .project-tile,
  .project-choice {
    width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    cursor: pointer;
    font: inherit;
    text-align: left;
    padding: 10px;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .resource-choice:hover:not(:disabled),
  .project-tile:hover,
  .project-choice:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--status-pending) 48%, transparent);
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .resource-choice.active,
  .project-tile:focus-visible,
  .project-choice:focus-visible {
    border-color: color-mix(in srgb, var(--status-pending) 68%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--status-pending) 18%, transparent);
    outline: none;
  }

  .resource-choice.disabled {
    opacity: 0.58;
  }

  .resource-choice--add {
    border-style: dashed;
  }

  .resource-choice-icon,
  .project-choice-icon {
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 6px;
    color: var(--terminal-fg, #d4d4d4);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    font-weight: 700;
  }

  .resource-choice-icon--image {
    overflow: hidden;
    background: #050505;
  }

  .resource-choice-icon--image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.95;
  }

  .resource-choice span:not(.resource-choice-icon),
  .project-choice span:not(.project-choice-icon),
  .project-tile > span:first-child {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .resource-choice strong,
  .project-choice strong,
  .project-tile strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 12px;
    font-weight: 600;
  }

  .resource-choice small,
  .project-choice small,
  .project-tile small {
    min-width: 0;
    color: color-mix(in srgb, var(--terminal-fg) 56%, transparent);
    font-size: 10.5px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .resource-choice em,
  .project-choice em {
    margin-left: auto;
    color: color-mix(in srgb, var(--terminal-fg) 48%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-style: normal;
    text-transform: uppercase;
  }

  .project-grid--chooser {
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  }

  .project-tile {
    min-height: 116px;
    flex-direction: column;
    align-items: stretch;
    justify-content: space-between;
  }

  .project-tile--add {
    justify-content: center;
    border-style: dashed;
  }

  .resource-preview {
    max-width: 760px;
  }

  .browser-bridge-card {
    max-width: none;
  }

  .browser-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .browser-url-row {
    display: grid;
    gap: 8px;
  }

  .browser-url-row .text-input {
    width: 100%;
  }

  .browser-context-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 10px;
  }

  .browser-context-card {
    min-width: 0;
    min-height: 112px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--terminal-bg) 60%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 76%, transparent);
    cursor: pointer;
    font: inherit;
    text-align: left;
    padding: 10px;
  }

  .browser-context-card:hover,
  .browser-context-card.active {
    border-color: color-mix(in srgb, var(--status-online) 58%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--status-online) 18%, transparent);
  }

  .browser-context-card strong,
  .browser-context-card small,
  .browser-context-card em {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-context-card strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 12px;
    font-weight: 700;
  }

  .browser-context-card small,
  .browser-context-card em {
    color: color-mix(in srgb, var(--terminal-fg) 54%, transparent);
    font-size: 10px;
    font-style: normal;
  }

  .browser-status {
    border: 1px solid currentColor;
    border-radius: 999px;
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    text-transform: uppercase;
  }

  .browser-status--open {
    color: var(--status-online, #a6e3a1);
  }

  .browser-status--closed {
    color: var(--status-offline, #f38ba8);
  }

  .browser-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }

  .browser-detail-column {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .browser-detail-column > strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 12px;
    font-weight: 700;
  }

  .browser-detail-column > span {
    color: color-mix(in srgb, var(--terminal-fg) 56%, transparent);
    font-size: 11px;
  }

  .browser-row {
    min-width: 0;
    display: grid;
    gap: 3px;
    border: 1px solid color-mix(in srgb, var(--node-border) 56%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--terminal-bg) 66%, transparent);
    padding: 8px;
  }

  .browser-row b,
  .browser-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-row b {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 11px;
    font-weight: 650;
  }

  .browser-row span {
    color: color-mix(in srgb, var(--terminal-fg) 52%, transparent);
    font-size: 10px;
  }

  .scope-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .session-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0 0;
    border-top: 1px solid color-mix(in srgb, var(--node-border) 56%, transparent);
  }

  .session-row:first-child {
    border-top: none;
    padding-top: 2px;
  }

  .session-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 12px;
  }

  .session-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 4px;
    flex-wrap: wrap;
  }

  .metrics-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .metrics-grid div {
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    border-radius: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
  }

  .metrics-grid span {
    display: block;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 18px;
    font-weight: 600;
    color: var(--terminal-fg, #d4d4d4);
  }

  .metric-label {
    margin-top: 2px;
    margin-bottom: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .alias-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--node-border) 72%, transparent);
    border-radius: 8px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
  }

  .alias-name {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
  }

  .alias-command {
    display: inline-block;
    max-width: min(100%, 680px);
    padding: 3px 8px;
    border-radius: 4px;
    background: var(--terminal-bg, #1e1e1e);
    color: var(--terminal-fg, #d4d4d4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }

  .mini-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 8px;
    font-size: 12px;
    border-top: 1px solid color-mix(in srgb, var(--node-border) 56%, transparent);
  }

	  .mini-row:first-child {
	    border-top: none;
	    padding-top: 0;
	  }

	  .flow-step {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 12px;
  }

  .flow-step strong {
    color: var(--terminal-fg, #d4d4d4);
  }

  .flow-index {
    width: 20px;
    height: 20px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--status-pending) 48%, transparent);
    background: transparent;
    color: var(--terminal-fg, #d4d4d4);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .scope-card--layout-only {
    background: color-mix(in srgb, var(--terminal-bg) 56%, transparent);
    border-style: dashed;
    border-color: color-mix(in srgb, var(--badge-planner) 36%, var(--node-border));
  }

  .message-text,
  .error-text {
    margin: 0;
    font-size: 12px;
  }

  .message-text {
    color: color-mix(in srgb, var(--status-online) 76%, white 12%);
  }

  .error-text {
    color: color-mix(in srgb, var(--edge-task-failed) 78%, white 8%);
  }

  .dict-group-label {
    margin: 10px 0 2px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg) 80%, transparent);
  }

  .dict-group-label:first-of-type {
    margin-top: 2px;
  }

  .project-modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.56);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
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
    border: 1px solid color-mix(in srgb, var(--node-border) 82%, transparent);
    border-radius: 12px;
    background: var(--node-header-bg, #2d2d2d);
    box-shadow: 0 24px 88px rgba(0, 0, 0, 0.58);
  }

  .project-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 18px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 72%, transparent);
  }

  .project-modal-title-row {
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .project-modal-header h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 19px;
    font-weight: 650;
  }

  .project-modal-header p {
    margin: 6px 0 0;
    max-width: 54ch;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
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
    min-height: 86px;
    padding: 12px;
  }

  .project-choice:disabled {
    cursor: default;
    opacity: 0.52;
  }

  .project-modal-body .form-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .text-area {
    min-height: 112px;
    resize: vertical;
    line-height: 1.45;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  @media (max-width: 1100px) {
    .home-shell {
      grid-template-columns: 1fr;
    }

    .start-grid {
      grid-template-columns: 1fr;
    }

    .start-loop-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .content-grid,
    .settings-grid,
    .metrics-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 780px) {
    .home-overlay {
      padding: 12px;
    }

    .content-grid,
    .settings-grid,
    .metrics-grid,
    .start-grid,
    .inline-grid {
      grid-template-columns: 1fr;
    }

    .content-header,
    .scope-card-header,
    .session-row,
    .footer-actions,
    .alias-row,
    .mini-row {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      justify-content: flex-start;
    }

    .start-copy h3 {
      font-size: 34px;
    }

    .start-loop-strip {
      grid-template-columns: 1fr;
    }

    .frazier-preview-glass {
      align-items: flex-start;
      flex-direction: column;
    }
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .home-overlay {
    --home-action-accent: #ffc412;
    --home-action-accent-rgb: 255, 196, 18;
    overflow: hidden;
    background: var(--bg-base, #000);
  }

  :global([data-theme="tron-encom-os"]) .home-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image: radial-gradient(rgba(216, 221, 230, 0.04) 1px, transparent 1.2px);
    background-size: 26px 26px;
  }

  :global([data-theme="tron-encom-os"]) .home-shell {
    position: relative;
    z-index: 1;
  }

  :global([data-theme="tron-encom-os"]) .home-nav,
  :global([data-theme="tron-encom-os"]) .home-content {
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    background: var(--bg-panel, #05070a);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 8px 1px rgba(255, 255, 255, 0.35),
      0 0 18px 2px rgba(255, 255, 255, 0.18),
      0 0 36px 6px rgba(255, 255, 255, 0.08),
      inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  }

  :global([data-theme="tron-encom-os"]) .brand-block h1,
  :global([data-theme="tron-encom-os"]) .content-header h2,
  :global([data-theme="tron-encom-os"]) .panel-card h3,
  :global([data-theme="tron-encom-os"]) .scope-card h3,
  :global([data-theme="tron-encom-os"]) .empty-card h3 {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
    font-weight: 600;
  }

  :global([data-theme="tron-encom-os"]) .brand-block h1 { font-size: 14px; }
  :global([data-theme="tron-encom-os"]) .content-header h2 { font-size: 13px; }
  :global([data-theme="tron-encom-os"]) .panel-card h3,
  :global([data-theme="tron-encom-os"]) .scope-card h3,
  :global([data-theme="tron-encom-os"]) .empty-card h3 { font-size: 12px; }

  :global([data-theme="tron-encom-os"]) .eyebrow,
  :global([data-theme="tron-encom-os"]) .stat-label,
  :global([data-theme="tron-encom-os"]) .header-chip,
  :global([data-theme="tron-encom-os"]) .summary-item {
    color: var(--fg-secondary, #8a94a0);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .panel-card,
  :global([data-theme="tron-encom-os"]) .scope-card,
  :global([data-theme="tron-encom-os"]) .empty-card {
    border: 1px solid var(--led-line-s, rgba(216, 221, 230, 0.45));
    border-radius: 0;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.006)),
      var(--node-bg, var(--bg-base, #000));
    box-shadow:
      inset 0 0 18px rgba(216, 221, 230, 0.02),
      0 0 16px rgba(255, 255, 255, 0.035);
  }

  :global([data-theme="tron-encom-os"]) .summary-strip {
    border: 1px solid var(--led-line, #d8dde6);
    background: var(--bg-panel, #05070a);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 8px 1px rgba(255, 255, 255, 0.28),
      0 0 18px 2px rgba(255, 255, 255, 0.12);
    border-radius: 0;
  }

  :global([data-theme="tron-encom-os"]) .header-chip {
    border-radius: 0;
    border: 1px solid var(--led-line, #d8dde6);
    background: var(--bg-panel, #05070a);
    color: #ffffff;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    font-size: 9.5px;
    padding: 3px 10px;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.3), 0 0 16px rgba(255, 255, 255, 0.1);
    text-shadow: 0 0 3px rgba(255, 255, 255, 0.3);
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button {
    position: relative;
    overflow: hidden;
    border-radius: 0;
    border: 1px solid transparent;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 10.5px;
    color: var(--fg-secondary, #8a94a0);
    transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button::before {
    content: '';
    position: absolute;
    left: -1px;
    top: 3px;
    bottom: 3px;
    width: 2px;
    background: #ffffff;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.9), 0 0 14px rgba(255, 255, 255, 0.4);
    opacity: 0;
    transition: opacity 0.14s ease;
  }

  :global([data-theme="tron-encom-os"]) .section-nav .nav-icon {
    color: var(--fg-secondary, #8a94a0);
    opacity: 0.82;
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button:hover {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02) 70%, transparent);
    border-color: rgba(255, 255, 255, 0.18);
    color: var(--fg-primary, #f5f7fa);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.18),
      0 0 14px rgba(255, 255, 255, 0.15),
      inset 0 0 18px rgba(255, 255, 255, 0.06);
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button:hover .nav-icon {
    color: #ffffff;
    opacity: 1;
    text-shadow: 0 0 3px rgba(255, 255, 255, 0.6);
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button.active {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.03) 70%, transparent);
    border-color: rgba(255, 255, 255, 0.25);
    color: #ffffff;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.25),
      0 0 20px rgba(255, 255, 255, 0.22),
      inset 0 0 24px rgba(255, 255, 255, 0.08);
    text-shadow: 0 0 3px rgba(255, 255, 255, 0.3);
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button.active .nav-icon {
    color: #ffffff;
    opacity: 1;
    text-shadow: 0 0 3px rgba(255, 255, 255, 0.6);
  }

  :global([data-theme="tron-encom-os"]) .section-nav > button.active::before,
  :global([data-theme="tron-encom-os"]) .section-nav > button:hover::before {
    opacity: 1;
  }

  :global([data-theme="tron-encom-os"]) .text-input,
  :global([data-theme="tron-encom-os"]) input[type="text"] {
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent),
      var(--node-header-bg, var(--bg-input, #02040a));
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .text-input:focus,
  :global([data-theme="tron-encom-os"]) input[type="text"]:focus {
    border-color: #ffffff;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.18),
      0 0 12px 2px rgba(255, 255, 255, 0.6),
      0 0 28px 4px rgba(255, 255, 255, 0.3);
    outline: none;
  }

  :global([data-theme="tron-encom-os"]) .primary-btn,
  :global([data-theme="tron-encom-os"]) .ghost-btn,
  :global([data-theme="tron-encom-os"]) .inline-btn,
  :global([data-theme="tron-encom-os"]) .icon-btn,
  :global([data-theme="tron-encom-os"]) .chip {
    border-radius: 0;
    border: 1px solid var(--led-line, #d8dde6);
    background: transparent;
    color: var(--fg-secondary, #8a94a0);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    font-size: 10px;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.06),
      0 0 6px 1px rgba(255, 255, 255, 0.22),
      0 0 14px 2px rgba(255, 255, 255, 0.1);
    transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
  }

  :global([data-theme="tron-encom-os"]) .primary-btn:hover,
  :global([data-theme="tron-encom-os"]) .ghost-btn:hover,
  :global([data-theme="tron-encom-os"]) .inline-btn:hover,
  :global([data-theme="tron-encom-os"]) .icon-btn:hover,
  :global([data-theme="tron-encom-os"]) .chip:hover {
    color: #ffffff;
    border-color: #ffffff;
    background: var(--bg-elevated, #0b0f14);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.18),
      0 0 12px 2px rgba(255, 255, 255, 0.6),
      0 0 28px 4px rgba(255, 255, 255, 0.3),
      0 0 56px 10px rgba(255, 255, 255, 0.14);
  }

  :global([data-theme="tron-encom-os"]) .primary-btn--start {
    border-color: var(--home-action-accent, #ffa94d);
    color: #ffd19a;
    text-shadow: 0 0 6px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.5);
    background:
      linear-gradient(180deg, rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.08), transparent 60%),
      var(--bg-panel, #05070a);
    box-shadow:
      0 0 0 1px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.35),
      0 0 10px 2px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.4),
      0 0 24px 4px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.2),
      inset 0 0 14px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.06);
  }

  :global([data-theme="tron-encom-os"]) .primary-btn--start:hover {
    color: #ffffff;
    border-color: #ffd9a8;
    background:
      linear-gradient(180deg, rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.14), transparent 60%),
      var(--bg-elevated, #0b0f14);
    box-shadow:
      0 0 0 1px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.5),
      0 0 16px 3px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.55),
      0 0 36px 6px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.28),
      inset 0 0 18px rgba(var(--home-action-accent-rgb, 255, 169, 77), 0.1);
  }

  :global([data-theme="tron-encom-os"]) .ghost-btn:not(.ghost-btn--danger) {
    border-color: var(--led-line-s, #6e7682);
    color: var(--fg-muted, #4a5260);
    box-shadow: none;
  }

  :global([data-theme="tron-encom-os"]) .ghost-btn:not(.ghost-btn--danger):hover {
    color: var(--fg-secondary, #8a94a0);
    border-color: var(--led-line, #d8dde6);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 8px 1px rgba(255, 255, 255, 0.35),
      0 0 18px 2px rgba(255, 255, 255, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .ghost-btn--danger {
    border-color: rgba(255, 90, 106, 0.55);
    color: var(--c-red, #ff3a4c);
    box-shadow: 0 0 6px rgba(255, 90, 106, 0.2);
  }

  :global([data-theme="tron-encom-os"]) .ghost-btn--danger:hover {
    background: rgba(255, 90, 106, 0.06);
    border-color: rgba(255, 90, 106, 0.8);
    box-shadow: 0 0 10px rgba(255, 90, 106, 0.35);
    color: #ff8a96;
  }

  :global([data-theme="tron-encom-os"]) .status-chip {
    border-radius: 0;
    border: 1px solid var(--led-line-s, rgba(216, 221, 230, 0.45));
    background: transparent;
    color: var(--fg-secondary, #8a94a0);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .status-chip.muted {
    border-color: color-mix(in srgb, var(--c-amber, #ffa94d) 38%, var(--led-line-s, rgba(216, 221, 230, 0.45)));
    color: color-mix(in srgb, var(--c-amber, #ffa94d) 60%, var(--fg-secondary, #8a94a0));
  }

  :global([data-theme="tron-encom-os"]) .summary-item em {
    color: #ffffff;
    text-shadow: 0 0 4px rgba(255, 255, 255, 0.45), 0 0 12px rgba(255, 255, 255, 0.18);
    font-style: normal;
    font-weight: 500;
  }

  :global([data-theme="tron-encom-os"]) .nav-footer {
    border-top: 1px solid var(--led-line-s, rgba(216, 221, 230, 0.45));
  }

  :global([data-theme="tron-encom-os"]) .stat-value {
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .error-text {
    color: var(--c-red, #ff3a4c);
  }

  @media (max-width: 1100px) {
    .home-overlay {
      align-items: flex-start;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .home-shell {
      min-height: auto;
    }

    .home-content {
      overflow: visible;
    }

    :global([data-theme="tron-encom-os"]) .home-overlay {
      overflow-y: auto;
      overflow-x: hidden;
    }
  }
</style>
