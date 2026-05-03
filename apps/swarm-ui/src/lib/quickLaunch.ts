import type { AgentProfile } from './types';
import { rolePresetForRole } from './agentRolePresets';

export type QuickLaunchPermissionTone = 'full-access' | 'standard';

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
}

export function chooseQuickLaunchProfileId(
  profiles: AgentProfile[],
  selectedId: string | null | undefined,
): string {
  const selected = selectedId?.trim() ?? '';
  if (selected && profiles.some((profile) => profile.id === selected)) {
    return selected;
  }
  return profiles[0]?.id ?? '';
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
    permissionTone: isFullAccessCommand(command) ? 'full-access' : 'standard',
  };
}

function isFullAccessCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === 'flux'
    || normalized === 'flux9'
    || normalized.includes('dangerously')
    || normalized.includes('bypass')
    || normalized.includes('skip-permissions');
}
