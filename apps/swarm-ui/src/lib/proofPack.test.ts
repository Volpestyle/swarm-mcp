import { describe, expect, it } from 'bun:test';

import { buildTaskBoardProofPack } from './proofPack';

describe('buildTaskBoardProofPack', () => {
  it('summarizes task rows, task-bound launch identity, and review warnings', () => {
    const pack = buildTaskBoardProofPack({
      surface: 'project-task-board',
      note: 'review pass',
      now: 1_777_777_777_000,
      project: {
        id: 'workspace-kit',
        name: 'Workspace Kit',
        root: '/repo/workspace-kit',
        scope: '/repo/workspace-kit#overhaul',
        color: '#8ad7ff',
      },
      taskRows: [
        {
          id: 'row-1',
          sourceTaskId: 'task-1',
          section: 'Slice 5',
          title: 'Capture proof pack',
          description: 'Write the evidence artifact',
          status: 'claimed',
          provider: 'codex',
          role: 'implementer',
          assignee: 'agent-1',
          listenerState: 'launched and bound',
          elapsed: '4m',
          lastActivity: 'just now',
          result: 'Launched codex/implementer',
          files: ['/repo/workspace-kit/apps/swarm-ui/src/panels/ProjectPage.svelte'],
          priority: 0,
          selected: false,
          draft: true,
          launchStatus: 'launched',
          launchPtyId: 'pty-1',
          launchInstanceId: 'agent-1',
          launchError: '',
        },
        {
          id: 'row-2',
          sourceTaskId: null,
          section: 'Slice 5',
          title: 'Try local shell',
          description: '',
          status: 'open',
          provider: 'local',
          role: 'tester',
          assignee: '',
          listenerState: 'not launched',
          elapsed: '0s',
          lastActivity: 'draft',
          result: '',
          files: [],
          priority: 0,
          selected: true,
          draft: true,
          launchStatus: 'not_launched',
          launchPtyId: '',
          launchInstanceId: '',
          launchError: '',
        },
      ],
      agents: [
        {
          id: 'agent-1',
          label: 'provider:codex role:implementer',
          status: 'online',
          directory: '/repo/workspace-kit',
          scope: '/repo/workspace-kit#overhaul',
          heartbeat: 123,
        },
      ],
      activity: [
        {
          title: 'Agent running',
          detail: 'Codex',
          meta: 'project channel',
          timestamp: 123,
          kind: 'agent',
        },
      ],
      screenshot: {
        ok: false,
        error: 'window screenshot capture unavailable in this runtime',
      },
      visual: {
        viewport: { width: 1280, height: 900, devicePixelRatio: 2 },
        themeVariables: { '--project-color': '#8ad7ff' },
        semanticSnapshot: [],
        scrollContainers: [],
      },
    });

    expect(pack.kind).toBe('swarm-ui-proof-pack');
    expect(pack.surface).toBe('project-task-board');
    expect(pack.taskBoard.rowCount).toBe(2);
    expect(pack.taskBoard.selectedCount).toBe(1);
    expect(pack.taskBoard.launchSummary.taskBoundRows).toBe(1);
    expect(pack.taskBoard.providerCounts.codex).toBe(1);
    expect(pack.taskBoard.providerCounts.local).toBe(1);
    expect(pack.agents.online).toBe(1);
    expect(pack.reviewSignals.map((signal) => signal.id)).toContain('screenshot-unavailable');
    expect(pack.reviewSignals.map((signal) => signal.id)).toContain('selected-not-launched:row-2');
    expect(pack.reviewSignals.map((signal) => signal.id)).toContain('local-provider-selected:row-2');
    expect(pack.status).toBe('warn');
  });
});
