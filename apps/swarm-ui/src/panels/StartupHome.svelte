<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type {
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
  import { setScopeSelection } from '../stores/swarm';
  import { deregisterOfflineInstances, forceDeregisterInstance, killInstance, getRolePresets, respawnInstance } from '../stores/pty';
  import { confirm } from '../lib/confirm';
  import { harnessAliases, HARNESS_NAMES } from '../stores/harnessAliases';

  type HomeSection = 'start' | 'sessions' | 'agents' | 'diagnostics' | 'dictionary' | 'about' | 'settings';

  type HomeNavItem = {
    id: HomeSection;
    label: string;
    meta: string;
    icon: string;
  };

  type ScopeEntry = {
    scope: RecoveryScopeSummary;
    items: RecoverySessionItem[];
    hasLayout: boolean;
  };

  const dispatch = createEventDispatcher<{
    enterCanvas: void;
    openSettings: void;
  }>();

  const navItems: HomeNavItem[] = [
    { id: 'start', label: 'Start', meta: 'Blank canvas and shared defaults', icon: '◇' },
    { id: 'sessions', label: 'Sessions & Layouts', meta: 'Reopen, recover, or clear past scopes', icon: '◈' },
    { id: 'agents', label: 'Agents', meta: 'Saved personas, context, mission, and permissions', icon: '◉' },
    { id: 'diagnostics', label: 'Diagnostics', meta: 'Cleanup actions and harness visibility', icon: '◎' },
    { id: 'dictionary', label: 'Dictionary', meta: 'Terms, tools, commands, and settings reference', icon: '◫' },
    { id: 'about', label: 'About', meta: 'What swarm, swarm-mcp, and swarm-ui are', icon: '◐' },
    { id: 'settings', label: 'Settings', meta: 'Theme, startup, and recovery controls', icon: '◌' },
  ];

  let activeSection: HomeSection = 'start';
  let initializedSection = false;
  let rolePresets: RolePresetSummary[] = [];
  let startError: string | null = null;
  let diagnosticsMessage: string | null = null;
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
  let harness = '';
  let role = '';
  let startScopeOverride = '';
  let themeProfileId = '';
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

  onMount(async () => {
    startScopeOverride = '';

    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[StartupHome] failed to load role presets:', err);
      rolePresets = [
        { role: 'planner' },
        { role: 'implementer' },
        { role: 'reviewer' },
        { role: 'researcher' },
      ];
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

  function buildStartScopeDescription(directory: string, override: string): {
    title: string;
    subtitle: string;
  } {
    const explicitScope = override.trim();
    if (explicitScope) {
      return {
        title: `Open ${formatScopeLabel(explicitScope, 2)}`,
        subtitle: `Canvas and launcher will follow ${formatScopePath(explicitScope)} until you intentionally override it again.`,
      };
    }

    const trimmedDirectory = directory.trim();
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

  function handleLaunchProfile(): void {
    diagnosticsMessage = null;
    enterCanvas();
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

  function openScope(scope: string, directory = ''): void {
    rememberScopeContext(scope, directory);
    diagnosticsMessage = null;
    enterCanvas();
  }

  /**
   * Tear down a recovery row the user has explicitly asked to remove.
   *
   * Uses `ui_kill_instance` so that externally-adopted agents (Claude
   * processes spawned by another tab or from a Terminal.app window) are
   * actually SIGTERM'd and not just dropped from the swarm.db rows. This
   * is the only path that handles every failure mode cleanly:
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
   * Falls back to `forceDeregisterInstance` if the kill command errors
   * (e.g. older backend binary without ui_kill_instance registered) so
   * the row still gets cleared from the UI.
   */
  async function tearDownSessionRow(session: RecoverySessionItem): Promise<void> {
    try {
      await killInstance(session.id);
    } catch (err) {
      console.warn('[StartupHome] killInstance failed, falling back to force-deregister:', err);
      await forceDeregisterInstance(session.id);
    }
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
          await respawnInstance(session.id);
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
        session.boundPtyId,
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
      diagnosticsMessage = `Scope cleanup failed: ${err}`;
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
    if (session.status === 'online' || session.status === 'adopting' || session.boundPtyId) {
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
      (item) => item.status === 'online' || item.status === 'adopting' || item.boundPtyId,
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
      // primitive per row: closePty for bound-live (server's exit handler
      // then deletes the unadopted row), ui_deregister_instance for
      // stale/offline rows. The bulk deregisterOfflineInstances command
      // enumerates by heartbeat on the server and skips bound/fresh rows,
      // so it can't deliver the "clear everything" promise by itself.
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
        return 'Open Scope';
      case 'respawn':
        return 'Respawn';
      case 'remove':
        return 'Remove';
      case 'cleanup_orphan':
        return 'Cleanup Orphan';
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
            <button class="ghost-btn" type="button" on:click={enterCanvas}>Skip to canvas</button>
          {:else if activeSection === 'settings'}
            <button class="primary-btn" type="button" on:click={openSettings}>Open settings</button>
          {/if}
        </div>
      </div>

      <div class="summary-strip" aria-label="Home summary">
        <span class="summary-item"><em>{diagnostics.sessionCount}</em> sessions</span>
        <span class="summary-item"><em>{diagnostics.layoutScopeCount}</em> layouts</span>
        <span class="summary-item"><em>{$agentProfiles.length}</em> agents</span>
        <span class="summary-item">launch <em>{harness || 'shell'}{role ? ` · ${role}` : ''}</em></span>
      </div>

      {#if activeSection === 'start'}
        <div class="start-grid">
          <article class="panel-card panel-card--hero">
            <div class="card-heading">
              <div>
                <h3>Starting Location</h3>
                <p>The shared working directory used by Home and the in-canvas launcher.</p>
              </div>
              {#if $startupPreferences.recentDirectories.length > 0}
                <span class="status-chip muted">{$startupPreferences.recentDirectories.length} recent</span>
              {/if}
            </div>

            <input
              id="home-directory"
              class="text-input mono"
              type="text"
              bind:value={selectedDirectory}
              placeholder="/path/to/project"
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

            {#if startError}
              <p class="error-text">{startError}</p>
            {/if}
          </article>

          <article class="panel-card">
            <div class="card-heading">
              <div>
                <h3>Launch Defaults</h3>
                <p>Pick the default harness and role without pinning the next canvas to an old scope.</p>
              </div>
            </div>

            <div class="inline-grid">
              <div>
                <label for="home-harness">Default Harness</label>
                <select id="home-harness" class="text-input" bind:value={harness} on:change={handleHarnessChange}>
                  {#each harnessOptions as option (option)}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              </div>

              <div>
                <label for="home-role">Default Role</label>
                <select id="home-role" class="text-input" bind:value={role} on:change={handleRoleChange}>
                  <option value="">—</option>
                  {#each rolePresets as preset (preset.role)}
                    <option value={preset.role}>{preset.role}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="field-row">
              <label for="home-scope">Fresh Canvas Scope Override</label>
              {#if startScopeOverride.trim()}
                <button class="inline-btn" type="button" on:click={clearStartScopeOverride}>Clear Override</button>
              {/if}
            </div>
            <input
              id="home-scope"
              class="text-input mono"
              type="text"
              bind:value={startScopeOverride}
              placeholder="leave blank to mint a new isolated scope"
              on:input={handleStartScopeInput}
            />
            <p class="field-hint">This field is for Start Fresh only. Entering the canvas clears any sticky launcher scope override so new nodes follow the current scope by default.</p>
          </article>

        </div>

        <p class="hint-line">{startScopeDescription.subtitle}</p>

        <div class="footer-actions">
          <button class="primary-btn primary-btn--large" type="button" on:click={handleStartFresh}>
            {startScopeDescription.title}
          </button>
          <button
            class="ghost-btn ghost-btn--danger"
            type="button"
            disabled={nukingEverything}
            title="Stop live terminals, clear every saved layout, then drop into a clean canvas."
            on:click={nukeEverythingAndStart}
          >
            {nukingEverything ? 'Clearing…' : 'Clear everything & start over'}
          </button>
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
                      title="Remove stale/offline rows in this scope"
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
                            aria-label="Copy instance ID"
                            title={`Copy instance ID (${session.id})`}
                            on:click={() => copyText(session.id, 'instance ID')}
                          >
                            <span aria-hidden="true">⧉</span>
                          </button>
                          <button
                            class="icon-btn icon-btn--danger"
                            type="button"
                            aria-label="Remove row from recovery list"
                            title={session.boundPtyId
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
                <h3>Scope Snapshot</h3>
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
              <div class="mini-row"><span>Scope Override</span><span>Pin the next Start Fresh to an explicit scope string instead of minting a fresh timestamped one.</span></div>
              <div class="mini-row"><span>Harness Aliases</span><span>Shell commands auto-typed into a PTY when a harness-backed node starts. Edit in Settings when paths change.</span></div>
              <div class="mini-row"><span>Theme Profile</span><span>Built-in palette for chrome and terminal colours. Background opacity is independently overridable.</span></div>
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
              <div class="mini-row"><span>Scopes</span><span>The active scope determines which instances appear on the canvas. Switch from Home → Sessions &amp; Layouts. Canvas layout is scoped too.</span></div>
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
                <span>Launcher scope override</span>
                <span>{$startupPreferences.launchDefaults.scope || 'Follow active scope'}</span>
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
                  <p>Built-in chrome and terminal palettes with an opacity override on top.</p>
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

  .section-nav button,
  .chip,
  .primary-btn,
  .ghost-btn,
  .inline-btn,
  .icon-btn {
    font: inherit;
  }

  .section-nav button {
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

  .section-nav button:hover {
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .section-nav button.active {
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
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
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
  .start-grid,
  .settings-grid {
    display: grid;
    gap: 14px;
  }

  .start-grid {
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    align-items: start;
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

  @media (max-width: 1100px) {
    .home-shell {
      grid-template-columns: 1fr;
    }

    .start-grid,
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

    .start-grid,
    .content-grid,
    .settings-grid,
    .metrics-grid,
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
  }
</style>
