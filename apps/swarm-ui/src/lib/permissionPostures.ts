export type HarnessPermissionPresetId = 'standard' | 'claude-full-access' | 'codex-full-access';

export interface HarnessPermissionPreset {
  id: HarnessPermissionPresetId;
  label: string;
  harness: 'claude' | 'codex' | '';
  permissionCopy: string;
  command: string;
  description: string;
}

export const HARNESS_PERMISSION_PRESETS: HarnessPermissionPreset[] = [
  {
    id: 'standard',
    label: 'Standard',
    harness: '',
    permissionCopy: 'Standard harness permissions; ask before high-risk operations.',
    command: '',
    description: 'Clears profile command override and uses the selected Launch Profile or harness alias.',
  },
  {
    id: 'claude-full-access',
    label: 'Claude full access',
    harness: 'claude',
    permissionCopy: 'Full access: Claude permission bypass via flux.',
    command: 'flux',
    description: 'Runs flux instead of claude so Claude starts with dangerous permission bypass.',
  },
  {
    id: 'codex-full-access',
    label: 'Codex full access',
    harness: 'codex',
    permissionCopy: 'Full access: Codex approval and sandbox bypass via flux9.',
    command: 'flux9',
    description: 'Runs flux9 instead of codex so Codex starts with approval and sandbox bypass.',
  },
];

const FULL_ACCESS_PATTERN = /\b(full\s*(permission|permissions|access)|dangerous|dangerously|bypass|skip[-\s]*permissions?)\b/i;

function normalizeHarness(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function inferLaunchCommandFromPermissions(
  harness: string | null | undefined,
  permissions: string | null | undefined,
): string {
  const normalizedHarness = normalizeHarness(harness);
  const normalizedPermissions = permissions?.trim() ?? '';
  if (!normalizedPermissions || !FULL_ACCESS_PATTERN.test(normalizedPermissions)) return '';

  if (normalizedHarness.includes('claude')) return 'flux';
  if (normalizedHarness.includes('codex')) return 'flux9';
  return '';
}

export function presetForPermissionState(
  harness: string,
  permissions: string,
  launchCommand: string,
): HarnessPermissionPresetId | '' {
  const normalizedHarness = normalizeHarness(harness);
  const normalizedPermissions = permissions.trim();
  const normalizedCommand = launchCommand.trim();

  if (!normalizedPermissions && !normalizedCommand) return '';
  if (
    normalizedHarness === 'claude'
    && normalizedCommand === 'flux'
    && normalizedPermissions === HARNESS_PERMISSION_PRESETS[1].permissionCopy
  ) {
    return 'claude-full-access';
  }
  if (
    normalizedHarness === 'codex'
    && normalizedCommand === 'flux9'
    && normalizedPermissions === HARNESS_PERMISSION_PRESETS[2].permissionCopy
  ) {
    return 'codex-full-access';
  }
  if (!normalizedCommand && normalizedPermissions === HARNESS_PERMISSION_PRESETS[0].permissionCopy) {
    return 'standard';
  }

  return '';
}
