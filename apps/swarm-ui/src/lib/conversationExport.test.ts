import { describe, expect, it } from 'bun:test';

import { formatConversationMarkdown } from './conversationExport';
import type { Instance, Message } from './types';

const baseInstance: Instance = {
  id: 'planner-1',
  scope: '/repo#overhaul',
  directory: '/repo',
  root: '/repo',
  file_root: '/repo',
  pid: 123,
  label: 'name:Orchestrator_Codex role:planner provider:codex',
  registered_at: 1,
  heartbeat: 2,
  status: 'online',
  adopted: true,
};

function msg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? 1,
    scope: partial.scope ?? '/repo#overhaul',
    sender: partial.sender ?? 'operator:/repo#overhaul',
    recipient: partial.recipient ?? 'planner-1',
    content: partial.content ?? 'hello',
    created_at: partial.created_at ?? 1777696925,
    read: partial.read ?? false,
  };
}

describe('formatConversationMarkdown', () => {
  it('exports visible conversation messages as compact markdown', () => {
    const markdown = formatConversationMarkdown({
      scope: '/repo#overhaul',
      messages: [
        msg({ id: 1, content: 'Can you check this?' }),
        msg({
          id: 2,
          sender: 'planner-1',
          recipient: 'operator:/repo#overhaul',
          content: 'Yes. I am checking scope handling.',
        }),
      ],
      instances: new Map([[baseInstance.id, baseInstance]]),
    });

    expect(markdown).toContain('# Swarm Conversation');
    expect(markdown).toContain('Scope: `/repo#overhaul`');
    expect(markdown).toContain('You -> Orchestrator_Codex');
    expect(markdown).toContain('Orchestrator_Codex -> You');
    expect(markdown).toContain('Can you check this?');
  });
});
