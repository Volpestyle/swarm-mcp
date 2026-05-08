import { agentIdentityFromLabel } from './agentIdentity';
import type { Instance, ProjectAsset, ProjectSpace, Task } from './types';

export const POST_SESSION_AREAS = [
  'Home',
  'Project',
  'Tasks',
  'Agents',
  'Canvas',
  'Context',
  'Review/Ship',
  'Settings',
  'Performance',
  'Other',
] as const;

export type PostSessionArea = typeof POST_SESSION_AREAS[number];
export type BackgroundTrustPosture = 'standard' | 'full-access';

export interface PostSessionReviewDraft {
  worked: string;
  confusing: string;
  broke: string;
  area: PostSessionArea;
  prompt: string;
  createTask: boolean;
  backgroundOptIn: boolean;
}

export interface BackgroundWorkPolicy {
  project: ProjectSpace;
  cwd: string;
  scope: string;
  harness: 'codex' | 'claude' | 'hermes' | 'openclaw' | 'opencode';
  role: string;
  trustPosture: BackgroundTrustPosture;
  timeoutMinutes: number;
  idlePolicy: string;
}

export interface BackgroundWorkValidation {
  ok: boolean;
  errors: string[];
}

export interface ImprovementTaskSeed {
  section: string;
  title: string;
  description: string;
  provider: 'codex' | 'claude' | 'hermes' | 'openclaw' | 'opencode';
  role: 'implementer' | 'planner' | 'reviewer' | 'researcher' | 'tester';
  priority: number;
}

export interface BackgroundRunSummary {
  instanceId: string;
  label: string;
  provider: string;
  role: string;
  status: Instance['status'];
  scope: string;
  directory: string;
  timeoutMinutes: number | null;
  runId: string;
  purpose: string;
  lastHeartbeat: number;
}

function compact(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ') ?? '';
}

function block(value: string | null | undefined, fallback = 'Not recorded.'): string {
  return value?.trim() || fallback;
}

function safeToken(value: string, fallback: string): string {
  const token = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) return fallback;
  return token.length <= 42 ? token : `${token.slice(0, 26)}_${token.slice(-15)}`;
}

function areaOrDefault(area: string | null | undefined): PostSessionArea {
  return (POST_SESSION_AREAS as readonly string[]).includes(area ?? '')
    ? area as PostSessionArea
    : 'Other';
}

function statusCounts(tasks: Task[]): string {
  if (tasks.length === 0) return 'No linked tasks.';
  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');
}

function agentCounts(agents: Instance[]): string {
  if (agents.length === 0) return 'No linked agents.';
  const online = agents.filter((agent) => agent.status === 'online').length;
  const stale = agents.filter((agent) => agent.status === 'stale').length;
  const offline = agents.filter((agent) => agent.status === 'offline').length;
  return `online: ${online}, stale: ${stale}, offline: ${offline}`;
}

export function buildPostSessionReviewMarkdown(input: {
  project: ProjectSpace;
  review: PostSessionReviewDraft;
  tasks: Task[];
  agents: Instance[];
  createdAt?: Date;
}): string {
  const created = input.createdAt ?? new Date();
  const review = {
    ...input.review,
    area: areaOrDefault(input.review.area),
  };

  return [
    `# Post-Session Improvement Review`,
    '',
    `Project: ${input.project.name}`,
    `Root: ${input.project.root}`,
    `Internal channel: ${input.project.scope || input.project.root}`,
    `Captured: ${created.toISOString()}`,
    '',
    `## Quick Review`,
    '',
    `Worked: ${block(review.worked)}`,
    '',
    `Confusing: ${block(review.confusing)}`,
    '',
    `Broke or felt unreliable: ${block(review.broke)}`,
    '',
    `Improve next: ${review.area}`,
    '',
    `## Detailed Follow-Up Prompt`,
    '',
    block(review.prompt, 'No follow-up prompt recorded.'),
    '',
    `## Current Project State`,
    '',
    `Tasks: ${statusCounts(input.tasks)}`,
    `Agents: ${agentCounts(input.agents)}`,
    '',
    `## Safety Posture`,
    '',
    review.backgroundOptIn
      ? 'Background work requested. Any launched agent must stay bounded, report progress, and avoid auto-commit, auto-push, deletion, or destructive cleanup.'
      : 'No background work requested. Save this as project context and optional task only.',
  ].join('\n');
}

export function buildPostSessionReviewAsset(input: {
  project: ProjectSpace;
  review: PostSessionReviewDraft;
  tasks: Task[];
  agents: Instance[];
  createdAt?: Date;
  id?: string;
}): ProjectAsset {
  const created = input.createdAt ?? new Date();
  const id = input.id ?? `post-session-${input.project.id}-${created.getTime()}`;
  return {
    id,
    projectId: input.project.id,
    kind: 'note',
    title: `Post-session review - ${created.toISOString().slice(0, 10)}`,
    path: null,
    content: buildPostSessionReviewMarkdown({
      project: input.project,
      review: input.review,
      tasks: input.tasks,
      agents: input.agents,
      createdAt: created,
    }),
    description: `Improve ${input.review.area}; background work ${input.review.backgroundOptIn ? 'requested' : 'not requested'}.`,
    createdAt: created.getTime(),
    updatedAt: created.getTime(),
  };
}

export function buildImprovementTaskSeed(input: {
  review: PostSessionReviewDraft;
  policy?: Pick<BackgroundWorkPolicy, 'harness' | 'role'> | null;
}): ImprovementTaskSeed {
  const area = areaOrDefault(input.review.area);
  const prompt = input.review.prompt.trim();
  const provider = input.policy?.harness ?? 'codex';
  const normalizedRole = input.policy?.role === 'qa' ? 'tester' : input.policy?.role;
  const role = normalizedRole === 'planner'
    || normalizedRole === 'reviewer'
    || normalizedRole === 'researcher'
    || normalizedRole === 'tester'
    ? normalizedRole
    : 'implementer';

  return {
    section: 'Post-session improvements',
    title: `Improve ${area}`,
    description: [
      prompt || `Review and improve the ${area} surface based on the post-session feedback.`,
      '',
      `Worked: ${block(input.review.worked)}`,
      `Confusing: ${block(input.review.confusing)}`,
      `Broke/unreliable: ${block(input.review.broke)}`,
      '',
      'Guardrails: do not commit, push, delete files, or run destructive cleanup without explicit approval.',
    ].join('\n'),
    provider,
    role: role as ImprovementTaskSeed['role'],
    priority: 5,
  };
}

export function validateBackgroundWorkPolicy(
  review: PostSessionReviewDraft,
  policy: BackgroundWorkPolicy,
): BackgroundWorkValidation {
  const errors: string[] = [];
  if (!review.backgroundOptIn) {
    errors.push('Background work is not opted in.');
  }
  if (!review.prompt.trim()) {
    errors.push('Detailed follow-up prompt is required for background work.');
  }
  if (!policy.project.id.trim()) {
    errors.push('Project id is required.');
  }
  if (!policy.cwd.trim()) {
    errors.push('Working directory is required.');
  }
  if (!policy.scope.trim()) {
    errors.push('Internal channel/scope is required.');
  }
  if (!policy.idlePolicy.trim()) {
    errors.push('Idle policy is required.');
  }
  if (!Number.isFinite(policy.timeoutMinutes) || policy.timeoutMinutes < 15 || policy.timeoutMinutes > 480) {
    errors.push('Timeout must be between 15 and 480 minutes.');
  }
  return { ok: errors.length === 0, errors };
}

export function buildBackgroundLaunchLabel(input: {
  project: ProjectSpace;
  runId: string;
  timeoutMinutes: number;
  trustPosture: BackgroundTrustPosture;
}): string {
  return [
    'owner:background-work',
    `project:${safeToken(input.project.id, 'project')}`,
    `background_run:${safeToken(input.runId, 'run')}`,
    `timeout_m:${Math.round(input.timeoutMinutes)}`,
    `trust:${safeToken(input.trustPosture, 'standard')}`,
    'source:post_session_review',
    'slice:may_1_s8',
  ].join(' ');
}

export function buildBackgroundWorkPrompt(input: {
  project: ProjectSpace;
  review: PostSessionReviewDraft;
  policy: BackgroundWorkPolicy;
  runId: string;
}): string {
  return [
    '[background-work]',
    `Owner: background-work`,
    `Run id: ${input.runId}`,
    `Project: ${input.project.name}`,
    `Project root: ${input.policy.cwd}`,
    `Internal channel: ${input.policy.scope}`,
    `Trust posture: ${input.policy.trustPosture}`,
    `Maximum runtime: ${input.policy.timeoutMinutes} minutes`,
    `Idle policy: ${input.policy.idlePolicy}`,
    '',
    'Task:',
    block(input.review.prompt),
    '',
    'Session feedback:',
    `- Worked: ${block(input.review.worked)}`,
    `- Confusing: ${block(input.review.confusing)}`,
    `- Broke/unreliable: ${block(input.review.broke)}`,
    `- Improve next: ${input.review.area}`,
    '',
    'Hard guardrails:',
    '- Do not commit, push, delete files, rewrite history, or perform destructive cleanup without explicit operator approval.',
    '- Report progress through the shared Conversation panel and task result summaries.',
    '- If blocked, approval is needed, or the timeout/idle policy is reached, stop work and report status.',
    '- Prefer small, reviewable changes tied to the generated post-session improvement task.',
  ].join('\n');
}

function labelToken(label: string | null | undefined, key: string): string {
  return label
    ?.split(/\s+/)
    .find((token) => token.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    ?? '';
}

export function backgroundRunsForProject(
  project: ProjectSpace,
  agents: Instance[],
): BackgroundRunSummary[] {
  return agents
    .filter((agent) => {
      const label = agent.label ?? '';
      const owned = label.includes('owner:background-work');
      const projectToken = labelToken(label, 'project');
      const expectedProject = safeToken(project.id, 'project');
      const scopeMatches = agent.scope === (project.scope || project.root);
      const directoryMatches = agent.directory === project.root;
      return owned && (projectToken === expectedProject || scopeMatches || directoryMatches);
    })
    .map((agent) => {
      const identity = agentIdentityFromLabel(agent.label);
      const timeout = Number(labelToken(agent.label, 'timeout_m'));
      return {
        instanceId: agent.id,
        label: compact(identity.name) || compact(identity.role) || compact(identity.provider) || agent.id.slice(0, 8),
        provider: compact(identity.provider) || 'agent',
        role: compact(identity.role) || 'background-work',
        status: agent.status,
        scope: agent.scope,
        directory: agent.directory,
        timeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
        runId: labelToken(agent.label, 'background_run') || agent.id.slice(0, 8),
        purpose: 'Post-session improvement',
        lastHeartbeat: agent.heartbeat,
      };
    })
    .sort((left, right) => right.lastHeartbeat - left.lastHeartbeat);
}
