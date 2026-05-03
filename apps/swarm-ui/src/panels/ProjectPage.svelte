<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import type { AssetKind, Event, Instance, Lock, ProjectInventoryEntry, ProjectMembership, ProjectSpace, Task } from '../lib/types';
  import AssetGrid from './AssetGrid.svelte';
  import {
    DEFAULT_PROJECT_COLOR,
    deleteProject,
    normalizeProjectColor,
    saveProject,
  } from '../stores/projects';
  import {
    attachAsset,
    analyzeProjectAsset,
    deleteProjectAsset,
    loadProjectAssets,
    projectAssets,
    assetAttachments,
    projectFileBubbleFolders,
    projectFileBubbleItems,
    projectInventory,
    projectInventoryDisplay,
    projectAssetRefreshSummary,
    readAssetTextFile,
    refreshProjectAssets,
    saveProjectAsset,
    type ProjectFileBubbleItem,
  } from '../stores/projectAssets';
  import { confirm } from '../lib/confirm';
  import {
    assetDialogOptionsForKind,
    assetDraftFromPickedPath,
    firstDialogSelection,
  } from '../lib/assetIntake';
  import { buildAssetDirectMessage } from '../lib/assetContext';
  import {
    buildTaskBoardProofPack,
    collectVisualEvidence,
    type ProofPackTaskRow,
  } from '../lib/proofPack';
  import {
    canRetryTaskBoardRow,
    resolveTaskBoardRowRuntime,
    type TaskBoardInstanceRuntimeInput,
    type TaskBoardLaunchStatus,
  } from '../lib/taskBoardState';
  import { buildReviewShipSummary } from '../lib/reviewShip';
  import {
    POST_SESSION_AREAS,
    backgroundRunsForProject,
    buildBackgroundLaunchLabel,
    buildBackgroundWorkPrompt,
    buildImprovementTaskSeed,
    buildPostSessionReviewAsset,
    validateBackgroundWorkPolicy,
    type BackgroundRunSummary,
    type BackgroundTrustPosture,
    type PostSessionArea,
    type PostSessionReviewDraft,
  } from '../lib/postSessionImprovement';
  import { requestNodeFocus } from '../lib/app/focus';
  import { killInstance, sendOperatorMessage, spawnShell } from '../stores/pty';
  import { resolveHarnessCommand } from '../stores/harnessAliases';
  import {
    formatLaunchPreflightFailure,
    preflightLaunchCommand,
    summarizeLaunchCommandPreflight,
  } from '../lib/launchPreflight';
  import darkFolderUrl from '../assets/dark-folder.png';

  export let project: ProjectSpace;
  export let memberships: ProjectMembership[] = [];
  export let instances: Instance[] = [];
  export let tasks: Task[] = [];
  export let locks: Lock[] = [];
  export let events: Event[] = [];

  type CockpitTaskLane = {
    id: string;
    label: string;
    hint: string;
    tasks: Task[];
  };

  type ProjectActivityEntry = {
    id: string;
    title: string;
    detail: string;
    meta: string;
    timestamp: number;
    kind: 'task' | 'agent' | 'event';
  };

  type TaskBoardProvider = 'codex' | 'claude' | 'opencode' | 'local';
  type TaskBoardRole = 'planner' | 'implementer' | 'reviewer' | 'researcher' | 'tester';
  type TaskBoardLaunchHarness = 'codex' | 'claude' | 'opencode';
  type TaskBoardRow = {
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
  };

  type TaskBoardSection = {
    name: string;
    rows: TaskBoardRow[];
  };

  type DiagnosticCommandResult = {
    ok?: boolean;
    path?: string;
    error?: string;
    [key: string]: unknown;
  };

  const TASK_BOARD_PROVIDERS: Array<{ value: TaskBoardProvider; label: string }> = [
    { value: 'codex', label: 'Codex' },
    { value: 'claude', label: 'Claude' },
    { value: 'opencode', label: 'opencode' },
    { value: 'local', label: 'Local shell' },
  ];

  const TASK_BOARD_ROLES: Array<{ value: TaskBoardRole; label: string }> = [
    { value: 'implementer', label: 'Implementer' },
    { value: 'planner', label: 'Planner' },
    { value: 'reviewer', label: 'Reviewer' },
    { value: 'researcher', label: 'Researcher' },
    { value: 'tester', label: 'Tester' },
  ];

  const TASK_BOARD_STATUSES: Task['status'][] = [
    'open',
    'claimed',
    'in_progress',
    'blocked',
    'approval_required',
    'done',
    'failed',
    'cancelled',
  ];

  const dispatch = createEventDispatcher<{
    close: void;
    deleted: { projectId: string };
    respawnAgent: { project: ProjectSpace; instanceId: string };
  }>();

  let draftProjectId = '';
  let draftColor = DEFAULT_PROJECT_COLOR;
  let draftNotes = '';
  let draftAdditionalRoots = '';
  let saving = false;
  let deleting = false;
  let saveMessage: string | null = null;
  let saveError: string | null = null;
  let assetKind: AssetKind = 'image';
  let assetTitle = '';
  let assetPath = '';
  let assetDescription = '';
  let assetContent = '';
  let assetSaving = false;
  let assetPicking = false;
  let assetRefreshing = false;
  let analyzingAssetIds = new Set<string>();
  let resettingView = false;
  let taskBoardRows: TaskBoardRow[] = [];
  let taskBoardSourceKey = '';
  let planImportText = '';
  let taskBoardMessage: string | null = null;
  let taskBoardError: string | null = null;
  let bulkProvider: TaskBoardProvider = 'codex';
  let bulkRole: TaskBoardRole = 'implementer';
  let launchActionMessage: string | null = null;
  let launchingTaskIds = new Set<string>();
  let proofPackNote = '';
  let proofPackCapturing = false;
  let proofPackMessage: string | null = null;
  let proofPackError: string | null = null;
  let reviewShipMessage: string | null = null;
  let reviewShipError: string | null = null;
  let postSessionWorked = '';
  let postSessionConfusing = '';
  let postSessionBroke = '';
  let postSessionArea: PostSessionArea = 'Tasks';
  let postSessionPrompt = '';
  let postSessionCreateTask = true;
  let backgroundWorkOptIn = false;
  let backgroundHarness: TaskBoardLaunchHarness = 'codex';
  let backgroundRole: TaskBoardRole = 'implementer';
  let backgroundTrustPosture: BackgroundTrustPosture = 'standard';
  let backgroundTimeoutMinutes = 90;
  let backgroundIdlePolicy = 'Report progress every 15 minutes; stop and report if blocked or idle for 20 minutes.';
  let postSessionSaving = false;
  let backgroundLaunching = false;
  let postSessionMessage: string | null = null;
  let postSessionError: string | null = null;
  let assetError: string | null = null;
  let loadedAssetProjectId = '';
  let selectedBubbleFolderPath = '';
  let selectedBubbleItemPath = '';
  let bubbleFolderHistory: string[] = [];
  let bubbleFolderOpen = false;
  let bubbleImageFailed = false;
  let bubbleMediaFailed = false;
  let lastBubbleMediaSrc = '';
  let lastBubbleImageSrc = '';
  let expandedBubbleImageUrl = '';
  let bubbleTextContent = '';
  let bubbleTextLoading = false;
  let bubbleTextError: string | null = null;
  let bubblePreviewRequestId = 0;
  const colorInputId = `project-color-picker-${Math.random().toString(36).slice(2)}`;
  const ASSET_KINDS: AssetKind[] = ['image', 'screenshot', 'note', 'folder', 'protocol', 'reference'];

  $: if (project.id !== draftProjectId) {
    draftProjectId = project.id;
    draftColor = normalizeProjectColor(project.color);
    draftNotes = project.notes;
    draftAdditionalRoots = project.additionalRoots.join('\n');
    saveMessage = null;
    saveError = null;
    selectedBubbleFolderPath = '';
    selectedBubbleItemPath = '';
    bubbleFolderHistory = [];
    bubbleFolderOpen = false;
    expandedBubbleImageUrl = '';
    taskBoardRows = [];
    taskBoardSourceKey = '';
    planImportText = '';
    taskBoardMessage = null;
    taskBoardError = null;
    launchActionMessage = null;
    launchingTaskIds = new Set<string>();
    proofPackNote = '';
    proofPackMessage = null;
    proofPackError = null;
    reviewShipMessage = null;
    reviewShipError = null;
    postSessionWorked = '';
    postSessionConfusing = '';
    postSessionBroke = '';
    postSessionArea = 'Tasks';
    postSessionPrompt = '';
    postSessionCreateTask = true;
    backgroundWorkOptIn = false;
    backgroundHarness = 'codex';
    backgroundRole = 'implementer';
    backgroundTrustPosture = 'standard';
    backgroundTimeoutMinutes = 90;
    backgroundIdlePolicy = 'Report progress every 15 minutes; stop and report if blocked or idle for 20 minutes.';
    postSessionMessage = null;
    postSessionError = null;
    clearBubbleTextPreview();
  }

  $: projectMemberships = memberships.filter((entry) => entry.projectId === project.id);
  $: projectMemberIds = new Set(projectMemberships.map((entry) => entry.instanceId));
  $: projectAgents = instances.filter((instance) => projectMemberIds.has(instance.id));
  $: projectRoots = [project.root, ...project.additionalRoots].filter(Boolean);
  $: projectTasks = tasks.filter((task) => {
    if (task.assignee && projectMemberIds.has(task.assignee)) return true;
    const files = Array.isArray(task.files) ? task.files : [];
    return files.some((file) => projectRoots.some((root) => file === root || file.startsWith(`${root}/`)));
  });
  $: taskBoardLanes = buildTaskBoardLanes(projectTasks);
  $: nextTaskBoardSourceKey = `${project.id}:${projectTasks
    .map((task) => `${task.id}:${task.changed_at}:${task.updated_at}:${task.status}:${task.assignee ?? ''}:${task.title}`)
    .join('|')}`;
  $: if (nextTaskBoardSourceKey !== taskBoardSourceKey) {
    syncTaskBoardRows(nextTaskBoardSourceKey, projectTasks);
  }
  $: taskBoardSections = groupTaskBoardRows(taskBoardRows);
  $: selectedTaskRows = taskBoardRows.filter((row) => row.selected);
  $: selectedTaskCount = selectedTaskRows.length;
  $: taskLaunchInFlight = launchingTaskIds.size > 0;
  $: taskBoardInstanceStates = instances.map((instance): TaskBoardInstanceRuntimeInput => ({
    id: instance.id,
    status: instance.status,
  }));
  $: projectLocks = locks.filter((lock) => projectRoots.some((root) => lock.file === root || lock.file.startsWith(`${root}/`)));
  $: projectFiles = uniqueStrings([
    ...projectTasks.flatMap((task) => task.files ?? []),
    ...projectLocks.map((lock) => lock.file),
  ]);
  $: openTasks = projectTasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  $: runningProjectAgents = projectAgents.filter((instance) => instance.status === 'online');
  $: reconnectableProjectAgents = projectAgents.filter((instance) => instance.status !== 'online');
  $: browserContextCount = projectMemberships.filter((entry) => entry.instanceId.startsWith('browser:')).length;
  $: recentProjectActivity = buildProjectActivity(projectTasks, projectAgents, events, projectMemberIds).slice(0, 6);
  $: reviewShipSummary = buildReviewShipSummary({
    project,
    tasks: projectTasks,
    agents: projectAgents,
    locks: projectLocks,
  });
  $: primaryReviewer = reviewShipSummary.reviewerCandidates[0] ?? null;
  $: postSessionReviewDraft = {
    worked: postSessionWorked,
    confusing: postSessionConfusing,
    broke: postSessionBroke,
    area: postSessionArea,
    prompt: postSessionPrompt,
    createTask: postSessionCreateTask,
    backgroundOptIn: backgroundWorkOptIn,
  } satisfies PostSessionReviewDraft;
  $: backgroundPolicy = {
    project,
    cwd: project.root,
    scope: project.scope || project.root,
    harness: backgroundHarness,
    role: roleToLaunchRole(backgroundRole),
    trustPosture: backgroundTrustPosture,
    timeoutMinutes: Number(backgroundTimeoutMinutes),
    idlePolicy: backgroundIdlePolicy,
  };
  $: backgroundRunRows = backgroundRunsForProject(project, instances);
  $: visibleAssets = $projectAssets.filter((asset) => asset.projectId === project.id);
  $: visibleInventory = $projectInventory.filter((entry) => entry.projectId === project.id);
  $: inventoryDisplay = projectInventoryDisplay(visibleInventory);
  $: fileBubbleFolders = projectFileBubbleFolders(projectRoots, visibleInventory, visibleAssets);
  $: if (!fileBubbleFolders.some((folder) => folder.path === selectedBubbleFolderPath)) {
    selectedBubbleFolderPath = fileBubbleFolders[0]?.path ?? '';
    bubbleFolderHistory = [];
    bubbleFolderOpen = false;
  }
  $: selectedBubbleFolder = fileBubbleFolders.find((folder) => folder.path === selectedBubbleFolderPath) ?? null;
  $: fileBubbleItems = selectedBubbleFolder
    ? projectFileBubbleItems(selectedBubbleFolder.path, visibleInventory, visibleAssets, projectRoots)
    : [];
  $: if (!fileBubbleItems.some((item) => item.path === selectedBubbleItemPath)) {
    selectedBubbleItemPath = '';
    clearBubbleTextPreview();
  }
  $: selectedBubbleItem = fileBubbleItems.find((item) => item.path === selectedBubbleItemPath) ?? null;
  $: selectedBubbleImageSrc = selectedBubbleItem?.isImage && selectedBubbleItem.path
    ? convertPreviewPath(selectedBubbleItem.path)
    : '';
  $: if (selectedBubbleImageSrc !== lastBubbleImageSrc) {
    lastBubbleImageSrc = selectedBubbleImageSrc;
    bubbleImageFailed = false;
  }
  $: selectedBubbleMediaSrc = selectedBubbleItem && canPreviewAsMedia(selectedBubbleItem)
    ? convertPreviewPath(selectedBubbleItem.path)
    : '';
  $: if (selectedBubbleMediaSrc !== lastBubbleMediaSrc) {
    lastBubbleMediaSrc = selectedBubbleMediaSrc;
    bubbleMediaFailed = false;
  }
  $: visibleAssetAttachments = $assetAttachments.filter((attachment) =>
    visibleAssets.some((asset) => asset.id === attachment.assetId),
  );
  $: if (project.id && project.id !== loadedAssetProjectId) {
    loadedAssetProjectId = project.id;
    void loadProjectAssets(project.id).catch((err) => {
      assetError = err instanceof Error ? err.message : String(err);
    });
  }

  function close(): void {
    dispatch('close');
  }

  function displayInstance(instance: Instance): string {
    const name = instance.label
      ?.split(/\s+/)
      .find((token) => token.startsWith('name:'))
      ?.slice('name:'.length)
      .replace(/_/g, ' ');
    return name || instance.id.slice(0, 8);
  }

  function compactPath(path: string): string {
    const normalized = path.replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 2) return normalized || path;
    return `.../${parts.slice(-2).join('/')}`;
  }

  function statusLabel(status: Task['status'] | Instance['status']): string {
    return status.replace(/_/g, ' ');
  }

  function statusClass(status: Task['status'] | Instance['status']): string {
    return status.replace(/_/g, '-');
  }

  function taskDetail(task: Task): string {
    const description = task.description?.trim();
    if (description) return description;
    const file = task.files?.[0];
    if (file) return compactPath(file);
    return 'No task detail yet.';
  }

  function buildTaskBoardLanes(list: Task[]): CockpitTaskLane[] {
    const lanes: Array<CockpitTaskLane & { statuses: Task['status'][] }> = [
      {
        id: 'ready',
        label: 'Ready',
        hint: 'Open or blocked rows tied to this root.',
        statuses: ['open', 'blocked', 'approval_required'],
        tasks: [],
      },
      {
        id: 'claimed',
        label: 'Claimed',
        hint: 'Assigned but not actively moving.',
        statuses: ['claimed'],
        tasks: [],
      },
      {
        id: 'active',
        label: 'Active',
        hint: 'Work currently in progress.',
        statuses: ['in_progress'],
        tasks: [],
      },
      {
        id: 'closed',
        label: 'Closed',
        hint: 'Finished or stopped rows.',
        statuses: ['done', 'failed', 'cancelled'],
        tasks: [],
      },
    ];

    return lanes.map((lane) => ({
      ...lane,
      tasks: list
        .filter((task) => lane.statuses.includes(task.status))
        .sort((left, right) => (right.priority - left.priority) || (right.changed_at - left.changed_at)),
    }));
  }

  function secondsSince(timestamp: number): number {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
    const seconds = timestamp > 100_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
    return Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  }

  function elapsedLabel(timestamp: number): string {
    const seconds = secondsSince(timestamp);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function inferTaskSection(task: Task): string {
    if (task.parent_task_id) return 'Child tasks';
    if (task.status === 'failed' || task.status === 'cancelled') return 'Needs recovery';
    if (task.status === 'done') return 'Closed';
    return 'Project tasks';
  }

  function inferProvider(task: Task): TaskBoardProvider {
    const assignee = task.assignee?.toLowerCase() ?? '';
    const title = `${task.title} ${task.description ?? ''}`.toLowerCase();
    if (assignee.includes('claude') || title.includes('claude')) return 'claude';
    if (assignee.includes('opencode') || title.includes('review')) return 'opencode';
    if (assignee.includes('local') || title.includes('shell')) return 'local';
    return 'codex';
  }

  function inferRole(task: Task): TaskBoardRole {
    const haystack = `${task.type} ${task.title} ${task.description ?? ''}`.toLowerCase();
    if (haystack.includes('review')) return 'reviewer';
    if (haystack.includes('research')) return 'researcher';
    if (haystack.includes('test') || haystack.includes('qa')) return 'tester';
    if (haystack.includes('plan')) return 'planner';
    return 'implementer';
  }

  function taskToBoardRow(task: Task, previous?: TaskBoardRow): TaskBoardRow {
    return {
      id: task.id,
      projectId: project.id,
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
      lastActivity: formatActivityTime(task.changed_at || task.updated_at || task.created_at),
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

  function createDraftTaskRow(input: Partial<TaskBoardRow> = {}): TaskBoardRow {
    const now = Date.now();
    return {
      id: input.id ?? `draft-${project.id}-${now}-${Math.random().toString(36).slice(2, 7)}`,
      projectId: project.id,
      sourceTaskId: null,
      section: input.section?.trim() || 'Imported Plan',
      title: input.title?.trim() || 'Untitled task',
      description: input.description?.trim() || '',
      status: input.status ?? 'open',
      provider: input.provider ?? bulkProvider,
      role: input.role ?? bulkRole,
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

  function syncTaskBoardRows(key: string, taskList: Task[]): void {
    const previousRows = new Map(taskBoardRows.map((row) => [row.id, row]));
    const liveRows = taskList.map((task) => taskToBoardRow(task, previousRows.get(task.id)));
    const draftRows = taskBoardRows.filter((row) => row.draft && row.projectId === project.id);
    taskBoardRows = [...liveRows, ...draftRows];
    taskBoardSourceKey = key;
  }

  function groupTaskBoardRows(rows: TaskBoardRow[]): TaskBoardSection[] {
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

  function updateTaskBoardRow(id: string, patch: Partial<TaskBoardRow>): void {
    taskBoardRows = taskBoardRows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  function setTaskLaunching(id: string, launching: boolean): void {
    const next = new Set(launchingTaskIds);
    if (launching) {
      next.add(id);
    } else {
      next.delete(id);
    }
    launchingTaskIds = next;
  }

  function toggleTaskSelection(id: string, selected: boolean): void {
    updateTaskBoardRow(id, { selected });
  }

  function setAllTaskSelection(selected: boolean): void {
    taskBoardRows = taskBoardRows.map((row) => ({ ...row, selected }));
  }

  function resetTaskLaunchState(rowId: string): void {
    const row = taskBoardRows.find((entry) => entry.id === rowId);
    if (!row) return;

    updateTaskBoardRow(rowId, {
      assignee: '',
      listenerState: 'ready to relaunch',
      lastActivity: 'reset just now',
      launchStatus: 'not_launched',
      launchPtyId: '',
      launchInstanceId: '',
      launchError: '',
      selected: true,
      status: row.status === 'done' ? 'open' : row.status,
    });
    taskBoardMessage = `Reset ${row.title} launch identity.`;
    taskBoardError = null;
    launchActionMessage = null;
  }

  function reassignTaskRow(rowId: string): void {
    const row = taskBoardRows.find((entry) => entry.id === rowId);
    if (!row) return;

    updateTaskBoardRow(rowId, {
      provider: bulkProvider,
      role: bulkRole,
      assignee: '',
      listenerState: 'reassigned, ready',
      lastActivity: 'reassigned just now',
      launchStatus: 'not_launched',
      launchPtyId: '',
      launchInstanceId: '',
      launchError: '',
      selected: true,
      status: row.status === 'done' ? 'open' : row.status,
    });
    taskBoardMessage = `Reassigned ${row.title} to ${bulkProvider} / ${bulkRole}.`;
    taskBoardError = null;
    launchActionMessage = null;
  }

  function addBlankTaskRow(): void {
    taskBoardMessage = null;
    taskBoardError = null;
    launchActionMessage = null;
    taskBoardRows = [
      ...taskBoardRows,
      createDraftTaskRow({
        section: 'Manual Tasks',
        title: 'New task',
        selected: false,
      }),
    ];
  }

  function parsePlanRows(text: string): TaskBoardRow[] {
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

  function importPlanRows(): void {
    taskBoardMessage = null;
    taskBoardError = null;
    launchActionMessage = null;
    const rows = parsePlanRows(planImportText);
    if (rows.length === 0) {
      taskBoardError = 'Paste a plan with headings and bullet or numbered task lines.';
      return;
    }
    taskBoardRows = [...taskBoardRows, ...rows];
    taskBoardMessage = `Imported ${rows.length} editable task row${rows.length === 1 ? '' : 's'}.`;
  }

  function applySelectedAssignment(): void {
    if (selectedTaskCount === 0) return;
    taskBoardRows = taskBoardRows.map((row) =>
      row.selected ? { ...row, provider: bulkProvider, role: bulkRole } : row,
    );
    taskBoardMessage = `Assigned ${selectedTaskCount} selected row${selectedTaskCount === 1 ? '' : 's'} to ${bulkProvider} / ${bulkRole}.`;
    launchActionMessage = null;
  }

  function providerToLaunchHarness(provider: TaskBoardProvider): TaskBoardLaunchHarness | null {
    if (provider === 'codex' || provider === 'claude' || provider === 'opencode') {
      return provider;
    }
    return null;
  }

  function roleToLaunchRole(role: TaskBoardRole): string {
    return role === 'tester' ? 'qa' : role;
  }

  function safeLaunchToken(value: string, fallback: string): string {
    const token = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!token) return fallback;
    if (token.length <= 32) return token;
    return `${token.slice(0, 20)}_${token.slice(-11)}`;
  }

  function taskLaunchName(row: TaskBoardRow, launchRole: string): string {
    return safeLaunchToken(`${launchRole}-${row.title}`, `${launchRole}-task`);
  }

  function taskLaunchLabel(row: TaskBoardRow): string {
    return [
      `project:${safeLaunchToken(project.id, 'project')}`,
      `task:${safeLaunchToken(row.sourceTaskId ?? row.id, 'task')}`,
      `task_title:${safeLaunchToken(row.title, 'task')}`,
      'source:project_task_board',
      'slice:may_1_s4',
    ].join(' ');
  }

  function taskLaunchInstructions(
    row: TaskBoardRow,
    harness: TaskBoardLaunchHarness,
    launchRole: string,
  ): string {
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
      `Task status at launch: ${statusLabel(row.status)}`,
      `Provider and role: ${harness}/${launchRole}`,
      `Description: ${row.description || 'No description provided.'}`,
      'Files:',
      files,
      'This terminal was launched from the Project Task Board for this exact task context.',
      `After registration, broadcast "[task-bound] ${row.title} ready" in the shared Conversation panel, then call wait_for_activity unless this exact instance id receives a direct assignment.`,
    ].join('\n');
  }

  function statusAfterLaunch(status: Task['status']): Task['status'] {
    return status === 'in_progress' ? 'in_progress' : 'claimed';
  }

  async function launchTaskRows(rowsToLaunch: TaskBoardRow[], mode: 'selected' | 'retry'): Promise<void> {
    if (rowsToLaunch.length === 0 || taskLaunchInFlight) return;

    let launched = 0;
    let failed = 0;
    taskBoardMessage = null;
    taskBoardError = null;
    launchActionMessage = mode === 'retry'
      ? `Retrying ${rowsToLaunch.length} task${rowsToLaunch.length === 1 ? '' : 's'}...`
      : `Launching ${rowsToLaunch.length} selected task${rowsToLaunch.length === 1 ? '' : 's'}...`;

    for (const row of rowsToLaunch) {
      const harness = providerToLaunchHarness(row.provider);
      if (!harness) {
        failed += 1;
        updateTaskBoardRow(row.id, {
          launchStatus: 'failed',
          launchError: 'Choose Codex, Claude, or opencode for a task-bound launch.',
          listenerState: 'launch blocked',
          selected: true,
        });
        continue;
      }

      const launchRole = roleToLaunchRole(row.role);
      setTaskLaunching(row.id, true);
      updateTaskBoardRow(row.id, {
        launchStatus: 'launching',
        assignee: '',
        launchError: '',
        launchInstanceId: '',
        launchPtyId: '',
        listenerState: 'preflighting',
        result: row.result.trim() || `Launching ${harness}/${launchRole}...`,
      });

      try {
        const command = resolveHarnessCommand(harness);
        const commandPreflight = await preflightLaunchCommand({
          command,
          cwd: project.root,
          harness,
          commandSource: 'Task Board provider command',
        });
        if (!commandPreflight.ok) {
          throw new Error(formatLaunchPreflightFailure(commandPreflight));
        }
        const preflightSummary = summarizeLaunchCommandPreflight(commandPreflight);
        updateTaskBoardRow(row.id, {
          listenerState: commandPreflight.trustPosture === 'full-access'
            ? 'preflight full access'
            : 'preflight ok',
          result: row.result.trim()
            ? `Preflight OK: ${preflightSummary}\n${row.result}`
            : `Preflight OK: ${preflightSummary}`,
        });

        const result = await spawnShell(project.root, {
          harness,
          role: launchRole,
          scope: project.scope || project.root,
          label: taskLaunchLabel(row),
          name: taskLaunchName(row, launchRole),
          bootstrapInstructions: taskLaunchInstructions(row, harness, launchRole),
          launchPreflight: commandPreflight,
        });
        const focusNodeId = result.instance_id
          ? `bound:${result.instance_id}`
          : `pty:${result.pty_id}`;
        requestNodeFocus(focusNodeId);

        const launchSummary = `Preflight OK: ${preflightSummary}\nLaunched ${harness}/${launchRole}${result.instance_id ? ` as ${result.instance_id.slice(0, 8)}` : ''}.`;
        updateTaskBoardRow(row.id, {
          assignee: result.instance_id ?? `pty:${result.pty_id}`,
          listenerState: result.instance_id ? 'launched and bound' : 'pty launched',
          lastActivity: 'just now',
          status: statusAfterLaunch(row.status),
          result: row.result.trim() ? `${launchSummary}\n${row.result}` : launchSummary,
          selected: false,
          launchStatus: 'launched',
          launchPtyId: result.pty_id,
          launchInstanceId: result.instance_id ?? '',
          launchError: '',
        });
        launched += 1;
      } catch (err) {
        failed += 1;
        updateTaskBoardRow(row.id, {
          launchStatus: 'failed',
          launchError: err instanceof Error ? err.message : String(err),
          listenerState: 'launch failed',
          assignee: '',
          launchInstanceId: '',
          launchPtyId: '',
          selected: true,
        });
      } finally {
        setTaskLaunching(row.id, false);
      }
    }

    if (failed > 0) {
      taskBoardError = `${failed} task launch${failed === 1 ? '' : 'es'} failed. Check the row launch details.`;
    }
    launchActionMessage = mode === 'retry'
      ? `Retried ${launched}/${rowsToLaunch.length} task-bound agent${launched === 1 ? '' : 's'}.`
      : `Launched ${launched}/${rowsToLaunch.length} task-bound agent${launched === 1 ? '' : 's'}.`;
  }

  async function launchSelectedTasks(): Promise<void> {
    if (selectedTaskCount === 0 || taskLaunchInFlight) return;
    await launchTaskRows([...selectedTaskRows], 'selected');
  }

  async function retryTaskRow(rowId: string): Promise<void> {
    const row = taskBoardRows.find((entry) => entry.id === rowId);
    if (!row || taskLaunchInFlight || launchingTaskIds.has(rowId)) return;
    await launchTaskRows([row], 'retry');
  }

  function taskRowsForProofPack(): ProofPackTaskRow[] {
    return taskBoardRows.map((row) => {
      const runtime = resolveTaskBoardRowRuntime(row, taskBoardInstanceStates);
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

  async function requestTaskBoardScreenshot(): Promise<DiagnosticCommandResult> {
    try {
      return await invoke<DiagnosticCommandResult>('ui_capture_screenshot', { out: null });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function captureTaskBoardProofPack(): Promise<void> {
    if (proofPackCapturing) return;
    proofPackCapturing = true;
    proofPackMessage = null;
    proofPackError = null;

    try {
      const screenshot = await requestTaskBoardScreenshot();
      const taskBoardElement = document.querySelector('.project-section--task-board-mvp');
      const pack = buildTaskBoardProofPack({
        surface: 'project-task-board',
        note: proofPackNote,
        project: {
          id: project.id,
          name: project.name,
          root: project.root,
          scope: project.scope,
          color: normalizeProjectColor(project.color),
        },
        taskRows: taskRowsForProofPack(),
        agents: projectAgents.map((agent) => ({
          id: agent.id,
          label: agent.label,
          status: agent.status,
          directory: agent.directory,
          scope: agent.scope,
          heartbeat: agent.heartbeat,
        })),
        activity: recentProjectActivity.map((entry) => ({
          title: entry.title,
          detail: entry.detail,
          meta: entry.meta,
          timestamp: entry.timestamp,
          kind: entry.kind,
        })),
        screenshot,
        visual: collectVisualEvidence(taskBoardElement ?? undefined),
      });

      const result = await invoke<DiagnosticCommandResult>('ui_write_proof_pack', {
        pack,
        out: null,
      });
      if (result.ok === false) {
        throw new Error(result.error || 'Proof pack write failed.');
      }
      const suffix = screenshot.ok === false ? ' Screenshot capture is marked unsupported in the artifact.' : '';
      proofPackMessage = result.path
        ? `Proof pack saved to ${result.path}.${suffix}`
        : `Proof pack captured.${suffix}`;
    } catch (err) {
      proofPackError = err instanceof Error ? err.message : String(err);
    } finally {
      proofPackCapturing = false;
    }
  }

  async function copyReviewShipText(text: string, label: string): Promise<void> {
    reviewShipError = null;
    reviewShipMessage = null;
    try {
      await navigator.clipboard.writeText(text);
      reviewShipMessage = `${label} copied.`;
    } catch (err) {
      reviewShipError = err instanceof Error ? err.message : `Failed to copy ${label.toLowerCase()}.`;
    }
  }

  async function askReviewerAgent(): Promise<void> {
    reviewShipError = null;
    reviewShipMessage = null;
    if (!primaryReviewer) {
      reviewShipError = 'No online reviewer/opencode agent is available in this project.';
      return;
    }

    try {
      const sent = await sendOperatorMessage(
        project.scope || project.root,
        primaryReviewer.id,
        reviewShipSummary.reviewerHandoff,
      );
      if (!sent) {
        reviewShipError = `Reviewer ${primaryReviewer.label} disappeared before the handoff was sent.`;
        return;
      }
      reviewShipMessage = `Review handoff sent to ${primaryReviewer.label}.`;
    } catch (err) {
      reviewShipError = err instanceof Error ? err.message : 'Failed to send reviewer handoff.';
    }
  }

  function addPostSessionImprovementTask(): TaskBoardRow {
    const seed = buildImprovementTaskSeed({
      review: postSessionReviewDraft,
      policy: backgroundPolicy,
    });
    const row = createDraftTaskRow({
      section: seed.section,
      title: seed.title,
      description: seed.description,
      provider: seed.provider,
      role: seed.role,
      priority: seed.priority,
      selected: false,
      result: 'Created from Post-Session Improvement Review.',
    });
    taskBoardRows = [...taskBoardRows, row];
    return row;
  }

  function backgroundRunName(runId: string): string {
    return `background-${postSessionArea.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${runId.slice(-5)}`;
  }

  async function savePostSessionReview(launchBackground: boolean): Promise<void> {
    if (postSessionSaving || backgroundLaunching) return;
    postSessionError = null;
    postSessionMessage = null;

    const validation = validateBackgroundWorkPolicy(postSessionReviewDraft, backgroundPolicy);
    if (launchBackground && !validation.ok) {
      postSessionError = validation.errors.join(' ');
      return;
    }

    if (launchBackground) {
      const ok = await confirm({
        title: 'Launch bounded background work',
        message: [
          `Project: ${project.name}`,
          `Working dir: ${backgroundPolicy.cwd}`,
          `Internal channel: ${backgroundPolicy.scope}`,
          `Trust posture: ${backgroundPolicy.trustPosture}`,
          `Timeout: ${backgroundPolicy.timeoutMinutes} minutes`,
          `Idle policy: ${backgroundPolicy.idlePolicy}`,
          '',
          'The agent must report progress and must not commit, push, delete files, rewrite history, or run destructive cleanup without explicit approval.',
        ].join('\n'),
        confirmLabel: 'Launch bounded agent',
        cancelLabel: 'Review policy',
        danger: backgroundPolicy.trustPosture === 'full-access',
      });
      if (!ok) return;
    }

    postSessionSaving = true;
    backgroundLaunching = launchBackground;
    let trackingRow: TaskBoardRow | null = null;
    try {
      const asset = await saveProjectAsset(buildPostSessionReviewAsset({
        project,
        review: postSessionReviewDraft,
        tasks: projectTasks,
        agents: projectAgents,
      }));
      try {
        await attachAsset(asset.id, 'project', project.id);
      } catch (err) {
        console.warn('[ProjectPage] failed to attach post-session review note:', err);
      }

      if (postSessionCreateTask || launchBackground) {
        trackingRow = addPostSessionImprovementTask();
      }

      if (launchBackground) {
        const runId = `bg-${Date.now().toString(36)}`;
        const label = buildBackgroundLaunchLabel({
          project,
          runId,
          timeoutMinutes: backgroundPolicy.timeoutMinutes,
          trustPosture: backgroundPolicy.trustPosture,
        });
        const prompt = buildBackgroundWorkPrompt({
          project,
          review: postSessionReviewDraft,
          policy: backgroundPolicy,
          runId,
        });
        const result = await spawnShell(backgroundPolicy.cwd, {
          harness: backgroundPolicy.harness,
          role: backgroundPolicy.role,
          scope: backgroundPolicy.scope,
          label,
          name: backgroundRunName(runId),
          bootstrapInstructions: prompt,
        });
        if (trackingRow) {
          updateTaskBoardRow(trackingRow.id, {
            assignee: result.instance_id ?? `pty:${result.pty_id}`,
            launchStatus: 'launched',
            launchPtyId: result.pty_id,
            launchInstanceId: result.instance_id ?? '',
            listenerState: result.instance_id ? 'background launched' : 'background pty',
            lastActivity: 'just now',
            status: 'claimed',
            result: `Background run ${runId} launched. Timeout ${backgroundPolicy.timeoutMinutes}m. Review note ${asset.id}.`,
          });
        }
        const focusNodeId = result.instance_id
          ? `bound:${result.instance_id}`
          : `pty:${result.pty_id}`;
        requestNodeFocus(focusNodeId);
        postSessionMessage = `Post-session note saved and bounded background run launched${result.instance_id ? ` as ${result.instance_id.slice(0, 8)}` : ''}.`;
      } else {
        postSessionMessage = trackingRow
          ? 'Post-session note saved and improvement task created.'
          : 'Post-session note saved.';
      }
    } catch (err) {
      postSessionError = err instanceof Error ? err.message : String(err);
    } finally {
      postSessionSaving = false;
      backgroundLaunching = false;
    }
  }

  async function suspendBackgroundRun(run: BackgroundRunSummary): Promise<void> {
    postSessionError = null;
    postSessionMessage = null;
    try {
      const sent = await sendOperatorMessage(
        run.scope,
        run.instanceId,
        '[background-work-control] Suspend after your current safe stopping point. Report current status, changed files, blockers, and next recommended action, then wait_for_activity.',
      );
      postSessionMessage = sent
        ? `Suspend request sent to ${run.label}.`
        : `${run.label} disappeared before the suspend request was sent.`;
    } catch (err) {
      postSessionError = err instanceof Error ? err.message : 'Failed to send suspend request.';
    }
  }

  async function killBackgroundRun(run: BackgroundRunSummary): Promise<void> {
    const ok = await confirm({
      title: 'Kill background run',
      message: `This kills ${run.label} (${run.instanceId.slice(0, 8)}) and deregisters its row. Use Suspend when you only need it to stop after reporting.`,
      confirmLabel: 'Kill run',
      cancelLabel: 'Keep running',
      danger: true,
    });
    if (!ok) return;

    postSessionError = null;
    postSessionMessage = null;
    try {
      await killInstance(run.instanceId);
      postSessionMessage = `Killed background run ${run.label}.`;
    } catch (err) {
      postSessionError = err instanceof Error ? err.message : 'Failed to kill background run.';
    }
  }

  function parseEventPayload(payload: string | null): Record<string, unknown> {
    if (!payload) return {};
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  function eventTitle(type: string): string {
    const known: Record<string, string> = {
      'task.created': 'Task created',
      'task.claimed': 'Task claimed',
      'task.updated': 'Task updated',
      'task.approved': 'Task approved',
      'message.sent': 'Message sent',
      'message.broadcast': 'Broadcast sent',
      'agent.polled': 'Agent checked in',
      'agent.waiting': 'Agent listening',
      'agent.wait_returned': 'Agent resumed',
      'instance.registered': 'Agent registered',
      'instance.deregistered': 'Agent removed',
      'browser.snapshot.captured': 'Browser snapshot',
      'browser.context.upserted': 'Browser context',
    };
    return known[type] ?? type.replace(/\./g, ' ');
  }

  function eventDetail(event: Event, tasksById: Map<string, Task>, agentsById: Map<string, Instance>): string {
    const payload = parseEventPayload(event.payload);
    if (event.subject && tasksById.has(event.subject)) {
      return tasksById.get(event.subject)?.title ?? event.subject;
    }
    if (event.subject && agentsById.has(event.subject)) {
      return displayInstance(agentsById.get(event.subject)!);
    }
    if (event.actor && agentsById.has(event.actor)) {
      return displayInstance(agentsById.get(event.actor)!);
    }
    if (typeof payload.status === 'string') {
      return `Status ${payload.status.replace(/_/g, ' ')}`;
    }
    if (typeof payload.label === 'string') {
      return payload.label;
    }
    return event.subject ?? event.actor ?? 'Project activity';
  }

  function buildProjectActivity(
    taskList: Task[],
    agentList: Instance[],
    eventList: Event[],
    memberIds: Set<string>,
  ): ProjectActivityEntry[] {
    const tasksById = new Map(taskList.map((task) => [task.id, task]));
    const agentsById = new Map(agentList.map((instance) => [instance.id, instance]));
    const entries: ProjectActivityEntry[] = [];

    for (const event of eventList) {
      const subjectMatches = event.subject ? tasksById.has(event.subject) || memberIds.has(event.subject) : false;
      const actorMatches = event.actor ? memberIds.has(event.actor) : false;
      const scopeMatches = event.scope === project.scope || event.scope === project.root;
      if (!subjectMatches && !actorMatches && !scopeMatches) continue;
      entries.push({
        id: `event-${event.id}`,
        title: eventTitle(event.type),
        detail: eventDetail(event, tasksById, agentsById),
        meta: event.scope === project.scope || event.scope === project.root ? 'project channel' : 'linked row',
        timestamp: event.created_at,
        kind: 'event',
      });
    }

    for (const task of taskList) {
      entries.push({
        id: `task-${task.id}`,
        title: `Task ${statusLabel(task.status)}`,
        detail: task.title,
        meta: task.assignee ? `assigned to ${task.assignee.slice(0, 8)}` : 'unassigned',
        timestamp: task.changed_at || task.updated_at || task.created_at,
        kind: 'task',
      });
    }

    for (const instance of agentList) {
      entries.push({
        id: `agent-${instance.id}`,
        title: instance.status === 'online' ? 'Agent running' : 'Agent reconnectable',
        detail: displayInstance(instance),
        meta: compactPath(instance.directory || project.root),
        timestamp: instance.heartbeat || instance.registered_at,
        kind: 'agent',
      });
    }

    return entries
      .filter((entry) => Number.isFinite(entry.timestamp))
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  function formatActivityTime(timestamp: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'now';
    const ms = timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  }

  function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
  }

  function parseRoots(value: string): string[] {
    return uniqueStrings(value.split(/\r?\n|,/).map((entry) => entry.trim()));
  }

  function inventoryMeta(entry: ProjectInventoryEntry): string {
    if (entry.entryType === 'folder') return 'folder';
    if (entry.extension) return `${entry.category} · .${entry.extension}`;
    return entry.category;
  }

  function convertPreviewPath(path: string): string {
    if (/^(https?:|asset:|data:|blob:)/i.test(path)) {
      return path;
    }
    return convertFileSrc(path);
  }

  function clearBubbleTextPreview(): void {
    bubblePreviewRequestId += 1;
    bubbleTextContent = '';
    bubbleTextLoading = false;
    bubbleTextError = null;
  }

  function selectTopLevelBubbleFolder(path: string): void {
    selectedBubbleFolderPath = path;
    selectedBubbleItemPath = '';
    bubbleFolderHistory = [];
    expandedBubbleImageUrl = '';
    clearBubbleTextPreview();
  }

  function selectBubbleFolder(path: string): void {
    if (bubbleFolderOpen && selectedBubbleFolderPath && selectedBubbleFolderPath !== path) {
      bubbleFolderHistory = [...bubbleFolderHistory, selectedBubbleFolderPath];
    }
    selectedBubbleFolderPath = path;
    selectedBubbleItemPath = '';
    bubbleFolderOpen = true;
    expandedBubbleImageUrl = '';
    clearBubbleTextPreview();
  }

  function goBackBubbleFolder(): void {
    selectedBubbleItemPath = '';
    expandedBubbleImageUrl = '';
    clearBubbleTextPreview();
    if (bubbleFolderHistory.length > 0) {
      const previous = bubbleFolderHistory[bubbleFolderHistory.length - 1];
      bubbleFolderHistory = bubbleFolderHistory.slice(0, -1);
      selectedBubbleFolderPath = previous;
      bubbleFolderOpen = true;
      return;
    }
    bubbleFolderOpen = false;
  }

  function closeBubbleFolder(): void {
    bubbleFolderHistory = [];
    bubbleFolderOpen = false;
    selectedBubbleItemPath = '';
    expandedBubbleImageUrl = '';
    clearBubbleTextPreview();
  }

  function canPreviewAsText(item: ProjectFileBubbleItem): boolean {
    return item.assetKind === 'note' ||
      item.assetKind === 'protocol' ||
      item.category === 'richText' ||
      item.category === 'text' ||
      item.category === 'code' ||
      ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'rtf', 'html', 'htm', 'css'].includes(item.extension);
  }

  function canPreviewAsMedia(item: ProjectFileBubbleItem): boolean {
    return item.category === 'media' && ['mp4', 'mov', 'm4v', 'webm'].includes(item.extension);
  }

  async function loadBubbleTextPreview(item: ProjectFileBubbleItem): Promise<void> {
    const requestId = ++bubblePreviewRequestId;
    bubbleTextContent = item.content || item.description || '';
    bubbleTextError = null;
    if (bubbleTextContent || !canPreviewAsText(item)) return;
    bubbleTextLoading = true;
    try {
      const content = await readAssetTextFile(item.path);
      if (requestId !== bubblePreviewRequestId) return;
      bubbleTextContent = content;
    } catch (err) {
      if (requestId !== bubblePreviewRequestId) return;
      bubbleTextError = err instanceof Error ? err.message : String(err);
    } finally {
      if (requestId === bubblePreviewRequestId) {
        bubbleTextLoading = false;
      }
    }
  }

  function selectBubbleItem(item: ProjectFileBubbleItem): void {
    if (item.entryType === 'folder') {
      selectBubbleFolder(item.path);
      return;
    }
    selectedBubbleItemPath = item.path;
    expandedBubbleImageUrl = '';
    void loadBubbleTextPreview(item);
  }

  function expandBubbleImage(): void {
    if (!selectedBubbleImageSrc || bubbleImageFailed) return;
    expandedBubbleImageUrl = selectedBubbleImageSrc;
  }

  async function resetProjectView(): Promise<void> {
    if (resettingView) return;
    resettingView = true;
    assetError = null;
    saveError = null;
    closeBubbleFolder();
    try {
      const catalog = await refreshProjectAssets(project.id);
      const visibleCount = catalog.inventory?.length ?? 0;
      saveMessage = `Project view reset and refreshed at ${new Date().toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })}. ${visibleCount} folder item${visibleCount === 1 ? '' : 's'} visible.`;
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    } finally {
      resettingView = false;
    }
  }

  async function saveDetails(): Promise<void> {
    if (saving) return;
    saving = true;
    saveMessage = null;
    saveError = null;
    try {
      await saveProject({
        ...project,
        color: normalizeProjectColor(draftColor),
        notes: draftNotes,
        additionalRoots: parseRoots(draftAdditionalRoots),
      });
      saveMessage = 'Project context saved.';
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function saveColor(value: string): Promise<void> {
    if (saving) return;
    const color = normalizeProjectColor(value);
    draftColor = color;
    saving = true;
    saveMessage = null;
    saveError = null;
    try {
      await saveProject({
        ...project,
        color,
        notes: draftNotes,
        additionalRoots: parseRoots(draftAdditionalRoots),
      });
      saveMessage = 'Project color saved.';
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function deleteCurrentProject(): Promise<void> {
    if (deleting) return;
    const ok = await confirm({
      title: 'Delete project',
      message: `Delete "${project.name}" from the canvas project catalog? This removes the project space and agent memberships, but leaves folders and files on disk untouched.`,
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;

    deleting = true;
    saveMessage = null;
    saveError = null;
    try {
      const deleted = await deleteProject(project.id);
      if (deleted) {
        dispatch('deleted', { projectId: project.id });
      } else {
        saveError = 'Project was already gone.';
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      deleting = false;
    }
  }

  function respawnAgent(instanceId: string): void {
    dispatch('respawnAgent', { project, instanceId });
  }

  function setAssetKind(kind: AssetKind): void {
    assetKind = kind;
    assetError = null;
  }

  async function pickAssetPath(): Promise<void> {
    if (assetPicking) return;
    assetPicking = true;
    assetError = null;
    try {
      const selected = await open(assetDialogOptionsForKind(assetKind));
      const pickedPath = firstDialogSelection(selected);
      if (!pickedPath) return;

      const draft = assetDraftFromPickedPath(pickedPath, assetKind);
      if (!draft) {
        throw new Error(`Selected file is not valid for a ${assetKind} asset.`);
      }

      assetTitle = assetTitle.trim() || draft.title;
      assetPath = draft.path ?? '';
      if ((assetKind === 'note' || assetKind === 'protocol') && draft.path) {
        assetContent = await readAssetTextFile(draft.path);
      } else if (draft.content) {
        assetContent = draft.content;
      }
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    } finally {
      assetPicking = false;
    }
  }

  async function refreshAssets(): Promise<void> {
    if (assetRefreshing) return;
    assetRefreshing = true;
    assetError = null;
    saveMessage = null;
    try {
      await saveProject({
        ...project,
        color: normalizeProjectColor(draftColor),
        notes: draftNotes,
        additionalRoots: parseRoots(draftAdditionalRoots),
      });
      const catalog = await refreshProjectAssets(project.id);
      saveMessage = projectAssetRefreshSummary(catalog);
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    } finally {
      assetRefreshing = false;
    }
  }

  function setAssetAnalyzing(assetId: string, value: boolean): void {
    const next = new Set(analyzingAssetIds);
    if (value) {
      next.add(assetId);
    } else {
      next.delete(assetId);
    }
    analyzingAssetIds = next;
  }

  async function analyzeAssetById(assetId: string): Promise<void> {
    const id = assetId.trim();
    if (!id || analyzingAssetIds.has(id)) return;
    setAssetAnalyzing(id, true);
    assetError = null;
    saveMessage = null;
    try {
      const analyzed = await analyzeProjectAsset(id);
      saveMessage = `Visual analysis saved for ${analyzed.title} and written to the project workspace.`;
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    } finally {
      setAssetAnalyzing(id, false);
    }
  }

  async function analyzeAsset(event: CustomEvent<{ assetId: string }>): Promise<void> {
    await analyzeAssetById(event.detail.assetId);
  }

  async function createAsset(): Promise<void> {
    if (assetSaving) return;
    assetSaving = true;
    assetError = null;
    saveMessage = null;
    try {
      const title = assetTitle.trim();
      if (!title) {
        throw new Error('Asset title is required.');
      }
      await saveProjectAsset({
        id: globalThis.crypto?.randomUUID?.() ?? `asset-${Date.now()}`,
        projectId: project.id,
        kind: assetKind,
        title,
        path: assetPath.trim() || null,
        content: assetContent.trim() || null,
        description: assetDescription.trim(),
      });
      assetTitle = '';
      assetPath = '';
      assetDescription = '';
      assetContent = '';
      saveMessage = 'Project asset saved.';
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    } finally {
      assetSaving = false;
    }
  }

  async function attachAssetToAgent(event: CustomEvent<{ assetId: string; instanceId: string }>): Promise<void> {
    try {
      await attachAsset(event.detail.assetId, 'agent', event.detail.instanceId);
      const asset = visibleAssets.find((entry) => entry.id === event.detail.assetId);
      const instance = projectAgents.find((entry) => entry.id === event.detail.instanceId);
      const message = asset ? buildAssetDirectMessage(project.name, [asset]) : '';
      if (instance?.scope && message) {
        const delivered = await sendOperatorMessage(instance.scope, instance.id, message);
        saveMessage = delivered
          ? 'Asset attached and sent to agent.'
          : 'Asset attached. Agent was not reachable for direct message.';
      } else {
        saveMessage = 'Asset attached to agent.';
      }
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteAsset(event: CustomEvent<{ assetId: string }>): Promise<void> {
    const asset = visibleAssets.find((entry) => entry.id === event.detail.assetId);
    const ok = await confirm({
      title: 'Delete asset',
      message: `Delete "${asset?.title ?? 'this asset'}" from the project asset catalog? Original files on disk are left untouched.`,
      confirmLabel: 'Delete asset',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProjectAsset(event.detail.assetId);
      saveMessage = 'Project asset deleted.';
    } catch (err) {
      assetError = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<aside class="project-page" aria-label={`${project.name} project page`} style={`--project-color:${draftColor};`}>
  <header class="project-header">
    <div>
      <span class="project-kicker">Project Space</span>
      <h2>{project.name}</h2>
      <p class="mono">{project.root}</p>
      <p class="context-copy">Project space is shared context, not a sandbox. Attach syncs notes, roots, and tasks; cwd and scope change only through the explicit respawn action.</p>
    </div>
    <div class="project-header-actions">
      <button class="inline-action" type="button" disabled={resettingView} on:click={resetProjectView}>
        {resettingView ? 'Resetting...' : 'Reset view'}
      </button>
      <button class="icon-btn" type="button" aria-label="Close project page" on:click={close}>×</button>
    </div>
  </header>

  <div class="project-body">
    <section class="project-cockpit" aria-label="Project cockpit">
      <div class="cockpit-hero">
        <div>
          <span class="project-kicker">Project Cockpit</span>
          <h3>{project.name}</h3>
          <p>
            Opened from the project root. Boundary sync is optional; this workspace is ready as soon as the folder is saved.
          </p>
        </div>
        <div class="cockpit-diagnostics" aria-label="Project diagnostic metadata">
          <span>
            <strong>Root</strong>
            <code>{project.root}</code>
          </span>
          <span>
            <strong>Task source</strong>
            <code>{projectTasks.length > 0 ? 'swarm.db linked rows' : 'waiting for task rows'}</code>
          </span>
          {#if project.scope}
            <span>
              <strong>Internal channel</strong>
              <code>{project.scope}</code>
            </span>
          {/if}
        </div>
      </div>

      <div class="cockpit-grid">
        <div class="cockpit-panel cockpit-panel--wide">
          <div class="section-heading">
            <h3>Task Board</h3>
            <span>{projectTasks.length} linked</span>
          </div>
          <div class="task-board-preview">
            {#each taskBoardLanes as lane (lane.id)}
              <section class="task-lane" aria-label={`${lane.label} project tasks`}>
                <header>
                  <strong>{lane.label}</strong>
                  <span>{lane.tasks.length}</span>
                </header>
                {#if lane.tasks.length === 0}
                  <p>{lane.hint}</p>
                {:else}
                  {#each lane.tasks.slice(0, 3) as task (task.id)}
                    <article class="task-preview-row">
                      <span class="task-status task-status--{statusClass(task.status)}">{statusLabel(task.status)}</span>
                      <strong>{task.title}</strong>
                      <p>{taskDetail(task)}</p>
                    </article>
                  {/each}
                {/if}
              </section>
            {/each}
          </div>
          {#if projectTasks.length === 0}
            <p class="cockpit-placeholder">
              Slice 3 will turn pasted plans into editable task rows. This preview is already scoped to {compactPath(project.root)} and attached agents.
            </p>
          {/if}
        </div>

        <div class="cockpit-panel">
          <div class="section-heading">
            <h3>Agents</h3>
            <span>{runningProjectAgents.length} running · {reconnectableProjectAgents.length} reconnectable</span>
          </div>
          <div class="agent-summary-grid">
            <div>
              <strong>{projectAgents.length}</strong>
              <span>attached</span>
            </div>
            <div>
              <strong>{runningProjectAgents.length}</strong>
              <span>running</span>
            </div>
            <div>
              <strong>{browserContextCount}</strong>
              <span>browser refs</span>
            </div>
          </div>
          {#if projectAgents.length === 0}
            <p class="cockpit-placeholder">No agents attached yet. Launch task-bound agents or sync a canvas node into this project.</p>
          {:else}
            <div class="cockpit-mini-list">
              {#each projectAgents.slice(0, 4) as instance (instance.id)}
                <div>
                  <strong>{displayInstance(instance)}</strong>
                  <span class="instance-status instance-status--{statusClass(instance.status)}">{statusLabel(instance.status)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="cockpit-panel">
          <div class="section-heading">
            <h3>Recent Activity</h3>
            <span>{recentProjectActivity.length}</span>
          </div>
          {#if recentProjectActivity.length === 0}
            <p class="cockpit-placeholder">Activity appears here after tasks, agents, assets, or browser context touch this project.</p>
          {:else}
            <div class="activity-list">
              {#each recentProjectActivity as activity (activity.id)}
                <article class="activity-row activity-row--{activity.kind}">
                  <time>{formatActivityTime(activity.timestamp)}</time>
                  <span>
                    <strong>{activity.title}</strong>
                    <em>{activity.detail}</em>
                  </span>
                  <small>{activity.meta}</small>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </section>

    <section class="project-section project-section--overview">
      <div class="section-heading">
        <h3>Overview</h3>
        <span>{projectAgents.length} agents · {openTasks.length} open tasks</span>
      </div>
      <div class="metrics">
        <div>
          <strong>{project.boundary.width.toFixed(0)} × {project.boundary.height.toFixed(0)}</strong>
          <span>boundary</span>
        </div>
        <div>
          <strong>{projectRoots.length}</strong>
          <span>roots</span>
        </div>
        <div>
          <strong>{projectFiles.length}</strong>
          <span>files</span>
        </div>
      </div>
    </section>

    <section class="project-section">
      <div class="section-heading">
        <h3>Project Color</h3>
        <span style={`color:${draftColor}`}>{draftColor}</span>
      </div>
      <div class="color-row">
        <label class="color-picker-shell" for={colorInputId} style={`--picker-color:${draftColor};`}>
          <input
            id={colorInputId}
            type="color"
            bind:value={draftColor}
            aria-label="Project color"
            on:change={(event) => saveColor((event.currentTarget as HTMLInputElement).value)}
          />
          <span aria-hidden="true">+</span>
        </label>
        <p class="color-hint">Click the lit color tile to choose a project color.</p>
      </div>
    </section>

    <section class="project-section">
      <div class="section-heading">
        <h3>Agents</h3>
        <span>{projectAgents.length}</span>
      </div>
      {#if projectAgents.length === 0}
        <p class="empty-text">No agents attached.</p>
      {:else}
        <div class="row-list">
          {#each projectAgents as instance (instance.id)}
            <div class="list-row">
              <span>
                <strong>{displayInstance(instance)}</strong>
                <em class="mono">{instance.directory}</em>
              </span>
              <div class="row-actions">
                <span>{instance.status}</span>
                <button
                  class="inline-action"
                  type="button"
                  disabled={instance.status === 'online'}
                  title={instance.status === 'online'
                    ? 'Stop this live agent before respawning it in the project root.'
                    : `Respawn in ${project.root}`}
                  on:click={() => respawnAgent(instance.id)}
                >
                  Respawn in project
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="project-section">
      <div class="section-heading">
        <h3>Notes</h3>
        <span>persistent</span>
      </div>
      <textarea
        class="notes-input"
        bind:value={draftNotes}
        rows="7"
        placeholder="Project notes, constraints, references, and handoff context."
      ></textarea>
    </section>

    <section class="project-section">
      <div class="section-heading">
        <h3>Roots &amp; Assets</h3>
        <span>{projectRoots.length}</span>
      </div>
      <label for="project-extra-roots">Extra roots / asset folders</label>
      <textarea
        id="project-extra-roots"
        class="notes-input mono"
        bind:value={draftAdditionalRoots}
        rows="4"
        placeholder="/absolute/path/to/assets"
      ></textarea>
      <div class="row-list">
        {#each projectRoots as root (root)}
          <div class="list-row">
            <strong class="mono">{root}</strong>
          </div>
        {/each}
      </div>
    </section>

    <section class="project-section project-section--inventory">
      <div class="section-heading">
        <h3>Folder Inventory</h3>
        <span>{visibleInventory.length}</span>
      </div>
      {#if visibleInventory.length === 0}
        <p class="empty-text">Nothing visible in saved roots.</p>
      {:else if inventoryDisplay.mode === 'list'}
        <div class="row-list">
          {#each inventoryDisplay.items as entry (entry.path)}
            <div class="list-row">
              <strong>{entry.name}</strong>
              <span>{inventoryMeta(entry)}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="inventory-groups">
          {#each inventoryDisplay.groups as group (group.category)}
            <div>
              <strong>{group.count}</strong>
              <span>{group.label}</span>
            </div>
          {/each}
        </div>
        {#if visibleInventory.some((entry) => entry.entryType === 'folder')}
          <div class="row-list inventory-folder-list">
            {#each visibleInventory.filter((entry) => entry.entryType === 'folder').slice(0, 8) as entry (entry.path)}
              <div class="list-row">
                <strong>{entry.name}</strong>
                <span>folder</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </section>

    <section class="project-section project-section--assets">
      <div class="section-heading">
        <h3>Assets</h3>
        <div class="section-actions">
          <span>{visibleAssets.length}</span>
          <button
            class="inline-action"
            type="button"
            disabled={assetRefreshing}
            on:click={refreshAssets}
          >
            {assetRefreshing ? 'Refreshing...' : 'Refresh assets'}
          </button>
        </div>
      </div>
      <div class="asset-kind-row" aria-label="Asset kind">
        {#each ASSET_KINDS as kind}
          <button
            type="button"
            class:active={assetKind === kind}
            on:click={() => setAssetKind(kind)}
          >
            Add {kind}
          </button>
        {/each}
      </div>
      <div class="asset-form">
        <input class="identity-input" bind:value={assetTitle} placeholder="Asset title" aria-label="Asset title" />
        <div class="asset-path-row">
          <input class="identity-input mono" bind:value={assetPath} placeholder="/absolute/path or reference URL" aria-label="Asset path or reference" />
          <button
            class="inline-action"
            type="button"
            disabled={assetPicking || assetKind === 'reference'}
            on:click={pickAssetPath}
          >
            {assetPicking ? 'Choosing...' : assetKind === 'folder' ? 'Choose folder' : 'Choose file'}
          </button>
        </div>
        <textarea class="notes-input" bind:value={assetDescription} rows="3" placeholder="Description for agents."></textarea>
        <textarea class="notes-input mono" bind:value={assetContent} rows="4" placeholder="Note or protocol content."></textarea>
        <button class="save-btn" type="button" disabled={assetSaving} on:click={createAsset}>
          {assetSaving ? 'Saving asset...' : `Save ${assetKind}`}
        </button>
      </div>
      {#if assetError}
        <p class="error-text">{assetError}</p>
      {/if}
      <AssetGrid
        assets={visibleAssets}
        attachments={visibleAssetAttachments}
        agents={projectAgents}
        analyzingAssetIds={analyzingAssetIds}
        on:analyzeAsset={analyzeAsset}
        on:attachAgent={attachAssetToAgent}
        on:deleteAsset={deleteAsset}
      />
    </section>

    <section class="project-section project-section--file-bubble">
      <div class="section-heading">
        <h3>File Bubble</h3>
        <div class="section-actions">
          <span>{bubbleFolderOpen ? `${fileBubbleItems.length} items` : `${fileBubbleFolders.length} folders`}</span>
          {#if bubbleFolderOpen}
            <button class="inline-action" type="button" on:click={goBackBubbleFolder}>Back</button>
          {/if}
        </div>
      </div>
      {#if fileBubbleFolders.length === 0}
        <p class="empty-text">Refresh assets to browse project folders here.</p>
      {:else}
        <div class="file-bubble-shell">
          {#if !bubbleFolderOpen}
            <div class="file-bubble-folder file-bubble-folder--stage">
              <button
                class="folder-tile folder-tile--hero"
                type="button"
                on:click={() => selectedBubbleFolder && selectBubbleFolder(selectedBubbleFolder.path)}
              >
                <span class="folder-art-shell" aria-hidden="true">
                  <img src={darkFolderUrl} alt="" />
                </span>
                <span>
                  <strong>{selectedBubbleFolder?.name ?? 'Project folder'}</strong>
                  <em class="mono">{selectedBubbleFolder?.path}</em>
                </span>
              </button>
              {#if fileBubbleFolders.length > 1}
                <div class="folder-picker" aria-label="Project folders">
                  {#each fileBubbleFolders as folder (folder.path)}
                    <button
                      type="button"
                      class:active={folder.path === selectedBubbleFolderPath}
                      on:click={() => selectTopLevelBubbleFolder(folder.path)}
                    >
                      {folder.name}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div class="bubble-breadcrumb">
              <button class="inline-action" type="button" on:click={goBackBubbleFolder}>Back</button>
              <strong>{selectedBubbleFolder?.name}</strong>
              <em class="mono">{selectedBubbleFolder?.path}</em>
            </div>
          {/if}

          {#if bubbleFolderOpen}
            <div class="file-bubble-browser">
            <div class="file-bubble-list" aria-label="Folder contents">
              {#if fileBubbleItems.length === 0}
                <p class="empty-text">No previewable contents in this folder yet.</p>
              {:else}
                {#each fileBubbleItems as item (item.path)}
                  <button
                    type="button"
                    class:active={item.path === selectedBubbleItemPath}
                      on:click={() => selectBubbleItem(item)}
                    >
                    <span>{item.entryType === 'folder' ? 'folder' : item.isImage ? 'image' : canPreviewAsMedia(item) ? 'media' : item.category}</span>
                    <strong>{item.name}</strong>
                  </button>
                {/each}
              {/if}
            </div>

            <div class="file-bubble-preview">
              {#if !selectedBubbleItem}
                <p class="empty-text">Select a file to preview.</p>
              {:else if selectedBubbleItem.isImage && selectedBubbleImageSrc && !bubbleImageFailed}
                <button
                  class="bubble-image-trigger"
                  type="button"
                  aria-label={`Expand ${selectedBubbleItem.name}`}
                  on:click={expandBubbleImage}
                >
                  <img
                    src={selectedBubbleImageSrc}
                    alt={selectedBubbleItem.name}
                    on:error={() => (bubbleImageFailed = true)}
                  />
                </button>
                <div class="preview-actions">
                  {#if selectedBubbleItem.assetId}
                    <button
                      class="preview-expand"
                      type="button"
                      disabled={analyzingAssetIds.has(selectedBubbleItem.assetId)}
                      on:click={() => selectedBubbleItem?.assetId && analyzeAssetById(selectedBubbleItem.assetId)}
                    >
                      {analyzingAssetIds.has(selectedBubbleItem.assetId) ? 'Analyzing...' : selectedBubbleItem.content ? 'Re-analyze image' : 'Analyze image'}
                    </button>
                  {/if}
                  <button class="preview-expand" type="button" on:click={expandBubbleImage}>
                    Expand image
                  </button>
                </div>
                {#if selectedBubbleItem.content}
                  <div class="bubble-visual-analysis">
                    <span>Visual analysis</span>
                    <p>{selectedBubbleItem.content}</p>
                  </div>
                {/if}
              {:else if selectedBubbleItem && canPreviewAsMedia(selectedBubbleItem) && selectedBubbleMediaSrc && !bubbleMediaFailed}
                <video
                  src={selectedBubbleMediaSrc}
                  controls
                  playsinline
                  preload="metadata"
                  on:error={() => (bubbleMediaFailed = true)}
                >
                  <track kind="captions" />
                </video>
              {:else if bubbleTextLoading}
                <p class="empty-text">Loading preview...</p>
              {:else if bubbleTextError}
                <div class="preview-file-meta">
                  <strong>{selectedBubbleItem.name}</strong>
                  <span>{bubbleTextError}</span>
                  <em class="mono">{selectedBubbleItem.path}</em>
                </div>
              {:else if bubbleTextContent || canPreviewAsText(selectedBubbleItem)}
                <pre>{bubbleTextContent || 'No text content yet.'}</pre>
              {:else}
                <div class="preview-file-meta">
                  <strong>{selectedBubbleItem.name}</strong>
                  <span>{selectedBubbleItem.extension ? `.${selectedBubbleItem.extension}` : selectedBubbleItem.category}</span>
                  <em class="mono">{selectedBubbleItem.path}</em>
                </div>
              {/if}
            </div>
          </div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="project-section project-section--task-board-mvp">
      <div class="section-heading">
        <h3>Task Board</h3>
        <div class="section-actions">
          <span>{taskBoardRows.length} rows</span>
          <button class="inline-action" type="button" on:click={addBlankTaskRow}>Add task</button>
          <button class="inline-action" type="button" on:click={() => setAllTaskSelection(true)}>Select all</button>
          <button class="inline-action" type="button" on:click={() => setAllTaskSelection(false)}>Clear</button>
        </div>
      </div>

      <div class="task-import-grid">
        <div>
          <label for="plan-import-text">Paste plan into task rows</label>
          <textarea
            id="plan-import-text"
            class="notes-input mono"
            bind:value={planImportText}
            rows="6"
            placeholder="# Slice 3&#10;- Add editable task rows&#10;- Select three tasks&#10;- Show Launch 3"
          ></textarea>
        </div>
        <div class="task-import-actions">
          <p>
            Headings become sections. Bullets and numbered lines become editable task rows tied to this project.
          </p>
          <button class="save-btn" type="button" on:click={importPlanRows}>Import plan rows</button>
          <div class="bulk-assignment">
            <label for="bulk-provider">Provider</label>
            <select id="bulk-provider" bind:value={bulkProvider}>
              {#each TASK_BOARD_PROVIDERS as provider (provider.value)}
                <option value={provider.value}>{provider.label}</option>
              {/each}
            </select>
            <label for="bulk-role">Role</label>
            <select id="bulk-role" bind:value={bulkRole}>
              {#each TASK_BOARD_ROLES as role (role.value)}
                <option value={role.value}>{role.label}</option>
              {/each}
            </select>
            <button class="inline-action" type="button" disabled={selectedTaskCount === 0} on:click={applySelectedAssignment}>
              Apply to selected
            </button>
          </div>
        </div>
      </div>

      <div class="proof-pack-panel">
        <div>
          <label for="task-board-proof-note">Review note</label>
          <input
            id="task-board-proof-note"
            class="identity-input"
            bind:value={proofPackNote}
            placeholder="What should the reviewer look for?"
          />
        </div>
        <button class="save-btn" type="button" disabled={proofPackCapturing} on:click={captureTaskBoardProofPack}>
          {proofPackCapturing ? 'Capturing...' : 'Capture proof pack'}
        </button>
      </div>
      {#if proofPackError}
        <p class="error-text">{proofPackError}</p>
      {/if}
      {#if proofPackMessage}
        <p class="message-text">{proofPackMessage}</p>
      {/if}

      {#if taskBoardError}
        <p class="error-text">{taskBoardError}</p>
      {/if}
      {#if taskBoardMessage}
        <p class="message-text">{taskBoardMessage}</p>
      {/if}

      {#if taskBoardRows.length === 0}
        <p class="empty-text">No task rows yet. Paste a plan or add a task to start the launch board.</p>
      {:else}
        <div class="task-board-sections">
          {#each taskBoardSections as section (section.name)}
            <section class="task-board-section" aria-label={`${section.name} task rows`}>
              <header>
                <h4>{section.name}</h4>
                <span>{section.rows.length}</span>
              </header>
              <div class="task-board-row task-board-row--header" aria-hidden="true">
                <span>Select</span>
                <span>Task</span>
                <span>Section</span>
                <span>Status</span>
                <span>Provider / Role</span>
                <span>Agent / Listener</span>
                <span>Result</span>
              </div>
              {#each section.rows as row (row.id)}
                {@const rowRuntime = resolveTaskBoardRowRuntime(row, taskBoardInstanceStates)}
                <article
                  class="task-board-row"
                  class:task-board-row--launching={row.launchStatus === 'launching'}
                  class:task-board-row--failed={row.launchStatus === 'failed'}
                  class:task-board-row--stale={rowRuntime.stale}
                >
                  <label class="task-select-cell">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      aria-label={`Select ${row.title}`}
                      on:change={(event) => toggleTaskSelection(row.id, (event.currentTarget as HTMLInputElement).checked)}
                    />
                    <span>{row.draft ? 'draft' : 'live'}</span>
                  </label>
                  <div class="task-title-cell">
                    <input
                      class="identity-input"
                      value={row.title}
                      aria-label={`${row.title} title`}
                      on:input={(event) => updateTaskBoardRow(row.id, { title: (event.currentTarget as HTMLInputElement).value })}
                    />
                    <textarea
                      class="notes-input"
                      value={row.description}
                      rows="3"
                      aria-label={`${row.title} description`}
                      on:input={(event) => updateTaskBoardRow(row.id, { description: (event.currentTarget as HTMLTextAreaElement).value })}
                    ></textarea>
                  </div>
                  <input
                    class="identity-input"
                    value={row.section}
                    aria-label={`${row.title} section`}
                    on:input={(event) => updateTaskBoardRow(row.id, { section: (event.currentTarget as HTMLInputElement).value })}
                  />
                  <select
                    value={row.status}
                    aria-label={`${row.title} status`}
                    on:change={(event) => updateTaskBoardRow(row.id, { status: (event.currentTarget as HTMLSelectElement).value as Task['status'] })}
                  >
                    {#each TASK_BOARD_STATUSES as status (status)}
                      <option value={status}>{statusLabel(status)}</option>
                    {/each}
                  </select>
                  <div class="provider-role-cell">
                    <select
                      value={row.provider}
                      aria-label={`${row.title} provider`}
                      on:change={(event) => updateTaskBoardRow(row.id, { provider: (event.currentTarget as HTMLSelectElement).value as TaskBoardProvider })}
                    >
                      {#each TASK_BOARD_PROVIDERS as provider (provider.value)}
                        <option value={provider.value}>{provider.label}</option>
                      {/each}
                    </select>
                    <select
                      value={row.role}
                      aria-label={`${row.title} role`}
                      on:change={(event) => updateTaskBoardRow(row.id, { role: (event.currentTarget as HTMLSelectElement).value as TaskBoardRole })}
                    >
                      {#each TASK_BOARD_ROLES as role (role.value)}
                        <option value={role.value}>{role.label}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="agent-listener-cell">
                    <input
                      class="identity-input mono"
                      value={row.assignee}
                      placeholder="unassigned"
                      aria-label={`${row.title} assignee`}
                      on:input={(event) => updateTaskBoardRow(row.id, { assignee: (event.currentTarget as HTMLInputElement).value })}
                    />
                    <span class:task-listener-state--stale={rowRuntime.stale}>{rowRuntime.listenerState} · {row.elapsed} · {row.lastActivity}</span>
                    {#if row.launchInstanceId}
                      <code>agent {row.launchInstanceId.slice(0, 8)}</code>
                    {/if}
                    {#if row.launchPtyId}
                      <code>pty {row.launchPtyId.slice(0, 8)}</code>
                    {/if}
                    {#if rowRuntime.instanceStatus}
                      <code>state {rowRuntime.instanceStatus}</code>
                    {/if}
                    {#if rowRuntime.launchError}
                      <small>{rowRuntime.launchError}</small>
                    {/if}
                  </div>
                  <div class="task-result-cell">
                    <textarea
                      class="notes-input"
                      value={row.result}
                      rows="3"
                      placeholder="Result summary"
                      aria-label={`${row.title} result summary`}
                      on:input={(event) => updateTaskBoardRow(row.id, { result: (event.currentTarget as HTMLTextAreaElement).value })}
                    ></textarea>
                    <div class="task-row-actions">
                      <button
                        class="inline-action"
                        type="button"
                        disabled={!canRetryTaskBoardRow(row, taskBoardInstanceStates) || taskLaunchInFlight || launchingTaskIds.has(row.id)}
                        on:click={() => retryTaskRow(row.id)}
                      >
                        Retry
                      </button>
                      <button
                        class="inline-action"
                        type="button"
                        disabled={taskLaunchInFlight || launchingTaskIds.has(row.id)}
                        title={`Use ${bulkProvider} / ${bulkRole}`}
                        on:click={() => reassignTaskRow(row.id)}
                      >
                        Reassign
                      </button>
                      <button
                        class="inline-action"
                        type="button"
                        disabled={taskLaunchInFlight || launchingTaskIds.has(row.id) || (row.launchStatus === 'not_launched' && !row.assignee)}
                        on:click={() => resetTaskLaunchState(row.id)}
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                </article>
              {/each}
            </section>
          {/each}
        </div>
      {/if}

      <div class="sticky-task-action-bar" class:visible={selectedTaskCount > 0 || taskLaunchInFlight}>
        <span>
          <strong>{selectedTaskCount}</strong>
          selected
        </span>
        <span>{bulkProvider} / {bulkRole}</span>
        <button class="inline-action" type="button" disabled={selectedTaskCount === 0 || taskLaunchInFlight} on:click={applySelectedAssignment}>
          Assign selected
        </button>
        <button class="save-btn" type="button" disabled={selectedTaskCount === 0 || taskLaunchInFlight} on:click={launchSelectedTasks}>
          {taskLaunchInFlight ? 'Launching...' : `Launch ${selectedTaskCount}`}
        </button>
      </div>
      {#if launchActionMessage}
        <p class="message-text">{launchActionMessage}</p>
      {/if}
    </section>

    <section class="project-section">
      <div class="section-heading">
        <h3>Files</h3>
        <span>{projectFiles.length}</span>
      </div>
      {#if projectFiles.length === 0}
        <p class="empty-text">No project-linked task or lock files yet.</p>
      {:else}
        <div class="row-list">
          {#each projectFiles as file (file)}
            <div class="list-row">
              <strong class="mono">{file}</strong>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="project-section project-section--review-ship">
      <div class="section-heading">
        <h3>Review / Ship</h3>
        <div class="section-actions">
          <span>{reviewShipSummary.fileGroups.length} files</span>
          <span>{reviewShipSummary.risks.length} risks</span>
          <span>explicit commit only</span>
        </div>
      </div>

      <div class="review-ship-grid">
        <div class="review-ship-panel review-ship-panel--commit">
          <div class="review-ship-panel-heading">
            <strong>Commit suggestion</strong>
            <span>{reviewShipSummary.taskGroups.length} task rows</span>
          </div>
          <textarea
            class="notes-input mono"
            rows="8"
            readonly
            aria-label="Suggested commit message"
            value={reviewShipSummary.primaryCommitMessage}
          ></textarea>
          <div class="review-ship-actions">
            <button
              class="inline-action"
              type="button"
              on:click={() => copyReviewShipText(reviewShipSummary.primaryCommitMessage, 'Commit message')}
            >
              Copy commit message
            </button>
            <button
              class="inline-action"
              type="button"
              on:click={() => copyReviewShipText(reviewShipSummary.reviewTaskPrompt, 'Review task prompt')}
            >
              Copy review task
            </button>
            <button
              class="save-btn"
              type="button"
              disabled={!primaryReviewer}
              title={primaryReviewer ? `Send to ${primaryReviewer.label}` : 'No online reviewer/opencode agent in this project'}
              on:click={askReviewerAgent}
            >
              Ask reviewer
            </button>
          </div>
          {#if reviewShipSummary.commitMessages.length > 1}
            <div class="commit-suggestion-list">
              {#each reviewShipSummary.commitMessages.slice(1) as message (message)}
                <code>{message.split('\n')[0]}</code>
              {/each}
            </div>
          {/if}
        </div>

        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Unresolved risks</strong>
            <span>{reviewShipSummary.risks.length}</span>
          </div>
          {#if reviewShipSummary.risks.length === 0}
            <p class="empty-text">No unresolved risks reported by task results.</p>
          {:else}
            <div class="review-risk-list">
              {#each reviewShipSummary.risks.slice(0, 6) as risk (risk)}
                <p>{risk}</p>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="review-ship-columns">
        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Changed / review files</strong>
            <span>{reviewShipSummary.fileGroups.length}</span>
          </div>
          {#if reviewShipSummary.fileGroups.length === 0}
            <p class="empty-text">No changed files reported yet. Finished agents should include `files_changed` in task results.</p>
          {:else}
            <div class="review-file-list">
              {#each reviewShipSummary.fileGroups.slice(0, 10) as group (group.file)}
                <div class="review-file-row">
                  <strong class="mono">{group.file}</strong>
                  <span>{group.taskTitles.length > 0 ? group.taskTitles.join(' · ') : 'no linked task'}</span>
                  <small>{group.agentLabels.length > 0 ? group.agentLabels.join(' · ') : group.agentIds.length > 0 ? group.agentIds.map((id) => id.slice(0, 8)).join(' · ') : 'unassigned'}</small>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Task result summaries</strong>
            <span>{reviewShipSummary.taskGroups.length}</span>
          </div>
          {#if reviewShipSummary.taskGroups.length === 0}
            <p class="empty-text">No project tasks yet. Launch or complete task rows before shipping.</p>
          {:else}
            <div class="review-task-list">
              {#each reviewShipSummary.taskGroups.slice(0, 8) as task (task.taskId)}
                <article class="review-task-row">
                  <header>
                    <strong>{task.title}</strong>
                    <span class={`task-status task-status--${task.status.replace('_', '-')}`}>{statusLabel(task.status)}</span>
                  </header>
                  <p>{task.summary}</p>
                  <small>{task.agentLabel} · tests: {task.testStatus}</small>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      {#if reviewShipMessage}
        <p class="message-text">{reviewShipMessage}</p>
      {/if}
      {#if reviewShipError}
        <p class="error-text">{reviewShipError}</p>
      {/if}
    </section>

    <section class="project-section project-section--post-session">
      <div class="section-heading">
        <h3>Post-Session Improvement</h3>
        <div class="section-actions">
          <span>8A review</span>
          <span>8B bounded work</span>
          <span>8C resume</span>
        </div>
      </div>

      <div class="post-session-grid">
        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Review</strong>
            <span>{postSessionArea}</span>
          </div>
          <label>
            Worked
            <textarea class="notes-input" rows="3" bind:value={postSessionWorked}></textarea>
          </label>
          <label>
            Confusing
            <textarea class="notes-input" rows="3" bind:value={postSessionConfusing}></textarea>
          </label>
          <label>
            Broke or unreliable
            <textarea class="notes-input" rows="3" bind:value={postSessionBroke}></textarea>
          </label>
          <label>
            Improve next
            <select bind:value={postSessionArea}>
              {#each POST_SESSION_AREAS as area (area)}
                <option value={area}>{area}</option>
              {/each}
            </select>
          </label>
        </div>

        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Follow-up prompt</strong>
            <span>{postSessionCreateTask ? 'task on save' : 'note only'}</span>
          </div>
          <textarea
            class="notes-input"
            rows="11"
            bind:value={postSessionPrompt}
            placeholder="Describe exactly what should improve, constraints, files or areas to avoid, and how the agent should report back."
          ></textarea>
          <label class="post-session-toggle">
            <input type="checkbox" bind:checked={postSessionCreateTask} />
            <span>Create improvement task</span>
          </label>
          <button
            class="inline-action"
            type="button"
            disabled={postSessionSaving || backgroundLaunching}
            on:click={() => savePostSessionReview(false)}
          >
            {postSessionSaving && !backgroundLaunching ? 'Saving...' : 'Save review'}
          </button>
        </div>

        <div class="review-ship-panel">
          <div class="review-ship-panel-heading">
            <strong>Background policy</strong>
            <span>{backgroundWorkOptIn ? backgroundTrustPosture : 'opt-in required'}</span>
          </div>
          <label class="post-session-toggle">
            <input type="checkbox" bind:checked={backgroundWorkOptIn} />
            <span>Work on this while I am away</span>
          </label>
          <div class="post-session-policy-grid">
            <label>
              Provider
              <select bind:value={backgroundHarness} disabled={!backgroundWorkOptIn}>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
                <option value="opencode">opencode</option>
              </select>
            </label>
            <label>
              Role
              <select bind:value={backgroundRole} disabled={!backgroundWorkOptIn}>
                {#each TASK_BOARD_ROLES as role (role.value)}
                  <option value={role.value}>{role.label}</option>
                {/each}
              </select>
            </label>
            <label>
              Trust
              <select bind:value={backgroundTrustPosture} disabled={!backgroundWorkOptIn}>
                <option value="standard">Standard</option>
                <option value="full-access">Full access</option>
              </select>
            </label>
            <label>
              Timeout minutes
              <input
                class="identity-input"
                type="number"
                min="15"
                max="480"
                step="15"
                bind:value={backgroundTimeoutMinutes}
                disabled={!backgroundWorkOptIn}
              />
            </label>
          </div>
          <label>
            Idle policy
            <textarea class="notes-input" rows="3" bind:value={backgroundIdlePolicy} disabled={!backgroundWorkOptIn}></textarea>
          </label>
          <div class="post-session-policy-summary">
            <code>{project.root}</code>
            <code>{project.scope || project.root}</code>
          </div>
          <button
            class="save-btn"
            type="button"
            disabled={!backgroundWorkOptIn || postSessionSaving || backgroundLaunching}
            on:click={() => savePostSessionReview(true)}
          >
            {backgroundLaunching ? 'Launching...' : 'Save + launch bounded agent'}
          </button>
        </div>
      </div>

      <div class="review-ship-panel post-session-resume-panel">
        <div class="review-ship-panel-heading">
          <strong>Resume Center · Background Work</strong>
          <span>{backgroundRunRows.length}</span>
        </div>
        {#if backgroundRunRows.length === 0}
          <p class="empty-text">No background-work runs are linked to this project.</p>
        {:else}
          <div class="background-run-list">
            {#each backgroundRunRows as run (run.instanceId)}
              <article class="background-run-row">
                <div>
                  <strong>{run.label}</strong>
                  <span class="instance-status instance-status--{statusClass(run.status)}">{statusLabel(run.status)}</span>
                  <small>{run.provider} / {run.role} · timeout {run.timeoutMinutes ?? 'unset'}m · {compactPath(run.scope)}</small>
                </div>
                <div class="task-row-actions">
                  <button class="inline-action" type="button" on:click={() => suspendBackgroundRun(run)}>
                    Suspend
                  </button>
                  <button class="delete-project-btn" type="button" on:click={() => killBackgroundRun(run)}>
                    Kill
                  </button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>

      {#if postSessionMessage}
        <p class="message-text">{postSessionMessage}</p>
      {/if}
      {#if postSessionError}
        <p class="error-text">{postSessionError}</p>
      {/if}
    </section>

    <section class="project-section project-section--actions">
      <button class="save-btn" type="button" disabled={saving} on:click={saveDetails}>
        {saving ? 'Saving...' : 'Save project context'}
      </button>
      <button class="delete-project-btn" type="button" disabled={deleting} on:click={deleteCurrentProject}>
        {deleting ? 'Deleting...' : 'Delete project'}
      </button>
      {#if saveMessage}
        <p class="message-text">{saveMessage}</p>
      {/if}
      {#if saveError}
        <p class="error-text">{saveError}</p>
      {/if}
    </section>
  </div>
</aside>

{#if expandedBubbleImageUrl}
  <div class="asset-lightbox" role="dialog" aria-modal="true" aria-label="Expanded project image">
    <button class="lightbox-close" type="button" aria-label="Close expanded image" on:click={() => (expandedBubbleImageUrl = '')}>
      ×
    </button>
    <img src={expandedBubbleImageUrl} alt={selectedBubbleItem?.name ?? 'Expanded project image'} />
  </div>
{/if}

<style>
  .project-page {
    position: fixed;
    left: 50%;
    top: 76px;
    bottom: 24px;
    width: min(1180px, calc(100vw - 56px));
    transform: translateX(-50%);
    z-index: 42;
    display: flex;
    flex-direction: column;
    --project-color: #ffffff;
    border: 1px solid color-mix(in srgb, var(--project-color) 62%, rgba(255, 255, 255, 0.42));
    background: rgba(0, 0, 0, 0.88);
    color: rgba(255, 255, 255, 0.9);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color) 18%, transparent) inset,
      0 24px 80px rgba(0, 0, 0, 0.72),
      0 0 42px color-mix(in srgb, var(--project-color) 18%, transparent);
    backdrop-filter: blur(18px);
  }

  .project-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 20px 22px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.16);
  }

  .project-header-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }

  .project-kicker,
  .section-heading span {
    color: rgba(255, 255, 255, 0.58);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    margin-top: 4px;
    color: #fff;
    font-size: 24px;
    line-height: 1.05;
    letter-spacing: 0;
  }

  .mono {
    margin-top: 8px;
    color: rgba(255, 255, 255, 0.62);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .context-copy {
    margin-top: 10px;
    max-width: 56ch;
    color: rgba(255, 255, 255, 0.62);
    font-size: 12px;
    line-height: 1.45;
  }

  .icon-btn {
    width: 32px;
    height: 32px;
    border: 1px solid rgba(255, 255, 255, 0.32);
    border-radius: 0;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.86);
    cursor: pointer;
  }

  .project-body {
    display: grid;
    grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
    gap: 14px;
    padding: 16px;
    overflow: auto;
  }

  .project-section {
    border: 1px solid color-mix(in srgb, var(--project-color) 28%, rgba(255, 255, 255, 0.16));
    background: rgba(255, 255, 255, 0.045);
    padding: 14px;
  }

  .project-cockpit {
    grid-column: 1 / -1;
    display: grid;
    gap: 14px;
    border: 1px solid color-mix(in srgb, var(--project-color) 42%, rgba(255, 255, 255, 0.18));
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--project-color) 13%, transparent), rgba(255, 255, 255, 0.035) 42%, rgba(0, 0, 0, 0.28)),
      rgba(255, 255, 255, 0.045);
    padding: 16px;
  }

  .cockpit-hero {
    display: grid;
    grid-template-columns: minmax(260px, 0.8fr) minmax(280px, 1fr);
    gap: 16px;
    align-items: start;
  }

  .cockpit-hero h3 {
    margin-top: 4px;
    color: #fff;
    font-size: 26px;
    line-height: 1.04;
    text-transform: none;
  }

  .cockpit-hero p,
  .cockpit-placeholder,
  .task-lane p {
    color: rgba(255, 255, 255, 0.62);
    font-size: 12px;
    line-height: 1.45;
  }

  .cockpit-hero p {
    margin-top: 8px;
    max-width: 62ch;
  }

  .cockpit-diagnostics {
    display: grid;
    gap: 8px;
  }

  .cockpit-diagnostics span {
    display: grid;
    grid-template-columns: minmax(92px, 0.28fr) minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--project-color) 22%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.34);
    padding: 9px 10px;
  }

  .cockpit-diagnostics strong {
    color: rgba(255, 255, 255, 0.52);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .cockpit-diagnostics code {
    min-width: 0;
    color: rgba(255, 255, 255, 0.78);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .cockpit-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.82fr) minmax(260px, 0.9fr);
    gap: 12px;
    align-items: stretch;
  }

  .cockpit-panel {
    display: grid;
    align-content: start;
    gap: 10px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--project-color) 24%, rgba(255, 255, 255, 0.14));
    background: rgba(0, 0, 0, 0.28);
    padding: 12px;
  }

  .task-board-preview {
    display: grid;
    grid-template-columns: repeat(4, minmax(132px, 1fr));
    gap: 8px;
    min-width: 0;
  }

  .task-lane {
    display: grid;
    align-content: start;
    gap: 8px;
    min-width: 0;
    min-height: 148px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .task-lane header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .task-lane header strong,
  .cockpit-mini-list strong,
  .activity-row strong {
    min-width: 0;
    color: rgba(255, 255, 255, 0.88);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .task-lane header span {
    display: inline-grid;
    place-items: center;
    min-width: 24px;
    min-height: 22px;
    border: 1px solid color-mix(in srgb, var(--project-color) 34%, rgba(255, 255, 255, 0.16));
    color: rgba(255, 255, 255, 0.76);
    font-size: 11px;
    font-weight: 800;
  }

  .task-preview-row {
    display: grid;
    gap: 5px;
    min-width: 0;
    border-left: 2px solid rgba(255, 255, 255, 0.3);
    background: rgba(0, 0, 0, 0.24);
    padding: 8px 9px;
  }

  .task-preview-row strong {
    color: rgba(255, 255, 255, 0.86);
    font-size: 12px;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .task-preview-row p {
    color: rgba(255, 255, 255, 0.54);
    font-size: 11px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .task-status,
  .instance-status {
    justify-self: start;
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: rgba(255, 255, 255, 0.7);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0;
    padding: 3px 5px;
    text-transform: uppercase;
  }

  .task-status--in-progress,
  .instance-status--online {
    border-color: rgba(118, 255, 184, 0.48);
    color: rgba(148, 255, 196, 0.9);
  }

  .task-status--failed,
  .task-status--cancelled,
  .instance-status--offline {
    border-color: rgba(255, 107, 107, 0.46);
    color: rgba(255, 142, 142, 0.9);
  }

  .task-import-grid {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(260px, 0.56fr);
    gap: 12px;
    align-items: stretch;
    margin-bottom: 12px;
  }

  .task-import-actions {
    display: grid;
    align-content: start;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--project-color) 20%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.26);
    padding: 12px;
  }

  .task-import-actions p {
    color: rgba(255, 255, 255, 0.62);
    font-size: 12px;
    line-height: 1.45;
  }

  .proof-pack-panel {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) auto;
    gap: 10px;
    align-items: end;
    margin-bottom: 12px;
    border: 1px solid color-mix(in srgb, var(--project-color) 24%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.24);
    padding: 10px;
  }

  .proof-pack-panel label {
    display: block;
    margin-bottom: 6px;
    color: rgba(255, 255, 255, 0.54);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .bulk-assignment {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: end;
  }

  .bulk-assignment label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }

  select {
    min-height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.48);
    color: rgba(255, 255, 255, 0.86);
    font: inherit;
    font-size: 11px;
    outline: none;
  }

  select:focus {
    border-color: color-mix(in srgb, var(--project-color) 72%, rgba(255, 255, 255, 0.52));
  }

  .task-board-sections {
    display: grid;
    gap: 12px;
  }

  .task-board-section {
    display: grid;
    gap: 8px;
    min-width: 0;
    overflow-x: auto;
    border: 1px solid color-mix(in srgb, var(--project-color) 22%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.2);
    padding: 10px;
  }

  .task-board-section header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .task-board-section h4 {
    margin: 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .task-board-section header span {
    color: rgba(255, 255, 255, 0.54);
    font-size: 11px;
  }

  .task-board-row {
    display: grid;
    grid-template-columns: 68px minmax(230px, 1.25fr) minmax(130px, 0.6fr) minmax(112px, 0.45fr) minmax(150px, 0.62fr) minmax(170px, 0.75fr) minmax(160px, 0.7fr);
    gap: 8px;
    align-items: start;
    min-width: 980px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .task-board-row--launching {
    border-color: rgba(118, 255, 184, 0.44);
    box-shadow: 0 0 18px rgba(118, 255, 184, 0.12);
  }

  .task-board-row--failed {
    border-color: rgba(255, 107, 107, 0.44);
    box-shadow: 0 0 18px rgba(255, 107, 107, 0.12);
  }

  .task-board-row--stale {
    border-color: rgba(255, 198, 109, 0.52);
    box-shadow: 0 0 18px rgba(255, 198, 109, 0.12);
  }

  .task-board-row--header {
    min-height: 0;
    border-color: transparent;
    background: transparent;
    padding-top: 0;
    padding-bottom: 0;
  }

  .task-board-row--header span {
    color: rgba(255, 255, 255, 0.46);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .task-select-cell {
    display: grid;
    gap: 6px;
    margin: 0;
    color: rgba(255, 255, 255, 0.56);
    font-size: 10px;
    text-transform: uppercase;
  }

  .task-select-cell input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: color-mix(in srgb, var(--project-color) 72%, #ffffff);
  }

  .task-title-cell,
  .provider-role-cell,
  .agent-listener-cell,
  .task-result-cell {
    display: grid;
    gap: 7px;
    min-width: 0;
  }

  .task-board-row .notes-input {
    min-height: 70px;
  }

  .agent-listener-cell span {
    color: rgba(255, 255, 255, 0.52);
    font-size: 10px;
    line-height: 1.35;
  }

  .agent-listener-cell .task-listener-state--stale {
    color: rgba(255, 214, 140, 0.92);
  }

  .agent-listener-cell code {
    justify-self: start;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.05);
    color: color-mix(in srgb, var(--project-color) 70%, rgba(255, 255, 255, 0.78));
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    padding: 3px 5px;
  }

  .agent-listener-cell small {
    color: rgba(255, 142, 142, 0.92);
    font-size: 10px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .task-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .task-row-actions .inline-action {
    min-height: 26px;
    padding: 4px 7px;
    font-size: 10px;
  }

  .sticky-task-action-bar {
    position: relative;
    z-index: 2;
    display: none;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 12px;
    border: 1px solid color-mix(in srgb, var(--project-color) 44%, rgba(255, 255, 255, 0.16));
    background: rgba(0, 0, 0, 0.82);
    box-shadow: 0 0 24px color-mix(in srgb, var(--project-color) 16%, transparent);
    padding: 10px;
  }

  .sticky-task-action-bar.visible {
    display: flex;
    opacity: 1;
  }

  .sticky-task-action-bar span {
    color: rgba(255, 255, 255, 0.68);
    font-size: 11px;
  }

  .sticky-task-action-bar strong {
    color: #fff;
    font-size: 14px;
  }

  .agent-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .agent-summary-grid div {
    border: 1px solid color-mix(in srgb, var(--project-color) 20%, rgba(255, 255, 255, 0.12));
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .agent-summary-grid strong {
    display: block;
    color: #fff;
    font-size: 15px;
  }

  .agent-summary-grid span,
  .activity-row small,
  .activity-row em {
    color: rgba(255, 255, 255, 0.55);
    font-size: 10px;
    line-height: 1.35;
  }

  .cockpit-mini-list,
  .activity-list {
    display: grid;
    gap: 8px;
  }

  .cockpit-mini-list div,
  .activity-row {
    display: grid;
    gap: 5px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .activity-row {
    grid-template-columns: 54px minmax(0, 1fr);
    align-items: start;
  }

  .activity-row time {
    color: color-mix(in srgb, var(--project-color) 66%, rgba(255, 255, 255, 0.58));
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
  }

  .activity-row span {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .activity-row small {
    grid-column: 2;
    text-transform: uppercase;
  }

  .review-ship-grid,
  .review-ship-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.72fr);
    gap: 12px;
    align-items: start;
  }

  .review-ship-columns {
    margin-top: 12px;
  }

  .review-ship-panel {
    display: grid;
    gap: 10px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--project-color) 22%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.24);
    padding: 12px;
  }

  .review-ship-panel--commit {
    align-content: start;
  }

  .review-ship-panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .review-ship-panel-heading strong {
    min-width: 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    overflow-wrap: anywhere;
    text-transform: uppercase;
  }

  .review-ship-panel-heading span,
  .review-file-row span,
  .review-file-row small,
  .review-task-row small {
    color: rgba(255, 255, 255, 0.56);
    font-size: 10px;
    line-height: 1.35;
  }

  .review-ship-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .commit-suggestion-list,
  .review-risk-list,
  .review-file-list,
  .review-task-list {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .commit-suggestion-list code,
  .review-file-row,
  .review-task-row,
  .review-risk-list p {
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .commit-suggestion-list code,
  .review-file-row strong {
    color: rgba(255, 255, 255, 0.78);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    overflow-wrap: anywhere;
  }

  .review-risk-list p {
    color: rgba(255, 198, 109, 0.9);
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .review-file-row,
  .review-task-row {
    display: grid;
    gap: 5px;
  }

  .review-task-row header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .review-task-row header strong {
    min-width: 0;
    color: rgba(255, 255, 255, 0.88);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .review-task-row p {
    color: rgba(255, 255, 255, 0.62);
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .post-session-grid {
    display: grid;
    grid-template-columns: minmax(240px, 0.92fr) minmax(260px, 1fr) minmax(260px, 0.98fr);
    gap: 12px;
    align-items: stretch;
  }

  .post-session-grid select,
  .post-session-policy-grid input {
    width: 100%;
    box-sizing: border-box;
  }

  .post-session-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    min-height: 32px;
    color: rgba(255, 255, 255, 0.72);
    font-size: 11px;
    line-height: 1.3;
    text-transform: none;
  }

  .post-session-toggle input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: color-mix(in srgb, var(--project-color) 72%, #ffffff);
    flex: 0 0 auto;
  }

  .post-session-policy-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .post-session-policy-summary {
    display: grid;
    gap: 6px;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 8px;
  }

  .post-session-policy-summary code {
    min-width: 0;
    color: color-mix(in srgb, var(--project-color) 72%, rgba(255, 255, 255, 0.78));
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .post-session-resume-panel {
    margin-top: 12px;
  }

  .background-run-list {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .background-run-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.035);
    padding: 9px;
  }

  .background-run-row > div:first-child {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .background-run-row strong {
    min-width: 0;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .background-run-row small {
    color: rgba(255, 255, 255, 0.56);
    font-size: 10px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .project-section--actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .project-section--overview,
  .project-section--task-board-mvp,
  .project-section--review-ship,
  .project-section--post-session,
  .project-section--assets,
  .project-section--file-bubble,
  .project-section--actions {
    grid-column: 1 / -1;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .section-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  h3 {
    color: rgba(255, 255, 255, 0.92);
    font-size: 13px;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .inventory-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }

  .metrics div,
  .inventory-groups div,
  .list-row {
    border: 1px solid color-mix(in srgb, var(--project-color) 20%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.32);
    padding: 10px;
  }

  .metrics strong,
  .inventory-groups strong {
    display: block;
    color: #fff;
    font-size: 13px;
  }

  .metrics span,
  .inventory-groups span,
  .list-row span,
  .empty-text {
    color: rgba(255, 255, 255, 0.58);
    font-size: 11px;
  }

  .row-list {
    display: grid;
    gap: 8px;
  }

  .inventory-folder-list {
    margin-top: 8px;
  }

  .list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .list-row > span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .list-row strong {
    min-width: 0;
    color: rgba(255, 255, 255, 0.86);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .list-row em {
    margin-top: 0;
    font-style: normal;
  }

  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  label {
    display: block;
    margin-bottom: 6px;
    color: rgba(255, 255, 255, 0.58);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .notes-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 92px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.42);
    color: rgba(255, 255, 255, 0.88);
    padding: 10px;
    font: inherit;
    font-size: 12px;
    line-height: 1.45;
    outline: none;
  }

  .notes-input:focus {
    border-color: color-mix(in srgb, var(--project-color) 72%, rgba(255, 255, 255, 0.52));
  }

  .asset-kind-row,
  .asset-form {
    display: grid;
    gap: 8px;
    margin-bottom: 12px;
  }

  .project-section--assets .asset-form {
    grid-template-columns: minmax(180px, 0.75fr) minmax(280px, 1.25fr);
    align-items: start;
  }

  .project-section--assets .asset-form .asset-path-row,
  .project-section--assets .asset-form textarea,
  .project-section--assets .asset-form .save-btn {
    grid-column: 1 / -1;
  }

  .asset-kind-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .asset-kind-row button {
    min-height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.72);
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .asset-kind-row button.active {
    border-color: color-mix(in srgb, var(--project-color) 72%, rgba(255, 255, 255, 0.56));
    background: color-mix(in srgb, var(--project-color) 12%, rgba(255, 255, 255, 0.1));
    color: #fff;
  }

  .asset-path-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: stretch;
  }

  .file-bubble-shell {
    display: grid;
    gap: 12px;
    width: 100%;
  }

  .file-bubble-folder {
    display: grid;
    grid-template-columns: minmax(260px, 0.42fr) minmax(0, 1fr);
    gap: 10px;
    align-items: stretch;
  }

  .file-bubble-folder--stage {
    grid-template-columns: minmax(320px, 0.72fr) minmax(180px, 0.28fr);
  }

  .folder-tile {
    display: grid;
    grid-template-columns: minmax(132px, 0.38fr) minmax(0, 1fr);
    gap: 18px;
    align-items: center;
    min-height: 96px;
    border: 1px solid color-mix(in srgb, var(--project-color) 54%, rgba(255, 255, 255, 0.18));
    border-radius: 0;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--project-color) 16%, transparent), rgba(0, 0, 0, 0.48)),
      rgba(0, 0, 0, 0.44);
    color: rgba(255, 255, 255, 0.9);
    cursor: pointer;
    padding: 14px;
    text-align: left;
    box-shadow: 0 0 28px color-mix(in srgb, var(--project-color) 13%, transparent);
  }

  .folder-tile--hero {
    min-height: 230px;
  }

  .folder-tile--hero strong {
    font-size: 28px;
  }

  .folder-art-shell {
    display: grid;
    place-items: center;
    min-width: 0;
    aspect-ratio: 1.15;
    border: 1px solid color-mix(in srgb, var(--project-color) 34%, rgba(255, 255, 255, 0.14));
    background:
      radial-gradient(circle at 50% 48%, color-mix(in srgb, var(--project-color) 16%, transparent), transparent 64%),
      rgba(0, 0, 0, 0.52);
    overflow: hidden;
  }

  .folder-art-shell img {
    display: block;
    width: 88%;
    height: 88%;
    object-fit: contain;
    filter: drop-shadow(0 0 22px color-mix(in srgb, var(--project-color) 28%, transparent));
  }

  .folder-tile strong {
    display: block;
    color: #fff;
    font-size: 18px;
    line-height: 1.08;
    overflow-wrap: anywhere;
  }

  .folder-picker {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 8px;
  }

  .folder-picker button,
  .file-bubble-list button {
    min-height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(255, 255, 255, 0.72);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .folder-picker button {
    padding: 8px 10px;
  }

  .folder-picker button.active,
  .file-bubble-list button.active {
    border-color: color-mix(in srgb, var(--project-color) 76%, rgba(255, 255, 255, 0.58));
    background: color-mix(in srgb, var(--project-color) 13%, rgba(255, 255, 255, 0.1));
    color: #fff;
  }

  .file-bubble-browser {
    display: grid;
    grid-template-columns: minmax(190px, 0.3fr) minmax(0, 1fr);
    gap: 10px;
    min-height: 360px;
  }

  .bubble-breadcrumb {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--project-color) 20%, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.28);
    padding: 10px;
  }

  .bubble-breadcrumb strong {
    color: #fff;
    font-size: 13px;
  }

  .bubble-breadcrumb em {
    margin-top: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-bubble-list {
    display: grid;
    align-content: start;
    gap: 8px;
    max-height: 420px;
    overflow: auto;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.24);
    padding: 10px;
  }

  .file-bubble-list button {
    display: grid;
    gap: 3px;
    padding: 9px 10px;
  }

  .file-bubble-list button span {
    color: rgba(255, 255, 255, 0.48);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .file-bubble-list button strong {
    color: inherit;
    font-size: 12px;
    line-height: 1.2;
  }

  .file-bubble-preview {
    position: relative;
    display: grid;
    align-content: center;
    justify-items: stretch;
    gap: 10px;
    min-height: 360px;
    border: 1px solid color-mix(in srgb, var(--project-color) 30%, rgba(255, 255, 255, 0.14));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(0, 0, 0, 0.28)),
      rgba(0, 0, 0, 0.44);
    overflow: auto;
    padding: 10px;
  }

  .bubble-image-trigger {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    cursor: zoom-in;
    padding: 0;
  }

  .bubble-image-trigger img,
  .file-bubble-preview img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 480px;
    object-fit: contain;
  }

  .file-bubble-preview video {
    display: block;
    width: 100%;
    max-height: 480px;
    background: rgba(0, 0, 0, 0.72);
  }

  .file-bubble-preview pre {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: 16px;
    overflow: auto;
    color: rgba(255, 255, 255, 0.78);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .preview-actions {
    position: absolute;
    right: 12px;
    top: 12px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .preview-expand {
    border: 1px solid rgba(255, 255, 255, 0.34);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.72);
    color: rgba(255, 255, 255, 0.9);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 7px 10px;
  }

  .preview-expand:disabled {
    opacity: 0.58;
    cursor: default;
  }

  .bubble-visual-analysis {
    display: grid;
    gap: 6px;
    border-left: 2px solid rgba(120, 255, 190, 0.62);
    background: rgba(120, 255, 190, 0.08);
    padding: 10px 12px;
  }

  .bubble-visual-analysis span {
    color: rgba(120, 255, 190, 0.82);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .bubble-visual-analysis p {
    color: rgba(255, 255, 255, 0.76);
    font-size: 12px;
    line-height: 1.45;
  }

  .preview-file-meta {
    display: grid;
    gap: 8px;
    max-width: min(560px, 90%);
    padding: 16px;
    text-align: center;
  }

  .preview-file-meta strong {
    color: #fff;
    font-size: 16px;
    overflow-wrap: anywhere;
  }

  .preview-file-meta span {
    color: rgba(255, 255, 255, 0.58);
    font-size: 11px;
    text-transform: uppercase;
  }

  .asset-lightbox {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 28px;
    background: rgba(0, 0, 0, 0.9);
    backdrop-filter: blur(12px);
  }

  .asset-lightbox img {
    display: block;
    max-width: 96vw;
    max-height: 92vh;
    object-fit: contain;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(0, 0, 0, 0.5);
  }

  .lightbox-close {
    position: fixed;
    right: 22px;
    top: 18px;
    width: 36px;
    height: 36px;
    border: 1px solid rgba(255, 255, 255, 0.32);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.6);
    color: rgba(255, 255, 255, 0.92);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
  }

  .identity-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 0;
    background: rgba(0, 0, 0, 0.42);
    color: rgba(255, 255, 255, 0.88);
    padding: 9px 10px;
    font: inherit;
    font-size: 12px;
    outline: none;
  }

  .identity-input:focus {
    border-color: color-mix(in srgb, var(--project-color) 72%, rgba(255, 255, 255, 0.52));
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .color-picker-shell {
    margin: 0;
    display: inline-flex;
    position: relative;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--picker-color) 76%, rgba(255, 255, 255, 0.34));
    background: var(--picker-color);
    box-shadow:
      inset 0 0 0 7px rgba(0, 0, 0, 0.62),
      0 0 18px color-mix(in srgb, var(--picker-color) 42%, transparent);
    cursor: pointer;
  }

  .color-picker-shell input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    cursor: pointer;
  }

  .color-picker-shell span {
    position: relative;
    color: color-mix(in srgb, var(--picker-color) 18%, #000);
    font-size: 24px;
    font-weight: 800;
    line-height: 1;
    text-shadow: 0 0 10px rgba(255, 255, 255, 0.38);
    pointer-events: none;
  }

  .color-hint {
    max-width: 24ch;
    color: rgba(255, 255, 255, 0.54);
    font-size: 11px;
    line-height: 1.35;
  }

  .inline-action,
  .save-btn,
  .delete-project-btn {
    border: 1px solid rgba(255, 255, 255, 0.26);
    border-radius: 0;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.86);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 6px 9px;
  }

  .inline-action:hover:not(:disabled),
  .save-btn:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--project-color) 74%, rgba(255, 255, 255, 0.7));
    background: color-mix(in srgb, var(--project-color) 12%, rgba(255, 255, 255, 0.14));
  }

  .delete-project-btn {
    border-color: rgba(255, 90, 106, 0.46);
    color: rgba(255, 154, 164, 0.92);
  }

  .delete-project-btn:hover:not(:disabled) {
    border-color: rgba(255, 90, 106, 0.8);
    background: rgba(255, 90, 106, 0.14);
  }

  .inline-action:disabled,
  .save-btn:disabled,
  .delete-project-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .message-text,
  .error-text {
    margin: 0;
    font-size: 11px;
  }

  .message-text {
    color: rgba(134, 255, 188, 0.78);
  }

  .error-text {
    color: rgba(255, 124, 124, 0.86);
  }

  @media (max-width: 680px) {
    .project-page {
      left: 12px;
      right: 12px;
      top: 74px;
      bottom: 12px;
      width: auto;
      transform: none;
    }

    .project-body,
    .cockpit-hero,
    .cockpit-grid,
    .task-board-preview,
    .task-import-grid,
    .proof-pack-panel,
    .bulk-assignment,
    .review-ship-grid,
    .review-ship-columns,
    .post-session-grid,
    .post-session-policy-grid,
    .background-run-row,
    .project-section--assets .asset-form,
    .file-bubble-folder,
    .file-bubble-browser {
      grid-template-columns: 1fr;
    }

    .sticky-task-action-bar {
      align-items: stretch;
      flex-direction: column;
    }

    .file-bubble-preview {
      min-height: 280px;
    }
  }
</style>
