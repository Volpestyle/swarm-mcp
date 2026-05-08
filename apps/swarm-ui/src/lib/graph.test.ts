import { describe, expect, it } from 'bun:test';

import { buildGraph } from './graph';
import type { BindingState, BrowserContext, BrowserTab, CanvasAppSurface, Instance, Message, PtySession } from './types';

function makePty(id: string, boundInstanceId: string | null): PtySession {
  return {
    id,
    command: 'claude',
    cwd: '/Users/mathewfrazier/Desktop/swarm-mcp-active',
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
    directory: '/Users/mathewfrazier/Desktop/swarm-mcp-active',
    root: '/Users/mathewfrazier/Desktop/swarm-mcp-active',
    file_root: '/Users/mathewfrazier/Desktop/swarm-mcp-active',
    pid: 1234,
    label: 'role:reviewer provider:claude',
    registered_at: 0,
    heartbeat: 0,
    status: 'online',
    adopted: true,
  };
}

function makeBrowserContext(id: string, scope: string): BrowserContext {
  return {
    id,
    scope,
    ownerInstanceId: null,
    endpoint: 'http://127.0.0.1:9444',
    host: '127.0.0.1',
    port: 9444,
    profileDir: `/tmp/${id}`,
    pid: 42,
    startUrl: 'https://example.com',
    status: 'open',
    createdAt: 1,
    updatedAt: 2,
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
      [],
      bindings,
      '/scope-a',
      {},
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['pty:pty-1']);
    expect(graph.nodes[0]?.data.status).toBe('pending');
  });

  it('does not render a bound PTY as pending when its instance belongs to another channel', () => {
    const ptySessions = new Map<string, PtySession>([
      ['pty-1', { ...makePty('pty-1', 'instance-1'), cwd: '/scope-a/worktree' }],
    ]);
    const allInstances = new Map<string, Instance>([
      ['instance-1', makeInstance('instance-1', '/scope-b')],
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
      [],
      bindings,
      '/scope-a',
      {},
      [],
      [],
      [],
      allInstances,
    );

    expect(graph.nodes).toHaveLength(0);
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
      [],
      bindings,
      '/scope-a',
      {},
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['bound:instance-1']);
  });

  it('surfaces unread incoming messages on node data', () => {
    const instances = new Map<string, Instance>([
      ['instance-1', makeInstance('instance-1', '/scope-a')],
      ['instance-2', makeInstance('instance-2', '/scope-a')],
    ]);
    const messages: Message[] = [
      {
        id: 1,
        scope: '/scope-a',
        sender: 'instance-2',
        recipient: 'instance-1',
        content: 'please act',
        created_at: 1,
        read: false,
      },
      {
        id: 2,
        scope: '/scope-a',
        sender: 'instance-2',
        recipient: 'instance-1',
        content: 'already read',
        created_at: 2,
        read: true,
      },
    ];

    const graph = buildGraph(
      instances,
      new Map(),
      new Map(),
      messages,
      [],
      [],
      { pending: [], resolved: [] },
      '/scope-a',
      {},
    );

    const target = graph.nodes.find((node) => node.id === 'instance:instance-1');
    expect(target?.data?.unreadMessages).toBe(1);
    expect(target?.data?.listenerHealth.status).toBe('needs_poll');
  });

  it('renders managed browser contexts as canvas nodes', () => {
    const context = makeBrowserContext('ctx-1', '/scope-a');
    const tabs: BrowserTab[] = [
      {
        scope: '/scope-a',
        contextId: 'ctx-1',
        tabId: 'tab-1',
        tabType: 'page',
        url: 'https://example.com',
        title: 'Example',
        active: true,
        updatedAt: 2,
      },
    ];

    const graph = buildGraph(
      new Map(),
      new Map(),
      new Map(),
      [],
      [],
      [],
      { pending: [], resolved: [] },
      '/scope-a',
      {},
      [context],
      tabs,
      [],
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['browser:ctx-1']);
    expect(graph.nodes[0]?.type).toBe('browser');
    expect(graph.nodes[0]?.data.browserTabs[0]?.title).toBe('Example');
  });

  it('renders native app surfaces as canvas nodes', () => {
    const surface: CanvasAppSurface = {
      id: 'notes-1',
      appId: 'notes',
      name: 'Notes',
      detail: 'Operator-visible notes app.',
      icon: '/notes.png',
      scope: '/scope-a',
      status: 'open',
      createdAt: 1,
      updatedAt: 2,
      document: null,
    };

    const graph = buildGraph(
      new Map(),
      new Map(),
      new Map(),
      [],
      [],
      [],
      { pending: [], resolved: [] },
      '/scope-a',
      {},
      [],
      [],
      [],
      new Map(),
      [surface],
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(['app:notes-1']);
    expect(graph.nodes[0]?.type).toBe('appSurface');
    expect(graph.nodes[0]?.data.appSurface?.name).toBe('Notes');
  });
});
