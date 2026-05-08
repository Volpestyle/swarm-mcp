<script lang="ts">
  import { Handle, NodeResizer, Position } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import {
    TASK_BOARD_PROVIDERS,
    TASK_BOARD_ROLES,
    applySelectedAssignmentToRows,
    canRetryTaskBoardRow,
    countSelectedTaskBoardRows,
    createDraftTaskRow,
    groupTaskBoardRows,
    parsePlanRows,
    providerToLaunchHarness,
    reassignTaskRowToBulk,
    resetTaskLaunchStateForRow,
    resolveTaskBoardRowRuntime,
    roleToLaunchRole,
    selectedTaskBoardRows,
    setAllTaskSelection,
    statusAfterLaunch,
    syncTaskBoardRows,
    taskBoardSourceKey,
    taskLaunchInstructions,
    taskLaunchLabel,
    taskLaunchName,
    toggleTaskSelection,
    updateTaskBoardRow,
    type TaskBoardProvider,
    type TaskBoardRole,
    type TaskBoardRow,
  } from '../lib/taskBoardModel';
  import { requestNodeFocus } from '../lib/app/focus';
  import { formatLaunchPreflightFailure, preflightLaunchCommand, summarizeLaunchCommandPreflight } from '../lib/launchPreflight';
  import { resolveHarnessCommand } from '../stores/harnessAliases';
  import { spawnShell } from '../stores/pty';
  import darkFolderUrl from '../assets/dark-folder.png';

  export let id: string;
  export let data: SwarmNodeData;
  export let selected: boolean = false;

  type MissionView = 'todo' | 'assign' | 'progress';

  let view: MissionView = 'todo';
  let rows: TaskBoardRow[] = [];
  let rowsSourceKey = '';
  let planText = '';
  let bulkProvider: TaskBoardProvider = 'codex';
  let bulkRole: TaskBoardRole = 'implementer';
  let launchingIds = new Set<string>();
  let message = '';
  let error = '';

  $: mission = data.mission ?? null;
  $: missionTasks = mission?.tasks ?? data.assignedTasks ?? [];
  $: sourceKey = mission ? taskBoardSourceKey(mission.projectId, missionTasks) : '';
  $: if (mission && sourceKey !== rowsSourceKey) {
    rows = syncTaskBoardRows(mission.projectId, missionTasks, rows);
    rowsSourceKey = sourceKey;
  }
  $: sections = groupTaskBoardRows(rows);
  $: selectedCount = countSelectedTaskBoardRows(rows);
  $: selectedRows = selectedTaskBoardRows(rows);
  $: launching = launchingIds.size > 0;
  $: projectColor = mission?.color || '#00f060';
  $: agentStates = mission?.agents ?? [];
  $: liveCount = rows.filter((row) => row.launchStatus === 'launched').length;
  $: failedCount = rows.filter((row) => row.launchStatus === 'failed').length;

  function sideToPosition(side: string): Position {
    switch (side) {
      case 'top': return Position.Top;
      case 'right': return Position.Right;
      case 'bottom': return Position.Bottom;
      case 'left': return Position.Left;
      default: return Position.Right;
    }
  }

  function setRowLaunching(rowId: string, nextLaunching: boolean): void {
    const next = new Set(launchingIds);
    if (nextLaunching) {
      next.add(rowId);
    } else {
      next.delete(rowId);
    }
    launchingIds = next;
  }

  function patchRow(rowId: string, patch: Partial<TaskBoardRow>): void {
    rows = updateTaskBoardRow(rows, rowId, patch);
  }

  function addBlankTask(): void {
    if (!mission) return;
    rows = [
      ...rows,
      createDraftTaskRow({
        projectId: mission.projectId,
        provider: bulkProvider,
        role: bulkRole,
        section: 'Manual Tasks',
        title: 'New task',
        selected: false,
      }),
    ];
    message = 'Added editable task row.';
    error = '';
  }

  function importPlan(): void {
    if (!mission) return;
    const imported = parsePlanRows(planText, mission.projectId, bulkProvider, bulkRole);
    if (imported.length === 0) {
      error = 'Paste headings with bullet or numbered task lines.';
      message = '';
      return;
    }
    rows = [...rows, ...imported];
    message = `Imported ${imported.length} task row${imported.length === 1 ? '' : 's'}.`;
    error = '';
    view = 'todo';
  }

  function applySelectedAssignment(): void {
    if (selectedCount === 0) return;
    rows = applySelectedAssignmentToRows(rows, bulkProvider, bulkRole);
    message = `Assigned ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}.`;
    error = '';
  }

  function resetRow(row: TaskBoardRow): void {
    patchRow(row.id, resetTaskLaunchStateForRow(row));
    message = `Reset ${row.title}.`;
    error = '';
  }

  function reassignRow(row: TaskBoardRow): void {
    patchRow(row.id, reassignTaskRowToBulk(row, bulkProvider, bulkRole));
    message = `Reassigned ${row.title}.`;
    error = '';
  }

  async function launchRows(rowsToLaunch: TaskBoardRow[], mode: 'selected' | 'retry'): Promise<void> {
    if (!mission || rowsToLaunch.length === 0 || launching) return;
    let launched = 0;
    let failed = 0;
    error = '';
    message = mode === 'retry'
      ? `Retrying ${rowsToLaunch.length} task${rowsToLaunch.length === 1 ? '' : 's'}...`
      : `Launching ${rowsToLaunch.length} selected task${rowsToLaunch.length === 1 ? '' : 's'}...`;

    for (const row of rowsToLaunch) {
      const harness = providerToLaunchHarness(row.provider);
      if (!harness) {
        failed += 1;
        patchRow(row.id, {
          launchStatus: 'failed',
          launchError: 'Choose Codex, Claude, Hermes, OpenClaw, or opencode for a task-bound launch.',
          listenerState: 'launch blocked',
          selected: true,
        });
        continue;
      }

      const launchRole = roleToLaunchRole(row.role);
      setRowLaunching(row.id, true);
      patchRow(row.id, {
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
          cwd: mission.root,
          harness,
          commandSource: 'Mission Board provider command',
        });
        if (!commandPreflight.ok) {
          throw new Error(formatLaunchPreflightFailure(commandPreflight));
        }
        const preflightSummary = summarizeLaunchCommandPreflight(commandPreflight);
        const result = await spawnShell(mission.root, {
          harness,
          role: launchRole,
          scope: mission.scope || mission.root,
          label: taskLaunchLabel(mission.projectId, row),
          name: taskLaunchName(row, launchRole),
          bootstrapInstructions: taskLaunchInstructions({
            project: {
              id: mission.projectId,
              name: mission.title,
              root: mission.root,
              scope: mission.scope,
            },
            row,
            harness,
            launchRole,
            source: 'mission_board',
          }),
          launchPreflight: commandPreflight,
        });

        const focusNodeId = result.instance_id
          ? `bound:${result.instance_id}`
          : `pty:${result.pty_id}`;
        requestNodeFocus(focusNodeId);

        const launchSummary = `Preflight OK: ${preflightSummary}\nLaunched ${harness}/${launchRole}${result.instance_id ? ` as ${result.instance_id.slice(0, 8)}` : ''}.`;
        patchRow(row.id, {
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
        patchRow(row.id, {
          launchStatus: 'failed',
          launchError: err instanceof Error ? err.message : String(err),
          listenerState: 'launch failed',
          assignee: '',
          launchInstanceId: '',
          launchPtyId: '',
          selected: true,
        });
      } finally {
        setRowLaunching(row.id, false);
      }
    }

    if (failed > 0) {
      error = `${failed} task launch${failed === 1 ? '' : 'es'} failed. Check Progress.`;
    }
    message = `Launched ${launched}/${rowsToLaunch.length} task-bound agent${launched === 1 ? '' : 's'}.`;
    view = 'progress';
  }

  async function launchSelected(): Promise<void> {
    await launchRows([...selectedRows], 'selected');
  }

  async function retryRow(row: TaskBoardRow): Promise<void> {
    if (launchingIds.has(row.id)) return;
    await launchRows([row], 'retry');
  }
</script>

<div class="mission-node" class:selected data-node-id={id} style="--mission-color: {projectColor};">
  <NodeResizer
    minWidth={430}
    minHeight={320}
    isVisible={selected}
    lineClass="resize-line"
    handleClass="resize-handle"
  />

  {#each ['top', 'right', 'bottom', 'left'] as side (side)}
    <Handle id="t-{side}" type="target" position={sideToPosition(side)} />
    <Handle id="s-{side}" type="source" position={sideToPosition(side)} />
  {/each}

  <header class="mission-header">
    <span class="mission-icon" aria-hidden="true"><img src={darkFolderUrl} alt="" /></span>
    <div>
      <span>Mission Board</span>
      <strong>{mission?.title ?? 'Project Mission'}</strong>
      <small>{mission?.summary ?? 'Project task command surface'}</small>
    </div>
    <em>{rows.length} tasks</em>
  </header>

  <nav class="mission-tabs" aria-label="Mission Board views">
    <button type="button" class:active={view === 'todo'} on:click={() => (view = 'todo')}>Todo</button>
    <button type="button" class:active={view === 'assign'} on:click={() => (view = 'assign')}>Assign</button>
    <button type="button" class:active={view === 'progress'} on:click={() => (view = 'progress')}>Progress</button>
  </nav>

  {#if view === 'todo'}
    <section class="mission-body mission-todo">
      <div class="mission-import nodrag nowheel">
        <textarea bind:value={planText} placeholder="Paste plan bullets..." on:pointerdown|stopPropagation></textarea>
        <div>
          <button type="button" on:click={importPlan}>Import</button>
          <button type="button" on:click={addBlankTask}>Add</button>
        </div>
      </div>
      <div class="mission-sections">
        {#if rows.length === 0}
          <p class="mission-empty">Paste a plan or add a task.</p>
        {/if}
        {#each sections as section (section.name)}
          <section>
            <h4>{section.name}<span>{section.rows.length}</span></h4>
            {#each section.rows as row (row.id)}
              <label class="mission-row nodrag">
                <input
                  type="checkbox"
                  checked={row.selected}
                  on:change={(event) => (rows = toggleTaskSelection(rows, row.id, (event.currentTarget as HTMLInputElement).checked))}
                />
                <span class="check-dot" aria-hidden="true"></span>
                <strong>{row.title}</strong>
                <em>{row.provider} / {row.role}</em>
              </label>
            {/each}
          </section>
        {/each}
      </div>
    </section>
  {:else if view === 'assign'}
    <section class="mission-body mission-assign">
      <div class="assign-panel nodrag">
        <button type="button" class="ghost" on:click={() => (view = 'todo')}>Back</button>
        <label>
          Set all
          <select bind:value={bulkProvider}>
            {#each TASK_BOARD_PROVIDERS as provider (provider.value)}
              <option value={provider.value}>{provider.label}</option>
            {/each}
          </select>
        </label>
        <select bind:value={bulkRole}>
          {#each TASK_BOARD_ROLES as role (role.value)}
            <option value={role.value}>{role.label}</option>
          {/each}
        </select>
        <button type="button" on:click={applySelectedAssignment} disabled={selectedCount === 0}>Apply</button>
      </div>
      <div class="assign-list">
        {#each rows as row (row.id)}
          <article class="assign-row nodrag">
            <span>{row.title}</span>
            <select value={row.provider} on:change={(event) => patchRow(row.id, { provider: (event.currentTarget as HTMLSelectElement).value as TaskBoardProvider })}>
              {#each TASK_BOARD_PROVIDERS as provider (provider.value)}
                <option value={provider.value}>{provider.label}</option>
              {/each}
            </select>
            <select value={row.role} on:change={(event) => patchRow(row.id, { role: (event.currentTarget as HTMLSelectElement).value as TaskBoardRole })}>
              {#each TASK_BOARD_ROLES as role (role.value)}
                <option value={role.value}>{role.label}</option>
              {/each}
            </select>
          </article>
        {/each}
      </div>
    </section>
  {:else}
    <section class="mission-body mission-progress">
      <div class="progress-summary">
        <span><strong>{liveCount}</strong> launched</span>
        <span><strong>{failedCount}</strong> failed</span>
        <span><strong>{agentStates.length}</strong> agents</span>
      </div>
      {#each rows as row (row.id)}
        {@const runtime = resolveTaskBoardRowRuntime(row, agentStates)}
        <article class="progress-row" class:stale={runtime.stale} class:failed={runtime.state === 'failed'}>
          <div>
            <strong>{row.title}</strong>
            <span>{runtime.listenerState}</span>
            {#if runtime.launchError}<small>{runtime.launchError}</small>{/if}
          </div>
          <div class="progress-actions nodrag">
            <button type="button" disabled={!canRetryTaskBoardRow(row, agentStates) || launching || launchingIds.has(row.id)} on:click={() => retryRow(row)}>Retry</button>
            <button type="button" disabled={launching || launchingIds.has(row.id)} on:click={() => reassignRow(row)}>Reassign</button>
            <button type="button" disabled={launching || launchingIds.has(row.id) || (row.launchStatus === 'not_launched' && !row.assignee)} on:click={() => resetRow(row)}>Reset</button>
          </div>
        </article>
      {/each}
    </section>
  {/if}

  <footer class="mission-tray">
    <button type="button" class="ghost" on:click={() => (rows = setAllTaskSelection(rows, selectedCount !== rows.length))}>
      {selectedCount === rows.length && rows.length > 0 ? 'Clear' : 'Select all'}
    </button>
    <span><strong>{selectedCount}</strong> selected</span>
    <span>{bulkProvider} / {bulkRole}</span>
    <button type="button" class="launch" disabled={selectedCount === 0 || launching} on:click={launchSelected}>
      {launching ? 'Launching...' : `Launch ${selectedCount}`}
    </button>
  </footer>

  {#if error}<p class="mission-message error">{error}</p>{/if}
  {#if message}<p class="mission-message">{message}</p>{/if}
</div>

<style>
  .mission-node {
    width: 100%;
    height: 100%;
    min-width: 430px;
    min-height: 320px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--mission-color) 54%, rgba(255, 255, 255, 0.28));
    border-radius: 10px;
    background:
      linear-gradient(145deg, color-mix(in srgb, var(--mission-color) 13%, transparent), transparent 42%),
      rgba(4, 10, 11, 0.92);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--mission-color) 18%, transparent) inset,
      0 0 42px color-mix(in srgb, var(--mission-color) 22%, transparent),
      0 24px 58px rgba(0, 0, 0, 0.46);
    color: rgba(239, 255, 250, 0.94);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    backdrop-filter: blur(18px);
  }

  .mission-node.selected {
    border-color: color-mix(in srgb, var(--mission-color) 76%, white 24%);
  }

  .mission-header {
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--mission-color) 28%, rgba(255, 255, 255, 0.12));
  }

  .mission-icon {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--mission-color) 58%, rgba(255, 255, 255, 0.24));
    background: rgba(0, 0, 0, 0.54);
  }

  .mission-icon img {
    width: 34px;
    height: 34px;
    object-fit: contain;
  }

  .mission-header div,
  .mission-row,
  .assign-row,
  .progress-row {
    min-width: 0;
  }

  .mission-header span,
  .mission-header em,
  .mission-tabs button,
  .mission-row em,
  .mission-tray,
  .progress-row span,
  .progress-row small {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .mission-header strong {
    display: block;
    font-size: 18px;
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mission-header small {
    display: block;
    margin-top: 4px;
    color: rgba(239, 255, 250, 0.56);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mission-header em {
    color: color-mix(in srgb, var(--mission-color) 76%, white 24%);
    font-style: normal;
  }

  .mission-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding: 8px 10px;
  }

  button,
  select,
  textarea {
    font: inherit;
  }

  .mission-tabs button,
  .mission-tray button,
  .mission-import button,
  .assign-panel button,
  .progress-actions button {
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.045);
    color: rgba(239, 255, 250, 0.76);
    cursor: pointer;
  }

  .mission-tabs button {
    height: 28px;
  }

  .mission-tabs button.active,
  .mission-tray .launch {
    border-color: color-mix(in srgb, var(--mission-color) 72%, white 18%);
    background: color-mix(in srgb, var(--mission-color) 18%, rgba(255, 255, 255, 0.04));
    color: white;
  }

  .mission-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px 72px;
  }

  .mission-import {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    margin-bottom: 10px;
  }

  .mission-import textarea {
    min-height: 58px;
    resize: vertical;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.34);
    color: white;
    padding: 8px;
  }

  .mission-import div {
    display: grid;
    gap: 6px;
  }

  .mission-sections section,
  .assign-list,
  .progress-summary {
    display: grid;
    gap: 7px;
  }

  .mission-sections h4 {
    display: flex;
    justify-content: space-between;
    margin: 8px 0 6px;
    color: color-mix(in srgb, var(--mission-color) 74%, white 26%);
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .mission-row,
  .assign-row,
  .progress-row,
  .progress-summary span {
    display: grid;
    gap: 8px;
    align-items: center;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.035);
  }

  .mission-row {
    grid-template-columns: 0 18px minmax(0, 1fr) auto;
    padding: 10px;
    cursor: pointer;
  }

  .mission-row input {
    opacity: 0;
    width: 0;
  }

  .check-dot {
    width: 15px;
    height: 15px;
    border: 1px solid rgba(255, 255, 255, 0.26);
    border-radius: 50%;
  }

  .mission-row input:checked + .check-dot {
    border-color: color-mix(in srgb, var(--mission-color) 80%, white 20%);
    background: color-mix(in srgb, var(--mission-color) 54%, transparent);
    box-shadow: 0 0 14px color-mix(in srgb, var(--mission-color) 42%, transparent);
  }

  .mission-row strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mission-row em {
    color: rgba(239, 255, 250, 0.55);
    font-style: normal;
  }

  .assign-panel {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: end;
    padding: 10px;
    margin-bottom: 10px;
    border: 1px solid color-mix(in srgb, var(--mission-color) 42%, rgba(255, 255, 255, 0.18));
    border-radius: 8px;
    background: rgba(2, 21, 17, 0.94);
  }

  .assign-panel label {
    display: grid;
    gap: 4px;
    color: rgba(239, 255, 250, 0.52);
    font-size: 10px;
    text-transform: uppercase;
  }

  .assign-row {
    grid-template-columns: minmax(0, 1fr) minmax(92px, 0.4fr) minmax(104px, 0.45fr);
    padding: 8px;
  }

  .assign-row span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  select {
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.4);
    color: white;
    padding: 6px;
  }

  .progress-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 10px;
  }

  .progress-summary span {
    padding: 9px;
  }

  .progress-summary strong {
    color: color-mix(in srgb, var(--mission-color) 74%, white 26%);
    font-size: 16px;
  }

  .progress-row {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px;
    margin-bottom: 7px;
  }

  .progress-row.failed,
  .progress-row.stale {
    border-color: rgba(243, 139, 168, 0.45);
  }

  .progress-row div:first-child {
    display: grid;
    gap: 4px;
  }

  .progress-row strong {
    overflow-wrap: anywhere;
  }

  .progress-row span,
  .progress-row small {
    color: rgba(239, 255, 250, 0.54);
  }

  .progress-actions {
    display: flex;
    gap: 6px;
  }

  .progress-actions button,
  .mission-tray button,
  .assign-panel button,
  .mission-import button {
    height: 30px;
    padding: 0 9px;
  }

  button:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }

  .mission-tray {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 9px;
    border: 1px solid color-mix(in srgb, var(--mission-color) 45%, rgba(255, 255, 255, 0.16));
    border-radius: 8px;
    background: rgba(1, 18, 14, 0.94);
    box-shadow: 0 0 22px rgba(0, 0, 0, 0.32);
  }

  .mission-tray span {
    color: rgba(239, 255, 250, 0.62);
  }

  .mission-tray strong {
    color: white;
    font-size: 15px;
  }

  .mission-empty,
  .mission-message {
    margin: 8px 0 0;
    color: rgba(239, 255, 250, 0.58);
    font-size: 11px;
  }

  .mission-message {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 57px;
  }

  .mission-message.error {
    color: #f38ba8;
  }
</style>
