import { describe, expect, it } from 'bun:test';

import { buildAgentActivitySummary, formatCost, formatTokens } from './agentActivity';
import type { SwarmNodeData } from './types';

function makeData(patch: Partial<SwarmNodeData> = {}): SwarmNodeData {
  return {
    nodeType: 'instance',
    instance: null,
    ptySession: null,
    label: 'agent',
    status: 'online',
    locks: [],
    assignedTasks: [],
    requestedTasks: [],
    unreadMessages: 0,
    listenerHealth: {
      status: 'listening',
      label: 'Listening',
      detail: 'No work yet',
      lastPollAt: null,
      lastWaitAt: null,
      lastWaitReturnAt: null,
      unreadMessages: 0,
      activeTaskCount: 0,
    },
    agentDisplay: {
      name: 'Agent',
      role: 'implementer',
      provider: 'codex',
      persona: null,
      mission: '',
      skills: '',
      permissions: '',
      taskCount: 0,
      lockCount: 0,
      unreadMessages: 0,
      listenerLabel: 'Listening',
    },
    project: null,
    displayName: null,
    mobileControlled: false,
    mobileLeaseHolder: null,
    browserContext: null,
    browserTabs: [],
    browserSnapshots: [],
    appSurface: null,
    ...patch,
  };
}

describe('agent activity summary', () => {
  it('does not invent a file when no task, lock, browser, or app proves one', () => {
    const summary = buildAgentActivitySummary(makeData());
    expect(summary.title).toBe('Standing by');
    expect(summary.detail).toBe('No work yet');
    expect(summary.icon.kind).toBe('project-folder');
  });

  it('uses task files as the current proven work path', () => {
    const summary = buildAgentActivitySummary(makeData({
      assignedTasks: [{
        id: 'task-1',
        scope: '/repo',
        requester: 'operator',
        assignee: 'agent-1',
        title: 'Update README',
        description: '',
        status: 'in_progress',
        type: 'feature',
        priority: 0,
        parent_task_id: null,
        depends_on: [],
        files: ['/repo/README.md'],
        result: null,
        created_at: 1,
        updated_at: 1,
        changed_at: 1,
      }],
    }));

    expect(summary.title).toBe('Update README');
    expect(summary.path).toBe('/repo/README.md');
    expect(summary.icon.kind).toBe('notes');
  });

  it('formats usage chips compactly', () => {
    expect(formatTokens(1250)).toBe('1.3K tok');
    expect(formatCost(0.004)).toBe('<$0.01');
  });
});
