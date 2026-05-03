import { describe, expect, it } from 'bun:test';
import {
  canRetryTaskBoardRow,
  resolveTaskBoardRowRuntime,
  taskBoardRowInstanceId,
} from './taskBoardState';

describe('taskBoardState', () => {
  it('uses launch instance ids before editable assignee text', () => {
    expect(taskBoardRowInstanceId({
      assignee: 'manual-agent',
      launchInstanceId: 'agent-1',
      launchStatus: 'launched',
    })).toBe('agent-1');
  });

  it('treats online launched agents as active listeners', () => {
    const runtime = resolveTaskBoardRowRuntime(
      {
        launchInstanceId: 'agent-1',
        launchStatus: 'launched',
        listenerState: 'launched and bound',
      },
      [{ id: 'agent-1', status: 'online' }],
    );

    expect(runtime.state).toBe('launched');
    expect(runtime.stale).toBe(false);
    expect(runtime.listenerState).toBe('launched and bound');
  });

  it('marks missing launched agents as stale and retryable', () => {
    const row = {
      launchInstanceId: 'agent-missing-1',
      launchStatus: 'launched' as const,
      listenerState: 'launched and bound',
    };
    const runtime = resolveTaskBoardRowRuntime(row, []);

    expect(runtime.state).toBe('stale');
    expect(runtime.instanceStatus).toBe('missing');
    expect(runtime.launchError).toContain('missing from live swarm state');
    expect(canRetryTaskBoardRow(row, [])).toBe(true);
  });

  it('marks stale or offline instances as stale and retryable', () => {
    const row = {
      launchInstanceId: 'agent-stale-1',
      launchStatus: 'launched' as const,
    };
    const runtime = resolveTaskBoardRowRuntime(row, [{ id: 'agent-stale-1', status: 'stale' }]);

    expect(runtime.state).toBe('stale');
    expect(runtime.listenerState).toBe('stale - stale');
    expect(canRetryTaskBoardRow(row, [{ id: 'agent-stale-1', status: 'stale' }])).toBe(true);
  });

  it('keeps pty-only launches non-stale while they await adoption', () => {
    const runtime = resolveTaskBoardRowRuntime(
      {
        assignee: 'pty:pty-1',
        launchPtyId: 'pty-1',
        launchStatus: 'launched',
      },
      [],
    );

    expect(runtime.state).toBe('launched');
    expect(runtime.stale).toBe(false);
    expect(runtime.listenerState).toBe('pty launched, awaiting agent adoption');
  });
});
