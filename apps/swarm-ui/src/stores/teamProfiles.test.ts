import { describe, expect, it } from 'bun:test';

import {
  createFreshTeamScope,
  normalizeAgentTeamDraft,
  profilesToTeamDraft,
} from './teamProfiles';
import type { AgentProfile } from '../lib/types';

describe('teamProfiles', () => {
  it('normalizes team members and drops empty entries', () => {
    const draft = normalizeAgentTeamDraft({
      name: ' Beast Mode ',
      members: [
        {
          profileId: 'planner',
          profile: {
            name: ' Claude Beast ',
            workingDirectory: ' /tmp/project ',
            harness: ' claude ',
            role: ' planner ',
            scope: '',
            nodeName: ' orchestrator ',
            label: ' team:core ',
            mission: '',
            persona: '',
            specialty: '',
            skills: '',
            context: '',
            memory: '',
            permissions: '',
            launchCommand: '',
            customInstructions: '',
          },
        },
        { profileId: null, profile: {} },
      ],
    });

    expect(draft.name).toBe('Beast Mode');
    expect(draft.members).toHaveLength(1);
    expect(draft.members[0]?.profile.name).toBe('Claude Beast');
    expect(draft.members[0]?.profile.role).toBe('planner');
  });

  it('creates team drafts from saved profiles', () => {
    const profile: AgentProfile = {
      id: 'profile-1',
      updatedAt: 1,
      name: 'Codex Reviewer',
      workingDirectory: '/tmp/project',
      harness: 'codex',
      role: 'reviewer',
      scope: '',
      nodeName: 'reviewer',
      label: 'team:frontend',
      mission: '',
      persona: '',
      specialty: '',
      skills: '',
      context: '',
      memory: '',
      permissions: '',
      launchCommand: '',
      customInstructions: '',
    };

    const draft = profilesToTeamDraft(' Review Team ', [profile]);

    expect(draft.name).toBe('Review Team');
    expect(draft.members[0]?.profileId).toBe('profile-1');
    expect(draft.members[0]?.profile.harness).toBe('codex');
  });

  it('builds fresh team scopes without reusing old instance identity', () => {
    const scope = createFreshTeamScope('/tmp/project', 'Claude Beast + Codex');

    expect(scope.startsWith('/tmp/project#team-claude-beast-codex-')).toBe(true);
  });
});
