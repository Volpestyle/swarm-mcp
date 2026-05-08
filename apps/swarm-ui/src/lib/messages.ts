// =============================================================================
// messages.ts — small utilities for classifying messages
//
// Keeps the system/peer distinction in one place so the Inspector and the
// edge packet renderer agree on what counts as a system event.
// =============================================================================

import type { Message } from './types';

/**
 * True for swarm-internal events the user shouldn't read as peer chat:
 * - sender === 'system' (registry prune broadcasts, etc.)
 * - content starts with `[auto]` (auto-release notifications)
 * - content starts with `[signal:` (planner/agent signals)
 */
export function isSystemMessage(msg: Pick<Message, 'sender' | 'content'>): boolean {
  if (msg.sender === 'system') return true;
  if (msg.content.startsWith('[auto]')) return true;
  if (msg.content.startsWith('[signal:')) return true;
  return false;
}
