// =============================================================================
// lib/persona.ts — Per-agent emoji persona helpers
//
// Each agent (Instance) gets an emoji persona that shows on the node and in
// chat so the user can tell at a glance which agent is speaking. The persona
// is persisted inside the existing `instances.label` free-form string as a
// comma-token `persona:<emoji>` entry, alongside the existing `name:`,
// `role:`, `provider:` tokens. No schema migration needed.
//
// Default resolution order:
//   1. Explicit `persona:<emoji>` token in the instance label
//   2. Role-based default from DEFAULT_PERSONAS_BY_ROLE (planner → 🦉, …)
//   3. Final fallback: 🤖
//
// Setter writes the new token by:
//   1. Splitting the existing label on whitespace
//   2. Removing any existing `persona:*` token
//   3. Appending `persona:<emoji>`
//   4. Calling the `ui_set_instance_label` Tauri command to persist
// =============================================================================

import { invoke } from '@tauri-apps/api/core';
import type { Instance } from './types';
import { mergeAgentLabelToken } from './agentIdentity';

/**
 * Full list of pickable emojis shown in the persona picker. 24 entries,
 * matching the mock's `.persona-menu` 6-column 4-row grid. First column
 * of each row is the name used as the button's `title` attribute.
 */
export const PERSONA_POOL: ReadonlyArray<{ emoji: string; name: string }> = [
  { emoji: '🦉', name: 'Planner' },
  { emoji: '🧭', name: 'Scout' },
  { emoji: '👷🏻‍♂️', name: 'Builder' },
  { emoji: '🔬', name: 'Researcher' },
  { emoji: '🛠️', name: 'Engineer' },
  { emoji: '🧪', name: 'Tester' },
  { emoji: '🎨', name: 'Designer' },
  { emoji: '📐', name: 'Architect' },
  { emoji: '🕵️', name: 'Investigator' },
  { emoji: '📚', name: 'Archivist' },
  { emoji: '⚙️', name: 'Ops' },
  { emoji: '🤖', name: 'Automation' },
  { emoji: '🧠', name: 'Analyst' },
  { emoji: '📡', name: 'Signal' },
  { emoji: '🔐', name: 'Security' },
  { emoji: '🚀', name: 'Launcher' },
  { emoji: '🗺️', name: 'Cartographer' },
  { emoji: '🧮', name: 'Math' },
  { emoji: '🧰', name: 'Toolsmith' },
  { emoji: '🦾', name: 'Agent' },
  { emoji: '🪄', name: 'Wizard' },
  { emoji: '🔮', name: 'Oracle' },
  { emoji: '🦊', name: 'Fox' },
  { emoji: '🐺', name: 'Wolf' },
];

/**
 * Role → default emoji. Matched against the lowercased role string with
 * `includes()` semantics so "implementer", "implement", "shell-only" all
 * route correctly. Order matters for overlapping substrings — more specific
 * checks come first.
 */
const ROLE_DEFAULT_MATCHERS: ReadonlyArray<{ match: (r: string) => boolean; emoji: string }> = [
  { match: (r) => r.includes('planner'), emoji: '🦉' },
  { match: (r) => r.includes('implement'), emoji: '👷🏻‍♂️' },
  { match: (r) => r.includes('review'), emoji: '🧪' },
  { match: (r) => r.includes('research'), emoji: '🔬' },
  { match: (r) => r.includes('design'), emoji: '🎨' },
  { match: (r) => r.includes('architect'), emoji: '📐' },
  { match: (r) => r.includes('security'), emoji: '🔐' },
  { match: (r) => r.includes('shell') || r === '$shell', emoji: '💻' },
];

const FALLBACK_PERSONA = '🤖';

/** Fixed persona for non-agent chat senders. */
export const OPERATOR_PERSONA = '🎮';
export const SYSTEM_PERSONA = '⚙️';

/** Extract the `persona:` token value from a label string, or null. */
export function parsePersonaFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const token of label.split(/\s+/)) {
    if (token.startsWith('persona:')) {
      const value = token.slice('persona:'.length);
      if (value) return value;
    }
  }
  return null;
}

/**
 * Extract the `role:` token value from a label string. Duplicated from
 * parseNameFromLabel/parseHarnessFromLabel elsewhere — keeping a local copy
 * avoids a cross-file import just for this one field.
 */
function parseRoleFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const token of label.split(/\s+/)) {
    if (token.startsWith('role:')) {
      const value = token.slice('role:'.length);
      if (value) return value;
    }
  }
  return null;
}

/** Resolve the default emoji for a given role string (case-insensitive). */
export function defaultPersonaForRole(role: string | null | undefined): string {
  if (!role) return FALLBACK_PERSONA;
  const lower = role.toLowerCase();
  for (const matcher of ROLE_DEFAULT_MATCHERS) {
    if (matcher.match(lower)) return matcher.emoji;
  }
  return FALLBACK_PERSONA;
}

/**
 * Final persona resolver: explicit token → role default → fallback.
 * Accepts a partial Instance (just needs `label`) so callers can resolve
 * for any row in a snapshot without an extra DB lookup.
 */
export function personaForInstance(
  instance: Pick<Instance, 'label'> | null | undefined,
): string {
  if (!instance) return FALLBACK_PERSONA;
  const explicit = parsePersonaFromLabel(instance.label ?? null);
  if (explicit) return explicit;
  return defaultPersonaForRole(parseRoleFromLabel(instance.label ?? null));
}

/**
 * Resolve the persona for a chat sender. `senderId` may be an instance id
 * (matched against the `instancesById` map), an `operator:<scope>` synthetic
 * sender, `system`, or an unknown string (falls back to 🤖).
 */
export function personaForSender(
  senderId: string | null | undefined,
  instancesById: Map<string, Instance>,
): string {
  if (!senderId) return FALLBACK_PERSONA;
  if (senderId === 'system') return SYSTEM_PERSONA;
  if (senderId.startsWith('operator:')) return OPERATOR_PERSONA;
  const instance = instancesById.get(senderId);
  if (instance) return personaForInstance(instance);
  return FALLBACK_PERSONA;
}

/**
 * Rewrite a label string so it has exactly one `persona:<emoji>` token at
 * the end. Preserves all other tokens in their original order. Used before
 * calling the Tauri set-label command.
 */
export function rewriteLabelWithPersona(
  existingLabel: string | null | undefined,
  emoji: string,
): string {
  return mergeAgentLabelToken(existingLabel, 'persona', emoji);
}

/**
 * Persist a new persona emoji for the given instance. Invokes the
 * `ui_set_instance_label` Tauri command with the rewritten label. The
 * swarm watcher will emit an `swarm:update` shortly after, which refreshes
 * the Svelte stores and re-renders everything tagged with this instance
 * id — no manual local mutation needed here.
 */
export async function setPersonaForInstance(
  instance: Instance,
  emoji: string,
): Promise<void> {
  const nextLabel = rewriteLabelWithPersona(instance.label ?? null, emoji);
  await invoke<boolean>('ui_set_instance_label', {
    instanceId: instance.id,
    label: nextLabel,
  });
}
