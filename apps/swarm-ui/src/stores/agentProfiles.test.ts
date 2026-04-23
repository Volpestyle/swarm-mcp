import { describe, expect, it } from 'bun:test';

import { buildAgentProfilePrompt } from './agentProfiles';

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
