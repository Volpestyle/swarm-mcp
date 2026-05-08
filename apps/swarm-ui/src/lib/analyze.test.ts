import { describe, expect, it } from 'bun:test';

import {
  buildAnalyzeOverlayModel,
  buildAnalyzeSummaryCards,
  countKillableMachineTargets,
  formatConfidenceLabel,
  formatUsdValue,
} from './analyze';
import type { AgentSessionRow, SystemLoadSnapshot } from './types';

function makeAgentRow(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    session_key: 'session-1',
    session_kind: 'bound_swarm_agent',
    session_label: 'Claude Planner',
    root_pid: 30591,
    process_group_id: 30591,
    child_pids: [30591, 30602, 30674],
    tty: 'ttys017',
    pty_id: 'pty-1',
    instance_id: 'instance-1',
    scope: '/Users/mathewfrazier/Desktop',
    cwd: '/Users/mathewfrazier/Desktop',
    provider: 'anthropic',
    harness: 'claude',
    model: 'claude-opus-4-7',
    started_at: 1_776_887_900_000,
    elapsed_seconds: 120,
    cpu_percent: 0.2,
    rss_kb: 15240,
    status: 'online',
    activity: 'task',
    helper_count: 2,
    tokensExact: 125000,
    tokensEstimated: null,
    costExactUsd: null,
    costEstimatedUsd: 0.42,
    usageConfidence: 'exact',
    costConfidence: 'estimated',
    usageAttribution: null,
    killable: true,
    killProtectionReason: null,
    killTarget: { kind: 'bound_instance', instance_id: 'instance-1' },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SystemLoadSnapshot> = {}): SystemLoadSnapshot {
  return {
    scanned_at_ms: 1_776_888_100_000,
    scope: null,
    price_catalog_as_of: '2026-04-22',
    total_agent_sessions: 2,
    hidden_orphan_sessions: 1,
    detached_helper_count: 3,
    estimated_live_cost_usd: 0.42,
    gpu_note: 'N/A',
    top_cpu_label: 'swarm-ui',
    top_cpu_percent: 5.5,
    top_memory_label: 'Google Chrome',
    top_memory_rss_kb: 512000,
    agent_sessions: [makeAgentRow()],
    helper_processes: [],
    daemon_processes: [],
    external_burden: [],
    ...overrides,
  };
}

describe('analyze helpers', () => {
  it('formats confidence labels for exact, estimated, and N/A values', () => {
    expect(formatConfidenceLabel('exact')).toBe('Exact');
    expect(formatConfidenceLabel('estimated')).toBe('Estimated');
    expect(formatConfidenceLabel('na')).toBe('N/A');
  });

  it('formats USD values conservatively', () => {
    expect(formatUsdValue(0.4242)).toBe('$0.42');
    expect(formatUsdValue(null)).toBe('N/A');
  });

  it('builds summary cards from the snapshot fields', () => {
    const cards = buildAnalyzeSummaryCards(makeSnapshot());
    expect(cards.map((card) => card.label)).toEqual([
      'Agent Sessions',
      'Hidden / Orphan',
      'Detached Helpers',
      'Daemon Radar',
      'Estimated Live Cost',
      'Top CPU',
      'Top Memory',
    ]);
    expect(cards[3]?.value).toBe('0');
    expect(cards[4]?.value).toBe('$0.42');
    expect(cards[5]?.detail).toContain('5.5% CPU');
  });

  it('calls out stale detached daemons in the summary strip', () => {
    const cards = buildAnalyzeSummaryCards(makeSnapshot({
      daemon_processes: [
        {
          daemon_key: 'daemon:swarm_server:69602',
          daemon_kind: 'swarm_server',
          label: 'swarm-server daemon',
          pid: 69602,
          parent_pid: 69601,
          parent_label: 'tmux',
          process_group_id: 69602,
          command: './target/debug/swarm-server',
          started_at: 1_776_000_000_000,
          elapsed_seconds: 432_000,
          cpu_percent: 0,
          rss_kb: 20480,
          status: 'stale_detached',
          stale: true,
          listening_ports: [5444],
          note: 'Detached swarm-server older than 30m; restart or kill before native launch proof.',
        },
      ],
    }));

    expect(cards.find((card) => card.label === 'Daemon Radar')).toEqual({
      label: 'Daemon Radar',
      value: '1',
      detail: '1 stale detached',
    });
  });

  it('builds overlay telemetry from live counts and history', () => {
    const history = [
      makeSnapshot({
        scanned_at_ms: 1_776_888_000_000,
        total_agent_sessions: 1,
        detached_helper_count: 1,
        external_burden: [
          {
            external_key: 'ext-0',
            label: 'Safari',
            pid: 880,
            process_group_id: 880,
            tty: null,
            command: '/Applications/Safari.app/Contents/MacOS/Safari',
            started_at: 1_776_888_000_000,
            elapsed_seconds: 120,
            cpu_percent: 5.2,
            rss_kb: 220_000,
            note: 'Browser tabs',
          },
        ],
        top_cpu_percent: 18.5,
        top_memory_rss_kb: 256_000,
      }),
      makeSnapshot({
        scanned_at_ms: 1_776_888_050_000,
        total_agent_sessions: 2,
        detached_helper_count: 2,
        external_burden: [
          {
            external_key: 'ext-1',
            label: 'Safari',
            pid: 881,
            process_group_id: 881,
            tty: null,
            command: '/Applications/Safari.app/Contents/MacOS/Safari',
            started_at: 1_776_888_000_000,
            elapsed_seconds: 320,
            cpu_percent: 12.1,
            rss_kb: 410_000,
            note: 'Browser tabs',
          },
        ],
        top_cpu_percent: 33.2,
        top_memory_rss_kb: 768_000,
      }),
    ];
    const snapshot = makeSnapshot({
      scanned_at_ms: 1_776_888_100_000,
      total_agent_sessions: 2,
      detached_helper_count: 3,
      external_burden: [
        {
          external_key: 'ext-2',
          label: 'Google Chrome',
          pid: 999,
          process_group_id: 999,
          tty: null,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          started_at: 1_776_888_000_000,
          elapsed_seconds: 500,
          cpu_percent: 24.2,
          rss_kb: 600_000,
          note: 'Browser tabs',
        },
        {
          external_key: 'ext-3',
          label: 'Figma',
          pid: 1000,
          process_group_id: 1000,
          tty: null,
          command: '/Applications/Figma.app/Contents/MacOS/Figma',
          started_at: 1_776_888_000_000,
          elapsed_seconds: 500,
          cpu_percent: 7.4,
          rss_kb: 450_000,
          note: 'Design workload',
        },
      ],
      top_cpu_percent: 48.6,
      top_memory_rss_kb: 1_536_000,
    });

    const model = buildAnalyzeOverlayModel(snapshot, history);

    expect(model.hostCpuPercent).toBeCloseTo(48.6);
    expect(model.hostMemoryMb).toBeCloseTo(1500, 0);
    expect(model.burdenSegments.map((segment) => [segment.label, segment.value])).toEqual([
      ['Agent Trees', 2],
      ['Detached Helpers', 3],
      ['Swarm Daemons', 0],
      ['External Burden', 2],
    ]);
    expect(model.cpuTrend.length).toBe(3);
    expect(model.cpuTrend.at(-1)?.value).toBeCloseTo(48.6);
    expect(model.burdenTrend.at(-1)?.value).toBe(7);
  });

  it('counts detached helpers as killable machine targets when no agent sessions remain', () => {
    const snapshot = makeSnapshot({
      total_agent_sessions: 0,
      detached_helper_count: 2,
      helper_processes: [
        {
          helper_key: 'helper-1',
          helper_kind: 'detached_mcp_process',
          label: 'context7-mcp',
          pid: 30067,
          pids: [30067, 30138],
          parent_session_key: null,
          tty: 'ttys016',
          scope: null,
          command: 'npm exec @upstash/context7-mcp',
          started_at: 1_776_888_000_000,
          elapsed_seconds: 1200,
          cpu_percent: 0.1,
          rss_kb: 10240,
          killable: true,
          killProtectionReason: null,
          killTarget: {
            kind: 'detached_mcp_process_set',
            pids: [30067, 30138],
            label: 'context7-mcp',
          },
        },
        {
          helper_key: 'helper-2',
          helper_kind: 'attached_mcp_process',
          label: 'context7-mcp',
          pid: 30602,
          pids: [30602, 30674],
          parent_session_key: 'session-1',
          tty: 'ttys017',
          scope: '/Users/mathewfrazier/Desktop',
          command: 'npm exec @upstash/context7-mcp',
          started_at: 1_776_888_000_000,
          elapsed_seconds: 1200,
          cpu_percent: 0.1,
          rss_kb: 10240,
          killable: true,
          killProtectionReason: null,
          killTarget: {
            kind: 'detached_mcp_process_set',
            pids: [30602, 30674],
            label: 'context7-mcp',
          },
        },
      ],
    });

    expect(countKillableMachineTargets(snapshot)).toBe(1);
  });
});
