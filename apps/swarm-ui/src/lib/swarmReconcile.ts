import type { Annotation, Instance, Lock, Message, Task } from './types';

export interface SwarmLocalState {
  instances: Map<string, Instance>;
  tasks: Map<string, Task>;
  messages: Message[];
  locks: Lock[];
  annotations: Annotation[];
}

export interface SwarmLocalReconcileResult extends SwarmLocalState {
  removedInstanceIds: string[];
  changed: boolean;
}

function normalizedInstanceIds(instanceIds: Iterable<string>): string[] {
  return [...new Set([...instanceIds].map((id) => id.trim()).filter(Boolean))].sort();
}

function releaseTaskForRemovedInstance(task: Task, targets: Set<string>): Task {
  if (!task.assignee || !targets.has(task.assignee)) return task;
  if (task.status === 'claimed' || task.status === 'in_progress') {
    return { ...task, assignee: null, status: 'open' };
  }
  if (task.status === 'blocked' || task.status === 'approval_required') {
    return { ...task, assignee: null };
  }
  return task;
}

export function reconcileLocalInstanceRemoval(
  state: SwarmLocalState,
  instanceIds: Iterable<string>,
): SwarmLocalReconcileResult {
  const removedInstanceIds = normalizedInstanceIds(instanceIds);
  if (removedInstanceIds.length === 0) {
    return { ...state, removedInstanceIds, changed: false };
  }

  const targets = new Set(removedInstanceIds);
  const instances = new Map(state.instances);
  let changed = false;
  for (const id of targets) {
    if (instances.delete(id)) changed = true;
  }

  const tasks = new Map<string, Task>();
  for (const [id, task] of state.tasks) {
    const next = releaseTaskForRemovedInstance(task, targets);
    if (next !== task) changed = true;
    tasks.set(id, next);
  }

  const messages = state.messages.filter((message) => !targets.has(message.recipient ?? ''));
  if (messages.length !== state.messages.length) changed = true;

  const locks = state.locks.filter((lock) => !targets.has(lock.instance_id));
  if (locks.length !== state.locks.length) changed = true;

  const annotations = state.annotations.filter(
    (annotation) => !(annotation.type === 'lock' && targets.has(annotation.instance_id)),
  );
  if (annotations.length !== state.annotations.length) changed = true;

  return {
    instances,
    tasks,
    messages,
    locks,
    annotations,
    removedInstanceIds,
    changed,
  };
}
