import { describe, expect, it } from 'bun:test';

import { deriveAgentListenerHealth } from './agentListenerHealth';
import type { Event, Instance, Task } from './types';

function makeInstance(patch: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    scope: '/scope-a',
    directory: '/scope-a',
    root: '/scope-a',
    file_root: '/scope-a',
    pid: 1234,
    label: 'provider:codex role:implementer',
    registered_at: 10,
    heartbeat: 100,
    status: 'online',
    adopted: true,
    ...patch,
  };
}

function makeTask(status: Task['status']): Task {
  return {
    id: `task-${status}`,
    scope: '/scope-a',
    type: 'implement',
    title: 'Do work',
    description: null,
    requester: 'planner',
    assignee: 'instance-1',
    status,
    files: null,
    result: null,
    created_at: 10,
    updated_at: 10,
    changed_at: 10,
    priority: 0,
    depends_on: null,
    idempotency_key: null,
    parent_task_id: null,
  };
}

function makeEvent(type: string, createdAt: number): Event {
  return {
    id: createdAt,
    scope: '/scope-a',
    type,
    actor: 'instance-1',
    subject: 'instance-1',
    payload: null,
    created_at: createdAt,
  };
}

describe('deriveAgentListenerHealth', () => {
  it('marks an unregistered PTY as needing register', () => {
    const health = deriveAgentListenerHealth({
      instance: null,
      activeScope: '/scope-a',
      unreadMessages: 0,
      assignedTasks: [],
      events: [],
    });

    expect(health.status).toBe('unregistered');
    expect(health.label).toBe('Register needed');
  });

  it('marks unread messages as needs-poll', () => {
    const health = deriveAgentListenerHealth({
      instance: makeInstance(),
      activeScope: '/scope-a',
      unreadMessages: 2,
      assignedTasks: [],
      events: [makeEvent('agent.polled', 90)],
    });

    expect(health.status).toBe('needs_poll');
    expect(health.label).toBe('Needs poll');
    expect(health.lastPollAt).toBe(90);
  });

  it('prefers active task state over idle listener state', () => {
    const health = deriveAgentListenerHealth({
      instance: makeInstance(),
      activeScope: '/scope-a',
      unreadMessages: 0,
      assignedTasks: [makeTask('in_progress')],
      events: [makeEvent('agent.waiting', 120)],
    });

    expect(health.status).toBe('working');
    expect(health.activeTaskCount).toBe(1);
    expect(health.lastWaitAt).toBe(120);
  });

  it('marks recent wait loop activity as listening', () => {
    const health = deriveAgentListenerHealth({
      instance: makeInstance(),
      activeScope: '/scope-a',
      unreadMessages: 0,
      assignedTasks: [],
      events: [makeEvent('agent.waiting', 120)],
    });

    expect(health.status).toBe('listening');
    expect(health.label).toBe('Listening');
  });

  it('flags visible scope mismatches', () => {
    const health = deriveAgentListenerHealth({
      instance: makeInstance({ scope: '/scope-b' }),
      activeScope: '/scope-a',
      unreadMessages: 0,
      assignedTasks: [],
      events: [],
    });

    expect(health.status).toBe('scope_mismatch');
  });
});
