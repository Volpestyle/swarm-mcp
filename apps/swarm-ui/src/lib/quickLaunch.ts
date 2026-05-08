import type { AgentProfile } from './types';
import { rolePresetForRole } from './agentRolePresets';
import { agentProviderChoiceForHarness } from './agentProviders';

export type QuickLaunchPermissionTone = 'full-access' | 'review' | 'shell' | 'custom';

export interface QuickLaunchProfileSummary {
  id: string;
  name: string;
  command: string;
  meta: string;
  role: string;
  harness: string;
  workingDirectory: string;
  emoji: string;
  roleAccent: string;
  permissionTone: QuickLaunchPermissionTone;
  permissionBadge: 'Review' | 'Full Access' | 'Shell' | 'Custom';
  logoUrl: string | null;
  logoAlt: string;
  providerLabel: string;
  providerSymbol: string;
}

export function chooseQuickLaunchProfileId(
  profiles: AgentProfile[],
  selectedId: string | null | undefined,
): string {
  const selected = selectedId?.trim() ?? '';
  if (selected && profiles.some((profile) => profile.id === selected)) {
    return selected;
  }
  return '';
}

export function summarizeQuickLaunchProfile(
  profile: AgentProfile,
  harnessAliases: Partial<Record<string, string>>,
): QuickLaunchProfileSummary {
  const harness = profile.harness.trim();
  const role = profile.role.trim();
  const command = profile.launchCommand.trim()
    || harnessAliases[harness]?.trim()
    || harness
    || '$SHELL';
  const rolePreset = rolePresetForRole(role);
  const providerChoice = agentProviderChoiceForHarness(harness || command);
  const permission = classifyQuickLaunchPermission(command, harness);
  const meta = [harness || 'custom terminal', role || 'generalist']
    .filter(Boolean)
    .join(' / ');

  return {
    id: profile.id,
    name: profile.name,
    command,
    meta,
    role,
    harness,
    workingDirectory: profile.workingDirectory,
    emoji: profile.emoji.trim() || rolePreset.emoji,
    roleAccent: profile.roleAccent.trim() || rolePreset.accent,
    permissionTone: permission.tone,
    permissionBadge: permission.badge,
    logoUrl: providerChoice?.logoUrl ?? null,
    logoAlt: providerChoice?.logoAlt ?? `${providerChoice?.label ?? 'Agent'} logo`,
    providerLabel: providerChoice?.label ?? (harness || 'Shell'),
    providerSymbol: providerChoice ? providerSymbol(providerChoice.label) : fallbackProviderSymbol(harness, command),
  };
}

export function summarizeQuickLaunchLocation(
  profile: Pick<AgentProfile, 'workingDirectory'>,
  fallbackWorkingDirectory: string | null | undefined,
): string {
  if (profile.workingDirectory.trim()) return 'Saved working dir';
  if (fallbackWorkingDirectory?.trim()) return 'Current working dir';
  return 'Working dir required';
}

function isFullAccessCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === 'flux'
    || normalized === 'flux9'
    || normalized.includes('dangerously')
    || normalized.includes('bypass')
    || normalized.includes('skip-permissions');
}

function classifyQuickLaunchPermission(
  command: string,
  harness: string,
): { tone: QuickLaunchPermissionTone; badge: QuickLaunchProfileSummary['permissionBadge'] } {
  const normalizedCommand = command.trim();
  if (isFullAccessCommand(command)) {
    return { tone: 'full-access', badge: 'Full Access' };
  }
  if (!harness.trim() && (normalizedCommand === '$SHELL' || normalizedCommand.startsWith('/bin/') || normalizedCommand.endsWith('zsh'))) {
    return { tone: 'shell', badge: 'Shell' };
  }
  if (!agentProviderChoiceForHarness(harness || command)) {
    return { tone: 'custom', badge: 'Custom' };
  }
  return { tone: 'review', badge: 'Review' };
}

function providerSymbol(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes('opencode')) return 'OC';
  if (normalized.includes('openai') || normalized.includes('codex')) return 'AI';
  if (normalized.includes('claude') || normalized.includes('anthropic')) return 'A';
  if (normalized.includes('hermes') || normalized.includes('nous')) return 'N';
  if (normalized.includes('openclaw')) return 'CL';
  return fallbackProviderSymbol(label, label);
}

function fallbackProviderSymbol(harness: string, command: string): string {
  const source = (harness || command || '$').trim();
  if (source === '$SHELL') return '$';
  const compact = source.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase();
  return compact || '$';
}
