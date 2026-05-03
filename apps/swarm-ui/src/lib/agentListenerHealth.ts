import type { Event, Instance, Task } from './types';

export type AgentListenerHealthStatus =
  | 'unregistered'
  | 'scope_mismatch'
  | 'offline'
  | 'adopting'
  | 'needs_poll'
  | 'working'
  | 'listening'
  | 'polled'
  | 'unknown';

export interface AgentListenerHealth {
  status: AgentListenerHealthStatus;
  label: string;
  detail: string;
  lastPollAt: number | null;
  lastWaitAt: number | null;
  lastWaitReturnAt: number | null;
  unreadMessages: number;
  activeTaskCount: number;
}

export interface AgentListenerHealthInput {
  instance: Instance | null;
  activeScope: string | null;
  unreadMessages: number;
  assignedTasks: Task[];
  events: Event[];
}

export function deriveAgentListenerHealth(
  input: AgentListenerHealthInput,
): AgentListenerHealth {
  const activeTaskCount = input.assignedTasks.filter(isActiveTask).length;
  const lastPollAt = latestEventAt(input.events, input.instance?.id ?? null, 'agent.polled');
  const lastWaitAt = latestEventAt(input.events, input.instance?.id ?? null, 'agent.waiting');
  const lastWaitReturnAt = latestEventAt(
    input.events,
    input.instance?.id ?? null,
    'agent.wait_returned',
  );

  const base = {
    lastPollAt,
    lastWaitAt,
    lastWaitReturnAt,
    unreadMessages: input.unreadMessages,
    activeTaskCount,
  };

  if (!input.instance) {
    return {
      ...base,
      status: 'unregistered',
      label: 'Register needed',
      detail: 'PTY is visible, but no swarm instance has adopted it yet.',
    };
  }

  if (input.activeScope !== null && input.instance.scope !== input.activeScope) {
    return {
      ...base,
      status: 'scope_mismatch',
      label: 'Scope mismatch',
      detail: `Registered in ${input.instance.scope}, not ${input.activeScope}.`,
    };
  }

  if (input.instance.status !== 'online') {
    return {
      ...base,
      status: 'offline',
      label: input.instance.status === 'stale' ? 'Stale' : 'Offline',
      detail: 'Heartbeat is not current; this agent may not consume swarm work.',
    };
  }

  if (!input.instance.adopted) {
    return {
      ...base,
      status: 'adopting',
      label: 'Adopting',
      detail: 'The UI has pre-created this row; the child process has not adopted it yet.',
    };
  }

  if (input.unreadMessages > 0) {
    return {
      ...base,
      status: 'needs_poll',
      label: 'Needs poll',
      detail: `${input.unreadMessages} unread swarm message${
        input.unreadMessages === 1 ? '' : 's'
      } still waiting for this agent.`,
    };
  }

  if (activeTaskCount > 0) {
    return {
      ...base,
      status: 'working',
      label: 'Working',
      detail: `${activeTaskCount} active task${activeTaskCount === 1 ? '' : 's'} assigned.`,
    };
  }

  if (lastWaitAt !== null && (lastWaitReturnAt === null || lastWaitAt >= lastWaitReturnAt)) {
    return {
      ...base,
      status: 'listening',
      label: 'Listening',
      detail: 'Agent has entered wait_for_activity and should react to new swarm changes.',
    };
  }

  if (lastPollAt !== null) {
    return {
      ...base,
      status: 'polled',
      label: 'Polled',
      detail: 'Agent has recently called poll_messages.',
    };
  }

  return {
    ...base,
    status: 'unknown',
    label: 'Unverified',
    detail: 'No poll_messages or wait_for_activity audit event has been observed yet.',
  };
}

function isActiveTask(task: Task): boolean {
  return task.status === 'claimed' || task.status === 'in_progress';
}

function latestEventAt(events: Event[], instanceId: string | null, type: string): number | null {
  if (!instanceId) return null;
  let latest: number | null = null;
  for (const event of events) {
    if (event.type !== type) continue;
    if (event.actor !== instanceId && event.subject !== instanceId) continue;
    if (latest === null || event.created_at > latest) {
      latest = event.created_at;
    }
  }
  return latest;
}
