import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_LAUNCH_PROFILES,
  normalizeLaunchProfile,
  normalizeLaunchProfiles,
} from './launchProfiles';

describe('launchProfiles', () => {
  it('normalizes a custom profile with explicit trust posture', () => {
    const profile = normalizeLaunchProfile({
      id: 'trusted-local',
      name: 'Trusted Local',
      harness: 'codex',
      trustPosture: 'trusted-local',
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
    });

    expect(profile).not.toBeNull();
    expect(profile?.trustPosture).toBe('trusted-local');
    expect(profile?.command).toContain('codex');
  });

  it('returns built-in defaults when user storage is empty', () => {
    const profiles = normalizeLaunchProfiles(undefined);

    expect(profiles.length).toBeGreaterThanOrEqual(DEFAULT_LAUNCH_PROFILES.length);
  });

  it('drops invalid custom profiles before falling back to defaults', () => {
    const profiles = normalizeLaunchProfiles([
      { id: 'missing-command', name: 'Missing Command', harness: 'codex' },
    ]);

    expect(profiles).toEqual(DEFAULT_LAUNCH_PROFILES);
  });
});
