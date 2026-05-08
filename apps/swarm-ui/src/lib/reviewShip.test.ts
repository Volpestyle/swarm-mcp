import { describe, expect, it } from 'bun:test';

import type { Instance, Lock, ProjectSpace, Task } from './types';
import { buildReviewShipSummary, parseTaskResult } from './reviewShip';

const project: ProjectSpace = {
  id: 'lab',
  name: 'swarm-mcp-lab',
  root: '/repo',
  color: '#ffffff',
  additionalRoots: [],
  notes: 'Ship carefully.',
  scope: '/repo#overhaul',
  boundary: { x: 0, y: 0, width: 100, height: 100 },
  createdAt: 1,
  updatedAt: 2,
};

function task(input: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: input.id,
    scope: input.scope ?? '/repo#overhaul',
    type: input.type ?? 'implement',
    title: input.title,
    description: input.description ?? null,
    requester: input.requester ?? 'planner',
    assignee: input.assignee ?? null,
    status: input.status ?? 'done',
    files: input.files ?? [],
    result: input.result ?? null,
    created_at: input.created_at ?? 1,
    updated_at: input.updated_at ?? 2,
    changed_at: input.changed_at ?? 3,
    priority: input.priority ?? 0,
    depends_on: input.depends_on ?? [],
    parent_task_id: input.parent_task_id ?? null,
  };
}

function agent(input: Partial<Instance> & Pick<Instance, 'id'>): Instance {
  return {
    id: input.id,
    scope: input.scope ?? '/repo#overhaul',
    directory: input.directory ?? '/repo',
    root: input.root ?? '/repo',
    file_root: input.file_root ?? '/repo',
    pid: input.pid ?? 123,
    label: input.label ?? null,
    registered_at: input.registered_at ?? 1,
    heartbeat: input.heartbeat ?? 2,
    status: input.status ?? 'online',
    adopted: input.adopted ?? true,
  };
}

describe('reviewShip', () => {
  it('parses structured task result JSON', () => {
    const parsed = parseTaskResult(JSON.stringify({
      summary: 'Added the review panel.',
      files_changed: ['apps/swarm-ui/src/lib/reviewShip.ts'],
      test_status: 'bun test passed',
      risks: ['Needs visual QA'],
    }));

    expect(parsed.summary).toBe('Added the review panel.');
    expect(parsed.filesChanged).toEqual(['apps/swarm-ui/src/lib/reviewShip.ts']);
    expect(parsed.testStatus).toBe('bun test passed');
    expect(parsed.risks).toEqual(['Needs visual QA']);
  });

  it('builds file groups, risks, commit text, and reviewer handoff', () => {
    const reviewer = agent({
      id: 'reviewer-1',
      label: 'provider:opencode role:reviewer name:Nyx',
    });
    const implementer = agent({
      id: 'agent-1',
      label: 'provider:codex role:implementer name:Codex',
    });
    const locks: Lock[] = [{ scope: '/repo#overhaul', file: '/repo/locked.ts', instance_id: 'agent-1' }];
    const summary = buildReviewShipSummary({
      project,
      agents: [reviewer, implementer],
      locks,
      tasks: [
        task({
          id: 'task-1',
          title: 'Add Review Ship panel',
          assignee: 'agent-1',
          files: ['/repo/apps/swarm-ui/src/panels/ProjectPage.svelte'],
          result: JSON.stringify({
            summary: 'Rendered task summaries and commit suggestions.',
            files_changed: ['/repo/apps/swarm-ui/src/lib/reviewShip.ts'],
            test_status: 'focused tests pass',
          }),
        }),
        task({
          id: 'task-2',
          title: 'Fix risky flow',
          status: 'failed',
          result: 'Launch path still fails.',
        }),
      ],
    });

    expect(summary.taskGroups).toHaveLength(2);
    expect(summary.fileGroups.map((group) => group.file)).toContain('/repo/apps/swarm-ui/src/lib/reviewShip.ts');
    expect(summary.fileGroups.map((group) => group.file)).toContain('/repo/locked.ts');
    expect(summary.risks.some((risk) => risk.includes('Fix risky flow failed'))).toBe(true);
    expect(summary.primaryCommitMessage).toContain('swarm-mcp-lab: Add Review Ship panel');
    expect(summary.primaryCommitMessage).toContain('Rendered task summaries');
    expect(summary.reviewerCandidates).toEqual([{ id: 'reviewer-1', label: 'Nyx / reviewer' }]);
    expect(summary.reviewerHandoff).toContain('[review-request]');
    expect(summary.reviewerHandoff).toContain('Please review the listed files');
  });
});
