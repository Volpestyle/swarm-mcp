import type { SwarmNodeData, Task } from './types';
import { formatTimestamp } from './time';

const ANSI_PATTERN = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))|(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b[()][A-Za-z0-9])/g;

export function terminalBufferToText(buffer: Uint8Array): string {
  if (buffer.length === 0) return '';
  return new TextDecoder()
    .decode(buffer)
    .replace(ANSI_PATTERN, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd();
}

export function buildAgentCopyAllText(
  data: SwarmNodeData,
  terminalText: string,
  capturedAt: Date = new Date(),
): string {
  const instance = data.instance;
  const pty = data.ptySession;
  const display = data.agentDisplay;
  const configRows: [string, string][] = [
    ['Captured', capturedAt.toISOString()],
    ['Name', data.displayName || display.name || ''],
    ['Role', display.role || data.label || ''],
    ['Provider', display.provider || ''],
    ['Status', data.status],
    ['Listener', data.listenerHealth.detail || data.listenerHealth.label],
    ['Node type', data.nodeType],
    ['Instance id', instance?.id ?? ''],
    ['PTY id', pty?.id ?? ''],
    ['Command', pty?.command ?? ''],
    ['Working directory', pty?.cwd || instance?.directory || ''],
    ['Scope', instance?.scope ?? ''],
    ['PID', instance?.pid === undefined ? '' : String(instance.pid)],
    ['Label', instance?.label ?? ''],
    ['Adopted', instance ? String(Boolean(instance.adopted)) : ''],
    ['Unread messages', String(data.unreadMessages)],
    ['Project', data.project?.name ?? ''],
    ['Mobile lease', data.mobileLeaseHolder ?? ''],
  ];

  return [
    '# Agent Copy All',
    '',
    '## Agent Config',
    ...configRows.map(([label, value]) => `${label}: ${value || 'n/a'}`),
    '',
    '## Assigned Tasks',
    taskLines(data.assignedTasks),
    '',
    '## Requested Tasks',
    taskLines(data.requestedTasks),
    '',
    '## Locks',
    data.locks.length > 0
      ? data.locks.map((lock) => `- ${lock.file}`).join('\n')
      : '- none',
    '',
    '## Runtime Terminal Text',
    terminalText.trim() || '[no terminal text captured]',
  ].join('\n');
}

function taskLines(tasks: Task[]): string {
  if (tasks.length === 0) return '- none';
  return tasks.map((task) => {
    const updated = task.updated_at ? ` updated ${formatTimestamp(task.updated_at)}` : '';
    return `- [${task.status}] ${task.title} (${task.id})${updated}`;
  }).join('\n');
}
