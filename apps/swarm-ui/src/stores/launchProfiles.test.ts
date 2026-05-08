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

  it('includes Hermes, OpenClaw, and OpenCode launch profiles', () => {
    const defaultsById = new Map(DEFAULT_LAUNCH_PROFILES.map((profile) => [profile.id, profile]));

    expect(defaultsById.get('hermes-nous')?.command).toBe('hermes --tui');
    expect(defaultsById.get('openclaw-local')?.command).toBe('openclaw chat');
    expect(defaultsById.get('opencode-local')?.command).toBe('opencode');
  });

  it('drops invalid custom profiles before falling back to defaults', () => {
    const profiles = normalizeLaunchProfiles([
      { id: 'missing-command', name: 'Missing Command', harness: 'codex' },
    ]);

    expect(profiles).toEqual(DEFAULT_LAUNCH_PROFILES);
  });

  it('merges new built-in profiles into older stored profile lists', () => {
    const profiles = normalizeLaunchProfiles([
      {
        id: 'trusted-local',
        name: 'Trusted Local',
        harness: 'codex',
        command: 'flux9',
        trustPosture: 'trusted-local',
        defaultRole: 'implementer',
        defaultScopeMode: 'follow-canvas',
      },
    ]);
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));

    expect(byId.get('trusted-local')?.command).toBe('flux9');
    expect(byId.has('opencode-local')).toBe(true);
    expect(byId.has('hermes-nous')).toBe(true);
    expect(byId.has('openclaw-local')).toBe(true);
  });
});
