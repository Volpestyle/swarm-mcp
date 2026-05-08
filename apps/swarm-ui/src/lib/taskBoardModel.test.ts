import { describe, expect, it } from 'bun:test';

import {
  createDraftTaskRow,
  groupTaskBoardRows,
  parsePlanRows,
  providerToLaunchHarness,
  taskRowsForProofPack,
  taskLaunchLabel,
  type TaskBoardRow,
} from './taskBoardModel';

function row(input: Partial<TaskBoardRow>): TaskBoardRow {
  return {
    id: 'task-row-1',
    projectId: 'project-1',
    sourceTaskId: 'task-1',
    section: 'Build',
    title: 'Launch missing agent',
    description: '',
    status: 'claimed',
    provider: 'codex',
    role: 'implementer',
    assignee: '',
    listenerState: 'launched and bound',
    elapsed: '1m',
    lastActivity: 'just now',
    result: '',
    files: [],
    priority: 2,
    selected: true,
    draft: false,
    launchStatus: 'launched',
    launchPtyId: '',
    launchInstanceId: 'agent-missing-123',
    launchError: '',
    ...input,
  };
}

describe('task board model', () => {
  it('parses headed markdown into selected task rows', () => {
    const rows = parsePlanRows('## Development\n- Add mission board\n  wire canvas node', 'project-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe('Development');
    expect(rows[0].selected).toBe(true);
    expect(rows[0].description).toContain('wire canvas node');
  });

  it('groups rows by section', () => {
    const rows = [
      createDraftTaskRow({ projectId: 'p', section: 'A', title: 'one' }),
      createDraftTaskRow({ projectId: 'p', section: 'B', title: 'two' }),
    ];
    expect(groupTaskBoardRows(rows).map((section) => section.name)).toEqual(['A', 'B']);
  });

  it('keeps local shell out of task-bound harness launches', () => {
    expect(providerToLaunchHarness('local')).toBeNull();
    expect(providerToLaunchHarness('codex')).toBe('codex');
  });

  it('parameterizes mission launch labels instead of lying about Project Page source', () => {
    expect(taskLaunchLabel('project alpha', createDraftTaskRow({ projectId: 'project alpha', title: 'Do work' })))
      .toContain('source:mission_board');
  });
});

describe('taskRowsForProofPack', () => {
  it('exports stale missing instance diagnostics used by the visible task board', () => {
    const [proofRow] = taskRowsForProofPack([row({})], []);

    expect(proofRow.listenerState).toBe('stale - missing agent-mi');
    expect(proofRow.launchError).toContain('missing from live swarm state');
  });
});
