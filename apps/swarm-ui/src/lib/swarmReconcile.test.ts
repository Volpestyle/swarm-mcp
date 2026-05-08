import { describe, expect, it } from 'bun:test';

import type { Annotation, Instance, Lock, Message, Task } from './types';
import { reconcileLocalInstanceRemoval } from './swarmReconcile';

function instance(id: string): Instance {
  return {
    id,
    scope: '/scope',
    directory: '/repo',
    root: '/repo',
    file_root: '/repo',
    pid: 123,
    label: 'provider:codex role:implementer',
    registered_at: 1,
    heartbeat: 2,
    status: 'online',
    adopted: true,
  };
}

function task(input: Pick<Task, 'id' | 'status'> & Partial<Task>): Task {
  return {
    id: input.id,
    scope: '/scope',
    type: 'implement',
    title: input.title ?? input.id,
    description: input.description ?? null,
    requester: input.requester ?? 'planner',
    assignee: input.assignee ?? null,
    status: input.status,
    files: input.files ?? [],
    result: input.result ?? null,
    created_at: 1,
    updated_at: 2,
    changed_at: 3,
    priority: 0,
    depends_on: [],
    parent_task_id: null,
  };
}

describe('reconcileLocalInstanceRemoval', () => {
  it('removes vanished instances and mirrors deregister cleanup locally', () => {
    const messages: Message[] = [
      { id: 1, scope: '/scope', sender: 'other', recipient: 'gone', content: 'queued', created_at: 1, read: false },
      { id: 2, scope: '/scope', sender: 'gone', recipient: 'other', content: 'history', created_at: 2, read: true },
    ];
    const locks: Lock[] = [
      { scope: '/scope', file: '/repo/a.ts', instance_id: 'gone' },
      { scope: '/scope', file: '/repo/b.ts', instance_id: 'live' },
    ];
    const annotations: Annotation[] = [
      { id: 'lock-1', scope: '/scope', instance_id: 'gone', file: '/repo/a.ts', type: 'lock', content: 'held', created_at: 1 },
      { id: 'note-1', scope: '/scope', instance_id: 'gone', file: '/repo/a.ts', type: 'note', content: 'keep note', created_at: 2 },
    ];

    const result = reconcileLocalInstanceRemoval({
      instances: new Map([['gone', instance('gone')], ['live', instance('live')]]),
      tasks: new Map([
        ['claimed', task({ id: 'claimed', assignee: 'gone', status: 'claimed' })],
        ['active', task({ id: 'active', assignee: 'gone', status: 'in_progress' })],
        ['blocked', task({ id: 'blocked', assignee: 'gone', status: 'blocked' })],
        ['done', task({ id: 'done', assignee: 'gone', status: 'done' })],
      ]),
      messages,
      locks,
      annotations,
    }, ['gone']);

    expect(result.changed).toBe(true);
    expect([...result.instances.keys()]).toEqual(['live']);
    expect(result.tasks.get('claimed')?.status).toBe('open');
    expect(result.tasks.get('claimed')?.assignee).toBeNull();
    expect(result.tasks.get('active')?.status).toBe('open');
    expect(result.tasks.get('blocked')?.status).toBe('blocked');
    expect(result.tasks.get('blocked')?.assignee).toBeNull();
    expect(result.tasks.get('done')?.assignee).toBe('gone');
    expect(result.messages).toEqual([messages[1]]);
    expect(result.locks).toEqual([locks[1]]);
    expect(result.annotations).toEqual([annotations[1]]);
  });

  it('reports unchanged for empty cleanup input', () => {
    const state = {
      instances: new Map([['live', instance('live')]]),
      tasks: new Map<string, Task>(),
      messages: [],
      locks: [],
      annotations: [],
    };
    const result = reconcileLocalInstanceRemoval(state, []);

    expect(result.changed).toBe(false);
    expect(result.instances).toBe(state.instances);
  });
});
