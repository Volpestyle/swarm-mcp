import { describe, expect, it } from 'bun:test';

import { buildGraph } from './graph';
import type { BindingState, Instance, PtySession } from './types';

function makePty(id: string, boundInstanceId: string | null): PtySession {
  return {
    id,
    command: 'claude',
    cwd: '/Users/example/projects/swarm-mcp',
    started_at: 0,
    exit_code: null,
    bound_instance_id: boundInstanceId,
    launch_token: null,
    cols: 120,
    rows: 40,
    lease: null,
  };
}

function makeInstance(id: string, scope: string): Instance {
  return {
    id,
    scope,
    directory: '/Users/example/projects/swarm-mcp',
    root: '/Users/example/projects/swarm-mcp',
    file_root: '/Users/example/projects/swarm-mcp',
    pid: 1234,
    label: 'role:reviewer provider:claude',
    registered_at: 0,
    heartbeat: 0,
    status: 'online',
    adopted: true,
  };
}

describe('buildGraph', () => {
  it('hides resolved bound PTYs when their instance is outside the active scope', () => {
    const ptySessions = new Map<string, PtySession>([
      ['pty-1', makePty('pty-1', 'instance-1')],
    ]);
    const bindings: BindingState = {
      pending: [],
      resolved: [['instance-1', 'pty-1']],
    };

    const graph = buildGraph(
      new Map<string, Instance>(),
      ptySessions,
      new Map(),
      [],
      [],
      bindings,
      '/scope-a',
      {},
    );

    expect(graph.nodes).toHaveLength(0);
  });

  it('renders orphaned PTYs when their cwd still belongs to the active scope', () => {
    const ptySessions = new Map<string, PtySession>([
      ['pty-1', { ...makePty('pty-1', 'instance-1'), cwd: '/scope-a/worktree' }],
    ]);
    const bindings: BindingState = {
      pending: [],
      resolved: [['instance-1', 'pty-1']],
    };

    const graph = buildGraph(
      new Map<string, Instance>(),
      ptySessions,
      new Map(),
      [],
      [],
      bindings,
      '/scope-a',
      {},
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['pty:pty-1']);
  });

  it('renders bound nodes when the scoped instance is present', () => {
    const instances = new Map<string, Instance>([
      ['instance-1', makeInstance('instance-1', '/scope-a')],
    ]);
    const ptySessions = new Map<string, PtySession>([
      ['pty-1', makePty('pty-1', 'instance-1')],
    ]);
    const bindings: BindingState = {
      pending: [],
      resolved: [['instance-1', 'pty-1']],
    };

    const graph = buildGraph(
      instances,
      ptySessions,
      new Map(),
      [],
      [],
      bindings,
      '/scope-a',
      {},
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['bound:instance-1']);
  });
});
