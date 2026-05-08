import { describe, expect, test } from 'bun:test';
import {
  buildHermesMajordomoCommand,
  buildMajordomoBootstrapInstructions,
  buildMajordomoRuntimeLabel,
  defaultHermesMajordomoRuntime,
  isRuntimeMajordomo,
  majordomoClarificationChoices,
  resolveMajordomoRuntime,
  structureMajordomoIdeaDump,
} from './majordomoRuntime';
import type { Instance, ProjectSpace, PtySession } from './types';

const project: ProjectSpace = {
  id: 'project-1',
  name: 'Project One',
  root: '/tmp/project-one',
  color: '#ffffff',
  additionalRoots: [],
  notes: '',
  scope: '/tmp/project-one',
  boundary: { x: 0, y: 0, width: 100, height: 100 },
  createdAt: 1,
  updatedAt: 1,
};

function instance(input: Partial<Instance>): Instance {
  return {
    id: 'agent-1',
    scope: '/tmp/project-one',
    directory: '/tmp/project-one',
    root: '/tmp/project-one',
    file_root: '/tmp/project-one',
    pid: 123,
    label: '',
    registered_at: 1,
    heartbeat: 1,
    status: 'online',
    adopted: true,
    ...input,
  };
}

function pty(input: Partial<PtySession>): PtySession {
  return {
    id: 'pty-1',
    command: 'Hermes',
    cwd: project.root,
    started_at: 1,
    exit_code: null,
    bound_instance_id: 'agent-1',
    launch_token: null,
    cols: 120,
    rows: 40,
    lease: null,
    ...input,
  };
}

describe('Majordomo runtime', () => {
  test('matches role, owner, and project label while rejecting other projects', () => {
    const label = buildMajordomoRuntimeLabel(project, 45);
    expect(isRuntimeMajordomo(instance({ label }), project)).toBe(true);
    expect(isRuntimeMajordomo(instance({ label: label.replace('project:project-1', 'project:other') }), project)).toBe(false);
  });

  test('builds source-tagged Hermes command with optional model/provider', () => {
    const runtime = defaultHermesMajordomoRuntime({ model: 'grok-4.3', provider: 'xAI' });
    expect(runtime.harness).toBe('hermes');
    expect(runtime.cleanupPolicy).toBe('stop-on-app-close');
    expect(runtime.command).toContain('--tui');
    expect(runtime.command).toContain('--source swarm-ui-majordomo');
    expect(runtime.command).toContain('--model grok-4.3');
    expect(runtime.command).toContain('--provider xAI');
    expect(buildHermesMajordomoCommand({ model: 'model with space' })).toContain("'model with space'");
  });

  test('bootstrap instructions name feature map, visual plan, learning folder, launch, and PTY surfaces', () => {
    const instructions = buildMajordomoBootstrapInstructions({
      sourceRoot: '/Users/mathewfrazier/Desktop/swarm-mcp-lab',
      project,
    });
    expect(instructions).toContain('docs/CURRENT_APP_FEATURES.md');
    expect(instructions).toContain('docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md');
    expect(instructions).toContain('Experiental Learning Evolution/README.md');
    expect(instructions).toContain('src/stores/pty.ts');
    expect(instructions).toContain('src-tauri/src/launch.rs');
    expect(instructions).toContain('never claim proof');
  });

  test('resolves visible runtime state and flags ghosts', () => {
    const label = buildMajordomoRuntimeLabel(project, 30);
    const visible = resolveMajordomoRuntime({
      instances: [instance({ label })],
      ptySessions: [pty({})],
      bindings: [['agent-1', 'pty-1']],
      project,
      launchRequested: true,
    });
    expect(visible.state).toBe('online');
    expect(visible.ghost).toBe(false);
    expect(visible.pty?.id).toBe('pty-1');

    const ghost = resolveMajordomoRuntime({
      instances: [],
      ptySessions: [],
      bindings: [],
      project,
      launchRequested: true,
    });
    expect(ghost.state).toBe('failed');
    expect(ghost.ghost).toBe(true);
  });

  test('structures idea dumps and offers concrete clarification choices', () => {
    expect(structureMajordomoIdeaDump('Fix the button. Maybe launch agents? Also save proof.')).toEqual([
      'Fix the button',
      'Maybe launch agents',
      'Also save proof',
    ]);
    expect(majordomoClarificationChoices('should we research and launch a swarm?')).toContain('research first');
    expect(majordomoClarificationChoices('should we research and launch a swarm?')).toContain('launch a swarm');
  });
});
