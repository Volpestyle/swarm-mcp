<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type {
    RolePresetSummary,
    ThemeProfileId,
  } from '../lib/types';
  import { activeScope } from '../stores/swarm';
  import {
    builtInThemeProfiles,
    recoveryScopeSummaries,
    recoverySessionItems,
    startupPreferences,
  } from '../stores/startup';
  import {
    clearStalePtySession,
    deregisterOfflineInstances,
    getRolePresets,
  } from '../stores/pty';
  import {
    harnessAliases,
    HARNESS_NAMES,
    type HarnessName,
  } from '../stores/harnessAliases';
  import { launchProfiles } from '../stores/launchProfiles';
  import {
    STANDARD_AGENT_ROLE_PRESETS,
    rolePresetForRole,
  } from '../lib/agentRolePresets';

  const dispatch = createEventDispatcher<{ close: void }>();

  type DiagnosticCommandResult = {
    ok?: boolean;
    path?: string;
    error?: string;
  };

  type AssetAnalyzerSettings = {
    openaiConfigured: boolean;
    openaiModel: string;
    customCommand: string;
    configPath?: string | null;
  };

  let rolePresets: RolePresetSummary[] = [];
  let diagnosticsMessage: string | null = null;
  let analyzerMessage: string | null = null;
  let sweepingOrphans = false;
  let clearingOffline = false;
  let exportingLayout = false;
  let capturingScreenshot = false;
  let loadingAnalyzerSettings = false;
  let savingAnalyzerSettings = false;
  let selectedDirectory = '';
  let harness = '';
  let role = '';
  let scope = '';
  let analyzerOpenAiKey = '';
  let analyzerOpenAiConfigured = false;
  let analyzerOpenAiModel = 'gpt-4.1-mini';
  let analyzerCustomCommand = '';
  let selectedLaunchProfileId = '';
  let themeProfileId = 'ghostty-dark';
  // Slider semantic: 100% = max see-through, 0% = fully opaque.
  // The flip lives only in this UI layer — internal `backgroundOpacityOverride`
  // remains an alpha (1=opaque, 0=transparent) so appearance.ts, themeProfiles,
  // and tests all keep their existing semantics.
  let backgroundTransparency = 32;
  let backdropBlur = 0;
  let effectiveBackgroundOpacity = 0.68;
  let effectiveBackdropBlur = 0;
  let currentScope: string | null = null;
  let diagnostics = {
    recoverableCount: 0,
    orphanCount: 0,
    adoptingCount: 0,
    layoutScopeCount: 0,
  };

  $: selectedDirectory = $startupPreferences.selectedDirectory;
  $: harness = $startupPreferences.launchDefaults.harness;
  $: role = $startupPreferences.launchDefaults.role;
  $: scope = $startupPreferences.launchDefaults.scope;
  $: selectedLaunchProfileId = $startupPreferences.selectedLaunchProfileId;
  $: themeProfileId = $startupPreferences.themeProfileId;
  $: currentScope = $activeScope;
  $: effectiveBackgroundOpacity =
    $startupPreferences.backgroundOpacityOverride ??
    builtInThemeProfiles.find((profile) => profile.id === $startupPreferences.themeProfileId)?.appearance.defaultBackgroundOpacity ??
    0.68;
  $: effectiveBackdropBlur =
    $startupPreferences.backdropBlurOverride ??
    builtInThemeProfiles.find((profile) => profile.id === $startupPreferences.themeProfileId)?.appearance.defaultBackdropBlur ??
    0;
  // 100% transparency = 0 opacity. The slider reads as "how much to see through."
  $: backgroundTransparency = Math.round((1 - effectiveBackgroundOpacity) * 100);
  $: backdropBlur = Math.round(effectiveBackdropBlur);
  $: diagnostics = {
    recoverableCount: $recoverySessionItems.filter((item) =>
      item.status === 'online' || item.status === 'stale' || item.status === 'offline').length,
    orphanCount: $recoverySessionItems.filter((item) => !item.adopted && item.status !== 'adopting').length,
    adoptingCount: $recoverySessionItems.filter((item) => item.status === 'adopting').length,
    layoutScopeCount: $recoveryScopeSummaries.filter((scopeSummary) => scopeSummary.layoutNodeCount > 0).length,
  };

  onMount(async () => {
    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[SettingsModal] failed to load role presets:', err);
      rolePresets = STANDARD_AGENT_ROLE_PRESETS.map((preset) => ({ role: preset.role }));
    }
    await loadAnalyzerSettings();
  });

  function closeSettings() {
    dispatch('close');
  }

  function handleThemeChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setThemeProfile(target.value as ThemeProfileId);
  }

  function handleBackgroundOpacityInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    // Slider reports transparency 0–100. Convert to internal opacity (1 - t/100).
    const transparencyPercent = Number(target.value);
    const opacity = 1 - transparencyPercent / 100;
    startupPreferences.setBackgroundOpacityOverride(opacity);
  }

  function useThemeDefaultOpacity() {
    startupPreferences.setBackgroundOpacityOverride(null);
  }

  function handleBackdropBlurInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setBackdropBlurOverride(Number(target.value));
  }

  function useThemeDefaultBlur() {
    startupPreferences.setBackdropBlurOverride(null);
  }

  function handleAliasInput(harnessName: HarnessName, event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    harnessAliases.setAlias(harnessName, target.value);
  }

  function handleLaunchProfileChange(event: Event) {
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

  function handleLaunchProfileCommandInput(profileId: string, event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const profile = $launchProfiles.find((entry) => entry.id === profileId);
    if (!profile) return;
    launchProfiles.save({
      ...profile,
      command: target.value,
    });
  }

  function handleLaunchProfileDescriptionInput(profileId: string, event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const profile = $launchProfiles.find((entry) => entry.id === profileId);
    if (!profile) return;
    launchProfiles.save({
      ...profile,
      description: target.value,
    });
  }

  async function loadAnalyzerSettings() {
    if (loadingAnalyzerSettings) return;
    loadingAnalyzerSettings = true;
    try {
      const settings = await invoke<AssetAnalyzerSettings>('ui_get_asset_analyzer_settings');
      analyzerOpenAiConfigured = settings.openaiConfigured;
      analyzerOpenAiModel = settings.openaiModel || 'gpt-4.1-mini';
      analyzerCustomCommand = settings.customCommand ?? '';
      analyzerMessage = settings.openaiConfigured
        ? 'OpenAI vision analyzer is configured.'
        : settings.customCommand
          ? 'Custom analyzer command is configured.'
          : null;
    } catch (err) {
      analyzerMessage = `Analyzer settings unavailable: ${err}`;
      console.error('[SettingsModal] analyzer settings unavailable:', err);
    } finally {
      loadingAnalyzerSettings = false;
    }
  }

  function handleAnalyzerKeyInput(event: Event) {
    analyzerOpenAiKey = (event.currentTarget as HTMLInputElement).value;
  }

  function handleAnalyzerModelInput(event: Event) {
    analyzerOpenAiModel = (event.currentTarget as HTMLInputElement).value;
  }

  function handleAnalyzerCommandInput(event: Event) {
    analyzerCustomCommand = (event.currentTarget as HTMLInputElement).value;
  }

  async function saveAnalyzerSettings(clearOpenAiApiKey = false) {
    if (savingAnalyzerSettings) return;
    savingAnalyzerSettings = true;
    analyzerMessage = null;
    try {
      const settings = await invoke<AssetAnalyzerSettings>('ui_save_asset_analyzer_settings', {
        settings: {
          openaiApiKey: analyzerOpenAiKey,
          openaiModel: analyzerOpenAiModel,
          customCommand: analyzerCustomCommand,
          clearOpenaiApiKey: clearOpenAiApiKey,
        },
      });
      analyzerOpenAiConfigured = settings.openaiConfigured;
      analyzerOpenAiModel = settings.openaiModel || analyzerOpenAiModel;
      analyzerCustomCommand = settings.customCommand ?? analyzerCustomCommand;
      analyzerOpenAiKey = '';
      analyzerMessage = settings.openaiConfigured || settings.customCommand
        ? 'Multimodal analyzer saved.'
        : 'Analyzer settings saved. No provider is configured yet.';
    } catch (err) {
      analyzerMessage = `Analyzer save failed: ${err}`;
      console.error('[SettingsModal] analyzer save failed:', err);
    } finally {
      savingAnalyzerSettings = false;
    }
  }

  function handleStartingLocationInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setSelectedDirectory(target.value);
  }

  function handleHarnessChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setLaunchDefaults({ harness: target.value });
  }

  function handleRoleChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    startupPreferences.setLaunchDefaults({ role: target.value });
  }

  function handleScopeChange(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setLaunchDefaults({ scope: target.value });
  }

  function clearLauncherScopeOverride() {
    startupPreferences.setLaunchDefaults({ scope: '' });
  }

  function applyRecentDirectory(directory: string) {
    startupPreferences.setSelectedDirectory(directory);
  }

  function removeRecentDirectory(directory: string) {
    startupPreferences.removeRecentDirectory(directory);
  }

  function clearRecentDirectories() {
    startupPreferences.clearRecentDirectories();
  }

  async function sweepOrphans() {
    if (sweepingOrphans) return;
    sweepingOrphans = true;
    diagnosticsMessage = null;
    try {
      const removed = await invoke<number>('ui_sweep_unadopted_orphans');
      diagnosticsMessage = removed > 0
        ? `Removed ${removed} stale orphan row${removed === 1 ? '' : 's'}.`
        : 'No stale unadopted orphan rows were found.';
    } catch (err) {
      diagnosticsMessage = `Orphan sweep failed: ${err}`;
      console.error('[SettingsModal] orphan sweep failed:', err);
    } finally {
      sweepingOrphans = false;
    }
  }

  async function clearOffline(scopeFilter: string | null) {
    if (clearingOffline) return;
    clearingOffline = true;
    diagnosticsMessage = null;
    try {
      const targetItems = $recoverySessionItems
        .filter((item) => item.status === 'stale' || item.status === 'offline')
        .filter((item) => (scopeFilter ? item.scope === scopeFilter : true));
      const targetIds = targetItems
        .map((item) => item.instanceId)
        .filter((id): id is string => Boolean(id));
      const orphanPtys = targetItems
        .map((item) => item.kind === 'orphan_pty' ? item.ptyId : null)
        .filter((id): id is string => Boolean(id));

      for (const ptyId of orphanPtys) {
        await clearStalePtySession(ptyId);
      }

      const removedRows = await deregisterOfflineInstances(targetIds, scopeFilter);
      const removed = orphanPtys.length + removedRows;
      diagnosticsMessage = removed > 0
        ? `Cleared ${removed} stale item${removed === 1 ? '' : 's'} (${removedRows} row${removedRows === 1 ? '' : 's'}, ${orphanPtys.length} orphan PTY${orphanPtys.length === 1 ? '' : 's'}).`
        : 'No stale rows or orphan PTYs matched the selected cleanup target.';
    } catch (err) {
      diagnosticsMessage = `Offline cleanup failed: ${err}`;
      console.error('[SettingsModal] offline cleanup failed:', err);
    } finally {
      clearingOffline = false;
    }
  }

  async function exportLayout() {
    if (exportingLayout || !currentScope) return;
    exportingLayout = true;
    diagnosticsMessage = null;
    try {
      const result = await invoke<DiagnosticCommandResult>('ui_export_layout', {
        scope: currentScope,
        out: null,
      });
      diagnosticsMessage = result.path
        ? `Exported layout to ${result.path}.`
        : 'Layout export completed.';
    } catch (err) {
      diagnosticsMessage = `Layout export failed: ${err}`;
      console.error('[SettingsModal] layout export failed:', err);
    } finally {
      exportingLayout = false;
    }
  }

  async function captureScreenshot() {
    if (capturingScreenshot) return;
    capturingScreenshot = true;
    diagnosticsMessage = null;
    try {
      const result = await invoke<DiagnosticCommandResult>('ui_capture_screenshot', {
        out: null,
      });
      if (result.ok === false) {
        diagnosticsMessage = result.error ?? 'Screenshot capture unavailable.';
      } else {
        diagnosticsMessage = result.path
          ? `Captured screenshot to ${result.path}.`
          : 'Screenshot capture completed.';
      }
    } catch (err) {
      diagnosticsMessage = `Screenshot capture failed: ${err}`;
      console.error('[SettingsModal] screenshot capture failed:', err);
    } finally {
      capturingScreenshot = false;
    }
  }

  function resetDefaults() {
    startupPreferences.reset();
    harnessAliases.reset();
    launchProfiles.reset();
    diagnosticsMessage = null;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div class="settings-overlay">
  <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-header">
      <div>
        <h2 id="settings-title">Settings</h2>
        <p>Theme profiles, startup defaults, recovery controls, and harness aliases.</p>
      </div>

      <button type="button" class="close-btn" on:click={closeSettings} aria-label="Close settings">
        Close
      </button>
    </div>

    <div class="settings-body">
      <section>
        <div class="section-header">
          <div>
            <h3>Theme Profile</h3>
            <p>Theme profiles drive both the chrome palette and the terminal palette.</p>
          </div>
        </div>

        <div class="settings-grid two-up">
          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-theme-profile">Built-in Theme</label>
              <p>Select the base chrome and terminal palette for all surfaces.</p>
            </div>
            <div class="setting-control">
              <select
                id="settings-theme-profile"
                class="input"
                value={themeProfileId}
                on:change={handleThemeChange}
              >
                {#each builtInThemeProfiles as profile (profile.id)}
                  <option value={profile.id}>{profile.name}</option>
                {/each}
              </select>
              <p class="control-hint">
                {builtInThemeProfiles.find((profile) => profile.id === themeProfileId)?.description}
              </p>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-background-transparency">See-Through Override</label>
              <p>Controls surface opacity only. Higher values let the graph and desktop read through the chrome without adding blur.</p>
            </div>
            <div class="setting-control">
              <div class="range-header">
                <span class="setting-value">{backgroundTransparency}%</span>
                <button type="button" class="inline-btn" on:click={useThemeDefaultOpacity}>
                  Use Theme Default
                </button>
              </div>
              <input
                id="settings-background-transparency"
                type="range"
                min="0"
                max="100"
                step="1"
                value={backgroundTransparency}
                on:input={handleBackgroundOpacityInput}
              />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-backdrop-blur">Backdrop Blur Override</label>
              <p>Controls frosted-glass blur only. Set to 0 for a clear window; raise it to engage native macOS blur and soften panels.</p>
            </div>
            <div class="setting-control">
              <div class="range-header">
                <span class="setting-value">{backdropBlur}%</span>
                <button type="button" class="inline-btn" on:click={useThemeDefaultBlur}>
                  Use Theme Default
                </button>
              </div>
              <input
                id="settings-backdrop-blur"
                type="range"
                min="0"
                max="100"
                step="1"
                value={backdropBlur}
                on:input={handleBackdropBlurInput}
              />
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-header">
          <div>
            <h3>Multimodal Analyzer</h3>
            <p>Vision summaries are saved into project assets before agents receive them.</p>
          </div>
        </div>

        <div class="settings-grid two-up">
          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-openai-key">OpenAI API Key</label>
              <p>{analyzerOpenAiConfigured ? 'Key saved in macOS Keychain.' : 'No OpenAI key saved for this app.'}</p>
            </div>
            <div class="setting-control">
              <input
                id="settings-openai-key"
                type="password"
                class="input mono"
                spellcheck="false"
                autocomplete="off"
                placeholder={analyzerOpenAiConfigured ? 'Leave blank to keep saved key' : 'sk-...'}
                value={analyzerOpenAiKey}
                on:input={handleAnalyzerKeyInput}
              />
              <input
                type="text"
                class="input mono"
                spellcheck="false"
                autocomplete="off"
                placeholder="gpt-4.1-mini"
                value={analyzerOpenAiModel}
                on:input={handleAnalyzerModelInput}
              />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-custom-analyzer">Custom Analyzer Command</label>
              <p>Receives JSON on stdin and returns plain text or an <code>analysis</code> field.</p>
            </div>
            <div class="setting-control">
              <input
                id="settings-custom-analyzer"
                type="text"
                class="input mono"
                spellcheck="false"
                autocomplete="off"
                placeholder="optional local analyzer command"
                value={analyzerCustomCommand}
                on:input={handleAnalyzerCommandInput}
              />
              <div class="control-row">
                <button
                  type="button"
                  class="primary-btn"
                  disabled={savingAnalyzerSettings || loadingAnalyzerSettings}
                  on:click={() => saveAnalyzerSettings(false)}
                >
                  {savingAnalyzerSettings ? 'Saving...' : 'Save analyzer'}
                </button>
                <button
                  type="button"
                  class="inline-btn danger"
                  disabled={savingAnalyzerSettings || loadingAnalyzerSettings || !analyzerOpenAiConfigured}
                  on:click={() => saveAnalyzerSettings(true)}
                >
                  Clear key
                </button>
              </div>
              {#if analyzerMessage}
                <p class="message-text">{analyzerMessage}</p>
              {/if}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-header">
          <div>
            <h3>Harness Commands</h3>
            <p>Override the shell command that launches each harness.</p>
          </div>
        </div>

        <div class="stack-list">
          {#each HARNESS_NAMES as harnessName (harnessName)}
            <div class="setting-card">
              <div class="setting-copy">
                <label for={`settings-harness-${harnessName}`}>{harnessName}</label>
                <p>Default command: <code>{harnessName}</code></p>
              </div>
              <div class="setting-control alias-control">
                <input
                  id={`settings-harness-${harnessName}`}
                  type="text"
                  class="input mono"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                  placeholder={harnessName}
                  value={$harnessAliases[harnessName]}
                  on:input={(event) => handleAliasInput(harnessName, event)}
                />
              </div>
            </div>
          {/each}
        </div>
      </section>

      <section>
        <div class="section-header">
          <div>
            <h3>Launch Profiles</h3>
            <p>Reusable product launch postures that wrap harness, command, role, and trust posture.</p>
          </div>
        </div>

        <div class="settings-grid two-up">
          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-launch-profile">Selected Profile</label>
              <p>Home and Launcher use this profile unless Manual harness defaults is selected.</p>
            </div>
            <div class="setting-control">
              <select
                id="settings-launch-profile"
                class="input"
                value={selectedLaunchProfileId}
                on:change={handleLaunchProfileChange}
              >
                <option value="">Manual harness defaults</option>
                {#each $launchProfiles as profile (profile.id)}
                  <option value={profile.id}>{profile.name}</option>
                {/each}
              </select>
            </div>
          </div>

          {#each $launchProfiles as profile (profile.id)}
            <div class="setting-card">
              <div class="setting-copy">
                <label for={`settings-profile-command-${profile.id}`}>{profile.name}</label>
                <p>{profile.trustPosture} · {profile.harness} · role:{profile.defaultRole || 'none'}</p>
              </div>
              <div class="setting-control alias-control">
                <input
                  id={`settings-profile-command-${profile.id}`}
                  type="text"
                  class="input mono"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                  value={profile.command}
                  on:input={(event) => handleLaunchProfileCommandInput(profile.id, event)}
                />
                <input
                  type="text"
                  class="input"
                  value={profile.description}
                  on:input={(event) => handleLaunchProfileDescriptionInput(profile.id, event)}
                />
              </div>
            </div>
          {/each}
        </div>
      </section>

      <section>
        <div class="section-header">
          <div>
            <h3>Home & Startup</h3>
            <p>The app always opens to Home on boot. These defaults drive Home and the in-canvas launcher.</p>
          </div>
        </div>

        <div class="settings-grid two-up">
          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-starting-location">Starting Location</label>
              <p>Shared default working directory for Start Fresh and Launch.</p>
            </div>
            <div class="setting-control">
              <input
                id="settings-starting-location"
                type="text"
                class="input mono"
                placeholder="/path/to/project"
                value={selectedDirectory}
                on:input={handleStartingLocationInput}
              />
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-default-scope">Launcher Channel Override</label>
              <p>Applies to the Launch tab. Start Fresh uses its own channel field and clears this override when you enter a new channel.</p>
            </div>
            <div class="setting-control">
              <div class="control-row">
                <input
                  id="settings-default-scope"
                  type="text"
                  class="input mono"
                  placeholder="optional explicit channel"
                  value={scope}
                  on:input={handleScopeChange}
                />
                <button
                  type="button"
                  class="inline-btn"
                  disabled={!scope.trim()}
                  on:click={clearLauncherScopeOverride}
                >
                  Use Active Channel
                </button>
              </div>
              <p class="control-hint">
                {scope.trim()
                  ? 'Pinned overrides make the launcher ignore the current canvas channel until you clear them.'
                  : 'When blank, the launcher follows whatever channel the canvas is currently showing.'}
              </p>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-default-harness">Default Harness</label>
              <p>Used by Home and the Launch tab unless you override it per action.</p>
            </div>
            <div class="setting-control">
              <select
                id="settings-default-harness"
                class="input"
                value={harness}
                on:change={handleHarnessChange}
              >
                <option value="">Shell (no swarm identity)</option>
                {#each HARNESS_NAMES as harnessName (harnessName)}
                  <option value={harnessName}>{harnessName}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <label for="settings-default-role">Default Role</label>
              <p>Stored as the launch default when a harness-backed session is spawned.</p>
            </div>
            <div class="setting-control">
              <select
                id="settings-default-role"
                class="input"
                value={role}
                on:change={handleRoleChange}
              >
                <option value="">—</option>
                {#each rolePresets as preset (preset.role)}
                  <option value={preset.role}>{rolePresetForRole(preset.role).label} ({preset.role})</option>
                {/each}
              </select>
            </div>
          </div>
        </div>

        <div class="recent-card">
          <div class="recent-header">
            <div>
              <h4>Recent Project History</h4>
              <p>Use this to prune stale paths or reapply a starting location quickly.</p>
            </div>
            <button
              type="button"
              class="inline-btn"
              disabled={$startupPreferences.recentDirectories.length === 0}
              on:click={clearRecentDirectories}
            >
              Clear History
            </button>
          </div>

          {#if $startupPreferences.recentDirectories.length === 0}
            <p class="empty-copy">No recent project paths have been stored yet.</p>
          {:else}
            <div class="stack-list">
              {#each $startupPreferences.recentDirectories as directory (directory)}
                <div class="recent-row">
                  <button type="button" class="recent-pill mono" on:click={() => applyRecentDirectory(directory)}>
                    {directory}
                  </button>
                  <button type="button" class="inline-btn danger" on:click={() => removeRecentDirectory(directory)}>
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <section>
        <div class="section-header">
          <div>
            <h3>Recovery & Diagnostics</h3>
            <p>Fast visibility into stale rows, adopting drift, layout channels, and cleanup actions.</p>
          </div>
        </div>

        <div class="metrics-grid">
          <div><span>{diagnostics.recoverableCount}</span><p class="metric-label">recoverable sessions</p></div>
          <div><span>{diagnostics.orphanCount}</span><p class="metric-label">orphans</p></div>
          <div><span>{diagnostics.adoptingCount}</span><p class="metric-label">adopting</p></div>
          <div><span>{diagnostics.layoutScopeCount}</span><p class="metric-label">layout channels</p></div>
        </div>

        <div class="settings-grid two-up">
          <div class="setting-card">
            <div class="setting-copy">
              <h4 class="card-label">Channel Recovery</h4>
              <p>Current channel: <code>{currentScope ?? 'auto / all'}</code></p>
            </div>
            <div class="setting-control action-stack">
              <button
                type="button"
                class="primary-btn"
                disabled={clearingOffline || !currentScope}
                on:click={() => clearOffline(currentScope)}
              >
                Clear Current Channel Stale/Offline
              </button>
              <button
                type="button"
                class="secondary-btn"
                disabled={clearingOffline}
                on:click={() => clearOffline(null)}
              >
                Clear All Stale/Offline
              </button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <h4 class="card-label">Orphan Cleanup</h4>
              <p>Remove stale unadopted placeholders without touching live adopted sessions.</p>
            </div>
            <div class="setting-control action-stack">
              <button
                type="button"
                class="primary-btn"
                disabled={sweepingOrphans}
                on:click={sweepOrphans}
              >
                Sweep Unadopted Orphans
              </button>
            </div>
          </div>

          <div class="setting-card">
            <div class="setting-copy">
              <h4 class="card-label">Acceleration Artifacts</h4>
              <p>Export the current channel layout or request a screenshot capture result for agent review.</p>
            </div>
            <div class="setting-control action-stack">
              <button
                type="button"
                class="primary-btn"
                disabled={exportingLayout || !currentScope}
                on:click={exportLayout}
              >
                {exportingLayout ? 'Exporting…' : 'Export Layout'}
              </button>
              <button
                type="button"
                class="secondary-btn"
                disabled={capturingScreenshot}
                on:click={captureScreenshot}
              >
                {capturingScreenshot ? 'Capturing…' : 'Capture Screenshot'}
              </button>
            </div>
          </div>
        </div>

        <div class="scope-summary-card">
          <h4>Recovery Channel Snapshot</h4>
          {#if $recoveryScopeSummaries.length === 0}
            <p class="empty-copy">No channels are available yet.</p>
          {:else}
            <div class="stack-list">
              {#each $recoveryScopeSummaries as scopeSummary (scopeSummary.scope)}
                <div class="scope-row">
                  <span class="mono">{scopeSummary.scope}</span>
                  <span>{scopeSummary.sessionCount} sessions</span>
                  <span>{scopeSummary.layoutNodeCount} layout nodes</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        {#if diagnosticsMessage}
          <p class="message-text">{diagnosticsMessage}</p>
        {/if}
      </section>
    </div>

    <div class="settings-footer">
      <button type="button" class="secondary-btn" on:click={resetDefaults}>
        Reset Defaults
      </button>
      <button type="button" class="primary-btn" on:click={closeSettings}>
        Done
      </button>
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(6, 7, 12, 0.42);
    backdrop-filter: blur(18px) saturate(1.08);
    -webkit-backdrop-filter: blur(18px) saturate(1.08);
  }

  .settings-modal {
    width: min(1120px, 100%);
    max-height: min(88vh, 960px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 18px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.38);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    overflow: hidden;
  }

  .settings-header,
  .settings-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .settings-footer {
    border-top: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-bottom: none;
  }

  .settings-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .settings-header p,
  .section-header p,
  .setting-copy p,
  .control-hint,
  .recent-header p,
  .empty-copy,
  .message-text {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: #8f94b2;
  }

  .settings-body {
    flex: 1;
    overflow: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .section-header h3,
  .card-label,
  .recent-header h4,
  .scope-summary-card h4 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #a6adc8;
  }

  .settings-grid {
    display: grid;
    gap: 16px;
  }

  .settings-grid.two-up {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stack-list,
  .action-stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .action-stack {
    align-items: flex-start;
  }

  .setting-card,
  .recent-card,
  .scope-summary-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 14px;
    background: var(--node-header-bg, rgba(24, 24, 37, 0.82));
  }

  .setting-copy {
    min-width: 0;
  }

  .setting-control {
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .control-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--terminal-fg, #c0caf5);
    background: rgba(17, 17, 27, 0.65);
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 10px;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .input:focus {
    border-color: var(--status-pending, #89b4fa);
    background: rgba(17, 17, 27, 0.82);
  }

  .mono,
  code {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  }

  code {
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(108, 112, 134, 0.22);
    color: var(--terminal-fg, #c0caf5);
  }

  .range-header,
  .recent-header,
  .recent-row,
  .scope-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .setting-value {
    font-size: 12px;
    color: var(--terminal-fg, #c0caf5);
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .metrics-grid div {
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 14px;
    padding: 14px;
    background: rgba(17, 17, 27, 0.35);
  }

  .metrics-grid span {
    display: block;
    font-size: 22px;
    font-weight: 700;
    color: var(--terminal-fg, #c0caf5);
  }

  .metric-label {
    margin: 4px 0 0;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8f94b2;
  }

  .primary-btn,
  .secondary-btn,
  .close-btn,
  .inline-btn,
  .recent-pill {
    font: inherit;
  }

  .primary-btn,
  .secondary-btn,
  .close-btn,
  .inline-btn {
    border-radius: 10px;
    cursor: pointer;
    transition: transform 0.14s ease, border-color 0.14s ease, background 0.14s ease;
  }

  .primary-btn,
  .secondary-btn,
  .close-btn {
    padding: 10px 14px;
  }

  .primary-btn {
    border: 1px solid color-mix(in srgb, var(--status-pending) 54%, transparent);
    background: color-mix(in srgb, var(--status-pending) 18%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .secondary-btn,
  .close-btn,
  .inline-btn {
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    background: transparent;
    color: var(--terminal-fg, #d4d4d4);
  }

  .inline-btn {
    padding: 7px 10px;
    font-size: 11px;
  }

  .inline-btn.danger {
    color: var(--edge-task-failed, #f38ba8);
  }

  .recent-pill {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 10px;
    padding: 10px 12px;
    text-align: left;
    background: rgba(17, 17, 27, 0.45);
    color: var(--terminal-fg, #c0caf5);
    cursor: pointer;
  }

  .primary-btn:hover:not(:disabled),
  .secondary-btn:hover:not(:disabled),
  .close-btn:hover:not(:disabled),
  .inline-btn:hover:not(:disabled),
  .recent-pill:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .primary-btn:disabled,
  .secondary-btn:disabled,
  .close-btn:disabled,
  .inline-btn:disabled {
    opacity: 0.56;
    cursor: default;
    transform: none;
  }

  .message-text {
    color: color-mix(in srgb, var(--status-online) 68%, white 16%);
  }

  @media (max-width: 900px) {
    .settings-grid.two-up,
    .metrics-grid {
      grid-template-columns: 1fr;
    }

    .setting-card {
      flex-direction: column;
    }

    .setting-control {
      width: 100%;
    }
  }

  @media (max-width: 640px) {
    .settings-overlay {
      padding: 12px;
    }

    .settings-modal {
      max-height: 100%;
    }

    .settings-header,
    .settings-footer,
    .control-row,
    .range-header,
    .recent-header,
    .recent-row,
    .scope-row {
      flex-direction: column;
      align-items: stretch;
    }
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────────
     Sharp 0px corners across the modal, white-LED hairlines, uppercase
     HUD type, JetBrains Mono everywhere. Existing logic unchanged — only
     the chrome is restyled. */
  :global([data-theme="tron-encom-os"]) .settings-modal {
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    background: var(--bg-base, #000);
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      0 0 24px rgba(255, 255, 255, 0.18),
      0 24px 60px rgba(0, 0, 0, 0.7);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .settings-header,
  :global([data-theme="tron-encom-os"]) .settings-footer {
    border-color: var(--led-line, #d8dde6);
  }

  :global([data-theme="tron-encom-os"]) .settings-header h2 {
    color: var(--accent, #ffffff);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 13px;
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .section-header h3,
  :global([data-theme="tron-encom-os"]) .card-label,
  :global([data-theme="tron-encom-os"]) .recent-header h4,
  :global([data-theme="tron-encom-os"]) .scope-summary-card h4 {
    color: var(--accent, #ffffff);
    letter-spacing: 0.16em;
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .settings-header p,
  :global([data-theme="tron-encom-os"]) .section-header p,
  :global([data-theme="tron-encom-os"]) .setting-copy p,
  :global([data-theme="tron-encom-os"]) .control-hint,
  :global([data-theme="tron-encom-os"]) .recent-header p,
  :global([data-theme="tron-encom-os"]) .empty-copy,
  :global([data-theme="tron-encom-os"]) .message-text {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .setting-card,
  :global([data-theme="tron-encom-os"]) .recent-card,
  :global([data-theme="tron-encom-os"]) .scope-summary-card {
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    background: var(--bg-panel, #05070a);
  }

  :global([data-theme="tron-encom-os"]) .input,
  :global([data-theme="tron-encom-os"]) .input.mono,
  :global([data-theme="tron-encom-os"]) input,
  :global([data-theme="tron-encom-os"]) select {
    border-radius: 0;
    background: var(--bg-input, #02040a);
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .inline-btn,
  :global([data-theme="tron-encom-os"]) button {
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .close-btn {
    background: transparent;
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--accent, #ffffff);
  }

  :global([data-theme="tron-encom-os"]) .close-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.18);
  }
</style>
