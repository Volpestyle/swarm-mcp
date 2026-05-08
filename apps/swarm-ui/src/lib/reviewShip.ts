import { agentIdentityFromLabel } from './agentIdentity';
import type { Instance, Lock, ProjectSpace, Task } from './types';

export interface ParsedTaskResult {
  summary: string;
  filesChanged: string[];
  testStatus: string;
  risks: string[];
}

export interface ReviewShipTaskGroup {
  taskId: string;
  title: string;
  status: Task['status'];
  agentId: string | null;
  agentLabel: string;
  summary: string;
  testStatus: string;
  risks: string[];
  files: string[];
  updatedAt: number;
}

export interface ReviewShipFileGroup {
  file: string;
  taskIds: string[];
  taskTitles: string[];
  agentIds: string[];
  agentLabels: string[];
  lockedBy: string[];
}

export interface ReviewShipSummary {
  taskGroups: ReviewShipTaskGroup[];
  fileGroups: ReviewShipFileGroup[];
  reviewerCandidates: Array<{ id: string; label: string }>;
  risks: string[];
  primaryCommitMessage: string;
  commitMessages: string[];
  reviewerHandoff: string;
  reviewTaskPrompt: string;
}

export interface ReviewShipInput {
  project: ProjectSpace;
  tasks: Task[];
  agents: Instance[];
  locks: Lock[];
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function compactList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((entry) => compact(entry)).filter(Boolean));
  }
  const text = compact(value);
  return text ? [text] : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function orderedUniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = compact(record[key]);
    if (value) return value;
  }
  return '';
}

function readFirstList(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const list = compactList(record[key]);
    if (list.length > 0) return list;
  }
  return [];
}

export function parseTaskResult(raw: string | null | undefined): ParsedTaskResult {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return { summary: '', filesChanged: [], testStatus: '', risks: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        summary: readFirstString(record, ['summary', 'result', 'notes', 'detail']) || trimmed,
        filesChanged: readFirstList(record, ['files_changed', 'filesChanged', 'changed_files', 'changedFiles', 'files']),
        testStatus: readFirstString(record, ['test_status', 'testStatus', 'tests', 'verification']),
        risks: readFirstList(record, ['risks', 'unresolved_risks', 'unresolvedRisks', 'blockers', 'warnings']),
      };
    }
  } catch {
    // Plain text result; keep it as an operator-readable summary.
  }

  return { summary: trimmed, filesChanged: [], testStatus: '', risks: [] };
}

function agentLabel(agent: Instance | null | undefined): string {
  if (!agent) return 'unassigned';
  const identity = agentIdentityFromLabel(agent.label);
  const name = compact(identity.name)?.replace(/_/g, ' ');
  const role = compact(identity.role)?.replace(/_/g, ' ');
  const provider = compact(identity.provider)?.replace(/_/g, ' ');
  if (name && role) return `${name} / ${role}`;
  if (name) return name;
  if (provider && role) return `${provider} / ${role}`;
  if (role) return role;
  if (provider) return provider;
  return agent.id.slice(0, 8);
}

function isReviewerCandidate(agent: Instance): boolean {
  if (agent.status !== 'online') return false;
  const identity = agentIdentityFromLabel(agent.label);
  const haystack = `${identity.role ?? ''} ${identity.provider ?? ''} ${identity.name ?? ''} ${agent.label ?? ''}`.toLowerCase();
  return haystack.includes('review') || haystack.includes('opencode');
}

function taskStatusRisk(task: Task): string | null {
  if (task.status === 'failed') return `${task.title} failed and needs review before ship.`;
  if (task.status === 'cancelled') return `${task.title} was cancelled; confirm it is intentionally out of scope.`;
  if (task.status === 'blocked') return `${task.title} is blocked and should not be shipped as complete.`;
  if (task.status === 'approval_required') return `${task.title} still needs approval.`;
  return null;
}

function taskGroup(task: Task, agentsById: Map<string, Instance>): ReviewShipTaskGroup {
  const parsed = parseTaskResult(task.result);
  const agent = task.assignee ? agentsById.get(task.assignee) : null;
  const statusRisk = taskStatusRisk(task);
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    agentId: task.assignee,
    agentLabel: agentLabel(agent),
    summary: parsed.summary || task.description || 'No task result summary recorded yet.',
    testStatus: parsed.testStatus || 'not reported',
    risks: uniqueStrings([...(statusRisk ? [statusRisk] : []), ...parsed.risks]),
    files: uniqueStrings([...(task.files ?? []), ...parsed.filesChanged]),
    updatedAt: task.changed_at || task.updated_at || task.created_at,
  };
}

function buildFileGroups(
  tasks: ReviewShipTaskGroup[],
  locks: Lock[],
): ReviewShipFileGroup[] {
  const groups = new Map<string, ReviewShipFileGroup>();
  const ensure = (file: string): ReviewShipFileGroup => {
    let group = groups.get(file);
    if (!group) {
      group = {
        file,
        taskIds: [],
        taskTitles: [],
        agentIds: [],
        agentLabels: [],
        lockedBy: [],
      };
      groups.set(file, group);
    }
    return group;
  };

  for (const task of tasks) {
    for (const file of task.files) {
      const group = ensure(file);
      group.taskIds.push(task.taskId);
      group.taskTitles.push(task.title);
      if (task.agentId) group.agentIds.push(task.agentId);
      if (task.agentLabel !== 'unassigned') group.agentLabels.push(task.agentLabel);
    }
  }

  for (const lock of locks) {
    const group = ensure(lock.file);
    group.lockedBy.push(lock.instance_id);
    group.agentIds.push(lock.instance_id);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      taskIds: uniqueStrings(group.taskIds),
      taskTitles: uniqueStrings(group.taskTitles),
      agentIds: uniqueStrings(group.agentIds),
      agentLabels: uniqueStrings(group.agentLabels),
      lockedBy: uniqueStrings(group.lockedBy),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function statusCounts(tasks: ReviewShipTaskGroup[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
}

function commitSubject(project: ProjectSpace, tasks: ReviewShipTaskGroup[]): string {
  const done = tasks.filter((task) => task.status === 'done');
  const scope = project.name.trim() || 'project';
  if (done.length === 1) return `${scope}: ${done[0].title}`;
  if (done.length > 1) return `${scope}: complete ${done.length} task updates`;
  if (tasks.length > 0) return `${scope}: review ${tasks.length} task updates`;
  return `${scope}: update project workspace`;
}

function commitBody(tasks: ReviewShipTaskGroup[], files: ReviewShipFileGroup[], risks: string[]): string {
  const lines: string[] = [];
  const completed = tasks.filter((task) => task.status === 'done').slice(0, 6);
  if (completed.length > 0) {
    lines.push('', 'Tasks:');
    for (const task of completed) lines.push(`- ${task.title}: ${task.summary}`);
  }

  if (files.length > 0) {
    lines.push('', 'Files:');
    for (const file of files.slice(0, 8)) lines.push(`- ${file.file}`);
  }

  const tests = uniqueStrings(tasks.map((task) => task.testStatus).filter((status) => status && status !== 'not reported'));
  if (tests.length > 0) {
    lines.push('', 'Verification:');
    for (const test of tests.slice(0, 5)) lines.push(`- ${test}`);
  }

  if (risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of risks.slice(0, 5)) lines.push(`- ${risk}`);
  }

  return lines.join('\n');
}

function buildCommitMessages(
  project: ProjectSpace,
  tasks: ReviewShipTaskGroup[],
  files: ReviewShipFileGroup[],
  risks: string[],
): string[] {
  const subject = commitSubject(project, tasks);
  const body = commitBody(tasks, files, risks);
  const counts = statusCounts(tasks);
  const reviewSubject = risks.length > 0
    ? `${project.name}: review ${risks.length} unresolved risk${risks.length === 1 ? '' : 's'}`
    : `${project.name}: prepare ${files.length} file${files.length === 1 ? '' : 's'} for review`;
  const statusSubject = `${project.name}: ${counts.done ?? 0} done, ${counts.failed ?? 0} failed, ${counts.in_progress ?? 0} active`;
  return orderedUniqueStrings([
    `${subject}${body}`,
    reviewSubject,
    statusSubject,
  ]);
}

function buildReviewTaskPrompt(
  project: ProjectSpace,
  tasks: ReviewShipTaskGroup[],
  files: ReviewShipFileGroup[],
  risks: string[],
): string {
  return [
    `Review ${project.name} project changes`,
    '',
    `Project root: ${project.root}`,
    `Channel: ${project.scope || project.root}`,
    '',
    'Tasks to inspect:',
    ...(tasks.length > 0
      ? tasks.slice(0, 8).map((task) => `- [${task.status}] ${task.title} (${task.agentLabel}): ${task.summary}`)
      : ['- No task rows are linked yet.']),
    '',
    'Files to inspect:',
    ...(files.length > 0 ? files.slice(0, 12).map((file) => `- ${file.file}`) : ['- No changed/review files reported yet.']),
    '',
    'Risks:',
    ...(risks.length > 0 ? risks.slice(0, 8).map((risk) => `- ${risk}`) : ['- No unresolved risks reported.']),
    '',
    'Please review the listed files and task results, then respond with approval or specific findings.',
  ].join('\n');
}

export function buildReviewShipSummary(input: ReviewShipInput): ReviewShipSummary {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const taskGroups = input.tasks
    .map((task) => taskGroup(task, agentsById))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const fileGroups = buildFileGroups(taskGroups, input.locks);
  const risks = uniqueStrings(taskGroups.flatMap((task) => task.risks));
  const commitMessages = buildCommitMessages(input.project, taskGroups, fileGroups, risks);
  const reviewTaskPrompt = buildReviewTaskPrompt(input.project, taskGroups, fileGroups, risks);
  const reviewerCandidates = input.agents
    .filter(isReviewerCandidate)
    .map((agent) => ({ id: agent.id, label: agentLabel(agent) }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    taskGroups,
    fileGroups,
    reviewerCandidates,
    risks,
    primaryCommitMessage: commitMessages[0] ?? `${input.project.name}: update project workspace`,
    commitMessages,
    reviewerHandoff: `[review-request]\n${reviewTaskPrompt}`,
    reviewTaskPrompt,
  };
}
