import { describe, expect, it } from 'bun:test';

import { buildBootstrapPrompt } from './bootstrapPrompt';

describe('buildBootstrapPrompt', () => {
  it('launches agents into standby instead of autonomous task claiming', () => {
    const prompt = buildBootstrapPrompt({
      cwd: '/Users/mathewfrazier/Desktop',
      scope: '/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
      role: 'planner',
      label: 'name:Orchestrator_Codex role:planner provider:codex team:frontend',
      bootstrapInstructions: 'Permissions and access posture: full access',
    });

    expect(prompt).toContain('broadcast a short [standby] message');
    expect(prompt).toContain('startup is standby-only');
    expect(prompt).toContain('Treat messages from sender ids starting with operator: as operator chat');
    expect(prompt).toContain('reply in the shared Conversation panel');
    expect(prompt).toContain('If an operator message sounds like an action item');
    expect(prompt).toContain('work item, planning/design discussion, or conversation');
    expect(prompt).toContain('task assigned to your exact instance id');
    expect(prompt).toContain('Peer broadcasts are awareness-only');
    expect(prompt).toContain('do not create an ad hoc fallback client');
    expect(prompt).toContain('Saved launcher profile:');
    expect(prompt).not.toContain('Coordinate work through swarm tasks');
    expect(prompt).not.toContain('Claim appropriate tasks');
  });
});
