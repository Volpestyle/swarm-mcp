import { describe, expect, it } from 'bun:test';

import {
  chooseQuickLaunchProfileId,
  summarizeQuickLaunchLocation,
  summarizeQuickLaunchProfile,
} from './quickLaunch';
import type { AgentProfile } from './types';

const baseProfile: AgentProfile = {
  id: 'profile-1',
  name: 'Claude Beast',
  workingDirectory: '/Users/mathewfrazier/Desktop/swarm-mcp-lab',
  harness: 'claude',
  role: 'planner',
  scope: '',
  nodeName: 'Claude_Planner',
  label: '',
  mission: '',
  persona: '',
  specialty: '',
  skills: '',
  context: '',
  memory: '',
  permissions: 'Full access: Claude permission bypass via flux.',
  launchCommand: 'flux',
  customInstructions: '',
  emoji: '🦉',
  roleAccent: 'cyan',
  tierRank: 1,
  updatedAt: 100,
};

describe('quick launch profile helpers', () => {
  it('keeps a valid selected profile as the quick-launch default', () => {
    expect(chooseQuickLaunchProfileId([baseProfile], 'profile-1')).toBe('profile-1');
  });

  it('does not auto-select a saved profile when the explicit selection is missing', () => {
    expect(chooseQuickLaunchProfileId([baseProfile], 'missing')).toBe('');
    expect(chooseQuickLaunchProfileId([baseProfile], '')).toBe('');
  });

  it('summarizes the actual command a saved profile will auto-type', () => {
    const summary = summarizeQuickLaunchProfile(baseProfile, {
      claude: 'claude',
      codex: 'codex',
    });

    expect(summary.name).toBe('Claude Beast');
    expect(summary.command).toBe('flux');
    expect(summary.permissionTone).toBe('full-access');
    expect(summary.permissionBadge).toBe('Full Access');
    expect(summary.emoji).toBe('🦉');
    expect(summary.meta).toContain('claude');
    expect(summary.meta).toContain('planner');
    expect(summary.providerLabel).toBe('Claude Code');
  });

  it('summarizes saved working directories without exposing absolute paths', () => {
    expect(summarizeQuickLaunchLocation(baseProfile, '/Users/mathewfrazier/Desktop')).toBe('Saved working dir');
    expect(
      summarizeQuickLaunchLocation({
        ...baseProfile,
        workingDirectory: '',
      }, '/Users/mathewfrazier/Desktop'),
    ).toBe('Current working dir');
  });

  it('summarizes custom non-swarm terminal agents from their command override', () => {
    const summary = summarizeQuickLaunchProfile({
      ...baseProfile,
      name: 'Hermes Agent',
      harness: '',
      role: 'operator',
      launchCommand: 'hermes-agent',
      emoji: '◇',
    }, {});

    expect(summary.command).toBe('hermes-agent');
    expect(summary.meta).toContain('custom terminal');
    expect(summary.emoji).toBe('◇');
    expect(summary.permissionBadge).toBe('Custom');
  });
});
