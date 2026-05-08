import { describe, expect, it } from 'bun:test';

import {
  backgroundRunsForProject,
  buildBackgroundLaunchLabel,
  buildBackgroundWorkPrompt,
  buildImprovementTaskSeed,
  buildPostSessionReviewAsset,
  validateBackgroundWorkPolicy,
  type PostSessionReviewDraft,
} from './postSessionImprovement';
import type { Instance, ProjectSpace } from './types';

const project: ProjectSpace = {
  id: 'workspace-kit',
  name: 'Workspace Kit',
  root: '/repo',
  color: '#35f2ff',
  additionalRoots: [],
  notes: '',
  scope: '/repo#overhaul',
  boundary: { x: 0, y: 0, width: 400, height: 240 },
  createdAt: 1,
  updatedAt: 1,
};

const review: PostSessionReviewDraft = {
  worked: 'Task Board launch worked.',
  confusing: 'Background controls were hard to find.',
  broke: 'One stale row survived.',
  area: 'Agents',
  prompt: 'Add clearer background-work controls and proof.',
  createTask: true,
  backgroundOptIn: true,
};

describe('postSessionImprovement', () => {
  it('builds a project-local review note with state and guardrails', () => {
    const asset = buildPostSessionReviewAsset({
      project,
      review,
      tasks: [],
      agents: [],
      createdAt: new Date('2026-05-02T18:00:00.000Z'),
      id: 'review-1',
    });

    expect(asset.kind).toBe('note');
    expect(asset.content).toContain('Post-Session Improvement Review');
    expect(asset.content).toContain('Add clearer background-work controls');
    expect(asset.content).toContain('Background work requested');
  });

  it('turns feedback into a draft improvement task seed', () => {
    const seed = buildImprovementTaskSeed({
      review,
      policy: { harness: 'codex', role: 'implementer' },
    });

    expect(seed.section).toBe('Post-session improvements');
    expect(seed.title).toBe('Improve Agents');
    expect(seed.description).toContain('Guardrails');
    expect(seed.provider).toBe('codex');
  });

  it('keeps QA background runs as tester improvement tasks', () => {
    const seed = buildImprovementTaskSeed({
      review,
      policy: { harness: 'codex', role: 'qa' },
    });

    expect(seed.role).toBe('tester');
  });

  it('requires explicit bounded policy before background launch', () => {
    const invalid = validateBackgroundWorkPolicy(
      { ...review, prompt: '', backgroundOptIn: true },
      {
        project,
        cwd: '/repo',
        scope: '/repo#overhaul',
        harness: 'codex',
        role: 'implementer',
        trustPosture: 'standard',
        timeoutMinutes: 600,
        idlePolicy: '',
      },
    );

    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toContain('Detailed follow-up prompt');
    expect(invalid.errors.join('\n')).toContain('Timeout');
    expect(invalid.errors.join('\n')).toContain('Idle policy');
  });

  it('builds launch label and prompt with owner, timeout, and safety rules', () => {
    const label = buildBackgroundLaunchLabel({
      project,
      runId: 'run 1',
      timeoutMinutes: 90,
      trustPosture: 'full-access',
    });
    expect(label).toContain('owner:background-work');
    expect(label).toContain('timeout_m:90');

    const prompt = buildBackgroundWorkPrompt({
      project,
      review,
      policy: {
        project,
        cwd: '/repo',
        scope: '/repo#overhaul',
        harness: 'codex',
        role: 'implementer',
        trustPosture: 'full-access',
        timeoutMinutes: 90,
        idlePolicy: 'Report every 15 minutes.',
      },
      runId: 'run-1',
    });
    expect(prompt).toContain('Owner: background-work');
    expect(prompt).toContain('Do not commit, push, delete files');
  });

  it('derives background run resume rows from agent labels', () => {
    const agent: Instance = {
      id: 'agent-1',
      pid: 123,
      pid_started_at: null,
      scope: '/repo#overhaul',
      directory: '/repo',
      file_root: '/repo',
      label: 'provider:codex role:implementer owner:background-work project:workspace-kit background_run:run-1 timeout_m:90',
      started_at: 1,
      heartbeat: 20,
      status: 'online',
      adopted: true,
    };

    const runs = backgroundRunsForProject(project, [agent]);
    expect(runs).toHaveLength(1);
    expect(runs[0].timeoutMinutes).toBe(90);
    expect(runs[0].provider).toBe('codex');
  });
});
