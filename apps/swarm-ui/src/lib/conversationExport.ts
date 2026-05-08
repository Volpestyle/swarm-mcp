import type { Instance, Message } from './types';

export interface ConversationExportInput {
  scope: string | null;
  messages: Message[];
  instances: Map<string, Instance>;
}

function labelFor(id: string | null | undefined, instances: Map<string, Instance>): string {
  if (!id) return 'all';
  if (id.startsWith('operator:')) return 'You';
  if (id === 'system') return 'system';
  const instance = instances.get(id);
  const name = instance?.label?.match(/name:([^\s,]+)/)?.[1];
  if (name) return name;
  const role = instance?.label?.match(/role:([^\s,]+)/)?.[1];
  if (role) return `${role}:${id.slice(0, 6)}`;
  return id.slice(0, 8);
}

function formatDate(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown time';
  return new Date(seconds * 1000).toISOString();
}

export function formatConversationMarkdown(input: ConversationExportInput): string {
  const scope = input.scope?.trim() || 'no active scope';
  const lines = [
    '# Swarm Conversation',
    '',
    `Scope: \`${scope}\``,
    `Exported: ${new Date().toISOString()}`,
    '',
  ];

  if (input.messages.length === 0) {
    lines.push('_No visible messages._');
    return lines.join('\n');
  }

  for (const message of input.messages) {
    lines.push(
      `## ${labelFor(message.sender, input.instances)} -> ${labelFor(message.recipient, input.instances)} · ${formatDate(message.created_at)}`,
      '',
      message.content,
      '',
    );
  }

  return lines.join('\n').trimEnd();
}
