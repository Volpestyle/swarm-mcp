<!--
  Launcher.svelte — Unified spawn controls

  Single form: working dir + harness + optional role + optional scope/label.

  - When a harness is picked, the backend pre-creates a swarm instance row
    and binds it to the PTY immediately, so the node renders draggable from
    the first paint.
  - When a role is also picked, the swarm label gets a `role:<role>` token.
    Role guidance comes from the explicit `swarm.register` response, not a
    hidden frontend prompt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProfile, AgentProfileDraft, RolePresetSummary } from '../lib/types';
  import {
    spawnShell,
    getRolePresets,
    unboundPtySessions,
  } from '../stores/pty';
  import { activeScope, availableScopes } from '../stores/swarm';
  import { formatScopeLabel, startupPreferences } from '../stores/startup';
  import {
    agentProfiles,
    buildAgentProfilePrompt,
    selectedAgentProfile,
    selectedAgentProfileId,
  } from '../stores/agentProfiles';
  import { harnessAliases } from '../stores/harnessAliases';
  import { requestNodeFocus } from '../lib/app/focus';

  const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
  const NAME_MAX_LEN = 32;

  // Curated starter label tokens. The <datalist> shows these as suggestions
  // while leaving the input free-text, so users can mix-and-match (e.g.
  // "team:frontend role:reviewer env:staging") without being constrained
  // to the presets.
  const LABEL_TOKEN_SUGGESTIONS: string[] = [
    'team:frontend',
    'team:backend',
    'team:infra',
    'team:research',
    'role:planner',
    'role:implementer',
    'role:reviewer',
    'role:researcher',
    'env:dev',
    'env:staging',
    'env:prod',
    'priority:high',
    'priority:low',
  ];

  // Scope suggestions are built reactively from live scopes + a few helpful
  // presets. Users can still type any string (fresh scopes, ad-hoc names).
  $: scopeSuggestions = (() => {
    const suggestions = new Set<string>();
    for (const scope of $availableScopes) {
      if (scope) suggestions.add(scope);
    }
    if ($activeScope) suggestions.add($activeScope);
    suggestions.add('default');
    suggestions.add('shared');
    return [...suggestions].filter((value) => value).sort();
  })();

  $: workingDirSuggestions = $startupPreferences.recentDirectories.filter(
    (dir) => dir && dir.trim().length > 0,
  );

  let workingDir: string = '';
  let launchScope: string = '';
  let label: string = '';
  let name: string = '';
  let harness: string = 'claude';
  let role: string = '';

  const harnessOptions: { value: string; label: string }[] = [
    { value: '', label: 'Shell (no swarm identity)' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'opencode', label: 'opencode' },
  ];

  let rolePresets: RolePresetSummary[] = [];
  let loading = false;
  let error: string | null = null;
  let explicitScopeOverride: string = '';
  let profileName: string = '';
  let mission: string = '';
  let persona: string = '';
  let specialty: string = '';
  let skills: string = '';
  let contextNotes: string = '';
  let memoryNotes: string = '';
  let permissions: string = '';
  let launchCommand: string = '';
  let customInstructions: string = '';
  let profileMessage: string | null = null;
  let filledProfileInstructionCount = 0;
  let scopeStatusCopy = '';
  let scopeStatusHeading = 'Following canvas scope';
  let scopeStatusPill = 'following canvas';
  let launchCommandPreview = '$SHELL';
  let lastAppliedProfileId = '';

  $: workingDir = $startupPreferences.selectedDirectory;
  $: explicitScopeOverride = $startupPreferences.launchDefaults.scope;
  $: launchScope = explicitScopeOverride || $activeScope || '';
  $: harness = $startupPreferences.launchDefaults.harness;
  $: role = $startupPreferences.launchDefaults.role;
  $: scopeStatusHeading = explicitScopeOverride.trim()
    ? 'Pinned launcher override'
    : 'Following canvas scope';
  $: scopeStatusPill = launchScope.includes('#fresh-')
    ? 'fresh scope'
    : explicitScopeOverride.trim()
      ? 'pinned scope'
      : 'following canvas';
  $: scopeStatusCopy = describeScopeBehavior(explicitScopeOverride, $activeScope || null);
  $: launchCommandPreview = harness
    ? launchCommand.trim() || ($harnessAliases[harness as keyof typeof $harnessAliases] ?? harness)
    : '$SHELL';
  $: filledProfileInstructionCount = [
    mission,
    persona,
    specialty,
    skills,
    contextNotes,
    memoryNotes,
    permissions,
    customInstructions,
  ].filter((value) => value.trim().length > 0).length;

  $: launchDisabled = loading || !workingDir.trim();
  $: roleDisabled = !harness;
  $: if ($selectedAgentProfile && $selectedAgentProfile.id !== lastAppliedProfileId) {
    applyProfile($selectedAgentProfile, false);
    lastAppliedProfileId = $selectedAgentProfile.id;
  }
  $: if (!$selectedAgentProfile && !$selectedAgentProfileId && lastAppliedProfileId) {
    lastAppliedProfileId = '';
  }
  $: if (!$selectedAgentProfile && $selectedAgentProfileId) {
    selectedAgentProfileId.set('');
    lastAppliedProfileId = '';
  }

  function validateCwd(value: string, context: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return `${context} is required`;
    if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) {
      return `${context} must be an absolute path`;
    }
    return null;
  }

  function validateName(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > NAME_MAX_LEN) {
      return `Name must be ${NAME_MAX_LEN} characters or fewer`;
    }
    if (!NAME_PATTERN.test(trimmed)) {
      return 'Name may only contain letters, digits, dashes, dots, and underscores';
    }
    return null;
  }

  function describeScopeBehavior(explicitScope: string, activeCanvasScope: string | null): string {
    const trimmedExplicit = explicitScope.trim();
    if (trimmedExplicit) {
      return trimmedExplicit.includes('#fresh-')
        ? `Pinned to fresh scope ${formatScopeLabel(trimmedExplicit)}. New launches stay isolated together until you pick a different scope.`
        : `Pinned to ${formatScopeLabel(trimmedExplicit)}. New launches ignore the current canvas scope until you clear the override.`;
    }

    if (!activeCanvasScope) {
      return 'Following the current canvas scope automatically.';
    }

    return activeCanvasScope.includes('#fresh-')
      ? `Following the active fresh scope ${formatScopeLabel(activeCanvasScope)}. New agents launched from this canvas join that isolated swarm unless you pin a different scope.`
      : `Following the active canvas scope: ${formatScopeLabel(activeCanvasScope)}.`;
  }

  onMount(async () => {
    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[Launcher] failed to load role presets:', err);
      rolePresets = [
        { role: 'planner' },
        { role: 'implementer' },
        { role: 'reviewer' },
        { role: 'researcher' },
      ];
    }
  });

  function buildCurrentProfileDraft(): AgentProfileDraft {
    return {
      name: profileName.trim(),
      workingDirectory: workingDir.trim(),
      harness,
      role,
      scope: explicitScopeOverride.trim(),
      nodeName: name.trim(),
      label: label.trim(),
      mission: mission.trim(),
      persona: persona.trim(),
      specialty: specialty.trim(),
      skills: skills.trim(),
      context: contextNotes.trim(),
      memory: memoryNotes.trim(),
      permissions: permissions.trim(),
      launchCommand: launchCommand.trim(),
      customInstructions: customInstructions.trim(),
    };
  }

  function applyProfile(profile: AgentProfile, announce = true): void {
    selectedAgentProfileId.set(profile.id);
    lastAppliedProfileId = profile.id;
    profileName = profile.name;
    mission = profile.mission;
    persona = profile.persona;
    specialty = profile.specialty;
    skills = profile.skills;
    contextNotes = profile.context;
    memoryNotes = profile.memory;
    permissions = profile.permissions;
    launchCommand = profile.launchCommand;
    customInstructions = profile.customInstructions;
    name = profile.nodeName;
    label = profile.label;

    if (profile.workingDirectory) {
      startupPreferences.setSelectedDirectory(profile.workingDirectory);
      startupPreferences.addRecentDirectory(profile.workingDirectory);
    }
    startupPreferences.setLaunchDefaults({
      harness: profile.harness,
      role: profile.role,
      scope: profile.scope,
    });

    if (announce) {
      profileMessage = `Loaded profile: ${profile.name}`;
    }
  }

  export async function launch(): Promise<boolean> {
    const cwdError = validateCwd(workingDir, 'Working directory');
    if (cwdError) {
      error = cwdError;
      return false;
    }
    const nameError = validateName(name);
    if (nameError) {
      error = nameError;
      return false;
    }

    if (loading) {
      return false;
    }

    loading = true;
    error = null;
    try {
      const result = await spawnShell(workingDir.trim(), {
        harness: harness || undefined,
        harnessCommand: harness ? launchCommand.trim() || undefined : undefined,
        // Without a harness there's no MCP server to adopt the role token,
        // so suppress role to avoid a confusing label on the orphan row.
        role: harness ? role || undefined : undefined,
        scope: launchScope.trim() || undefined,
        label: label.trim() || undefined,
        // Same reasoning as role: a name token only makes sense when the
        // harness is going to adopt the pre-created instance row.
        name: harness ? name.trim() || undefined : undefined,
        bootstrapInstructions: buildAgentProfilePrompt(buildCurrentProfileDraft()) || undefined,
      });

      startupPreferences.setSelectedDirectory(workingDir.trim());
      startupPreferences.addRecentDirectory(workingDir.trim());
      startupPreferences.setLaunchDefaults({
        harness,
        role,
        scope: explicitScopeOverride,
      });

      // Ask the canvas to pan to the new node so it doesn't get lost among
      // the accumulated offline/adopting zombies. Matches the node id that
      // graph.ts will emit: `bound:<id>` when the pre-created instance row
      // comes back, else `pty:<id>` for plain shells with no swarm identity.
      const focusNodeId = result.instance_id
        ? `bound:${result.instance_id}`
        : `pty:${result.pty_id}`;
      requestNodeFocus(focusNodeId);

      return true;
    } catch (err) {
      error = `Failed to launch: ${err}`;
      console.error('[Launcher] spawn error:', err);
      return false;
    } finally {
      loading = false;
    }
  }

  async function handleLaunch() {
    await launch();
  }

  function handleWorkingDirectoryInput(event: Event): void {
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

  function handleScopeInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setLaunchDefaults({ scope: target.value });
  }

  function clearScopeOverride(): void {
    startupPreferences.setLaunchDefaults({ scope: '' });
    profileMessage = 'Launcher scope reset to follow the active canvas.';
    error = null;
  }

  function handleProfileChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    const nextId = target.value;
    if (!nextId) {
      selectedAgentProfileId.set('');
      lastAppliedProfileId = '';
      profileMessage = 'Using the current launch form.';
      return;
    }

    const profile = $agentProfiles.find((entry) => entry.id === nextId);
    if (!profile) {
      selectedAgentProfileId.set('');
      return;
    }

    applyProfile(profile);
  }

  function handleSaveProfile(): void {
    try {
      const profile = agentProfiles.saveDraft(
        buildCurrentProfileDraft(),
        $selectedAgentProfileId || null,
      );
      selectedAgentProfileId.set(profile.id);
      lastAppliedProfileId = profile.id;
      profileName = profile.name;
      profileMessage = `Saved profile: ${profile.name}`;
      error = null;
    } catch (err) {
      error = `Failed to save profile: ${err}`;
    }
  }

  function handleSaveProfileAsNew(): void {
    try {
      const profile = agentProfiles.saveDraft(buildCurrentProfileDraft(), null);
      selectedAgentProfileId.set(profile.id);
      lastAppliedProfileId = profile.id;
      profileName = profile.name;
      profileMessage = `Created profile: ${profile.name}`;
      error = null;
    } catch (err) {
      error = `Failed to save profile: ${err}`;
    }
  }

  function handleDeleteProfile(): void {
    const existing = $selectedAgentProfile;
    if (!existing) return;

    agentProfiles.deleteProfile(existing.id);
    selectedAgentProfileId.set('');
    lastAppliedProfileId = '';
    profileMessage = `Deleted profile: ${existing.name}`;
  }
</script>

<div class="launcher">
  <div class="body">
    <section class="block surface surface-accent">
      <div class="section-intro">
        <div>
          <h4>
            <span>Agent Profiles</span>
            <span class="count">{$agentProfiles.length}</span>
          </h4>
          <p class="hint">Save reusable harness, persona, context, memory, and node-label setups.</p>
        </div>
      </div>

      <div class="form-group">
        <label for="profile-select">Saved profile</label>
        <select
          id="profile-select"
          class="input"
          value={$selectedAgentProfileId}
          on:change={handleProfileChange}
        >
          <option value="">Current form</option>
          {#each $agentProfiles as profile (profile.id)}
            <option value={profile.id}>{profile.name}</option>
          {/each}
        </select>
      </div>

      <div class="profile-actions">
        <button
          type="button"
          class="btn"
          disabled={!profileName.trim()}
          on:click={handleSaveProfile}
        >
          {$selectedAgentProfileId ? 'Update profile' : 'Save profile'}
        </button>
        <button
          type="button"
          class="btn"
          disabled={!profileName.trim()}
          on:click={handleSaveProfileAsNew}
        >
          Save as new
        </button>
        <button
          type="button"
          class="btn"
          disabled={!$selectedAgentProfileId}
          on:click={handleDeleteProfile}
        >
          Delete
        </button>
      </div>

      <div class="form-group">
        <label for="profile-name-input">Profile name</label>
        <input
          id="profile-name-input"
          type="text"
          class="input"
          placeholder="e.g. Codex Reviewer"
          bind:value={profileName}
        />
      </div>

      <details class="profile-details">
        <summary>
          Profile instructions
          {#if filledProfileInstructionCount > 0}
            <span class="count">{filledProfileInstructionCount} filled</span>
          {/if}
        </summary>

        <div class="profile-details-body">
          <div class="form-group">
            <label for="profile-mission">Mission</label>
            <textarea
              id="profile-mission"
              class="input profile-textarea"
              rows="2"
              placeholder="Primary mission or outcome for this saved agent."
              bind:value={mission}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-persona">Persona</label>
            <textarea
              id="profile-persona"
              class="input profile-textarea"
              rows="2"
              placeholder="How this agent should act and sound."
              bind:value={persona}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-specialty">Specialty</label>
            <textarea
              id="profile-specialty"
              class="input profile-textarea"
              rows="2"
              placeholder="Primary specialty or operating lane."
              bind:value={specialty}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-skills">Skills</label>
            <textarea
              id="profile-skills"
              class="input profile-textarea"
              rows="2"
              placeholder="Skills, tools, or workflows to lean on."
              bind:value={skills}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-context">Context</label>
            <textarea
              id="profile-context"
              class="input profile-textarea"
              rows="2"
              placeholder="Look-back guidance, files to inspect first, or context rules."
              bind:value={contextNotes}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-memory">Memory</label>
            <textarea
              id="profile-memory"
              class="input profile-textarea"
              rows="2"
              placeholder="Carry-forward notes and things this agent should remember."
              bind:value={memoryNotes}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-permissions">Permissions posture</label>
            <textarea
              id="profile-permissions"
              class="input profile-textarea"
              rows="2"
              placeholder="File access, approval posture, network expectations, or other permission notes."
              bind:value={permissions}
            ></textarea>
          </div>

          <div class="form-group">
            <label for="profile-launch-command">Profile launch command override</label>
            <input
              id="profile-launch-command"
              type="text"
              class="input mono"
              placeholder="leave blank to use the harness alias"
              bind:value={launchCommand}
            />
            <p class="field-hint">
              When set, this exact command is typed into the shell for this profile instead of the global harness alias.
            </p>
          </div>

          <div class="form-group">
            <label for="profile-custom-instructions">Custom instructions</label>
            <textarea
              id="profile-custom-instructions"
              class="input profile-textarea"
              rows="3"
              placeholder="Any extra harness instructions to append on boot."
              bind:value={customInstructions}
            ></textarea>
          </div>
        </div>
      </details>

      {#if profileMessage}
        <p class="hint profile-message">{profileMessage}</p>
      {/if}
    </section>

    <div class="divider"></div>

    <section class="block surface">
      <div class="section-intro">
        <div>
          <h4>Launch Node</h4>
          <p class="hint">Spawn into the active canvas scope or intentionally pin a different swarm.</p>
        </div>
        <div class="state-row">
          <span class="state-pill">{harness || 'shell'}</span>
          {#if role}
            <span class="state-pill">{role}</span>
          {/if}
          <span class:accent={!explicitScopeOverride || launchScope.includes('#fresh-')} class="state-pill">
            {scopeStatusPill}
          </span>
        </div>
      </div>

      <div class="form-group">
        <label for="working-dir">Working dir</label>
        <input
          id="working-dir"
          type="text"
          class="input mono"
          placeholder="/path/to/project"
          list="working-dir-suggestions"
          autocomplete="off"
          bind:value={workingDir}
          on:input={handleWorkingDirectoryInput}
        />
        {#if workingDirSuggestions.length > 0}
          <datalist id="working-dir-suggestions">
            {#each workingDirSuggestions as dir (dir)}
              <option value={dir}></option>
            {/each}
          </datalist>
        {/if}
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label for="harness-select">Harness</label>
          <select id="harness-select" class="input" bind:value={harness} on:change={handleHarnessChange}>
            {#each harnessOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="role-select">Role</label>
          <select
            id="role-select"
            class="input"
            bind:value={role}
            disabled={roleDisabled}
            title={roleDisabled ? 'Pick a harness first' : ''}
            on:change={handleRoleChange}
          >
            <option value="">—</option>
            {#each rolePresets as preset (preset.role)}
              <option value={preset.role}>{preset.role}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label for="name-input">Name <span class="optional-tag">optional</span></label>
        <input
          id="name-input"
          type="text"
          class="input mono"
          placeholder="e.g. scout"
          bind:value={name}
          disabled={!harness}
          title={!harness ? 'Pick a harness first — names are stored on the swarm row' : ''}
        />
        <p class="field-hint">
          Friendly label shown on the node header. Falls back to the instance
          ID prefix when blank.
        </p>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <div class="label-row">
            <label for="scope-input">Scope</label>
            {#if explicitScopeOverride}
              <button type="button" class="link-btn" on:click={clearScopeOverride}>
                Use active scope
              </button>
            {/if}
          </div>
          <input
            id="scope-input"
            type="text"
            class="input mono"
            placeholder="leave blank to follow the current canvas scope"
            list="scope-suggestions"
            autocomplete="off"
            value={explicitScopeOverride}
            on:input={handleScopeInput}
          />
          {#if scopeSuggestions.length > 0}
            <datalist id="scope-suggestions">
              {#each scopeSuggestions as suggestion (suggestion)}
                <option value={suggestion}></option>
              {/each}
            </datalist>
          {/if}
          <div class="scope-status" class:active={!explicitScopeOverride}>
            <strong>{scopeStatusHeading}</strong>
            <p>{scopeStatusCopy}</p>
          </div>
        </div>
        <div class="form-group">
          <label for="label-input">Label tokens</label>
          <input
            id="label-input"
            type="text"
            class="input"
            placeholder="team:frontend role:reviewer"
            list="label-token-suggestions"
            autocomplete="off"
            bind:value={label}
          />
          <datalist id="label-token-suggestions">
            {#each LABEL_TOKEN_SUGGESTIONS as token (token)}
              <option value={token}></option>
            {/each}
          </datalist>
        </div>
      </div>

      <button
        class="btn btn-primary"
        on:click={handleLaunch}
        disabled={launchDisabled}
        aria-keyshortcuts="Meta+N Control+N"
        title={launchDisabled && !workingDir.trim()
          ? 'Enter a working directory first'
          : 'Launch a new node (Cmd/Ctrl+N)'
        }
      >
        {loading ? 'Launching…' : 'Launch'}
      </button>

      <p class="hint">
        Shortcut: <code>Cmd/Ctrl+N</code> launches a node with the current form
        values.
      </p>

      {#if harness && role}
        <p class="hint">
          Spawns a shell, auto-types <code>{launchCommandPreview}</code>, and pre-creates a
          swarm row labeled <code>role:{role}</code>. Role guidance arrives
          when the agent calls <code>register</code>.
        </p>
      {:else if harness}
        <p class="hint">
          Spawns a shell and auto-types <code>{launchCommandPreview}</code>. The harness
          adopts the pre-created swarm row on register.
        </p>
      {:else}
        <p class="hint">
          Plain shell with no swarm identity. Pick a harness for a registered,
          draggable node.
        </p>
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
    </section>

    {#if $unboundPtySessions.length > 0}
      <div class="divider"></div>

      <section class="block">
        <h4>
          <span>Pending</span>
          <span class="count">{$unboundPtySessions.length}</span>
        </h4>
        <div class="pending-list">
          {#each $unboundPtySessions as pty (pty.id)}
            <div class="pending-item">
              <span class="pending-dot"></span>
              <span class="pending-cmd mono">{pty.command}</span>
              {#if pty.launch_token}
                <span class="pending-token mono">{pty.launch_token}</span>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .launcher {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .surface {
    border: 1px solid rgba(108, 112, 134, 0.22);
    border-radius: 12px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 42%),
      rgba(17, 17, 27, 0.14);
    padding: 12px;
  }

  .surface-accent {
    background:
      linear-gradient(180deg, rgba(137, 180, 250, 0.08), transparent 48%),
      rgba(17, 17, 27, 0.14);
  }

  .section-intro {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  h4 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: #a6adc8;
    letter-spacing: 0.02em;
  }

  .count {
    font-size: 10px;
    font-weight: 500;
    color: #6c7086;
    font-variant-numeric: tabular-nums;
  }

  .divider {
    height: 1px;
    background: rgba(108, 112, 134, 0.18);
    margin: 2px 0;
  }

  .profile-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .state-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .state-pill {
    border: 1px solid rgba(108, 112, 134, 0.28);
    border-radius: 999px;
    padding: 5px 9px;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #a6adc8;
    background: rgba(17, 17, 27, 0.24);
  }

  .state-pill.accent {
    border-color: rgba(137, 180, 250, 0.36);
    color: #cdd6f4;
  }

  .profile-details {
    border: 1px solid rgba(108, 112, 134, 0.25);
    border-radius: 6px;
    background: rgba(17, 17, 27, 0.18);
    overflow: hidden;
  }

  .profile-details summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    color: #a6adc8;
    list-style: none;
  }

  .profile-details summary::-webkit-details-marker {
    display: none;
  }

  .profile-details-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 10px 10px;
  }

  .profile-textarea {
    resize: vertical;
    min-height: 56px;
  }

  .profile-message {
    color: var(--status-pending, #89b4fa);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .form-group label {
    font-size: 11px;
    font-weight: 500;
    color: #6c7086;
  }

  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .form-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .input {
    width: 100%;
    padding: 6px 8px;
    background: rgba(17, 17, 27, 0.22);
    border: 1px solid rgba(108, 112, 134, 0.25);
    border-radius: 4px;
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.12s ease, background 0.12s ease;
    box-sizing: border-box;
    line-height: 1.4;
  }

  .input.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }

  .input::placeholder {
    color: #585b70;
  }

  .input:focus {
    border-color: rgba(137, 180, 250, 0.6);
    background: rgba(17, 17, 27, 0.42);
  }

  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: #6c7086;
  }

  .field-hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.45;
    color: #585b70;
  }

  .scope-status {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 10px;
    border: 1px solid rgba(108, 112, 134, 0.22);
    border-radius: 8px;
    background: rgba(17, 17, 27, 0.16);
  }

  .scope-status.active {
    border-color: rgba(137, 180, 250, 0.26);
  }

  .scope-status strong {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #cdd6f4;
  }

  .scope-status p {
    margin: 0;
    font-size: 10px;
    line-height: 1.45;
    color: #6c7086;
  }

  .optional-tag {
    font-size: 9.5px;
    font-weight: 400;
    color: #585b70;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-left: 4px;
  }

  .hint code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    background: rgba(17, 17, 27, 0.30);
    padding: 1px 4px;
    border-radius: 3px;
    color: #cdd6f4;
  }

  select.input {
    cursor: pointer;
    appearance: none;
    padding-right: 22px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236c7086'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
  }

  .btn {
    padding: 6px 12px;
    border: 1px solid rgba(108, 112, 134, 0.3);
    background: rgba(17, 17, 27, 0.22);
    color: var(--terminal-fg, #c0caf5);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
  }

  .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(108, 112, 134, 0.55);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-primary {
    background: rgba(137, 180, 250, 0.12);
    border-color: rgba(137, 180, 250, 0.4);
    color: #89b4fa;
  }

  .btn-primary:hover:not(:disabled) {
    background: rgba(137, 180, 250, 0.2);
    border-color: rgba(137, 180, 250, 0.7);
  }

  .error {
    font-size: 11px;
    color: var(--edge-task-failed, #f38ba8);
    padding: 2px 0;
  }

  .link-btn {
    border: none;
    background: transparent;
    color: #89b4fa;
    padding: 0;
    font-size: 10px;
    cursor: pointer;
  }

  .link-btn:hover {
    text-decoration: underline;
  }

  .pending-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pending-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
  }

  .pending-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-pending, #89b4fa);
    animation: pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }

  .pending-cmd {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a6adc8;
  }

  .pending-token {
    font-size: 10px;
    color: #6c7086;
    background: rgba(17, 17, 27, 0.30);
    padding: 1px 5px;
    border-radius: 3px;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }

  .mono { font-family: var(--font-mono); }

  @media (max-width: 860px) {
    .section-intro,
    .label-row {
      flex-direction: column;
      align-items: stretch;
    }

    .state-row {
      justify-content: flex-start;
    }

    .form-grid-2 {
      grid-template-columns: 1fr;
    }
  }

  /* ── Tron Encom OS overrides ──────────────────────────────────────────
     Re-skin to the mock's `LAUNCH · 01` panel: white-LED hairlines, sharp
     corners, uppercase HUD type, JetBrains Mono. All interactive logic
     is preserved — only the chrome is restyled. */
  :global([data-theme="tron-encom-os"]) .launcher {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .surface {
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    background: var(--bg-panel, #05070a);
    box-shadow: 0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.06));
  }

  :global([data-theme="tron-encom-os"]) .surface-accent {
    background: var(--bg-elevated, #0b0f14);
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.06)),
      inset 0 0 24px rgba(255, 255, 255, 0.03);
  }

  :global([data-theme="tron-encom-os"]) h4 {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 11px;
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .count {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .divider {
    background: var(--led-line, #d8dde6);
    opacity: 0.4;
  }

  :global([data-theme="tron-encom-os"]) .state-pill {
    border-radius: 0;
    border: 1px solid var(--led-line, #d8dde6);
    background: transparent;
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }

  :global([data-theme="tron-encom-os"]) .state-pill.accent {
    background: rgba(255, 255, 255, 0.06);
    color: var(--accent, #ffffff);
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .btn {
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    border: 1px solid var(--led-line, #d8dde6);
    background: transparent;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .btn-primary {
    background: rgba(255, 255, 255, 0.1);
    color: var(--accent, #ffffff);
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.28);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .btn-primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.18);
    box-shadow: 0 0 14px rgba(255, 255, 255, 0.4);
  }

  :global([data-theme="tron-encom-os"]) input,
  :global([data-theme="tron-encom-os"]) select,
  :global([data-theme="tron-encom-os"]) textarea {
    border-radius: 0;
    background: var(--bg-input, #02040a);
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) input:focus,
  :global([data-theme="tron-encom-os"]) select:focus,
  :global([data-theme="tron-encom-os"]) textarea:focus {
    outline: none;
    border-color: var(--accent, #ffffff);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
  }

  :global([data-theme="tron-encom-os"]) .pending-token {
    border-radius: 0;
    background: var(--bg-input, #02040a);
    border: 1px solid var(--led-line-s, #6e7682);
    color: var(--fg-secondary, #8a94a0);
  }
</style>
