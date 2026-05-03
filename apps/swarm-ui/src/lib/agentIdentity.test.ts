import { describe, expect, it } from 'bun:test';

import {
  agentIdentityFromLabel,
  mergeAgentLabelToken,
  mergeAgentLabelTokens,
  normalizeLabelTokenValue,
} from './agentIdentity';

describe('agentIdentityFromLabel', () => {
  it('extracts name, role, provider, and persona from label tokens', () => {
    const identity = agentIdentityFromLabel('provider:codex role:planner name:Orion persona:owl');
    expect(identity.provider).toBe('codex');
    expect(identity.role).toBe('planner');
    expect(identity.name).toBe('Orion');
    expect(identity.persona).toBe('owl');
  });

  it('preserves colon-containing token values', () => {
    const identity = agentIdentityFromLabel('provider:codex mission:repo:/tmp/demo');
    expect(identity.mission).toBe('repo:/tmp/demo');
  });
});

describe('mergeAgentLabelToken', () => {
  it('replaces an existing token without duplicating it', () => {
    expect(mergeAgentLabelToken('role:planner name:Orion', 'role', 'reviewer'))
      .toBe('name:Orion role:reviewer');
  });

  it('removes an existing token when the next value is blank', () => {
    expect(mergeAgentLabelToken('role:planner name:Orion', 'role', ''))
      .toBe('name:Orion');
  });
});

describe('mergeAgentLabelTokens', () => {
  it('updates multiple tokens while preserving unrelated values', () => {
    expect(
      mergeAgentLabelTokens('provider:codex role:planner name:Orion team:ui', {
        name: 'Vega Prime',
        role: 'reviewer',
      }),
    ).toBe('provider:codex team:ui name:Vega_Prime role:reviewer');
  });
});

describe('normalizeLabelTokenValue', () => {
  it('converts whitespace to underscores for label-token compatibility', () => {
    expect(normalizeLabelTokenValue('  Agent One  ')).toBe('Agent_One');
  });
});
