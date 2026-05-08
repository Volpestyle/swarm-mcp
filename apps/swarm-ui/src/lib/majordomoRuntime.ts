import type { Instance, ProjectSpace, PtySession } from './types';

export type MajordomoRuntimeState =
  | 'offline'
  | 'launching'
  | 'online'
  | 'blocked'
  | 'stale'
  | 'timeout-soon'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type MajordomoHarnessRuntime = {
  harness: 'hermes';
  command: string;
  model: string | null;
  provider: string | null;
  sourceTag: 'swarm-ui-majordomo';
  cleanupPolicy: 'stop-on-app-close' | 'leave-running-visible';
};

export type MajordomoRuntimeMatch = {
  instance: Instance | null;
  pty: PtySession | null;
  state: MajordomoRuntimeState;
  ghost: boolean;
};

const SOURCE_TAG = 'swarm-ui-majordomo';
const DEFAULT_HERMES_BIN = '/Users/mathewfrazier/.local/bin/Hermes';

function labelIncludes(label: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(token)}($|\\s)`).test(label ?? '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isRuntimeMajordomo(instance: Instance, project: ProjectSpace | null): boolean {
  const label = instance.label ?? '';
  const roleMatch = labelIncludes(label, 'role:majordomo');
  const ownerMatch = labelIncludes(label, 'owner:majordomo');
  const hasProjectToken = /(^|\s)project:[^\s]+($|\s)/.test(label);
  const projectMatch = project
    ? hasProjectToken
      ? labelIncludes(label, `project:${project.id}`)
      : instance.directory === project.root
    : true;
  return roleMatch && ownerMatch && projectMatch;
}

export function buildMajordomoRuntimeLabel(project: ProjectSpace, timeoutMinutes: number): string {
  return [
    'role:majordomo',
    'owner:majordomo',
    'runtime_ai_assistant:true',
    `project:${project.id}`,
    `timeout_m:${Math.max(1, Math.round(timeoutMinutes))}`,
    `source:${SOURCE_TAG}`,
  ].join(' ');
}

export function buildHermesMajordomoCommand(input: {
  model?: string | null;
  provider?: string | null;
  executable?: string;
} = {}): string {
  const parts = [
    input.executable?.trim() || DEFAULT_HERMES_BIN,
    '--tui',
    '--source',
    SOURCE_TAG,
  ];
  if (input.model?.trim()) {
    parts.push('--model', shellToken(input.model.trim()));
  }
  if (input.provider?.trim()) {
    parts.push('--provider', shellToken(input.provider.trim()));
  }
  return parts.join(' ');
}

export function defaultHermesMajordomoRuntime(input: {
  model?: string | null;
  provider?: string | null;
  cleanupPolicy?: MajordomoHarnessRuntime['cleanupPolicy'];
} = {}): MajordomoHarnessRuntime {
  const model = input.model?.trim() || null;
  const provider = input.provider?.trim() || null;
  return {
    harness: 'hermes',
    command: buildHermesMajordomoCommand({ model, provider }),
    model,
    provider,
    sourceTag: SOURCE_TAG,
    cleanupPolicy: input.cleanupPolicy ?? 'stop-on-app-close',
  };
}

export function buildMajordomoBootstrapInstructions(input: {
  sourceRoot: string;
  project: ProjectSpace | null;
  learningRoot?: string;
}): string {
  const sourceRoot = input.sourceRoot.replace(/\/+$/, '');
  const learningRoot = input.learningRoot
    ?? '/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution';
  return [
    'You are the visible swarm-ui Majordomo runtime assistant.',
    `Project: ${input.project?.name ?? 'current canvas'} (${input.project?.root ?? sourceRoot})`,
    '',
    'Read these startup context files before making claims:',
    `${sourceRoot}/docs/CURRENT_APP_FEATURES.md`,
    `${sourceRoot}/docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md`,
    `${sourceRoot}/docs/superpowers/plans/2026-05-08-majordomo-visual-proof-and-learning.md`,
    `${learningRoot}/README.md`,
    `${learningRoot}/action-items/open.md`,
    `${sourceRoot}/apps/swarm-ui/src/stores/pty.ts`,
    `${sourceRoot}/apps/swarm-ui/src-tauri/src/launch.rs`,
    `${sourceRoot}/apps/swarm-ui/src/panels/MajordomoArchitect.svelte`,
    '',
    'Responsibilities:',
    '- answer feature, version, runpath, and proof-level questions',
    '- guide the operator to app surfaces instead of inventing hidden controls',
    '- interpret issue captures and feed them into closeout questions',
    '- generate adaptive closeout questions while deterministic fallback stays visible',
    '- use swarm MCP or CLI channels when available to inspect state and communicate',
    '- stay visible, source-tagged, killable, and honest about cleanup',
    '- never claim proof without visual, semantic, native-command, or explicit limitation evidence',
  ].join('\n');
}

export function resolveMajordomoRuntime(input: {
  instances: Instance[];
  ptySessions: PtySession[];
  bindings: Array<[string, string]>;
  project: ProjectSpace | null;
  launchRequested: boolean;
}): MajordomoRuntimeMatch {
  const instance = input.instances.find((candidate) => isRuntimeMajordomo(candidate, input.project)) ?? null;
  const ptyId = instance
    ? input.bindings.find(([instanceId]) => instanceId === instance.id)?.[1] ?? null
    : null;
  const pty = ptyId
    ? input.ptySessions.find((session) => session.id === ptyId) ?? null
    : null;
  const ghost = input.launchRequested && !instance && !pty;
  let state: MajordomoRuntimeState = 'offline';
  if (ghost) state = 'failed';
  else if (!instance && input.launchRequested) state = 'launching';
  else if (instance?.status === 'online') state = 'online';
  else if (instance?.status === 'stale') state = 'stale';
  else if (instance?.status === 'offline') state = 'blocked';
  return { instance, pty, state, ghost };
}

export function structureMajordomoIdeaDump(input: string): string[] {
  return input
    .split(/[.!?\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function majordomoClarificationChoices(input: string): string[] {
  const lower = input.toLowerCase();
  const choices = ['implement now', 'add to plan', 'create learning item'];
  if (lower.includes('why') || lower.includes('research')) choices.splice(1, 0, 'research first');
  if (lower.includes('agent') || lower.includes('swarm')) choices.push('launch a swarm');
  return choices;
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9._:/=-]+$/.test(value)
    ? value
    : `'${value.split("'").join("'\\''")}'`;
}
