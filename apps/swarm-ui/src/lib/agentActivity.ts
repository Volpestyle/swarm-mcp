import type { AgentSessionRow, SwarmNodeData, SystemLoadSnapshot, Task } from './types';
import { resolveAgentSurfaceIcon, type AgentSurfaceIcon } from './agentSurfaceIcons';

export interface AgentActivitySummary {
  title: string;
  detail: string;
  path: string;
  icon: AgentSurfaceIcon;
  iconStack: AgentSurfaceIcon[];
  effort: number;
  effortSparkline: number[];
  tokenLabel: string;
  costLabel: string;
  usageExact: boolean;
}

export function buildAgentActivitySummary(
  data: SwarmNodeData,
  systemLoad: SystemLoadSnapshot | null = null,
): AgentActivitySummary {
  const activeTask = selectActiveTask(data.assignedTasks);
  const primaryLock = data.locks[0] ?? null;
  const browserTab = data.browserTabs.find((tab) => tab.active) ?? data.browserTabs[0] ?? null;
  const appDocument = data.appSurface?.document ?? null;
  const path =
    browserTab?.url ||
    appDocument?.path ||
    activeTask?.files?.[0] ||
    primaryLock?.file ||
    data.instance?.directory ||
    data.ptySession?.cwd ||
    '';
  const title =
    browserTab?.title?.trim() ||
    appDocument?.title?.trim() ||
    activeTask?.title?.trim() ||
    (primaryLock ? 'File lock' : '') ||
    (data.status === 'online' ? 'Standing by' : statusTitle(data.status));
  const detail =
    browserTab?.url ||
    appDocument?.path ||
    activeTaskDetail(activeTask) ||
    primaryLock?.file ||
    data.listenerHealth.detail ||
    'No proven active file yet.';
  const operation = inferOperation(data, activeTask, primaryLock?.file ?? '');
  const icon = resolveAgentSurfaceIcon({
    appId: data.appSurface?.appId ?? null,
    source: data.browserContext ? 'browser' : data.appSurface?.name ?? operation,
    path,
    operation,
  });
  const iconStack = uniqueIcons([
    icon,
    ...data.locks.slice(0, 2).map((lock) => resolveAgentSurfaceIcon({ path: lock.file, operation: 'lock' })),
    ...(data.browserContext ? [resolveAgentSurfaceIcon({ source: 'browser', path: browserTab?.url ?? '' })] : []),
  ]).slice(0, 4);
  const usage = usageForAgent(data, systemLoad);
  const tokens = usage?.tokensExact ?? usage?.tokensEstimated ?? null;
  const cost = usage?.costExactUsd ?? usage?.costEstimatedUsd ?? null;
  const effort = effortScore(data, usage);

  return {
    title,
    detail,
    path,
    icon,
    iconStack,
    effort,
    effortSparkline: effortSparkline(data, usage),
    tokenLabel: formatTokens(tokens),
    costLabel: formatCost(cost),
    usageExact: Boolean(usage?.tokensExact ?? usage?.costExactUsd),
  };
}

export function usageForAgent(
  data: SwarmNodeData,
  systemLoad: SystemLoadSnapshot | null,
): AgentSessionRow | null {
  if (!systemLoad) return null;
  const instanceId = data.instance?.id ?? '';
  const ptyId = data.ptySession?.id ?? '';
  const cwd = data.instance?.directory || data.ptySession?.cwd || '';

  return systemLoad.agent_sessions.find((row) =>
    (instanceId && row.instance_id === instanceId) ||
    (ptyId && row.pty_id === ptyId) ||
    (cwd && row.cwd === cwd && providerMatches(row.provider, data.agentDisplay.provider))
  ) ?? null;
}

export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'tokens --';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K tok`;
  return `${value} tok`;
}

export function formatCost(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '$--';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`;
}

function selectActiveTask(tasks: Task[]): Task | null {
  return tasks.find((task) => task.status === 'in_progress') ??
    tasks.find((task) => task.status === 'claimed') ??
    tasks.find((task) => task.status === 'open') ??
    tasks[0] ??
    null;
}

function activeTaskDetail(task: Task | null): string {
  if (!task) return '';
  return task.description?.trim() || task.files?.[0] || task.status;
}

function inferOperation(data: SwarmNodeData, task: Task | null, lockPath: string): string {
  const haystack = `${task?.title ?? ''} ${task?.description ?? ''} ${lockPath}`.toLowerCase();
  if (data.browserContext) return 'browser';
  if (data.appSurface?.appId) return data.appSurface.appId;
  if (haystack.includes('grep') || haystack.includes('search') || haystack.includes('rg ')) return 'search';
  if (haystack.includes('read') || haystack.includes('inspect')) return 'read';
  if (task) return 'task';
  if (lockPath) return 'file';
  return 'project';
}

function statusTitle(status: SwarmNodeData['status']): string {
  if (status === 'pending') return 'Connecting';
  return status.replace(/_/g, ' ');
}

function providerMatches(left: string | null, right: string): boolean {
  const a = left?.trim().toLowerCase() ?? '';
  const b = right.trim().toLowerCase();
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function effortScore(data: SwarmNodeData, usage: AgentSessionRow | null): number {
  const taskPressure = Math.min(42, data.assignedTasks.length * 9);
  const active = data.listenerHealth.activeTaskCount > 0 || data.status === 'online' ? 16 : 0;
  const cpu = Math.min(28, Math.max(0, usage?.cpu_percent ?? 0) * 3);
  const locks = Math.min(14, data.locks.length * 7);
  return Math.max(4, Math.min(100, Math.round(taskPressure + active + cpu + locks)));
}

function effortSparkline(data: SwarmNodeData, usage: AgentSessionRow | null): number[] {
  const base = effortScore(data, usage);
  const seed = stringHash(`${data.instance?.id ?? data.ptySession?.id ?? data.label}:${data.listenerHealth.label}`);
  return Array.from({ length: 12 }, (_, index) => {
    const wave = Math.sin((index + 1) * 0.85 + seed) * 13;
    const pulse = index > 8 && data.listenerHealth.activeTaskCount > 0 ? 10 : 0;
    return Math.max(8, Math.min(96, Math.round(base + wave + pulse - 12)));
  });
}

function stringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 997;
  }
  return hash;
}

function uniqueIcons(icons: AgentSurfaceIcon[]): AgentSurfaceIcon[] {
  const seen = new Set<string>();
  const next: AgentSurfaceIcon[] = [];
  for (const icon of icons) {
    if (seen.has(icon.kind)) continue;
    seen.add(icon.kind);
    next.push(icon);
  }
  return next;
}
