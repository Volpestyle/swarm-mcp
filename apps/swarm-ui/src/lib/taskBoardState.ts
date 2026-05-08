import type { InstanceStatus } from './types';

export type TaskBoardLaunchStatus = 'not_launched' | 'launching' | 'launched' | 'failed';
export type TaskBoardRuntimeState = 'idle' | 'launching' | 'launched' | 'failed' | 'stale';

export interface TaskBoardRowRuntimeInput {
  assignee?: string;
  launchError?: string;
  launchInstanceId?: string;
  launchPtyId?: string;
  launchStatus: TaskBoardLaunchStatus;
  listenerState?: string;
}

export interface TaskBoardInstanceRuntimeInput {
  id: string;
  status: InstanceStatus;
}

export interface TaskBoardRowRuntimeState {
  instanceId: string;
  instanceStatus: InstanceStatus | 'missing' | '';
  launchError: string;
  listenerState: string;
  state: TaskBoardRuntimeState;
  stale: boolean;
}

function clean(value?: string): string {
  return value?.trim() ?? '';
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

export function taskBoardRowInstanceId(row: TaskBoardRowRuntimeInput): string {
  const launchInstanceId = clean(row.launchInstanceId);
  if (launchInstanceId) return launchInstanceId;

  const assignee = clean(row.assignee);
  if (!assignee || assignee.startsWith('pty:')) return '';
  return assignee;
}

export function resolveTaskBoardRowRuntime(
  row: TaskBoardRowRuntimeInput,
  instances: TaskBoardInstanceRuntimeInput[],
): TaskBoardRowRuntimeState {
  const listenerState = clean(row.listenerState);
  const launchError = clean(row.launchError);
  const instanceId = taskBoardRowInstanceId(row);

  if (row.launchStatus === 'launching') {
    return {
      instanceId,
      instanceStatus: '',
      launchError,
      listenerState: listenerState || 'launching',
      state: 'launching',
      stale: false,
    };
  }

  if (row.launchStatus === 'failed') {
    return {
      instanceId,
      instanceStatus: '',
      launchError,
      listenerState: listenerState || 'launch failed',
      state: 'failed',
      stale: false,
    };
  }

  if (row.launchStatus !== 'launched') {
    return {
      instanceId,
      instanceStatus: '',
      launchError,
      listenerState: listenerState || 'not launched',
      state: 'idle',
      stale: false,
    };
  }

  if (!instanceId) {
    const ptyId = clean(row.launchPtyId);
    if (ptyId) {
      return {
        instanceId,
        instanceStatus: '',
        launchError,
        listenerState: listenerState || 'pty launched, awaiting agent adoption',
        state: 'launched',
        stale: false,
      };
    }

    return {
      instanceId,
      instanceStatus: 'missing',
      launchError: launchError || 'Launched row has no agent or PTY identity.',
      listenerState: 'stale - missing launch identity',
      state: 'stale',
      stale: true,
    };
  }

  const instance = instances.find((entry) => entry.id === instanceId);
  if (!instance) {
    return {
      instanceId,
      instanceStatus: 'missing',
      launchError: launchError || `Launched instance ${shortId(instanceId)} is missing from live swarm state.`,
      listenerState: `stale - missing ${shortId(instanceId)}`,
      state: 'stale',
      stale: true,
    };
  }

  if (instance.status !== 'online') {
    return {
      instanceId,
      instanceStatus: instance.status,
      launchError: launchError || `Launched instance ${shortId(instanceId)} is ${instance.status}.`,
      listenerState: `stale - ${instance.status}`,
      state: 'stale',
      stale: true,
    };
  }

  return {
    instanceId,
    instanceStatus: instance.status,
    launchError,
    listenerState: listenerState || 'online listener',
    state: 'launched',
    stale: false,
  };
}

export function canRetryTaskBoardRow(row: TaskBoardRowRuntimeInput, instances: TaskBoardInstanceRuntimeInput[]): boolean {
  const runtime = resolveTaskBoardRowRuntime(row, instances);
  return runtime.state === 'failed' || runtime.state === 'stale';
}
