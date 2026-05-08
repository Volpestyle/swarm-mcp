import { describe, expect, it } from 'bun:test';

import {
  buildAgentProfilePrompt,
  moveAgentProfileInTier,
  normalizeAgentProfileDraft,
  rankAgentProfiles,
} from './agentProfiles';
import type { AgentProfile } from '../lib/types';

describe('buildAgentProfilePrompt', () => {
  it('formats only the filled instruction fields', () => {
    const prompt = buildAgentProfilePrompt({
      mission: 'Audit the code path before shipping.',
      persona: 'Calm reviewer',
      specialty: 'Regression hunting',
      skills: 'rg, git diff, targeted test runs',
      context: '',
      memory: 'Prefer reading recent failures before proposing fixes.',
      permissions: 'Workspace edits allowed, no destructive git commands.',
      customInstructions: '',
    });

    expect(prompt).toContain('Mission: Audit the code path before shipping.');
    expect(prompt).toContain('Persona: Calm reviewer');
    expect(prompt).toContain('Specialty: Regression hunting');
    expect(prompt).toContain('Skills and tools to lean on: rg, git diff, targeted test runs');
    expect(prompt).toContain('Memory and carry-forward notes: Prefer reading recent failures before proposing fixes.');
    expect(prompt).toContain('Permissions and access posture: Workspace edits allowed, no destructive git commands.');
    expect(prompt).not.toContain('Context and look-back guidance:');
    expect(prompt).not.toContain('Additional custom instructions:');
  });
});

describe('normalizeAgentProfileDraft', () => {
  it('migrates legacy Claude full-permission notes into the flux launch command', () => {
    const draft = normalizeAgentProfileDraft({
      harness: 'claude',
      permissions: 'full permission',
      launchCommand: '',
    });

    expect(draft.launchCommand).toBe('flux');
  });

  it('migrates legacy Codex full-access notes into the flux9 launch command', () => {
    const draft = normalizeAgentProfileDraft({
      harness: 'codex',
      permissions: 'full access',
      launchCommand: '',
    });

    expect(draft.launchCommand).toBe('flux9');
  });

  it('keeps an explicit launch command instead of replacing it from permissions text', () => {
    const draft = normalizeAgentProfileDraft({
      harness: 'claude',
      permissions: 'full permission',
      launchCommand: 'custom-claude-wrapper',
    });

    expect(draft.launchCommand).toBe('custom-claude-wrapper');
  });

  it('normalizes role look fields for saved-agent cards', () => {
    const draft = normalizeAgentProfileDraft({
      role: 'planner',
      emoji: '🦉',
      roleAccent: 'cyan',
    });

    expect(draft.emoji).toBe('🦉');
    expect(draft.roleAccent).toBe('cyan');
  });
});

const profileBase: AgentProfile = {
  id: 'profile-1',
  name: 'One',
  workingDirectory: '/tmp',
  harness: 'claude',
  role: 'planner',
  scope: '',
  nodeName: '',
  label: '',
  mission: '',
  persona: '',
  specialty: '',
  skills: '',
  context: '',
  memory: '',
  permissions: '',
  launchCommand: 'flux',
  customInstructions: '',
  emoji: '🦉',
  roleAccent: 'cyan',
  tierRank: 1,
  updatedAt: 100,
};

describe('agent profile tier ordering', () => {
  it('sorts profiles by explicit tier rank before update time', () => {
    const ranked = rankAgentProfiles([
      { ...profileBase, id: 'profile-2', name: 'Two', tierRank: 2, updatedAt: 200 },
      { ...profileBase, id: 'profile-1', name: 'One', tierRank: 1, updatedAt: 100 },
    ]);

    expect(ranked.map((profile) => profile.id)).toEqual(['profile-1', 'profile-2']);
  });

  it('moves a saved agent to the top tier slot', () => {
    const moved = moveAgentProfileInTier([
      { ...profileBase, id: 'profile-1', name: 'One', tierRank: 1 },
      { ...profileBase, id: 'profile-2', name: 'Two', tierRank: 2 },
    ], 'profile-2', 'top');

    expect(moved.map((profile) => [profile.id, profile.tierRank])).toEqual([
      ['profile-2', 1],
      ['profile-1', 2],
    ]);
  });
});
