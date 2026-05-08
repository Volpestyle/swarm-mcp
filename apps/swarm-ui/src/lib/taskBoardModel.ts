import type { InstanceStatus, ProjectSpace, Task } from './types';
import {
  resolveTaskBoardRowRuntime,
  type TaskBoardLaunchStatus,
} from './taskBoardState';
export {
  canRetryTaskBoardRow,
  taskBoardRowInstanceId,
  type TaskBoardInstanceRuntimeInput,
  type TaskBoardLaunchStatus,
  type TaskBoardRowRuntimeInput,
  type TaskBoardRowRuntimeState,
  type TaskBoardRuntimeState,
} from './taskBoardState';
export { resolveTaskBoardRowRuntime };

export type TaskBoardProvider = 'codex' | 'claude' | 'hermes' | 'openclaw' | 'opencode' | 'local';
export type TaskBoardRole =
  | 'planner'
  | 'implementer'
  | 'builder'
  | 'reviewer'
  | 'researcher'
  | 'designer'
  | 'operator'
  | 'architect'
  | 'majordomo'
  | 'debugger'
  | 'qa'
  | 'tester'
  | 'scribe';
export type TaskBoardLaunchHarness = 'codex' | 'claude' | 'hermes' | 'openclaw' | 'opencode';

export interface CockpitTaskLane {
  id: string;
  label: string;
  hint: string;
  tasks: Task[];
}

export interface TaskBoardRow {
  id: string;
  projectId: string;
  sourceTaskId: string | null;
  section: string;
  title: string;
  description: string;
  status: Task['status'];
  provider: TaskBoardProvider;
  role: TaskBoardRole;
  assignee: string;
  listenerState: string;
  elapsed: string;
  lastActivity: string;
  result: string;
  files: string[];
  priority: number;
  selected: boolean;
  draft: boolean;
  launchStatus: TaskBoardLaunchStatus;
  launchPtyId: string;
  launchInstanceId: string;
  launchError: string;
}

export interface TaskBoardSection {
  name: string;
  rows: TaskBoardRow[];
}

export const TASK_BOARD_PROVIDERS: Array<{ value: TaskBoardProvider; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'hermes', label: 'Hermes (Nous)' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'opencode', label: 'opencode' },
  { value: 'local', label: 'Local shell' },
];

export const TASK_BOARD_ROLES: Array<{ value: TaskBoardRole; label: string }> = [
  { value: 'implementer', label: 'Implementer' },
  { value: 'builder', label: 'Builder' },
  { value: 'planner', label: 'Planner' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'researcher', label: 'Researcher' },
  { value: 'designer', label: 'Designer' },
  { value: 'operator', label: 'Operator' },
  { value: 'architect', label: 'Architect' },
  { value: 'majordomo', label: 'Majordomo / Grand Architect' },
  { value: 'debugger', label: 'Debugger' },
  { value: 'qa', label: 'QA' },
  { value: 'tester', label: 'Tester' },
  { value: 'scribe', label: 'Scribe' },
];

export const TASK_BOARD_STATUSES: Task['status'][] = [
  'open',
  'claimed',
  'in_progress',
  'blocked',
  'approval_required',
  'done',
  'failed',
  'cancelled',
];

export function buildTaskBoardLanes(list: Task[]): CockpitTaskLane[] {
  const lanes: Array<CockpitTaskLane & { statuses: Task['status'][] }> = [
    { id: 'ready', label: 'Ready', hint: 'Open or blocked rows tied to this root.', statuses: ['open', 'blocked', 'approval_required'], tasks: [] },
    { id: 'claimed', label: 'Claimed', hint: 'Assigned but not actively moving.', statuses: ['claimed'], tasks: [] },
    { id: 'active', label: 'Active', hint: 'Work currently in progress.', statuses: ['in_progress'], tasks: [] },
    { id: 'closed', label: 'Closed', hint: 'Finished or stopped rows.', statuses: ['done', 'failed', 'cancelled'], tasks: [] },
  ];

  return lanes.map((lane) => ({
    ...lane,
    tasks: list
      .filter((task) => lane.statuses.includes(task.status))
      .sort((left, right) => (right.priority - left.priority) || (right.changed_at - left.changed_at)),
  }));
}

export function taskBelongsToProject(task: Task, project: Pick<ProjectSpace, 'id' | 'root' | 'additionalRoots'>, memberIds: Set<string> = new Set()): boolean {
  if (task.assignee && memberIds.has(task.assignee)) return true;
  const roots = [project.root, ...project.additionalRoots].filter(Boolean);
  return (task.files ?? []).some((file) => roots.some((root) => file === root || file.startsWith(`${root}/`)));
}

export function projectTasksForProject(
  tasks: Task[],
  project: Pick<ProjectSpace, 'id' | 'root' | 'additionalRoots'>,
  memberIds: Set<string> = new Set(),
): Task[] {
  return tasks.filter((task) => taskBelongsToProject(task, project, memberIds));
}

export function secondsSince(timestamp: number, nowMs = Date.now()): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const seconds = timestamp > 100_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
  return Math.max(0, Math.floor(nowMs / 1000) - seconds);
}

export function elapsedLabel(timestamp: number, nowMs = Date.now()): string {
  const seconds = secondsSince(timestamp, nowMs);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatTaskBoardActivityTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'now';
  const ms = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function inferTaskSection(task: Task): string {
  if (task.parent_task_id) return 'Child tasks';
  if (task.status === 'failed' || task.status === 'cancelled') return 'Needs recovery';
  if (task.status === 'done') return 'Closed';
  return 'Project tasks';
}

export function inferProvider(task: Task): TaskBoardProvider {
  const assignee = task.assignee?.toLowerCase() ?? '';
  const title = `${task.title} ${task.description ?? ''}`.toLowerCase();
  if (assignee.includes('claude') || title.includes('claude')) return 'claude';
  if (assignee.includes('hermes') || title.includes('hermes') || title.includes('nous')) return 'hermes';
  if (assignee.includes('openclaw') || title.includes('openclaw')) return 'openclaw';
  if (assignee.includes('opencode') || title.includes('review')) return 'opencode';
  if (assignee.includes('local') || title.includes('shell')) return 'local';
  return 'codex';
}

export function inferRole(task: Task): TaskBoardRole {
  const haystack = `${task.type} ${task.title} ${task.description ?? ''}`.toLowerCase();
  if (haystack.includes('review')) return 'reviewer';
  if (haystack.includes('research')) return 'researcher';
  if (haystack.includes('test') || haystack.includes('qa')) return 'tester';
  if (haystack.includes('plan')) return 'planner';
  if (haystack.includes('build') || haystack.includes('feature')) return 'builder';
  return 'implementer';
}

export function taskDetail(task: Task): string {
  const description = task.description?.trim();
  if (description) return description;
  const file = task.files?.[0];
  if (file) return compactPath(file);
  return 'No task detail yet.';
}

export function taskToBoardRow(projectId: string, task: Task, previous?: TaskBoardRow): TaskBoardRow {
  return {
    id: task.id,
    projectId,
    sourceTaskId: task.id,
    section: previous?.section || inferTaskSection(task),
    title: previous?.draft ? previous.title : task.title,
    description: previous?.draft ? previous.description : taskDetail(task),
    status: task.status,
    provider: previous?.provider ?? inferProvider(task),
    role: previous?.role ?? inferRole(task),
    assignee: task.assignee ?? previous?.assignee ?? '',
    listenerState: task.assignee ? 'bound' : 'waiting',
    elapsed: elapsedLabel(task.created_at),
    lastActivity: formatTaskBoardActivityTime(task.changed_at || task.updated_at || task.created_at),
    result: task.result ?? previous?.result ?? '',
    files: task.files ?? [],
    priority: task.priority,
    selected: previous?.selected ?? false,
    draft: false,
    launchStatus: previous?.launchStatus ?? (task.assignee ? 'launched' : 'not_launched'),
    launchPtyId: previous?.launchPtyId ?? '',
    launchInstanceId: previous?.launchInstanceId ?? task.assignee ?? '',
    launchError: previous?.launchError ?? '',
  };
}

export function createDraftTaskRow(input: Partial<TaskBoardRow> & {
  projectId: string;
  provider?: TaskBoardProvider;
  role?: TaskBoardRole;
}): TaskBoardRow {
  const now = Date.now();
  const projectId = input.projectId;
  return {
    id: input.id ?? `draft-${projectId}-${now}-${Math.random().toString(36).slice(2, 7)}`,
    projectId,
    sourceTaskId: null,
    section: input.section?.trim() || 'Imported Plan',
    title: input.title?.trim() || 'Untitled task',
    description: input.description?.trim() || '',
    status: input.status ?? 'open',
    provider: input.provider ?? 'codex',
    role: input.role ?? 'implementer',
    assignee: input.assignee ?? '',
    listenerState: input.listenerState ?? 'not launched',
    elapsed: input.elapsed ?? '0s',
    lastActivity: input.lastActivity ?? 'draft',
    result: input.result ?? '',
    files: input.files ?? [],
    priority: input.priority ?? 0,
    selected: input.selected ?? true,
    draft: true,
    launchStatus: input.launchStatus ?? 'not_launched',
    launchPtyId: input.launchPtyId ?? '',
    launchInstanceId: input.launchInstanceId ?? '',
    launchError: input.launchError ?? '',
  };
}

export function syncTaskBoardRows(projectId: string, taskList: Task[], previousRows: TaskBoardRow[]): TaskBoardRow[] {
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  const liveRows = taskList.map((task) => taskToBoardRow(projectId, task, previousById.get(task.id)));
  const draftRows = previousRows.filter((row) => row.draft && row.projectId === projectId);
  return [...liveRows, ...draftRows];
}

export function taskBoardSourceKey(projectId: string, taskList: Task[]): string {
  return `${projectId}:${taskList
    .map((task) => `${task.id}:${task.changed_at}:${task.updated_at}:${task.status}:${task.assignee ?? ''}:${task.title}`)
    .join('|')}`;
}

export function groupTaskBoardRows(rows: TaskBoardRow[]): TaskBoardSection[] {
  const groups = new Map<string, TaskBoardRow[]>();
  for (const row of rows) {
    const section = row.section.trim() || 'Unsectioned';
    groups.set(section, [...(groups.get(section) ?? []), row]);
  }
  return [...groups.entries()].map(([name, groupedRows]) => ({
    name,
    rows: groupedRows.sort((left, right) => (right.priority - left.priority) || left.title.localeCompare(right.title)),
  }));
}

export function updateTaskBoardRow(rows: TaskBoardRow[], id: string, patch: Partial<TaskBoardRow>): TaskBoardRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

export function toggleTaskSelection(rows: TaskBoardRow[], id: string, selected: boolean): TaskBoardRow[] {
  return updateTaskBoardRow(rows, id, { selected });
}

export function setAllTaskSelection(rows: TaskBoardRow[], selected: boolean): TaskBoardRow[] {
  return rows.map((row) => ({ ...row, selected }));
}

export function countSelectedTaskBoardRows(rows: TaskBoardRow[]): number {
  return rows.filter((row) => row.selected).length;
}

export function selectedTaskBoardRows(rows: TaskBoardRow[]): TaskBoardRow[] {
  return rows.filter((row) => row.selected);
}

export function applySelectedAssignmentToRows(
  rows: TaskBoardRow[],
  provider: TaskBoardProvider,
  role: TaskBoardRole,
): TaskBoardRow[] {
  return rows.map((row) => row.selected ? { ...row, provider, role } : row);
}

export function resetTaskLaunchStateForRow(row: TaskBoardRow): Partial<TaskBoardRow> {
  return {
    assignee: '',
    listenerState: 'ready to relaunch',
    lastActivity: 'reset just now',
    launchStatus: 'not_launched',
    launchPtyId: '',
    launchInstanceId: '',
    launchError: '',
    selected: true,
    status: row.status === 'done' ? 'open' : row.status,
  };
}

export function reassignTaskRowToBulk(
  row: TaskBoardRow,
  provider: TaskBoardProvider,
  role: TaskBoardRole,
): Partial<TaskBoardRow> {
  return {
    provider,
    role,
    assignee: '',
    listenerState: 'reassigned, ready',
    lastActivity: 'reassigned just now',
    launchStatus: 'not_launched',
    launchPtyId: '',
    launchInstanceId: '',
    launchError: '',
    selected: true,
    status: row.status === 'done' ? 'open' : row.status,
  };
}

export function parsePlanRows(
  text: string,
  projectId: string,
  provider: TaskBoardProvider = 'codex',
  role: TaskBoardRole = 'implementer',
): TaskBoardRow[] {
  const rows: TaskBoardRow[] = [];
  let section = 'Imported Plan';
  let previousRow: TaskBoardRow | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      previousRow = null;
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      previousRow = null;
      continue;
    }

    const taskMatch = line.match(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.+)$/);
    if (taskMatch) {
      const title = taskMatch[1].replace(/^\s*task\s*[:-]\s*/i, '').trim();
      if (title) {
        previousRow = createDraftTaskRow({
          projectId,
          provider,
          role,
          section,
          title,
          description: '',
          selected: true,
        });
        rows.push(previousRow);
      }
      continue;
    }

    if (previousRow) {
      previousRow.description = [previousRow.description, line].filter(Boolean).join('\n');
    }
  }

  return rows;
}

export function providerToLaunchHarness(provider: TaskBoardProvider): TaskBoardLaunchHarness | null {
  return provider === 'codex' || provider === 'claude' || provider === 'hermes' || provider === 'openclaw' || provider === 'opencode'
    ? provider
    : null;
}

export function roleToLaunchRole(role: TaskBoardRole): string {
  return role === 'tester' ? 'qa' : role;
}

export function safeLaunchToken(value: string, fallback: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) return fallback;
  if (token.length <= 32) return token;
  return `${token.slice(0, 20)}_${token.slice(-11)}`;
}

export function taskLaunchName(row: TaskBoardRow, launchRole: string): string {
  return safeLaunchToken(`${launchRole}-${row.title}`, `${launchRole}-task`);
}

export function taskLaunchLabel(
  projectId: string,
  row: TaskBoardRow,
  source = 'mission_board',
  slice = 'canvas_mission_v1',
): string {
  return [
    `project:${safeLaunchToken(projectId, 'project')}`,
    `task:${safeLaunchToken(row.sourceTaskId ?? row.id, 'task')}`,
    `task_title:${safeLaunchToken(row.title, 'task')}`,
    `source:${safeLaunchToken(source, 'mission_board')}`,
    `slice:${safeLaunchToken(slice, 'canvas_mission_v1')}`,
  ].join(' ');
}

export function taskLaunchInstructions(input: {
  project: Pick<ProjectSpace, 'id' | 'name' | 'root' | 'scope'>;
  row: TaskBoardRow;
  harness: TaskBoardLaunchHarness;
  launchRole: string;
  source?: string;
}): string {
  const { project, row, harness, launchRole } = input;
  const files = row.files.length > 0
    ? row.files.map((file) => `- ${file}`).join('\n')
    : '- No files attached yet.';
  return [
    '[task-bound-launch]',
    `Project: ${project.name}`,
    `Project id: ${project.id}`,
    `Project root: ${project.root}`,
    `Internal channel: ${project.scope || project.root}`,
    `Task row id: ${row.sourceTaskId ?? row.id}`,
    `Task title: ${row.title}`,
    `Task section: ${row.section}`,
    `Task status at launch: ${row.status.replace(/_/g, ' ')}`,
    `Provider and role: ${harness}/${launchRole}`,
    `Launch source: ${input.source ?? 'mission_board'}`,
    `Description: ${row.description || 'No description provided.'}`,
    'Files:',
    files,
    'This terminal was launched for this exact task context.',
    `After registration, broadcast "[task-bound] ${row.title} ready" in the shared Conversation panel, then call wait_for_activity unless this exact instance id receives a direct assignment.`,
  ].join('\n');
}

export function statusAfterLaunch(status: Task['status']): Task['status'] {
  return status === 'in_progress' ? 'in_progress' : 'claimed';
}

export function taskRowsForProofPack(rows: TaskBoardRow[], instances: Array<{ id: string; status: InstanceStatus }>): import('./proofPack').ProofPackTaskRow[] {
  return rows.map((row) => {
    const runtime = resolveTaskBoardRowRuntime(row, instances);
    return {
      id: row.id,
      sourceTaskId: row.sourceTaskId,
      section: row.section,
      title: row.title,
      description: row.description,
      status: row.status,
      provider: row.provider,
      role: row.role,
      assignee: row.assignee,
      listenerState: runtime.listenerState,
      elapsed: row.elapsed,
      lastActivity: row.lastActivity,
      result: row.result,
      files: row.files,
      priority: row.priority,
      selected: row.selected,
      draft: row.draft,
      launchStatus: row.launchStatus,
      launchPtyId: row.launchPtyId,
      launchInstanceId: row.launchInstanceId,
      launchError: runtime.launchError,
    };
  });
}

function compactPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized || path;
  return `.../${parts.slice(-2).join('/')}`;
}
