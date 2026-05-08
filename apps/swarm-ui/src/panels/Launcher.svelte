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
  import type { AgentProfile, AgentProfileDraft, AgentTeam, LaunchProfile, RolePresetSummary } from '../lib/types';
  import {
    spawnShell,
    getRolePresets,
    unboundPtySessions,
  } from '../stores/pty';
  import { activeScope, allInstances, availableScopes, scopeSelection, setScopeSelection } from '../stores/swarm';
  import { formatScopeLabel, startupPreferences } from '../stores/startup';
  import {
    agentProfiles,
    buildAgentProfilePrompt,
    selectedAgentProfile,
    selectedAgentProfileId,
  } from '../stores/agentProfiles';
  import {
    agentTeams,
    createFreshTeamScope,
    profilesToTeamDraft,
    selectedAgentTeam,
    selectedAgentTeamId,
  } from '../stores/teamProfiles';
  import { harnessAliases } from '../stores/harnessAliases';
  import { launchProfiles } from '../stores/launchProfiles';
  import { requestNodeFocus } from '../lib/app/focus';
  import { confirm } from '../lib/confirm';
  import {
    buildLaunchPreflightReview,
    resolveEffectiveLaunchConfig,
    resolveLaunchScope,
    type EffectiveLaunchConfig,
    type ResolvedLaunchScope,
  } from '../lib/launcherConfig';
  import {
    formatLaunchPreflightFailure,
    preflightLaunchCommand,
    type LaunchCommandPreflight,
  } from '../lib/launchPreflight';
  import {
    HARNESS_PERMISSION_PRESETS,
    presetForPermissionState,
    type HarnessPermissionPreset,
  } from '../lib/permissionPostures';
  import {
    chooseQuickLaunchProfileId,
    summarizeQuickLaunchLocation,
    summarizeQuickLaunchProfile,
    type QuickLaunchProfileSummary,
  } from '../lib/quickLaunch';
  import {
    AGENT_ACCENT_CHOICES,
    AGENT_EMOJI_CHOICES,
    STANDARD_AGENT_ROLE_PRESETS,
    rolePresetForRole,
    type AgentRolePreset,
  } from '../lib/agentRolePresets';
  import {
    appendSkillSuggestion,
    skillSuggestionsForHarness,
  } from '../lib/skillSuggestions';

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

  interface HarnessOption {
    value: string;
    label: string;
    description: string;
    defaultRole?: string;
    profileId?: string;
  }

  interface HarnessChoiceCard extends HarnessOption {
    command: string;
    roleHint: string;
    profileName: string;
    selected: boolean;
  }

  const harnessOptions: HarnessOption[] = [
    {
      value: 'openclaw',
      label: 'OpenClaw',
      description: 'Local OpenClaw chat harness',
      defaultRole: 'operator',
      profileId: 'openclaw-local',
    },
    {
      value: 'hermes',
      label: 'Hermes',
      description: 'Nous Hermes agent terminal',
      defaultRole: 'researcher',
      profileId: 'hermes-nous',
    },
    {
      value: 'codex',
      label: 'OpenAI Codex',
      description: 'Codex terminal coding agent',
      defaultRole: 'implementer',
      profileId: 'trusted-local',
    },
    {
      value: 'claude',
      label: 'Claude Code',
      description: 'Claude Code swarm agent',
      defaultRole: 'reviewer',
      profileId: 'safe-review',
    },
    {
      value: 'opencode',
      label: 'OpenCode',
      description: 'OpenCode CLI agent',
      defaultRole: 'implementer',
      profileId: 'opencode-local',
    },
    {
      value: '',
      label: 'Shell (no swarm identity)',
      description: 'Plain terminal session',
    },
  ];

  let rolePresets: RolePresetSummary[] = [];
  let loading = false;
  let error: string | null = null;
  let explicitScopeOverride: string = '';
  let launcherScopePinned = false;
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
  let teamMessage: string | null = null;
  let teamName: string = '';
  let teamMemberProfileIds: string[] = [];
  let launchingTeam = false;
  let filledProfileInstructionCount = 0;
  let scopeStatusCopy = '';
  let scopeStatusHeading = 'Following canvas channel';
  let scopeStatusPill = 'following canvas';
  let launchChannelCopy = '';
  let launchCommandPreview = '$SHELL';
  let launchCommandSourceCopy = '';
  let launchProfileMismatchCopy = '';
  let resolvedLaunchScope: ResolvedLaunchScope = {
    scope: '',
    source: 'unresolved',
    mode: 'follow-canvas',
    matchesActiveFeed: false,
    warning: '',
  };
  let launchScopeWarningCopy = '';
  let launchScopeSourceCopy = '';
  let selectedPermissionPreset = '';
  let agentProfileActive = false;
  let lastAppliedProfileId = '';
  let quickProfileSummaries: QuickLaunchProfileSummary[] = [];
  let selectedQuickProfileId = '';
  let selectedQuickProfile: AgentProfile | null = null;
  let selectedQuickSummary: QuickLaunchProfileSummary | null = null;
  let quickPrimaryDisabled = false;
  let quickPresetDisabled = false;
  let advancedOpen = false;
  let agentModal: 'none' | 'add' | 'saved' | 'role' = 'none';
  let editingAgentId = '';
  let agentDraftName = '';
  let agentDraftCommand = '';
  let agentDraftHarness = '';
  let agentDraftRole = 'operator';
  let agentDraftEmoji = '⌁';
  let agentDraftAccent = 'white';
  let agentDraftWorkingDir = '';
  let agentDraftNodeName = '';
  let agentDraftPermissions = '';
  let roleEditorProfileId = '';
  let roleEditorRole = '';
  let roleEditorEmoji = '';
  let roleEditorAccent = '';

  $: workingDir = $startupPreferences.selectedDirectory;
  $: launcherScopePinned = Boolean($startupPreferences.launchDefaults.scopePinned);
  $: explicitScopeOverride = launcherScopePinned ? $startupPreferences.launchDefaults.scope : '';
  $: harness = $startupPreferences.launchDefaults.harness;
  $: role = $startupPreferences.launchDefaults.role;
  $: selectedLaunchProfile =
    $launchProfiles.find((profile) => profile.id === $startupPreferences.selectedLaunchProfileId) ?? null;
  $: agentProfileActive = Boolean($selectedAgentProfileId);
  $: effectiveLaunch = resolveEffectiveLaunchConfig({
    formHarness: harness,
    formRole: role,
    profileCommand: launchCommand,
    selectedLaunchProfile,
    harnessAliases: $harnessAliases,
    agentProfileActive,
  });
  $: effectiveHarness = effectiveLaunch.harness;
  $: effectiveCommand = effectiveLaunch.command;
  $: effectiveRole = effectiveLaunch.role;
  $: resolvedLaunchScope = resolveLaunchScope({
    explicitScopeOverride,
    activeCanvasScope: $activeScope || null,
    workingDirectory: workingDir,
    selectedLaunchProfile: agentProfileActive ? null : selectedLaunchProfile,
    profileScope: agentProfileActive ? $selectedAgentProfile?.scope ?? '' : '',
  });
  $: launchScope = resolvedLaunchScope.scope;
  $: scopeStatusHeading = explicitScopeOverride.trim()
    ? 'Pinned launcher override'
    : $activeScope
      ? 'Following canvas channel'
      : 'Working directory channel';
  $: scopeStatusPill = launchScope.includes('#fresh-')
    ? 'fresh channel'
    : explicitScopeOverride.trim()
      ? 'pinned scope'
      : $activeScope
        ? 'following canvas'
        : 'working dir channel';
  $: scopeStatusCopy = describeScopeBehavior(
    explicitScopeOverride,
    $activeScope || null,
    workingDir,
    $scopeSelection,
  );
  $: launchChannelCopy = launchScope
    ? `${formatScopeLabel(launchScope)} — ${launchScope}`
    : 'Set a working directory to resolve the launch channel.';
  $: launchCommandPreview = effectiveHarness
    ? effectiveCommand || effectiveHarness
    : '$SHELL';
  $: launchCommandSourceCopy = describeLaunchCommandSource(
    effectiveLaunch.commandSource,
    selectedLaunchProfile?.name ?? null,
    agentProfileActive,
  );
  $: launchProfileMismatchCopy = describeLaunchProfileMismatch(
    effectiveLaunch,
    selectedLaunchProfile,
    agentProfileActive,
  );
  $: launchScopeWarningCopy = resolvedLaunchScope.warning;
  $: launchScopeSourceCopy = describeLaunchScopeSource(resolvedLaunchScope);
  $: profileSkillSuggestions = skillSuggestionsForHarness(harness);
  $: harnessChoiceCards = harnessOptions
    .filter((option) => option.value)
    .map((option): HarnessChoiceCard => {
      const profile = option.profileId
        ? $launchProfiles.find((entry) => entry.id === option.profileId) ?? null
        : null;
      const aliases = $harnessAliases as Partial<Record<string, string>>;
      const command = profile?.command.trim()
        || aliases[option.value]?.trim()
        || option.value;
      const roleHint = profile?.defaultRole.trim() || option.defaultRole || role || 'unassigned';
      return {
        ...option,
        command,
        roleHint,
        profileName: profile?.name ?? '',
        selected: !selectedQuickProfileId && effectiveHarness === option.value,
      };
    });
  $: selectedPermissionPreset = presetForPermissionState(harness, permissions, launchCommand);
  $: quickProfileSummaries = $agentProfiles.map((profile) =>
    summarizeQuickLaunchProfile(profile, $harnessAliases),
  );
  $: selectedQuickProfileId = chooseQuickLaunchProfileId($agentProfiles, $selectedAgentProfileId);
  $: selectedQuickProfile = $agentProfiles.find((profile) => profile.id === selectedQuickProfileId) ?? null;
  $: selectedQuickSummary = selectedQuickProfile
    ? summarizeQuickLaunchProfile(selectedQuickProfile, $harnessAliases)
    : null;
  $: selectedQuickLaunchScope = selectedQuickProfile
    ? resolveAgentProfileLaunchScope(selectedQuickProfile)
    : null;
  $: activeLaunchTruthScope = selectedQuickLaunchScope ?? resolvedLaunchScope;
  $: activeLaunchTruthDirectoryCopy = selectedQuickProfile
    ? summarizeQuickLaunchLocation(selectedQuickProfile, workingDir)
    : workingDir || 'not set';
  $: activeLaunchTruthSourceCopy = selectedQuickLaunchScope
    ? describeLaunchScopeSource(selectedQuickLaunchScope)
    : launchScopeSourceCopy;
  $: activeLaunchTruthWarningCopy = selectedQuickLaunchScope?.warning ?? launchScopeWarningCopy;
  $: activeLaunchTruthTargetCopy = selectedQuickProfile && activeLaunchTruthScope.scope
    ? 'Saved profile channel'
    : activeLaunchTruthScope.scope || 'unresolved';
  $: quickHarnessHeading = selectedQuickSummary
    ? 'Saved agent'
    : 'Harness';
  $: quickHarnessValue = selectedQuickSummary
    ? `${selectedQuickSummary.harness || 'custom'} · ${selectedQuickSummary.command}`
    : effectiveHarness
      ? launchCommandPreview
      : 'Shell';
  $: selectedQuickLaunchChannelCopy = selectedQuickLaunchScope?.scope
    ? 'Saved profile channel; exact scope shown in launch review.'
    : launchChannelCopy;
  $: selectedQuickLaunchScopeWarningCopy = selectedQuickLaunchScope?.warning ?? '';
  $: quickPrimaryDisabled = loading || !(selectedQuickProfile?.workingDirectory || workingDir).trim();
  $: quickPresetDisabled = loading || !workingDir.trim();
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
  $: selectedTeamProfiles = $agentProfiles.filter((profile) =>
    teamMemberProfileIds.includes(profile.id),
  );

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

  function describeScopeBehavior(
    explicitScope: string,
    activeCanvasScope: string | null,
    currentWorkingDir: string,
    selection: string,
  ): string {
    const trimmedExplicit = explicitScope.trim();
    if (trimmedExplicit) {
      return trimmedExplicit.includes('#fresh-')
        ? `Pinned to fresh channel ${formatScopeLabel(trimmedExplicit)}. New launches stay isolated together until you pick a different channel.`
        : `Pinned to ${formatScopeLabel(trimmedExplicit)}. New launches ignore the current canvas channel until you clear the override.`;
    }

    if (!activeCanvasScope) {
      const fallback = currentWorkingDir.trim();
      if (!fallback) {
        return 'No launch channel is resolved yet. Enter a working directory or pick an existing channel.';
      }
      return selection === 'all'
        ? `All channels is only a viewing mode. New launches will join ${formatScopeLabel(fallback)} from the working directory.`
        : `No active canvas channel yet. New launches will start on ${formatScopeLabel(fallback)} from the working directory.`;
    }

    return activeCanvasScope.includes('#fresh-')
      ? `Following the active fresh channel ${formatScopeLabel(activeCanvasScope)}. New agents launched from this canvas join that isolated swarm unless you pin a different channel.`
      : `Following the active canvas channel: ${formatScopeLabel(activeCanvasScope)}.`;
  }

  function describeLaunchCommandSource(
    source: EffectiveLaunchConfig['commandSource'],
    launchProfileName: string | null,
    agentProfileActive: boolean,
  ): string {
    switch (source) {
      case 'agent-profile-command':
        return 'Agent Profile command override';
      case 'launch-profile-command':
        return agentProfileActive && launchProfileName
          ? `Launch Profile command preset (${launchProfileName})`
          : launchProfileName
            ? `Launch Profile command (${launchProfileName})`
            : 'Launch Profile command';
      case 'harness-alias':
        return 'Harness alias from Settings';
      case 'harness':
        return 'Raw harness name';
      case 'shell':
      default:
        return 'Plain shell';
    }
  }

  function describeLaunchProfileMismatch(
    config: EffectiveLaunchConfig,
    profile: LaunchProfile | null,
    agentProfileActive: boolean,
  ): string {
    if (agentProfileActive || !profile || config.launchProfileCommandUsable) {
      return '';
    }

    return `Selected Launch Profile is for ${profile.harness}; saved Agent Profile keeps ${config.harness}. Its command preset is ignored to prevent a cross-provider launch.`;
  }

  function describeLaunchScopeSource(scope: ResolvedLaunchScope): string {
    switch (scope.source) {
      case 'agent-profile-scope':
        return 'Agent Profile scope override';
      case 'pinned-scope':
        return 'Pinned launcher scope';
      case 'launch-profile-fresh':
        return 'Fresh project scope from Launch Profile';
      case 'active-canvas':
        return 'Following active Conversation feed';
      case 'working-directory':
        return 'Working directory fallback scope';
      case 'unresolved':
      default:
        return 'Scope unresolved';
    }
  }

  onMount(async () => {
    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[Launcher] failed to load role presets:', err);
      rolePresets = STANDARD_AGENT_ROLE_PRESETS.map((preset) => ({ role: preset.role }));
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
      emoji: '',
      roleAccent: '',
      tierRank: 0,
    };
  }

  function resolveAgentProfileLaunchScope(profile: AgentProfile): ResolvedLaunchScope {
    return resolveLaunchScope({
      explicitScopeOverride,
      activeCanvasScope: $activeScope || null,
      workingDirectory: profile.workingDirectory || workingDir,
      selectedLaunchProfile: null,
      profileScope: profile.scope,
    });
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
    });

    if (announce) {
      profileMessage = `Loaded profile: ${profile.name}`;
    }
  }

  interface LaunchResolvedInput {
    cwd: string;
    harness?: string;
    command?: string;
    role?: string;
    scope?: string;
    label?: string;
    name?: string;
    bootstrapInstructions?: string;
    scopeSource?: string;
    commandSource?: string;
    commandWarning?: string;
    launchDefaults?: {
      harness: string;
      role: string;
      scope: string;
      scopePinned?: boolean;
    };
  }

  async function launchResolved(input: LaunchResolvedInput): Promise<boolean> {
    const cwd = input.cwd.trim();
    const cwdError = validateCwd(cwd, 'Working directory');
    if (cwdError) {
      error = cwdError;
      return false;
    }
    const nameError = validateName(input.name ?? '');
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
      const preflightCommand = input.command || input.harness || '';
      const commandPreflight = preflightCommand
        ? await preflightLaunchCommand({
            command: preflightCommand,
            cwd,
            harness: input.harness,
            commandSource: input.commandSource,
          })
        : null;
      if (commandPreflight && !commandPreflight.ok) {
        error = formatLaunchPreflightFailure(commandPreflight);
        return false;
      }

      const review = buildLaunchPreflightReview({
        cwd,
        harness: input.harness,
        command: input.command,
        role: input.role,
        scope: input.scope,
        activeScope: $activeScope,
        scopeSource: input.scopeSource,
        commandSource: input.commandSource,
        commandWarning: input.commandWarning,
        commandPreflight,
        activeInstances: [...$allInstances.values()],
      });
      const ok = await confirm({
        title: review.title,
        message: review.message,
        confirmLabel: review.confirmLabel,
        cancelLabel: review.cancelLabel,
        danger: review.hasIncongruencies,
      });
      if (!ok) return false;

      const result = await spawnShell(cwd, {
        harness: input.harness || undefined,
        harnessCommand: input.command || undefined,
        // Without a harness there's no MCP server to adopt the role token,
        // so suppress role to avoid a confusing label on the orphan row.
        role: input.harness ? input.role || undefined : undefined,
        scope: input.scope?.trim() || undefined,
        label: input.label?.trim() || undefined,
        // Same reasoning as role: a name token only makes sense when the
        // harness is going to adopt the pre-created instance row.
        name: input.harness ? input.name?.trim() || undefined : undefined,
        bootstrapInstructions: input.bootstrapInstructions?.trim() || undefined,
        launchPreflight: commandPreflight ?? undefined,
      });

      startupPreferences.setSelectedDirectory(cwd);
      startupPreferences.addRecentDirectory(cwd);
      if (input.launchDefaults) {
        startupPreferences.setLaunchDefaults(input.launchDefaults);
      }

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

  export async function launch(): Promise<boolean> {
    return launchResolved({
      cwd: workingDir,
      harness: effectiveHarness || undefined,
      command: effectiveCommand || undefined,
      role: effectiveRole || undefined,
      scope: launchScope,
      label,
      name,
      bootstrapInstructions: buildAgentProfilePrompt(buildCurrentProfileDraft()) || undefined,
      scopeSource: launchScopeSourceCopy,
      commandSource: launchCommandSourceCopy,
      commandWarning: launchProfileMismatchCopy,
      launchDefaults: {
        harness: effectiveHarness,
        role: effectiveRole,
        scope: explicitScopeOverride,
        scopePinned: Boolean(explicitScopeOverride),
      },
    });
  }

  export function hasInternalModal(): boolean {
    return agentModal !== 'none';
  }

  async function launchAgentProfile(profile: AgentProfile): Promise<boolean> {
    applyProfile(profile, false);
    const profileLaunchScope = resolveAgentProfileLaunchScope(profile);
    const config = resolveEffectiveLaunchConfig({
      formHarness: profile.harness,
      formRole: profile.role,
      profileCommand: profile.launchCommand,
      selectedLaunchProfile: null,
      harnessAliases: $harnessAliases,
      agentProfileActive: true,
    });

    return launchResolved({
      cwd: profile.workingDirectory || workingDir,
      harness: config.harness || undefined,
      command: config.command || undefined,
      role: config.role || undefined,
      scope: profileLaunchScope.scope,
      label: profile.label,
      name: profile.nodeName,
      bootstrapInstructions: buildAgentProfilePrompt(profile) || undefined,
      scopeSource: describeLaunchScopeSource(profileLaunchScope),
      commandSource: describeLaunchCommandSource(config.commandSource, null, true),
      launchDefaults: {
        harness: config.harness,
        role: config.role,
        scope: explicitScopeOverride,
        scopePinned: Boolean(explicitScopeOverride),
      },
    });
  }

  async function handleQuickLaunchSelected(): Promise<void> {
    if (selectedQuickProfile) {
      await launchAgentProfile(selectedQuickProfile);
      return;
    }
    await launch();
  }

  async function handleQuickPresetLaunch(
    nextHarness: string,
    nextRole: string,
    nextCommand: string,
    nextPermissions: string,
  ): Promise<void> {
    selectedAgentProfileId.set('');
    lastAppliedProfileId = '';
    permissions = nextPermissions;
    launchCommand = nextCommand;
    startupPreferences.setLaunchDefaults({ harness: nextHarness, role: nextRole });
    await launchResolved({
      cwd: workingDir,
      harness: nextHarness,
      command: nextCommand,
      role: nextRole,
      scope: launchScope,
      label,
      name,
      bootstrapInstructions: buildAgentProfilePrompt({
        ...buildCurrentProfileDraft(),
        harness: nextHarness,
        role: nextRole,
        permissions: nextPermissions,
        launchCommand: nextCommand,
      }) || undefined,
      scopeSource: launchScopeSourceCopy,
      commandSource: 'Quick preset command',
      launchDefaults: {
        harness: nextHarness,
        role: nextRole,
        scope: explicitScopeOverride,
        scopePinned: Boolean(explicitScopeOverride),
      },
    });
  }

  function selectHarnessOption(option: HarnessOption): void {
    selectedAgentProfileId.set('');
    lastAppliedProfileId = '';
    launchCommand = '';

    const profile = option.profileId
      ? $launchProfiles.find((entry) => entry.id === option.profileId) ?? null
      : null;

    if (profile) {
      startupPreferences.setSelectedLaunchProfileId(profile.id);
      startupPreferences.setLaunchDefaults({
        harness: profile.harness,
        role: profile.defaultRole,
      });
      profileMessage = `Launch choice: ${profile.name}`;
      error = null;
      return;
    }

    startupPreferences.setSelectedLaunchProfileId('');
    startupPreferences.setLaunchDefaults({
      harness: option.value,
      role: option.defaultRole || role,
    });
    profileMessage = `Launch choice: ${option.label}`;
    error = null;
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

  function appendProfileSkillSuggestion(value: string): void {
    skills = appendSkillSuggestion(skills, value);
  }

  function applyPermissionPreset(preset: HarnessPermissionPreset): void {
    permissions = preset.permissionCopy;
    launchCommand = preset.command;
    if (preset.harness) {
      startupPreferences.setLaunchDefaults({ harness: preset.harness });
    }
    profileMessage = preset.command
      ? `${preset.label}: terminal will auto-type ${preset.command}.`
      : `${preset.label}: profile command override cleared.`;
  }

  function knownHarnessForCommand(command: string): string {
    const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first.includes('openclaw')) return 'openclaw';
    if (first.includes('hermes')) return 'hermes';
    if (first.includes('claude') || first === 'flux') return 'claude';
    if (first.includes('codex') || first === 'flux9') return 'codex';
    if (first.includes('opencode')) return 'opencode';
    return '';
  }

  function openAddAgentModal(profile: AgentProfile | null = null): void {
    editingAgentId = profile?.id ?? '';
    agentDraftName = profile?.name ?? '';
    agentDraftCommand = profile?.launchCommand || profile?.harness || '';
    agentDraftHarness = profile?.harness ?? knownHarnessForCommand(agentDraftCommand);
    agentDraftRole = profile?.role || 'operator';
    const preset = rolePresetForRole(agentDraftRole);
    agentDraftEmoji = profile?.emoji || preset.emoji;
    agentDraftAccent = profile?.roleAccent || preset.accent;
    agentDraftWorkingDir = profile?.workingDirectory || workingDir;
    agentDraftNodeName = profile?.nodeName || '';
    agentDraftPermissions = profile?.permissions || '';
    agentModal = 'add';
    error = null;
  }

  function openSavedAgentsModal(): void {
    agentModal = 'saved';
    error = null;
  }

  function closeAgentModal(): void {
    agentModal = 'none';
    roleEditorProfileId = '';
  }

  function applyAgentRolePreset(preset: AgentRolePreset): void {
    agentDraftRole = preset.role;
    agentDraftEmoji = preset.emoji;
    agentDraftAccent = preset.accent;
  }

  function applyAgentEmojiChoice(emoji: string): void {
    agentDraftEmoji = emoji;
  }

  function applyAgentAccentChoice(accent: string): void {
    agentDraftAccent = accent;
  }

  function saveAgentDraft(): AgentProfile | null {
    const command = agentDraftCommand.trim();
    const nameValue = agentDraftName.trim() || command || 'New Agent';
    try {
      const existing = editingAgentId
        ? $agentProfiles.find((profile) => profile.id === editingAgentId) ?? null
        : null;
      const profile = agentProfiles.saveDraft({
        name: nameValue,
        workingDirectory: agentDraftWorkingDir.trim() || workingDir.trim(),
        harness: agentDraftHarness.trim(),
        role: agentDraftRole.trim(),
        scope: existing?.scope || explicitScopeOverride.trim(),
        nodeName: agentDraftNodeName.trim(),
        label: existing?.label || '',
        mission: existing?.mission || '',
        persona: existing?.persona || '',
        specialty: existing?.specialty || '',
        skills: existing?.skills || '',
        context: existing?.context || '',
        memory: existing?.memory || '',
        permissions: agentDraftPermissions.trim(),
        launchCommand: command,
        customInstructions: existing?.customInstructions || '',
        emoji: agentDraftEmoji.trim(),
        roleAccent: agentDraftAccent.trim(),
        tierRank: existing?.tierRank || $agentProfiles.length + 1,
      }, editingAgentId || null);
      selectedAgentProfileId.set(profile.id);
      lastAppliedProfileId = profile.id;
      profileMessage = editingAgentId ? `Updated agent: ${profile.name}` : `Added agent: ${profile.name}`;
      return profile;
    } catch (err) {
      error = `Failed to save agent: ${err}`;
      return null;
    }
  }

  function handleSaveAgentDraft(): void {
    const profile = saveAgentDraft();
    if (!profile) return;
    applyProfile(profile, false);
    closeAgentModal();
  }

  async function handleSaveAndLaunchAgentDraft(): Promise<void> {
    const profile = saveAgentDraft();
    if (!profile) return;
    closeAgentModal();
    await launchAgentProfile(profile);
  }

  function openRolePicker(profile: AgentProfile): void {
    const preset = rolePresetForRole(profile.role);
    roleEditorProfileId = profile.id;
    roleEditorRole = profile.role || preset.role;
    roleEditorEmoji = profile.emoji || preset.emoji;
    roleEditorAccent = profile.roleAccent || preset.accent;
    agentModal = 'role';
  }

  function applyRoleEditorPreset(preset: AgentRolePreset): void {
    roleEditorRole = preset.role;
    roleEditorEmoji = preset.emoji;
    roleEditorAccent = preset.accent;
  }

  function applyRoleEditorEmoji(emoji: string): void {
    roleEditorEmoji = emoji;
  }

  function applyRoleEditorAccent(accent: string): void {
    roleEditorAccent = accent;
  }

  function saveRoleEditor(): void {
    const profile = $agentProfiles.find((entry) => entry.id === roleEditorProfileId);
    if (!profile) return;
    const updated = agentProfiles.saveDraft({
      ...profile,
      role: roleEditorRole.trim(),
      emoji: roleEditorEmoji.trim(),
      roleAccent: roleEditorAccent.trim(),
    }, profile.id);
    selectedAgentProfileId.set(updated.id);
    profileMessage = `Updated role look: ${updated.name}`;
    closeAgentModal();
  }

  function handleScopeInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement;
    startupPreferences.setLaunchDefaults({
      scope: target.value,
      scopePinned: target.value.trim().length > 0,
    });
  }

  function handleLaunchProfileChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    const profile = $launchProfiles.find((entry) => entry.id === target.value) ?? null;
    startupPreferences.setSelectedLaunchProfileId(target.value);

    if (!profile) {
      profileMessage = agentProfileActive
        ? 'Launch Profile command preset cleared. Saved Agent Profile will use its own command override or harness alias.'
        : 'Using the current launch form.';
      return;
    }

    if (agentProfileActive) {
      profileMessage = profile.harness === harness
        ? `Using Launch Profile command preset with saved Agent Profile: ${profile.name}`
        : `Selected ${profile.name}, but saved Agent Profile keeps ${harness}. Command preset ignored unless the harness matches.`;
      return;
    }

    profileMessage = `Using launch profile: ${profile.name}`;
    if (profile) {
      startupPreferences.setLaunchDefaults({
        harness: profile.harness,
        role: profile.defaultRole,
      });
    }
  }

  function clearScopeOverride(): void {
    startupPreferences.setLaunchDefaults({ scope: '', scopePinned: false });
    profileMessage = 'Launcher channel reset to follow the active canvas.';
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

  function handleTeamProfileToggle(profileId: string): void {
    if (teamMemberProfileIds.includes(profileId)) {
      teamMemberProfileIds = teamMemberProfileIds.filter((id) => id !== profileId);
    } else {
      teamMemberProfileIds = [...teamMemberProfileIds, profileId];
    }
  }

  function handleTeamChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    const teamId = target.value;
    selectedAgentTeamId.set(teamId);
    if (!teamId) {
      teamMessage = 'Using team draft.';
      return;
    }

    const team = $agentTeams.find((entry) => entry.id === teamId);
    if (!team) {
      selectedAgentTeamId.set('');
      return;
    }

    teamName = team.name;
    teamMemberProfileIds = team.members
      .map((member) => member.profileId)
      .filter((id): id is string => Boolean(id));
    teamMessage = `Loaded team: ${team.name}`;
  }

  function handleSaveTeam(): void {
    try {
      const team = agentTeams.saveDraft(
        profilesToTeamDraft(teamName, selectedTeamProfiles),
        $selectedAgentTeamId || null,
      );
      selectedAgentTeamId.set(team.id);
      teamName = team.name;
      teamMessage = `Saved team: ${team.name}`;
      error = null;
    } catch (err) {
      error = `Failed to save team: ${err}`;
    }
  }

  function handleSaveTeamAsNew(): void {
    try {
      const team = agentTeams.saveDraft(
        profilesToTeamDraft(teamName, selectedTeamProfiles),
        null,
      );
      selectedAgentTeamId.set(team.id);
      teamName = team.name;
      teamMessage = `Created team: ${team.name}`;
      error = null;
    } catch (err) {
      error = `Failed to save team: ${err}`;
    }
  }

  function handleDeleteTeam(): void {
    const existing = $selectedAgentTeam;
    if (!existing) return;

    agentTeams.deleteTeam(existing.id);
    selectedAgentTeamId.set('');
    teamMessage = `Deleted team: ${existing.name}`;
  }

  async function launchTeam(team: AgentTeam): Promise<void> {
    if (launchingTeam) return;

    const baseScope = launchScope.trim() || workingDir.trim();
    const freshScope = createFreshTeamScope(baseScope, team.name);
    const memberPreflights: Array<{
      memberName: string;
      cwd: string;
      config: EffectiveLaunchConfig;
      preflight: LaunchCommandPreflight;
    }> = [];
    for (const member of team.members) {
      const profile = member.profile;
      const cwd = profile.workingDirectory || workingDir.trim();
      const cwdError = validateCwd(cwd, `${profile.name || profile.nodeName || 'Team member'} working directory`);
      if (cwdError) {
        error = cwdError;
        return;
      }
      const config = resolveEffectiveLaunchConfig({
        formHarness: profile.harness,
        formRole: profile.role,
        profileCommand: profile.launchCommand,
        selectedLaunchProfile: null,
        harnessAliases: $harnessAliases,
        agentProfileActive: true,
      });
      const preflight = await preflightLaunchCommand({
        command: config.command,
        cwd,
        harness: config.harness,
        commandSource: describeLaunchCommandSource(config.commandSource, null, true),
      });
      if (!preflight.ok) {
        error = `${profile.name || profile.nodeName || config.harness || 'Team member'} preflight blocked: ${formatLaunchPreflightFailure(preflight)}`;
        return;
      }
      memberPreflights.push({
        memberName: profile.name || profile.nodeName || config.harness || 'team member',
        cwd,
        config,
        preflight,
      });
    }
    const commandWarnings = memberPreflights
      .flatMap((entry) => [
        ...entry.preflight.warnings.map((warning) => `${entry.memberName}: ${warning}`),
        entry.preflight.trustPosture === 'full-access'
          ? `${entry.memberName}: full-access command posture`
          : '',
      ])
      .filter(Boolean)
      .join('\n');
    const review = buildLaunchPreflightReview({
      cwd: workingDir,
      harness: 'team loadout',
      command: `${team.members.length} agents`,
      role: team.name || 'team',
      scope: freshScope,
      activeScope: $activeScope,
      scopeSource: 'Fresh team channel',
      commandSource: 'Saved team loadout',
      commandWarning: commandWarnings,
      activeInstances: [...$allInstances.values()],
    });
    const ok = await confirm({
      title: review.title,
      message: review.message,
      confirmLabel: review.hasIncongruencies ? 'Launch team anyway' : 'Launch team',
      cancelLabel: review.cancelLabel,
      danger: review.hasIncongruencies,
    });
    if (!ok) return;

    launchingTeam = true;
    error = null;
    teamMessage = `Launching ${team.members.length} agents into fresh channel...`;

    try {
      let firstNodeId: string | null = null;
      for (let index = 0; index < team.members.length; index += 1) {
        const member = team.members[index];
        const profile = member.profile;
        const preflightEntry = memberPreflights[index];
        const cwd = preflightEntry?.cwd || profile.workingDirectory || workingDir.trim();
        const config = preflightEntry?.config ?? resolveEffectiveLaunchConfig({
          formHarness: profile.harness,
          formRole: profile.role,
          profileCommand: profile.launchCommand,
          selectedLaunchProfile: null,
          harnessAliases: $harnessAliases,
          agentProfileActive: true,
        });

        const result = await spawnShell(cwd, {
          harness: config.harness || undefined,
          harnessCommand: config.command || undefined,
          role: config.role || undefined,
          scope: freshScope,
          label: profile.label || undefined,
          name: profile.nodeName || undefined,
          bootstrapInstructions: buildAgentProfilePrompt(profile) || undefined,
          launchPreflight: preflightEntry?.preflight,
        });

        startupPreferences.addRecentDirectory(cwd);
        if (!firstNodeId) {
          firstNodeId = result.instance_id
            ? `bound:${result.instance_id}`
            : `pty:${result.pty_id}`;
        }
      }

      startupPreferences.setLaunchDefaults({
        harness,
        role,
        scope: '',
        scopePinned: false,
      });
      setScopeSelection(freshScope);
      if (firstNodeId) requestNodeFocus(firstNodeId);
      teamMessage = `Launched ${team.members.length} fresh agents in ${formatScopeLabel(freshScope)}.`;
    } catch (err) {
      error = `Failed to launch team: ${err}`;
      teamMessage = null;
    } finally {
      launchingTeam = false;
    }
  }

  async function handleLaunchTeam(): Promise<void> {
    const team = $selectedAgentTeam;
    if (!team) {
      error = 'Pick a saved team first.';
      return;
    }
    await launchTeam(team);
  }
</script>

<div class="launcher" class:modal-open={agentModal !== 'none'}>
  <div class="body">
    <section class="block surface surface-primary quick-launch">
      <div class="section-intro">
        <div>
          <h4>Launch</h4>
          <p class="hint">Pick a saved agent or use a direct full-access starter. Advanced knobs stay below.</p>
        </div>
        <div class="state-row">
          <span class="state-pill accent">{selectedQuickSummary?.command ?? launchCommandPreview}</span>
          <span class:accent={!explicitScopeOverride || launchScope.includes('#fresh-')} class="state-pill">
            {scopeStatusPill}
          </span>
        </div>
      </div>

      <div class="form-group">
        <label id="quick-working-dir-label" for={selectedQuickProfile ? undefined : 'quick-working-dir-input'}>Working dir</label>
        {#if selectedQuickProfile}
          <div class="input readonly-launch-field" aria-labelledby="quick-working-dir-label">
            <strong>Saved working dir</strong>
            <span>Exact path shown in launch review.</span>
          </div>
        {:else}
          <input
            id="quick-working-dir-input"
            type="text"
            class="input mono"
            placeholder="/path/to/project"
            list="working-dir-suggestions"
            autocomplete="off"
            bind:value={workingDir}
            on:input={handleWorkingDirectoryInput}
          />
        {/if}
        {#if workingDirSuggestions.length > 0}
          <datalist id="working-dir-suggestions">
            {#each workingDirSuggestions as dir (dir)}
              <option value={dir}></option>
            {/each}
          </datalist>
        {/if}
      </div>

      <div class="scope-truth-card" class:warning={Boolean(activeLaunchTruthWarningCopy)}>
        <div>
          <span>Launch truth</span>
          <strong>{activeLaunchTruthSourceCopy}</strong>
        </div>
        <p>
          Directory <code>{activeLaunchTruthDirectoryCopy}</code>
          · Feed <code>{$activeScope ?? 'no active feed'}</code>
          · Registers <code>{activeLaunchTruthTargetCopy}</code>
        </p>
        {#if activeLaunchTruthWarningCopy}
          <small>{activeLaunchTruthWarningCopy}</small>
        {/if}
      </div>

      <div class="harness-choice-panel">
        <div class="harness-choice-header">
          <span>{quickHarnessHeading}</span>
          <strong>{quickHarnessValue}</strong>
        </div>
        <div class="harness-choice-grid" role="group" aria-label="Harness choices">
          {#each harnessChoiceCards as option (option.value)}
            <button
              type="button"
              class="harness-choice"
              class:selected={option.selected}
              aria-pressed={option.selected}
              disabled={loading}
              on:click={() => selectHarnessOption(option)}
            >
              <span class="harness-choice-topline">
                <strong>{option.label}</strong>
                <code>{option.command}</code>
              </span>
              <span>{option.description}</span>
              <small>
                {option.profileName ? option.profileName : `Role ${option.roleHint}`}
              </small>
            </button>
          {/each}
        </div>
      </div>

      {#if quickProfileSummaries.length > 0}
        <div class="quick-agent-grid" aria-label="Saved agents">
          {#each quickProfileSummaries as profile (profile.id)}
            <div
              class="quick-agent-card"
              class:selected={selectedQuickProfileId === profile.id}
              class:fullAccess={profile.permissionTone === 'full-access'}
              class:custom={profile.permissionTone === 'custom'}
            >
              <button
                type="button"
                class="quick-agent-mark"
                title={`Select ${profile.name}`}
                on:click={() => {
                  const match = $agentProfiles.find((entry) => entry.id === profile.id);
                  if (match) applyProfile(match);
                }}
              >
                {#if profile.logoUrl}
                  <img src={profile.logoUrl} alt={profile.logoAlt} />
                {:else}
                  <span>{profile.providerSymbol}</span>
                {/if}
              </button>
              <button
                type="button"
                class="quick-agent-main"
                on:click={() => {
                  const match = $agentProfiles.find((entry) => entry.id === profile.id);
                  if (match) applyProfile(match);
                }}
              >
                <span class="quick-agent-topline">
                  <strong>{profile.name}</strong>
                  <code class:full={profile.permissionTone === 'full-access'}>{profile.permissionBadge}</code>
                </span>
                <span>{profile.providerLabel} · {profile.meta}</span>
                <small title={profile.command}>{profile.command}</small>
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-quick-state">
          <strong>No saved agents yet</strong>
          <span>Use the starters below, then save the setup from Advanced when it feels right.</span>
        </div>
      {/if}

      <div class="quick-actions">
        <button
          type="button"
          class="btn btn-primary"
          disabled={quickPrimaryDisabled}
          on:click={handleQuickLaunchSelected}
        >
          {loading ? 'Launching...' : selectedQuickProfile ? 'Launch Selected Agent' : 'Launch Current Setup'}
        </button>
        <button
          type="button"
          class="btn"
          on:click={() => openAddAgentModal()}
        >
          Add Agent
        </button>
        <button
          type="button"
          class="btn"
          on:click={openSavedAgentsModal}
        >
          Saved Agents
        </button>
        <button
          type="button"
          class="btn"
          aria-expanded={advancedOpen}
          aria-controls="advanced-launch-body"
          on:click={() => (advancedOpen = !advancedOpen)}
        >
          {advancedOpen ? 'Hide Advanced' : 'Advanced'}
        </button>
        <button
          type="button"
          class="btn"
          disabled={quickPresetDisabled}
          on:click={() => handleQuickPresetLaunch('', '', '', 'Standard shell session; no swarm harness identity.')}
        >
          Shell
        </button>
      </div>

      <p class="hint command-source">
        Ready command: <strong>{selectedQuickSummary?.command ?? launchCommandPreview}</strong>
        {#if selectedQuickProfile}
          from <strong>{selectedQuickProfile.name}</strong>
        {:else}
          from <strong>{launchCommandSourceCopy}</strong>
        {/if}
      </p>
      <p class="hint command-source">
        Launch channel: <strong>{selectedQuickProfile ? selectedQuickLaunchChannelCopy : launchChannelCopy}</strong>
      </p>
      {#if selectedQuickProfile ? selectedQuickLaunchScopeWarningCopy : launchScopeWarningCopy}
        <p class="field-hint warning">{selectedQuickProfile ? selectedQuickLaunchScopeWarningCopy : launchScopeWarningCopy}</p>
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
    </section>

    <div class="advanced-launch" class:open={advancedOpen}>
      <div class="advanced-summary">
        <span>Advanced setup</span>
        <small>Edit profiles, manual harness details, scopes, labels, and team loadouts</small>
      </div>
      {#if advancedOpen}
      <div class="advanced-body" id="advanced-launch-body">
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
            <div class="skill-suggestion-row" aria-label="Skill suggestions">
              {#each profileSkillSuggestions as suggestion (suggestion.id)}
                <button
                  type="button"
                  class="suggestion-chip"
                  title={suggestion.value}
                  on:click={() => appendProfileSkillSuggestion(suggestion.value)}
                >
                  {suggestion.label}
                </button>
              {/each}
            </div>
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
            <span class="form-label">Permissions posture</span>
            <div class="permission-grid" role="group" aria-label="Permissions posture">
              {#each HARNESS_PERMISSION_PRESETS as preset (preset.id)}
                <button
                  type="button"
                  class:active={selectedPermissionPreset === preset.id}
                  class:danger={preset.command}
                  class="permission-option"
                  on:click={() => applyPermissionPreset(preset)}
                >
                  <span>{preset.label}</span>
                  <small>{preset.description}</small>
                  {#if preset.command}
                    <code>{preset.command}</code>
                  {/if}
                </button>
              {/each}
            </div>
            <p class="field-hint">
              These buttons set the actual command that gets typed into the node terminal. Text in this section is not a permission switch by itself.
            </p>
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

    <section class="block surface surface-accent">
      <div class="section-intro">
        <div>
          <h4>
            <span>Team Loadouts</span>
            <span class="count">{$agentTeams.length}</span>
          </h4>
          <p class="hint">
            Save a squad of profiles, then launch fresh agents together into a new clean scope.
          </p>
        </div>
      </div>

      <div class="form-group">
        <label for="team-select">Saved team</label>
        <select
          id="team-select"
          class="input"
          value={$selectedAgentTeamId}
          on:change={handleTeamChange}
        >
          <option value="">Team draft</option>
          {#each $agentTeams as team (team.id)}
            <option value={team.id}>{team.name} · {team.members.length} agents</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label for="team-name-input">Team name</label>
        <input
          id="team-name-input"
          type="text"
          class="input"
          placeholder="e.g. Claude Beast + Codex builders"
          bind:value={teamName}
        />
      </div>

      <div class="form-group">
        <span class="form-label">Members from saved profiles</span>
        {#if $agentProfiles.length === 0}
          <p class="field-hint">Save individual agent profiles first, then combine them here.</p>
        {:else}
          <div class="team-member-list">
            {#each $agentProfiles as profile (profile.id)}
              <label class="team-member">
                <input
                  type="checkbox"
                  checked={teamMemberProfileIds.includes(profile.id)}
                  on:change={() => handleTeamProfileToggle(profile.id)}
                />
                <span>
                  <strong>{profile.name}</strong>
                  <small>{profile.harness || 'shell'} · {profile.role || 'no role'} · {profile.nodeName || 'unnamed'}</small>
                </span>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="profile-actions">
        <button
          type="button"
          class="btn"
          disabled={!teamName.trim() || selectedTeamProfiles.length === 0}
          on:click={handleSaveTeam}
        >
          {$selectedAgentTeamId ? 'Update team' : 'Save team'}
        </button>
        <button
          type="button"
          class="btn"
          disabled={!teamName.trim() || selectedTeamProfiles.length === 0}
          on:click={handleSaveTeamAsNew}
        >
          Save as new
        </button>
        <button
          type="button"
          class="btn"
          disabled={!$selectedAgentTeamId}
          on:click={handleDeleteTeam}
        >
          Delete
        </button>
      </div>

      <button
        type="button"
        class="btn btn-primary"
        disabled={!$selectedAgentTeam || launchingTeam}
        on:click={handleLaunchTeam}
        title="Launch every member as a brand-new agent in a fresh team channel"
      >
        {launchingTeam ? 'Launching team...' : 'Launch Team Fresh'}
      </button>

      <p class="hint">
        Fresh launch creates a <code>#team-...</code> channel and new PTYs, so stale
        PIDs and old instance rows are not reused.
      </p>

      {#if teamMessage}
        <p class="hint profile-message">{teamMessage}</p>
      {/if}
    </section>

    <div class="divider"></div>

    <section class="block surface">
      <div class="section-intro">
        <div>
          <h4>Launch Node</h4>
          <p class="hint">Spawn into the active canvas channel or intentionally pin a different swarm.</p>
        </div>
        <div class="state-row">
          <span class="state-pill">{effectiveHarness || 'shell'}</span>
          {#if role}
            <span class="state-pill">{role}</span>
          {/if}
          <span class:accent={!explicitScopeOverride || launchScope.includes('#fresh-')} class="state-pill">
            {scopeStatusPill}
          </span>
        </div>
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          {#if agentProfileActive}
            <span class="form-label">Launch Owner</span>
            <div class="launch-owner-card">
              <strong>{profileName || 'Agent Profile'}</strong>
              <span>{launchCommandSourceCopy}</span>
              <code>{launchCommandPreview}</code>
            </div>
          {:else}
            <label for="launch-profile-select">Launch Profile</label>
            <select
              id="launch-profile-select"
              class="input"
              value={$startupPreferences.selectedLaunchProfileId}
              on:change={handleLaunchProfileChange}
            >
              <option value="">Manual harness defaults</option>
              {#each $launchProfiles as profile (profile.id)}
                <option value={profile.id}>{profile.name}</option>
              {/each}
            </select>
            {#if selectedLaunchProfile}
              <p class="field-hint">{selectedLaunchProfile.description}</p>
              {#if launchProfileMismatchCopy}
                <p class="field-hint warning">{launchProfileMismatchCopy}</p>
              {/if}
            {/if}
          {/if}
        </div>
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
              <option value={preset.role}>
                {rolePresetForRole(preset.role).label} ({preset.role})
              </option>
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
            <label for="scope-input">Channel</label>
            {#if explicitScopeOverride}
              <button type="button" class="link-btn" on:click={clearScopeOverride}>
                Use active channel
              </button>
            {/if}
          </div>
          <input
            id="scope-input"
            type="text"
            class="input mono"
            placeholder="leave blank to follow the current canvas channel"
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
            <code>{launchChannelCopy}</code>
            <small>{launchScopeSourceCopy}</small>
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
      <p class="hint command-source">
        Command source: <strong>{launchCommandSourceCopy}</strong>
      </p>
      <p class="hint command-source">
        New node joins: <strong>{launchChannelCopy}</strong>
      </p>
      {#if launchScopeWarningCopy}
        <p class="field-hint warning">{launchScopeWarningCopy}</p>
      {/if}

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
      </div>
      {/if}
    </div>

    {#if agentModal !== 'none'}
      <div class="agent-modal-backdrop">
        <button type="button" class="agent-modal-dismiss" aria-label="Close agent modal" on:click={closeAgentModal}></button>
        <section class="agent-modal" role="dialog" aria-modal="true">
          <header class="agent-modal-header">
            <div>
              <h3>
                {agentModal === 'add'
                  ? editingAgentId ? 'Edit Agent' : 'Add Agent'
                  : agentModal === 'saved'
                    ? 'Saved Agents'
                    : 'Role Look'}
              </h3>
              <p>
                {agentModal === 'add'
                  ? 'Save any terminal command as a launchable agent. Swarm-aware harnesses can still register; custom commands run in a terminal.'
                  : agentModal === 'saved'
                    ? 'Move favorite agents into the first slots, edit them, or launch directly.'
                    : 'Pick a standard role emoji, then customize the visible role look.'}
              </p>
            </div>
            <button type="button" class="modal-close" on:click={closeAgentModal} aria-label="Close agent modal">×</button>
          </header>

          {#if agentModal === 'add'}
            <div class="agent-modal-body">
              <div class="form-grid-2">
                <div class="form-group">
                  <label for="agent-draft-name">Agent name</label>
                  <input id="agent-draft-name" class="input" bind:value={agentDraftName} placeholder="Hermes Agent" />
                </div>
                <div class="form-group">
                  <label for="agent-draft-command">Terminal command</label>
                  <input id="agent-draft-command" class="input mono" bind:value={agentDraftCommand} placeholder="hermes-agent" />
                </div>
              </div>

              <div class="form-grid-2">
                <div class="form-group">
                  <label for="agent-draft-harness">Swarm harness</label>
                  <select id="agent-draft-harness" class="input" bind:value={agentDraftHarness}>
                    <option value="">Custom terminal command</option>
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                    <option value="hermes">hermes</option>
                    <option value="openclaw">openclaw</option>
                    <option value="opencode">opencode</option>
                  </select>
                  <p class="field-hint">Only known harnesses get a pre-created swarm identity row.</p>
                </div>
                <div class="form-group">
                  <label for="agent-draft-dir">Working dir</label>
                  <input id="agent-draft-dir" class="input mono" bind:value={agentDraftWorkingDir} placeholder={workingDir || '/path/to/project'} />
                </div>
              </div>

              <div class="role-preset-strip" aria-label="Standard roles">
                {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                  <button
                    type="button"
                    class:selected={agentDraftRole === preset.role && agentDraftEmoji === preset.emoji}
                    on:click={() => applyAgentRolePreset(preset)}
                    title={preset.description}
                  >
                    <span>{preset.emoji}</span>
                    <small>{preset.label}</small>
                  </button>
                {/each}
              </div>

              <div class="form-grid-2">
                <div class="form-group">
                  <label for="agent-draft-role">Role</label>
                  <input id="agent-draft-role" class="input" bind:value={agentDraftRole} placeholder="operator" list="agent-role-choices" />
                  <datalist id="agent-role-choices">
                    {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                      <option value={preset.role}>{preset.label}</option>
                    {/each}
                  </datalist>
                  <div class="choice-menu" aria-label="Role choices">
                    {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                      <button type="button" title={preset.description} on:click={() => applyAgentRolePreset(preset)}>
                        {preset.role}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <label for="agent-draft-emoji">Emoji</label>
                  <input id="agent-draft-emoji" class="input" bind:value={agentDraftEmoji} placeholder="◇" list="agent-emoji-choices" />
                  <datalist id="agent-emoji-choices">
                    {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                      <option value={emoji}></option>
                    {/each}
                  </datalist>
                  <div class="choice-menu choice-menu--emoji" aria-label="Emoji choices">
                    {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                      <button type="button" on:click={() => applyAgentEmojiChoice(emoji)}>{emoji}</button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <label for="agent-draft-accent">Role accent</label>
                  <input id="agent-draft-accent" class="input" bind:value={agentDraftAccent} placeholder="cyan" list="agent-accent-choices" />
                  <datalist id="agent-accent-choices">
                    {#each AGENT_ACCENT_CHOICES as accent (accent)}
                      <option value={accent}></option>
                    {/each}
                  </datalist>
                  <div class="choice-menu choice-menu--accent" aria-label="Accent choices">
                    {#each AGENT_ACCENT_CHOICES as accent (accent)}
                      <button type="button" style={`--choice-accent:${accent};`} on:click={() => applyAgentAccentChoice(accent)}>
                        <i></i>{accent}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <label for="agent-draft-node-name">Node name</label>
                  <input id="agent-draft-node-name" class="input" bind:value={agentDraftNodeName} placeholder="Hermes_Operator" />
                </div>
              </div>

              <div class="form-group">
                <label for="agent-draft-permissions">Permission note</label>
                <input id="agent-draft-permissions" class="input" bind:value={agentDraftPermissions} placeholder="Custom local terminal command" />
              </div>

              <div class="modal-actions">
                <button type="button" class="btn" on:click={handleSaveAgentDraft}>Save Agent</button>
                <button type="button" class="btn btn-primary" on:click={handleSaveAndLaunchAgentDraft}>Save and Launch</button>
              </div>
            </div>
          {:else if agentModal === 'saved'}
            <div class="agent-modal-body">
              <div class="modal-actions modal-actions-top">
                <button type="button" class="btn" on:click={() => openAddAgentModal()}>Create New Agent</button>
              </div>
              {#if $agentProfiles.length === 0}
                <div class="empty-quick-state">
                  <strong>No saved agents yet</strong>
                  <span>Create one from Add Agent and it will appear here as tier #1.</span>
                </div>
              {:else}
                <div class="saved-agent-list">
                  {#each $agentProfiles as profile, index (profile.id)}
                    <article class="saved-agent-row">
                      <button type="button" class="quick-agent-emoji" on:click={() => openRolePicker(profile)}>
                        <span>{profile.emoji || rolePresetForRole(profile.role).emoji}</span>
                      </button>
                      <div class="saved-agent-copy">
                        <strong>#{index + 1} {profile.name}</strong>
                        <span>{profile.launchCommand || profile.harness || '$SHELL'} · {profile.harness || 'custom terminal'} · {profile.role || 'generalist'}</span>
                      </div>
                      <div class="saved-agent-actions">
                        <button type="button" class="mini-btn" on:click={() => agentProfiles.moveProfile(profile.id, 'top')}>#1</button>
                        <button type="button" class="mini-btn" on:click={() => agentProfiles.moveProfile(profile.id, 'up')}>↑</button>
                        <button type="button" class="mini-btn" on:click={() => agentProfiles.moveProfile(profile.id, 'down')}>↓</button>
                        <button type="button" class="mini-btn" on:click={() => openAddAgentModal(profile)}>Edit</button>
                        <button type="button" class="mini-btn" on:click={() => launchAgentProfile(profile)}>Launch</button>
                      </div>
                    </article>
                  {/each}
                </div>
              {/if}
            </div>
          {:else if agentModal === 'role'}
            <div class="agent-modal-body">
              <div class="role-preset-strip role-preset-strip-large" aria-label="Standard role emojis">
                {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                  <button
                    type="button"
                    class:selected={roleEditorRole === preset.role && roleEditorEmoji === preset.emoji}
                    on:click={() => applyRoleEditorPreset(preset)}
                    title={preset.description}
                  >
                    <span>{preset.emoji}</span>
                    <small>{preset.label}</small>
                  </button>
                {/each}
              </div>

              <div class="form-grid-2">
                <div class="form-group">
                  <label for="role-editor-role">Role</label>
                  <input id="role-editor-role" class="input" bind:value={roleEditorRole} list="role-editor-role-choices" />
                  <datalist id="role-editor-role-choices">
                    {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                      <option value={preset.role}>{preset.label}</option>
                    {/each}
                  </datalist>
                  <div class="choice-menu" aria-label="Role choices">
                    {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                      <button type="button" title={preset.description} on:click={() => applyRoleEditorPreset(preset)}>
                        {preset.role}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <label for="role-editor-emoji">Emoji</label>
                  <input id="role-editor-emoji" class="input" bind:value={roleEditorEmoji} list="role-editor-emoji-choices" />
                  <datalist id="role-editor-emoji-choices">
                    {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                      <option value={emoji}></option>
                    {/each}
                  </datalist>
                  <div class="choice-menu choice-menu--emoji" aria-label="Emoji choices">
                    {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                      <button type="button" on:click={() => applyRoleEditorEmoji(emoji)}>{emoji}</button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <label for="role-editor-accent">Role accent</label>
                  <input id="role-editor-accent" class="input" bind:value={roleEditorAccent} list="role-editor-accent-choices" />
                  <datalist id="role-editor-accent-choices">
                    {#each AGENT_ACCENT_CHOICES as accent (accent)}
                      <option value={accent}></option>
                    {/each}
                  </datalist>
                  <div class="choice-menu choice-menu--accent" aria-label="Accent choices">
                    {#each AGENT_ACCENT_CHOICES as accent (accent)}
                      <button type="button" style={`--choice-accent:${accent};`} on:click={() => applyRoleEditorAccent(accent)}>
                        <i></i>{accent}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="form-group">
                  <span class="form-label">Role depth</span>
                  <p class="field-hint">
                    Role look changes the label and bootstrap hint. A deeper custom-role system should save mission, tools, and protocol rules as a separate role profile.
                  </p>
                </div>
              </div>

              <div class="modal-actions">
                <button type="button" class="btn" on:click={closeAgentModal}>Cancel</button>
                <button type="button" class="btn btn-primary" on:click={saveRoleEditor}>Save Role Look</button>
              </div>
            </div>
          {/if}
        </section>
      </div>
    {/if}

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

  .launcher.modal-open,
  .launcher.modal-open .body {
    overflow: visible;
  }

  .body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    overscroll-behavior: contain;
    flex: 1;
    min-height: 0;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .surface {
    border: 1px solid rgba(216, 221, 230, 0.18);
    border-radius: 12px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.018), transparent 42%),
      rgba(2, 4, 8, 0.28);
    padding: 12px;
  }

  .surface-accent {
    background:
      linear-gradient(180deg, rgba(0, 240, 96, 0.075), transparent 48%),
      color-mix(in srgb, var(--terminal-bg, #05070a) 74%, transparent);
  }

  .surface-primary {
    border-color: rgba(0, 240, 96, 0.38);
    background:
      linear-gradient(180deg, rgba(0, 240, 96, 0.11), transparent 52%),
      color-mix(in srgb, var(--terminal-bg, #05070a) 78%, transparent);
  }

  .quick-launch {
    gap: 12px;
  }

  .quick-agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
  }

  .quick-agent-card {
    min-height: 104px;
    padding: 10px;
    border: 1px solid rgba(216, 221, 230, 0.2);
    border-radius: 7px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.018), transparent 60%),
      rgba(0, 0, 0, 0.54);
    color: #d8dde6;
    font-family: inherit;
    text-align: left;
    display: flex;
    align-items: stretch;
    gap: 10px;
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
  }

  .quick-agent-card:hover {
    border-color: rgba(0, 240, 96, 0.56);
    background: rgba(0, 240, 96, 0.055);
  }

  .quick-agent-card.selected {
    border-color: rgba(0, 240, 96, 0.78);
    background: rgba(0, 240, 96, 0.075);
    box-shadow: 0 0 0 1px rgba(0, 240, 96, 0.14);
  }

  .quick-agent-card.fullAccess.selected {
    border-color: rgba(243, 139, 168, 0.72);
    box-shadow:
      0 0 0 1px rgba(243, 139, 168, 0.24),
      0 0 18px rgba(243, 139, 168, 0.32);
  }

  .quick-agent-mark {
    width: 58px;
    min-height: 78px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(216, 221, 230, 0.28);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.68);
    color: #f5f7fa;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 14px rgba(0, 240, 96, 0.12);
  }

  .quick-agent-mark > span {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    color: #ffffff;
    font-size: 16px;
    font-weight: 900;
    line-height: 1;
  }

  .quick-agent-mark img {
    width: 42px;
    height: 42px;
    object-fit: contain;
    border-radius: 7px;
  }

  .quick-agent-mark:hover {
    border-color: rgba(0, 240, 96, 0.94);
    background: rgba(0, 0, 0, 0.78);
  }

  .quick-agent-emoji {
    width: 42px;
    min-height: 42px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(0, 240, 96, 0.46);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.58);
    color: #ffffff;
    cursor: pointer;
  }

  .quick-agent-emoji > span {
    display: block;
    font-size: 18px;
    line-height: 1;
  }

  .quick-agent-card.fullAccess.selected .quick-agent-mark {
    border-color: rgba(0, 240, 96, 0.88);
    color: #ffffff;
    box-shadow:
      0 0 0 1px rgba(0, 240, 96, 0.2),
      0 0 14px rgba(0, 240, 96, 0.42);
  }

  .quick-agent-card.fullAccess.selected .quick-agent-mark > span {
    color: #ffffff;
  }

  .quick-agent-main {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: 0;
  }

  .quick-agent-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .quick-agent-topline strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-agent-topline strong {
    color: #cdd6f4;
    font-size: 12px;
    font-weight: 700;
  }

  .quick-agent-topline code {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: #a6e3a1;
    background: rgba(17, 17, 27, 0.38);
    border: 1px solid rgba(166, 227, 161, 0.28);
    border-radius: 4px;
    padding: 2px 5px;
  }

  .quick-agent-topline code.full {
    color: #f38ba8;
    border-color: rgba(243, 139, 168, 0.32);
  }

  .quick-agent-main > span:not(.quick-agent-topline) {
    color: #a6adc8;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .quick-agent-main > small {
    min-width: 0;
    color: rgba(166, 173, 200, 0.72);
    font-size: 10px;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .quick-actions .btn-primary {
    grid-column: 1 / -1;
  }

  .empty-quick-state {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px;
    border: 1px dashed rgba(108, 112, 134, 0.36);
    border-radius: 7px;
    background: rgba(17, 17, 27, 0.16);
  }

  .empty-quick-state strong {
    color: #cdd6f4;
    font-size: 12px;
  }

  .empty-quick-state span {
    color: #6c7086;
    font-size: 10.5px;
  }

  .advanced-launch {
    border: 1px solid rgba(108, 112, 134, 0.22);
    border-radius: 8px;
    background: rgba(17, 17, 27, 0.12);
    overflow: hidden;
  }

  .advanced-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 12px;
    padding: 10px 12px;
    border: 0;
    background: transparent;
    color: #a6adc8;
    font-size: 11px;
    font-weight: 700;
    font-family: inherit;
    text-align: left;
  }

  .advanced-summary span {
    color: #cdd6f4;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .advanced-summary small {
    color: #6c7086;
    font-weight: 500;
    text-align: right;
  }

  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 0 12px 12px;
  }

  .agent-modal-backdrop {
    position: fixed;
    top: -44px;
    right: calc(-1 * (var(--mode-rail-width, 86px) + var(--shell-surface-gap, 18px) + 16px));
    bottom: -108px;
    left: calc(-100vw + 100% + var(--mode-rail-width, 86px) + var(--shell-surface-gap, 18px) + 16px);
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 28px;
    background: rgba(0, 0, 0, 0.66);
    backdrop-filter: blur(10px);
  }

  .agent-modal-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .agent-modal {
    position: relative;
    z-index: 1;
    width: min(820px, calc(100vw - 220px));
    max-height: min(84vh, 760px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(0, 240, 96, 0.34);
    border-radius: 8px;
    background: #020408;
    box-shadow:
      0 24px 86px rgba(0, 0, 0, 0.72),
      0 0 28px rgba(0, 240, 96, 0.12);
  }

  .agent-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    border-bottom: 1px solid rgba(216, 221, 230, 0.22);
    background:
      linear-gradient(180deg, rgba(0, 240, 96, 0.075), transparent),
      rgba(0, 0, 0, 0.42);
  }

  .agent-modal-header h3 {
    margin: 0;
    color: #f5f7fa;
    font-size: 15px;
  }

  .agent-modal-header p {
    margin: 4px 0 0;
    color: #b7c0cc;
    font-size: 11px;
    line-height: 1.45;
    max-width: 620px;
  }

  .modal-close {
    width: 32px;
    height: 32px;
    border: 1px solid rgba(216, 221, 230, 0.34);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.46);
    color: #f5f7fa;
    cursor: pointer;
    font-size: 18px;
  }

  .agent-modal-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px 16px;
    overflow-y: auto;
  }

  .role-preset-strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 2px 0 8px;
  }

  .role-preset-strip button {
    min-width: 86px;
    min-height: 74px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid rgba(216, 221, 230, 0.26);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.42);
    color: #d8dde6;
    cursor: pointer;
  }

  .role-preset-strip button.selected {
    border-color: rgba(0, 240, 96, 0.72);
    background: rgba(0, 240, 96, 0.12);
    color: #ffffff;
  }

  .role-preset-strip span {
    font-size: 24px;
    line-height: 1;
  }

  .role-preset-strip small {
    color: #c9d1dc;
    font-size: 10px;
  }

  .role-preset-strip-large button {
    min-width: 104px;
  }

  .choice-menu {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(82px, 1fr));
    gap: 5px;
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition: max-height 0.14s ease, opacity 0.14s ease;
  }

  .form-group:focus-within .choice-menu,
  .choice-menu:hover {
    max-height: 210px;
    opacity: 1;
    pointer-events: auto;
  }

  .choice-menu button {
    min-width: 0;
    min-height: 28px;
    border: 1px solid rgba(108, 112, 134, 0.28);
    border-radius: 5px;
    background: rgba(17, 17, 27, 0.24);
    color: #a6adc8;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .choice-menu button:hover {
    border-color: rgba(0, 240, 96, 0.54);
    color: #cdd6f4;
  }

  .choice-menu--emoji {
    grid-template-columns: repeat(10, minmax(28px, 1fr));
  }

  .choice-menu--emoji button {
    font-size: 16px;
    padding: 0;
  }

  .choice-menu--accent button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    justify-content: center;
  }

  .choice-menu--accent i {
    width: 8px;
    height: 8px;
    border: 1px solid rgba(255, 255, 255, 0.42);
    background: var(--choice-accent, #00f060);
    box-shadow: 0 0 8px var(--choice-accent, #00f060);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }

  .modal-actions-top {
    justify-content: flex-start;
  }

  .saved-agent-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .saved-agent-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 9px;
    border: 1px solid rgba(108, 112, 134, 0.24);
    border-radius: 7px;
    background: rgba(17, 17, 27, 0.18);
  }

  .saved-agent-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .saved-agent-copy strong,
  .saved-agent-copy span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .saved-agent-copy strong {
    color: #cdd6f4;
    font-size: 12px;
  }

  .saved-agent-copy span {
    color: #6c7086;
    font-size: 10.5px;
  }

  .saved-agent-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 5px;
  }

  .mini-btn {
    border: 1px solid rgba(108, 112, 134, 0.32);
    border-radius: 5px;
    background: rgba(17, 17, 27, 0.24);
    color: #a6adc8;
    cursor: pointer;
    padding: 4px 7px;
    font-family: inherit;
    font-size: 10px;
  }

  .mini-btn:hover {
    border-color: rgba(0, 240, 96, 0.5);
    color: #cdd6f4;
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
    border-color: rgba(0, 240, 96, 0.36);
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
    color: var(--status-pending, #00f060);
  }

  .launch-owner-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 10px;
    align-items: center;
    min-height: 46px;
    padding: 8px 10px;
    border: 1px solid rgba(0, 240, 96, 0.32);
    border-radius: 6px;
    background:
      linear-gradient(180deg, rgba(0, 240, 96, 0.09), transparent 62%),
      rgba(17, 17, 27, 0.22);
  }

  .launch-owner-card strong,
  .launch-owner-card span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .launch-owner-card strong {
    color: #cdd6f4;
    font-size: 11px;
    font-weight: 700;
  }

  .launch-owner-card span {
    grid-column: 1 / 2;
    color: #6c7086;
    font-size: 10px;
  }

  .launch-owner-card code {
    grid-row: 1 / span 2;
    grid-column: 2;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 3px 6px;
    border: 1px solid rgba(0, 240, 96, 0.32);
    border-radius: 4px;
    background: rgba(17, 17, 27, 0.4);
    color: #00f060;
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .team-member-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;
    padding: 2px;
  }

  .team-member {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    border: 1px solid rgba(108, 112, 134, 0.22);
    border-radius: 8px;
    padding: 8px;
    background: rgba(17, 17, 27, 0.16);
    cursor: pointer;
  }

  .team-member input {
    margin-top: 2px;
  }

  .team-member span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .team-member strong {
    color: #cdd6f4;
    font-size: 11px;
    font-weight: 600;
  }

  .team-member small {
    color: #6c7086;
    font-size: 10px;
    line-height: 1.35;
  }

  .skill-suggestion-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .permission-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .permission-option {
    display: flex;
    min-height: 92px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
    padding: 9px;
    border: 1px solid rgba(108, 112, 134, 0.28);
    border-radius: 6px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent 54%),
      rgba(17, 17, 27, 0.22);
    color: #a6adc8;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
  }

  .permission-option:hover {
    border-color: rgba(0, 240, 96, 0.5);
    background: rgba(0, 240, 96, 0.08);
    color: #cdd6f4;
  }

  .permission-option.active {
    border-color: rgba(0, 240, 96, 0.75);
    background: rgba(0, 240, 96, 0.14);
    color: #cdd6f4;
    box-shadow: 0 0 0 1px rgba(0, 240, 96, 0.16);
  }

  .permission-option.danger.active {
    border-color: rgba(243, 139, 168, 0.75);
    background: rgba(243, 139, 168, 0.12);
    box-shadow: 0 0 0 1px rgba(243, 139, 168, 0.18);
  }

  .permission-option span {
    font-size: 11px;
    font-weight: 700;
    color: #cdd6f4;
  }

  .permission-option small {
    color: #6c7086;
    font-size: 10px;
    line-height: 1.35;
  }

  .permission-option code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: #f38ba8;
    background: rgba(17, 17, 27, 0.42);
    border: 1px solid rgba(243, 139, 168, 0.28);
    border-radius: 4px;
    padding: 2px 5px;
  }

  .suggestion-chip {
    border: 1px solid rgba(108, 112, 134, 0.26);
    border-radius: 999px;
    background: rgba(17, 17, 27, 0.2);
    color: #a6adc8;
    padding: 3px 8px;
    font-size: 10px;
    line-height: 1.2;
    cursor: pointer;
  }

  .suggestion-chip:hover {
    border-color: rgba(0, 240, 96, 0.5);
    color: #cdd6f4;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .form-group label,
  .form-label {
    font-size: 11px;
    font-weight: 500;
    color: #b7c0cc;
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
    background: rgba(0, 0, 0, 0.52);
    border: 1px solid rgba(216, 221, 230, 0.28);
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
    border-color: rgba(0, 240, 96, 0.6);
    background: rgba(0, 0, 0, 0.72);
  }

  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: #b7c0cc;
  }

  .field-hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.45;
    color: #9da7b4;
  }

  .field-hint.warning {
    color: var(--status-stale, #f9e2af);
  }

  .command-source strong {
    color: #cdd6f4;
    font-weight: 600;
  }

  .scope-truth-card {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px 12px;
    border: 1px solid rgba(0, 240, 96, 0.22);
    border-radius: 8px;
    background: rgba(0, 240, 96, 0.055);
  }

  .scope-truth-card.warning {
    border-color: rgba(249, 226, 175, 0.38);
    background: rgba(249, 226, 175, 0.07);
  }

  .scope-truth-card div {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
  }

  .scope-truth-card span,
  .scope-truth-card strong {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .scope-truth-card span {
    color: #6c7086;
  }

  .scope-truth-card strong {
    color: #cdd6f4;
    text-align: right;
  }

  .scope-truth-card p,
  .scope-truth-card small {
    margin: 0;
    font-size: 10px;
    line-height: 1.45;
  }

  .scope-truth-card p {
    color: #9da7b4;
    overflow-wrap: anywhere;
  }

  .scope-truth-card small {
    color: var(--status-stale, #f9e2af);
  }

  .scope-truth-card code {
    color: #d4d4d4;
  }

  .readonly-launch-field {
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: default;
  }

  .readonly-launch-field strong,
  .readonly-launch-field span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .readonly-launch-field strong {
    color: #cdd6f4;
    font-size: 12px;
  }

  .readonly-launch-field span {
    color: #6c7086;
    font-size: 11px;
  }

  .harness-choice-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .harness-choice-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .harness-choice-header span,
  .harness-choice-header strong {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .harness-choice-header span {
    color: #6c7086;
  }

  .harness-choice-header strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #cdd6f4;
    text-align: right;
  }

  .harness-choice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(142px, 1fr));
    gap: 8px;
  }

  .harness-choice {
    min-width: 0;
    min-height: 92px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 7px;
    padding: 10px;
    border: 1px solid rgba(216, 221, 230, 0.2);
    border-radius: 7px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.018), transparent 58%),
      rgba(0, 0, 0, 0.5);
    color: #a6adc8;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease, color 0.12s ease;
  }

  .harness-choice:hover:not(:disabled) {
    border-color: rgba(0, 240, 96, 0.5);
    background: rgba(0, 240, 96, 0.06);
    color: #cdd6f4;
  }

  .harness-choice.selected {
    border-color: rgba(0, 240, 96, 0.76);
    background: rgba(0, 240, 96, 0.1);
    box-shadow: 0 0 0 1px rgba(0, 240, 96, 0.14);
    color: #cdd6f4;
  }

  .harness-choice:disabled {
    opacity: 0.52;
    cursor: not-allowed;
  }

  .harness-choice-topline {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .harness-choice strong,
  .harness-choice code,
  .harness-choice small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .harness-choice strong {
    color: #cdd6f4;
    font-size: 11px;
    font-weight: 700;
  }

  .harness-choice code {
    flex-shrink: 0;
    max-width: 48%;
    font-family: var(--font-mono);
    font-size: 10px;
    color: #00f060;
    background: rgba(17, 17, 27, 0.42);
    border: 1px solid rgba(0, 240, 96, 0.24);
    border-radius: 4px;
    padding: 2px 5px;
  }

  .harness-choice > span:not(.harness-choice-topline) {
    display: -webkit-box;
    overflow: hidden;
    color: #9da7b4;
    font-size: 10.5px;
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .harness-choice small {
    margin-top: auto;
    color: #6c7086;
    font-size: 10px;
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
    border-color: rgba(0, 240, 96, 0.26);
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

  .scope-status code {
    width: fit-content;
    max-width: 100%;
    overflow-wrap: anywhere;
    border-radius: 5px;
    padding: 3px 5px;
    background: rgba(0, 240, 96, 0.08);
    color: #d4d4d4;
    font-size: 10px;
  }

  .scope-status small {
    color: #7f849c;
    font-size: 9.5px;
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
    border: 1px solid rgba(216, 221, 230, 0.24);
    background: rgba(0, 0, 0, 0.44);
    color: var(--terminal-fg, #c0caf5);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
  }

  .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.035);
    border-color: rgba(216, 221, 230, 0.58);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-primary {
    background: rgba(0, 0, 0, 0.52);
    border-color: rgba(0, 240, 96, 0.58);
    color: #a8ffd0;
    box-shadow: 0 0 12px rgba(0, 240, 96, 0.16);
  }

  .btn-primary:hover:not(:disabled) {
    background: rgba(0, 240, 96, 0.1);
    border-color: rgba(0, 240, 96, 0.7);
  }

  .error {
    font-size: 11px;
    color: var(--edge-task-failed, #f38ba8);
    padding: 2px 0;
  }

  .link-btn {
    border: none;
    background: transparent;
    color: #00f060;
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
    background: var(--status-pending, #00f060);
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

    .permission-grid {
      grid-template-columns: 1fr;
    }

    .quick-actions {
      grid-template-columns: 1fr;
    }

    .advanced-summary {
      flex-direction: column;
      align-items: flex-start;
    }

    .advanced-summary small {
      text-align: left;
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

  :global([data-theme="tron-encom-os"]) .surface-primary {
    border-color: var(--accent, #ffffff);
    background: var(--bg-elevated, #0b0f14);
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      0 0 18px rgba(255, 255, 255, 0.14),
      inset 0 0 24px rgba(255, 255, 255, 0.04);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-card,
  :global([data-theme="tron-encom-os"]) .harness-choice,
  :global([data-theme="tron-encom-os"]) .empty-quick-state,
  :global([data-theme="tron-encom-os"]) .advanced-launch {
    border-radius: 0;
    border-color: var(--led-line-s, #6e7682);
    background: var(--bg-input, #02040a);
  }

  :global([data-theme="tron-encom-os"]) .harness-choice:hover:not(:disabled),
  :global([data-theme="tron-encom-os"]) .harness-choice.selected {
    border-color: var(--accent, #ffffff);
    background: rgba(0, 0, 0, 0.62);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 12px rgba(255, 255, 255, 0.24);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-card:hover,
  :global([data-theme="tron-encom-os"]) .quick-agent-card.selected {
    border-color: var(--accent, #ffffff);
    background: rgba(0, 0, 0, 0.62);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 12px rgba(255, 255, 255, 0.24);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-card.fullAccess.selected {
    border-color: var(--edge-task-failed, #ff5d73);
    box-shadow:
      0 0 0 1px rgba(255, 93, 115, 0.28),
      0 0 18px rgba(255, 93, 115, 0.48),
      inset 0 0 24px rgba(255, 93, 115, 0.035);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-card.fullAccess.selected .quick-agent-mark {
    border-color: var(--home-action-accent, #00f060);
    box-shadow:
      0 0 0 1px rgba(0, 240, 96, 0.28),
      0 0 16px rgba(0, 240, 96, 0.48);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-mark,
  :global([data-theme="tron-encom-os"]) .quick-agent-emoji {
    border-radius: 0;
    border-color: var(--home-action-accent, #00f060);
    background: var(--bg-base, #000000);
    box-shadow:
      0 0 0 1px rgba(0, 240, 96, 0.22),
      0 0 18px rgba(0, 240, 96, 0.38);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-mark > span,
  :global([data-theme="tron-encom-os"]) .quick-agent-emoji > span {
    color: #ffffff;
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-topline strong,
  :global([data-theme="tron-encom-os"]) .harness-choice-header strong,
  :global([data-theme="tron-encom-os"]) .harness-choice strong,
  :global([data-theme="tron-encom-os"]) .empty-quick-state strong,
  :global([data-theme="tron-encom-os"]) .advanced-summary span {
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .harness-choice-header span,
  :global([data-theme="tron-encom-os"]) .harness-choice span,
  :global([data-theme="tron-encom-os"]) .harness-choice small {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .harness-choice code {
    border-radius: 0;
    border-color: rgba(0, 240, 96, 0.5);
    background: rgba(0, 240, 96, 0.08);
    color: var(--home-action-accent, #00f060);
  }

  :global([data-theme="tron-encom-os"]) .quick-agent-topline code {
    border-radius: 0;
    border-color: rgba(255, 93, 115, 0.5);
    background: rgba(255, 93, 115, 0.08);
    color: var(--edge-task-failed, #ff5d73);
  }

  :global([data-theme="tron-encom-os"]) .advanced-summary {
    border-bottom: 1px solid transparent;
  }

  :global([data-theme="tron-encom-os"]) .advanced-launch.open .advanced-summary {
    border-bottom-color: var(--led-line-s, #6e7682);
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

  :global([data-theme="tron-encom-os"]) .launch-owner-card {
    border-radius: 0;
    border-color: var(--led-line, #d8dde6);
    background: var(--bg-input, #02040a);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      inset 0 0 14px rgba(255, 255, 255, 0.03);
  }

  :global([data-theme="tron-encom-os"]) .launch-owner-card strong {
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .launch-owner-card span {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .launch-owner-card code {
    border-radius: 0;
    border-color: var(--led-line-s, #6e7682);
    color: var(--accent, #ffffff);
    background: rgba(255, 255, 255, 0.06);
  }

  :global([data-theme="tron-encom-os"]) .permission-option {
    border-radius: 0;
    border-color: var(--led-line-s, #6e7682);
    background: var(--bg-input, #02040a);
    color: var(--fg-secondary, #8a94a0);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .permission-option:hover {
    border-color: var(--led-line, #d8dde6);
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.2);
  }

  :global([data-theme="tron-encom-os"]) .permission-option.active {
    border-color: var(--accent, #ffffff);
    background: rgba(255, 255, 255, 0.1);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 0 12px rgba(255, 255, 255, 0.24);
  }

  :global([data-theme="tron-encom-os"]) .permission-option.danger.active {
    border-color: var(--edge-task-failed, #ff5d73);
    box-shadow:
      0 0 0 1px rgba(255, 93, 115, 0.18),
      0 0 14px rgba(255, 93, 115, 0.28);
  }

  :global([data-theme="tron-encom-os"]) .permission-option span {
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  :global([data-theme="tron-encom-os"]) .permission-option small {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .permission-option code {
    border-radius: 0;
    border-color: rgba(255, 93, 115, 0.5);
    background: rgba(255, 93, 115, 0.08);
    color: var(--edge-task-failed, #ff5d73);
  }

  :global([data-theme="tron-encom-os"]) .btn {
    border-radius: 0;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    border: 1px solid var(--led-line, #d8dde6);
    background: rgba(0, 0, 0, 0.54);
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.035);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .btn-primary {
    background: rgba(0, 0, 0, 0.62);
    color: var(--accent, #ffffff);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.14),
      0 0 12px rgba(255, 255, 255, 0.3);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .btn-primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.055);
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
