import type { SystemLoadSnapshot, UsageConfidence } from './types';

export interface AnalyzeSummaryCard {
  label: string;
  value: string;
  detail: string | null;
}

export interface AnalyzeOverlaySegment {
  label: string;
  value: number;
  percent: number;
}

export interface AnalyzeOverlayTrendPoint {
  x: number;
  y: number;
  value: number;
}

export interface AnalyzeOverlayModel {
  hostCpuPercent: number;
  hostMemoryMb: number;
  burdenSegments: AnalyzeOverlaySegment[];
  cpuTrend: AnalyzeOverlayTrendPoint[];
  burdenTrend: AnalyzeOverlayTrendPoint[];
}

export function countKillableMachineTargets(snapshot: SystemLoadSnapshot | null): number {
  if (!snapshot) return 0;
  const detachedHelpers = snapshot.helper_processes.filter(
    (row) => row.killable && row.parent_session_key === null && row.killTarget !== null,
  ).length;
  return snapshot.total_agent_sessions + detachedHelpers;
}

export function formatConfidenceLabel(confidence: UsageConfidence): string {
  switch (confidence) {
    case 'exact':
      return 'Exact';
    case 'estimated':
      return 'Estimated';
    case 'unlinked':
      return 'Unlinked';
    case 'na':
    default:
      return 'N/A';
  }
}

export function formatUsdValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatMemoryValue(rssKb: number | null): string {
  if (rssKb === null || !Number.isFinite(rssKb)) return 'N/A';
  const mb = rssKb / 1024;
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export function formatTokenValue(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return 'N/A';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

export function formatRuntimeValue(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'N/A';
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

export function buildAnalyzeSummaryCards(snapshot: SystemLoadSnapshot): AnalyzeSummaryCard[] {
  return [
    {
      label: 'Agent Sessions',
      value: `${snapshot.total_agent_sessions}`,
      detail: snapshot.price_catalog_as_of
        ? `Pricing as of ${snapshot.price_catalog_as_of}`
        : null,
    },
    {
      label: 'Hidden / Orphan',
      value: `${snapshot.hidden_orphan_sessions}`,
      detail: 'Unbound terminal or PTY sessions',
    },
    {
      label: 'Detached Helpers',
      value: `${snapshot.detached_helper_count}`,
      detail: 'Repo MCPs or loose tool helpers',
    },
    {
      label: 'Estimated Live Cost',
      value: formatUsdValue(snapshot.estimated_live_cost_usd),
      detail: 'Exact tokens only; otherwise N/A',
    },
    {
      label: 'Top CPU',
      value: snapshot.top_cpu_label ?? 'N/A',
      detail: snapshot.top_cpu_label
        ? `${formatPercent(snapshot.top_cpu_percent)} CPU`
        : null,
    },
    {
      label: 'Top Memory',
      value: snapshot.top_memory_label ?? 'N/A',
      detail: snapshot.top_memory_label
        ? `${formatMemoryValue(snapshot.top_memory_rss_kb)} resident`
        : null,
    },
  ];
}

function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function buildTrendPoints(values: number[]): AnalyzeOverlayTrendPoint[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  return values.map((value, index) => ({
    x: values.length === 1 ? 100 : (index / (values.length - 1)) * 100,
    y: 100 - ((value - min) / span) * 100,
    value,
  }));
}

export function buildAnalyzeOverlayModel(
  snapshot: SystemLoadSnapshot,
  history: SystemLoadSnapshot[] = [],
): AnalyzeOverlayModel {
  const uniqueHistory = [...history, snapshot]
    .sort((a, b) => a.scanned_at_ms - b.scanned_at_ms)
    .filter((entry, index, all) =>
      index === 0 || entry.scanned_at_ms !== all[index - 1]?.scanned_at_ms,
    );

  const sessionCount = snapshot.total_agent_sessions;
  const helperCount = snapshot.detached_helper_count;
  const externalCount = snapshot.external_burden.length;
  const burdenTotal = Math.max(1, sessionCount + helperCount + externalCount);

  return {
    hostCpuPercent: clampPercent(snapshot.top_cpu_percent),
    hostMemoryMb: snapshot.top_memory_rss_kb
      ? snapshot.top_memory_rss_kb / 1024
      : 0,
    burdenSegments: [
      {
        label: 'Agent Trees',
        value: sessionCount,
        percent: (sessionCount / burdenTotal) * 100,
      },
      {
        label: 'Detached Helpers',
        value: helperCount,
        percent: (helperCount / burdenTotal) * 100,
      },
      {
        label: 'External Burden',
        value: externalCount,
        percent: (externalCount / burdenTotal) * 100,
      },
    ],
    cpuTrend: buildTrendPoints(
      uniqueHistory.map((entry) => clampPercent(entry.top_cpu_percent)),
    ),
    burdenTrend: buildTrendPoints(
      uniqueHistory.map((entry) =>
        entry.total_agent_sessions
        + entry.detached_helper_count
        + entry.external_burden.length,
      ),
    ),
  };
}
