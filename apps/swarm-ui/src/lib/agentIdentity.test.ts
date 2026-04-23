import { describe, expect, it } from 'bun:test';

import { deriveAgentIdentity } from './agentIdentity';
import type { Instance, PtySession } from './types';

function makeInstance(label: string | null): Instance {
  return {
    id: 'instance-1234567890',
    scope: '/Users/example/projects/swarm-mcp',
    directory: '/Users/example/projects/swarm-mcp',
    root: '/Users/example/projects/swarm-mcp',
    file_root: '/Users/example/projects/swarm-mcp',
    pid: 1234,
    label,
    registered_at: 0,
    heartbeat: 0,
    status: 'online',
    adopted: true,
  };
}

function makePty(command: string): PtySession {
  return {
    id: 'pty-abc',
    command,
    cwd: '/Users/example/projects/swarm-mcp',
    started_at: 0,
    exit_code: null,
    bound_instance_id: null,
    launch_token: null,
    cols: 120,
    rows: 40,
    lease: null,
  };
}

describe('deriveAgentIdentity', () => {
  it('renders Claude labels as Anthropic with the requested Opus display model', () => {
    const identity = deriveAgentIdentity({
      instance: makeInstance('provider:claude role:planner name:Atlas'),
      ptySession: makePty('claude'),
      role: 'planner',
      displayName: 'Atlas',
    });

    expect(identity.providerKind).toBe('anthropic');
    expect(identity.providerLabel).toBe('Anthropic');
    expect(identity.modelLabel).toBe('Claude Opus 4.7');
    expect(identity.nameLabel).toBe('Atlas');
    expect(identity.roleLabel).toBe('Planner');
  });

  it('renders Codex labels as OpenAI with the requested GPT display model', () => {
    const identity = deriveAgentIdentity({
      instance: makeInstance('provider:codex role:implementer name:MJ'),
      ptySession: makePty('codex'),
      role: 'implementer',
      displayName: 'MJ',
    });

    expect(identity.providerKind).toBe('openai');
    expect(identity.providerLabel).toBe('OpenAI');
    expect(identity.modelLabel).toBe('Codex GPT-5.4');
    expect(identity.nameLabel).toBe('MJ');
    expect(identity.roleLabel).toBe('Implementer');
  });

  it('formats explicit model tokens without losing provider context', () => {
    const identity = deriveAgentIdentity({
      instance: makeInstance('provider:anthropic role:researcher model:claude-sonnet-4-6'),
      ptySession: makePty('claude'),
      role: 'researcher',
      displayName: null,
    });

    expect(identity.providerKind).toBe('anthropic');
    expect(identity.modelLabel).toBe('Claude Sonnet 4.6');
    expect(identity.nameLabel).toBe('Researcher');
    expect(identity.roleLabel).toBe('Researcher');
  });

  it('keeps GPT version labels compact when a Codex model token is explicit', () => {
    const identity = deriveAgentIdentity({
      instance: makeInstance('provider:codex role:implementer model:gpt-5.4'),
      ptySession: makePty('codex'),
      role: 'implementer',
      displayName: null,
    });

    expect(identity.modelLabel).toBe('Codex GPT-5.4');
  });
});
