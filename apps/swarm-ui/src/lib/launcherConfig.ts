import type { LaunchProfile, LaunchScopeMode } from './types';
import type { LaunchCommandPreflight } from './launchPreflight';

export type HarnessAliases = Partial<Record<string, string>>;

export interface LaunchConfigInput {
  formHarness: string;
  formRole: string;
  profileCommand: string;
  selectedLaunchProfile: LaunchProfile | null;
  harnessAliases: HarnessAliases;
  agentProfileActive: boolean;
}

export interface EffectiveLaunchConfig {
  harness: string;
  command: string;
  role: string;
  profileOwnsLaunch: boolean;
  launchProfileCommandUsable: boolean;
  commandSource: 'agent-profile-command' | 'launch-profile-command' | 'harness-alias' | 'harness' | 'shell';
}

export type LaunchScopeSource =
  | 'agent-profile-scope'
  | 'pinned-scope'
  | 'launch-profile-fresh'
  | 'active-canvas'
  | 'working-directory'
  | 'unresolved';

export interface LaunchScopeInput {
  explicitScopeOverride: string;
  activeCanvasScope: string | null;
  workingDirectory: string;
  selectedLaunchProfile: LaunchProfile | null;
  profileScope?: string | null;
  now?: Date;
}

export interface ResolvedLaunchScope {
  scope: string;
  source: LaunchScopeSource;
  mode: LaunchScopeMode;
  matchesActiveFeed: boolean;
  warning: string;
}

export interface LaunchPreflightInstance {
  id: string;
  scope: string;
  status: 'online' | 'stale' | 'offline';
  adopted?: boolean;
  label?: string | null;
}

export interface LaunchPreflightInput {
  cwd: string;
  harness?: string;
  command?: string;
  role?: string;
  scope?: string;
  activeScope: string | null;
  scopeSource?: string;
  commandSource?: string;
  commandWarning?: string;
  commandPreflight?: LaunchCommandPreflight | null;
  activeInstances: LaunchPreflightInstance[];
}

export interface LaunchPreflightReview {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  hasIncongruencies: boolean;
  incongruencies: string[];
}

function trim(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function resolveEffectiveLaunchConfig(input: LaunchConfigInput): EffectiveLaunchConfig {
  const formHarness = trim(input.formHarness);
  const formRole = trim(input.formRole);
  const profileCommand = trim(input.profileCommand);
  const launchProfileHarness = trim(input.selectedLaunchProfile?.harness);
  const launchProfileCommand = trim(input.selectedLaunchProfile?.command);
  const profileOwnsLaunch = input.agentProfileActive || profileCommand.length > 0;

  const launchProfileOwnsIdentity = !profileOwnsLaunch;
  const harness = launchProfileOwnsIdentity
    ? launchProfileHarness || formHarness
    : formHarness;
  const role = launchProfileOwnsIdentity
    ? formRole || trim(input.selectedLaunchProfile?.defaultRole)
    : formRole;
  const launchProfileCommandUsable = Boolean(
    !profileOwnsLaunch
    && !input.agentProfileActive
    && input.selectedLaunchProfile
    && launchProfileCommand
    && launchProfileHarness
    && launchProfileHarness === harness,
  );
  const aliasCommand = harness ? input.harnessAliases[harness]?.trim() || '' : '';

  let command = '';
  let commandSource: EffectiveLaunchConfig['commandSource'] = 'shell';
  if (profileCommand) {
    command = profileCommand;
    commandSource = 'agent-profile-command';
  } else if (launchProfileCommandUsable) {
    command = launchProfileCommand;
    commandSource = 'launch-profile-command';
  } else if (aliasCommand) {
    command = aliasCommand;
    commandSource = 'harness-alias';
  } else if (harness) {
    command = harness;
    commandSource = 'harness';
  }

  return {
    harness,
    command,
    role,
    profileOwnsLaunch,
    launchProfileCommandUsable,
    commandSource,
  };
}

function freshProjectScope(baseScope: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'z')
    .toLowerCase();
  return `${baseScope}#fresh-${stamp}`;
}

function normalizeScope(value: string | null | undefined): string {
  return trim(value).replace(/\/+$/, '');
}

export function resolveLaunchScope(input: LaunchScopeInput): ResolvedLaunchScope {
  const activeCanvasScope = normalizeScope(input.activeCanvasScope);
  const workingDirectory = normalizeScope(input.workingDirectory);
  const profileScope = normalizeScope(input.profileScope);
  const explicitScope = normalizeScope(input.explicitScopeOverride);
  const mode = input.selectedLaunchProfile?.defaultScopeMode ?? 'follow-canvas';

  let scope = '';
  let source: LaunchScopeSource = 'unresolved';

  if (explicitScope) {
    scope = explicitScope;
    source = 'pinned-scope';
  } else if (mode === 'fresh-project') {
    const baseScope = workingDirectory || activeCanvasScope;
    scope = baseScope ? freshProjectScope(baseScope, input.now ?? new Date()) : '';
    source = scope ? 'launch-profile-fresh' : 'unresolved';
  } else if (activeCanvasScope) {
    scope = activeCanvasScope;
    source = 'active-canvas';
  } else if (profileScope) {
    scope = profileScope;
    source = 'agent-profile-scope';
  } else if (workingDirectory) {
    scope = workingDirectory;
    source = 'working-directory';
  }

  const matchesActiveFeed = Boolean(scope && activeCanvasScope && scope === activeCanvasScope);
  const warning = scope && activeCanvasScope && !matchesActiveFeed
    ? `Will register in ${scope}, but the active feed is ${activeCanvasScope}.`
    : '';

  return {
    scope,
    source,
    mode,
    matchesActiveFeed,
    warning,
  };
}

function scopeBase(scope: string): string {
  return normalizeScope(scope.split('#')[0] ?? scope);
}

function listScopes(scopes: Iterable<string>): string {
  const values = [...new Set([...scopes].map(normalizeScope).filter(Boolean))].sort();
  if (values.length === 0) return 'none';
  if (values.length <= 3) return values.join(', ');
  return `${values.slice(0, 3).join(', ')} +${values.length - 3} more`;
}

function preflightSummary(preflight: LaunchCommandPreflight): string {
  const executable = preflight.executable || preflight.command || 'command';
  if (!preflight.native) {
    return `Parsed ${executable}; native PATH check will run in the app shell.`;
  }
  if (preflight.resolvedPath) {
    return `${preflight.shell} resolved ${executable} as ${preflight.resolvedPath}.`;
  }
  return `${preflight.shell} accepted ${executable}.`;
}

function postureCopy(preflight: LaunchCommandPreflight | null | undefined): string {
  if (!preflight) return 'unknown';
  return preflight.trustPosture === 'full-access' ? 'full access' : 'standard';
}

export function buildLaunchPreflightReview(input: LaunchPreflightInput): LaunchPreflightReview {
  const cwd = normalizeScope(input.cwd);
  const scope = normalizeScope(input.scope);
  const activeScope = normalizeScope(input.activeScope);
  const harness = trim(input.harness);
  const commandPreflight = input.commandPreflight ?? null;
  const command = trim(commandPreflight?.command) || trim(input.command) || (harness ? harness : '$SHELL');
  const role = trim(input.role) || (harness ? 'unassigned' : 'none');
  const onlineInstances = input.activeInstances.filter(
    (instance) => instance.status === 'online' && instance.adopted !== false,
  );
  const onlineLaunchScopeCount = scope
    ? onlineInstances.filter((instance) => normalizeScope(instance.scope) === scope).length
    : 0;
  const onlineOtherScopes = onlineInstances
    .map((instance) => normalizeScope(instance.scope))
    .filter((instanceScope) => instanceScope && instanceScope !== scope);

  const incongruencies: string[] = [];
  if (!harness) {
    incongruencies.push('No swarm harness selected; this will open a shell without an agent identity or conversation listener.');
  }
  if (!scope) {
    incongruencies.push('No registration scope is resolved yet.');
  }
  if (scope && activeScope && scope !== activeScope) {
    incongruencies.push(`Scope mismatch: active feed is ${activeScope}, but this launch registers in ${scope}.`);
  }
  if (scope && cwd && scopeBase(scope) !== cwd) {
    incongruencies.push(`Directory/scope mismatch: working dir is ${cwd}, but the scope base is ${scopeBase(scope)}.`);
  }
  if (scope && !scope.includes('#fresh-') && onlineInstances.length > 0 && onlineLaunchScopeCount === 0) {
    incongruencies.push(`No online agents are currently in ${scope}; online agents are in ${listScopes(onlineOtherScopes)}.`);
  }
  if (input.commandWarning) {
    incongruencies.push(input.commandWarning);
  }
  if (commandPreflight && !commandPreflight.ok) {
    incongruencies.push(
      `Launch blocked by command preflight: ${commandPreflight.blocker || 'command did not pass preflight.'}`,
    );
  }
  if (commandPreflight?.trustPosture === 'full-access') {
    const warning = `Full-access command posture: ${commandPreflight.executable || command} can bypass normal permission or sandbox checks.`;
    if (!commandPreflight.warnings.includes(warning)) {
      incongruencies.push(warning);
    }
  }
  for (const warning of commandPreflight?.warnings ?? []) {
    if (!incongruencies.includes(warning)) {
      incongruencies.push(warning);
    }
  }

  const summary = [
    `Working dir: ${cwd || 'unresolved'}`,
    `Command: ${command}`,
    `Command source: ${input.commandSource || 'unknown'}`,
    `Preflight: ${commandPreflight ? preflightSummary(commandPreflight) : 'not run'}`,
    `Trust posture: ${postureCopy(commandPreflight)}`,
    `Role: ${role}`,
    `Scope: ${scope || 'unresolved'}`,
    `Scope source: ${input.scopeSource || 'unknown'}`,
    `Active feed: ${activeScope || 'none'}`,
    `Online agents in launch scope: ${onlineLaunchScopeCount}`,
  ];

  const message = [
    'Review this launch before spawning the agent.',
    '',
    ...summary.map((line) => `- ${line}`),
    '',
    incongruencies.length > 0
      ? 'Incongruencies found:'
      : 'No scope, directory, or command incongruencies detected.',
    ...incongruencies.map((issue) => `- ${issue}`),
  ].join('\n');

  return {
    title: incongruencies.length > 0 ? 'Review launch incongruencies' : 'Confirm agent launch',
    message,
    confirmLabel: incongruencies.length > 0 ? 'Launch anyway' : 'Launch agent',
    cancelLabel: 'Review settings',
    hasIncongruencies: incongruencies.length > 0,
    incongruencies,
  };
}
