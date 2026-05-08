import { describe, expect, it } from 'bun:test';
import type { SwarmNodeData } from './types';
import { buildAgentCopyAllText, terminalBufferToText } from './agentCopyAll';

function nodeData(): SwarmNodeData {
  return {
    nodeType: 'bound',
    instance: {
      id: 'agent-1',
      scope: '/repo#main',
      directory: '/repo',
      root: '/repo',
      file_root: '/repo',
      pid: 123,
      label: 'name:Codex role:planner provider:codex',
      registered_at: 1,
      heartbeat: 2,
      adopted: true,
    },
    ptySession: {
      id: 'pty-1',
      command: 'flux9',
      cwd: '/repo',
      started_at: 1,
      exit_code: null,
      bound_instance_id: 'agent-1',
      launch_token: null,
      cols: 120,
      rows: 40,
      lease: null,
    },
    label: 'role:planner',
    status: 'online',
    locks: [],
    assignedTasks: [],
    requestedTasks: [],
    unreadMessages: 0,
    listenerHealth: {
      status: 'waiting',
      label: 'Waiting',
      detail: 'Agent entered wait_for_activity.',
      lastPollAt: null,
      lastWaitAt: null,
      lastWaitReturnAt: null,
      unreadMessages: 0,
      activeTaskCount: 0,
    },
    agentDisplay: {
      name: 'Codex',
      role: 'planner',
      provider: 'codex',
      persona: null,
      mission: 'Plan the lane.',
      skills: '',
      permissions: 'Full access',
      taskCount: 0,
      lockCount: 0,
      unreadMessages: 0,
      listenerLabel: 'Waiting',
    },
    project: null,
    displayName: 'Codex',
    mobileControlled: false,
    mobileLeaseHolder: null,
    browserContext: null,
    browserTabs: [],
    browserSnapshots: [],
    appSurface: null,
  };
}

describe('agent copy all diagnostics', () => {
  it('strips terminal ansi escapes into readable text', () => {
    const text = terminalBufferToText(new TextEncoder().encode('\u001b[31mred\u001b[0m\r\nnext'));
    expect(text).toBe('red\nnext');
  });

  it('combines agent config and terminal text', () => {
    const copied = buildAgentCopyAllText(
      nodeData(),
      'Registered with swarm.',
      new Date('2026-05-06T12:00:00.000Z'),
    );

    expect(copied).toContain('# Agent Copy All');
    expect(copied).toContain('Name: Codex');
    expect(copied).toContain('Scope: /repo#main');
    expect(copied).toContain('Command: flux9');
    expect(copied).toContain('## Runtime Terminal Text');
    expect(copied).toContain('Registered with swarm.');
  });
});
