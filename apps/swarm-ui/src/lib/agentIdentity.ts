import type {
  AgentDisplayState,
  AgentRuntimeProfile,
  Instance,
  NodeType,
  PtySession,
} from './types';

export type AgentLabelIdentity = {
  provider: string | null;
  role: string | null;
  name: string | null;
  persona: string | null;
  mission: string | null;
  skills: string | null;
  permissions: string | null;
};

export type AgentProviderKind = 'anthropic' | 'openai' | 'local' | 'unknown';

export interface AgentIdentityInput {
  instance: Instance | null;
  ptySession: PtySession | null;
  role: string;
  displayName: string | null;
}

export interface AgentIdentity {
  providerKind: AgentProviderKind;
  providerLabel: string;
  modelLabel: string;
  nameLabel: string;
  roleLabel: string;
}

interface LabelTokens {
  provider: string | null;
  role: string | null;
  name: string | null;
  model: string | null;
}

const IDENTITY_TOKEN_KEYS = [
  'provider',
  'role',
  'name',
  'persona',
  'mission',
  'skills',
  'permissions',
] as const;

type IdentityTokenKey = (typeof IDENTITY_TOKEN_KEYS)[number];

const DEFAULT_CLAUDE_MODEL = 'Claude Opus 4.7';
const DEFAULT_CODEX_MODEL = 'Codex GPT-5.4';

export function deriveAgentIdentity(input: AgentIdentityInput): AgentIdentity {
  const tokens = parseDisplayLabelTokens(input.instance?.label ?? null);
  const providerHint = firstText(
    tokens.provider,
    commandBasename(input.ptySession?.command ?? null),
    input.role,
  );
  const providerKind = deriveProviderKind(providerHint);
  const roleValue = firstText(tokens.role, input.role, providerKind === 'local' ? 'shell' : null);
  const roleLabel = titleCase(roleValue ?? 'Agent');
  const primaryName = firstText(input.displayName, tokens.name, roleValue);
  const nameLabel = primaryName
    ? titleCase(primaryName)
    : input.instance?.id.slice(0, 8) ?? 'Agent';

  return {
    providerKind,
    providerLabel: providerLabel(providerKind),
    modelLabel: modelLabel(providerKind, tokens.model),
    nameLabel,
    roleLabel,
  };
}

export function agentIdentityFromLabel(label: string | null | undefined): AgentLabelIdentity {
  const identity: AgentLabelIdentity = {
    provider: null,
    role: null,
    name: null,
    persona: null,
    mission: null,
    skills: null,
    permissions: null,
  };

  for (const token of (label ?? '').split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = token.split(':');
    const value = rest.join(':');
    if (!isIdentityTokenKey(key) || !value) continue;
    identity[key] = value;
  }

  return identity;
}

export function mergeAgentLabelToken(
  label: string | null | undefined,
  key: string,
  value: string,
): string {
  const tokens = (label ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith(`${key}:`));
  const normalized = normalizeLabelTokenValue(value);
  if (normalized) tokens.push(`${key}:${normalized}`);
  return tokens.join(' ');
}

export function mergeAgentLabelTokens(
  label: string | null | undefined,
  updates: Record<string, string | null | undefined>,
): string {
  const keys = new Set(Object.keys(updates));
  const tokens = (label ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const [key] = token.split(':');
      return !keys.has(key);
    });

  for (const [key, value] of Object.entries(updates)) {
    const normalized = normalizeLabelTokenValue(value ?? '');
    if (normalized) tokens.push(`${key}:${normalized}`);
  }

  return tokens.join(' ');
}

export function normalizeLabelTokenValue(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

export function buildAgentDisplayState(input: {
  nodeType: NodeType;
  instance: Instance | null;
  pty: PtySession | null;
  label: string;
  displayName: string | null;
  runtimeProfile?: AgentRuntimeProfile | null;
  taskCount: number;
  lockCount: number;
  unreadMessages: number;
  listenerLabel: string;
}): AgentDisplayState {
  const identity = agentIdentityFromLabel(input.instance?.label ?? null);
  const runtime = input.runtimeProfile ?? null;
  const role = runtime?.role || identity.role || input.label || fallbackRole(input.nodeType);

  return {
    name:
      runtime?.name ||
      identity.name ||
      input.displayName ||
      fallbackName(input.nodeType, input.instance, input.pty, input.label),
    role,
    provider: identity.provider || inferProvider(input.pty) || 'local',
    persona: runtime?.persona || identity.persona || null,
    mission: runtime?.mission || identity.mission || '',
    skills: runtime?.skills || identity.skills || '',
    permissions: runtime?.permissions || identity.permissions || '',
    taskCount: input.taskCount,
    lockCount: input.lockCount,
    unreadMessages: input.unreadMessages,
    listenerLabel: input.listenerLabel,
  };
}

function isIdentityTokenKey(value: string): value is IdentityTokenKey {
  return (IDENTITY_TOKEN_KEYS as readonly string[]).includes(value);
}

function fallbackRole(nodeType: NodeType): string {
  if (nodeType === 'pty') return 'shell';
  if (nodeType === 'instance') return 'agent';
  return 'operator';
}

function fallbackName(
  nodeType: NodeType,
  instance: Instance | null,
  pty: PtySession | null,
  label: string,
): string {
  if (label) return label;
  if (instance) return instance.id.slice(0, 8);
  if (pty) return pty.command.split('/').pop() || 'Shell';
  return nodeType;
}

function inferProvider(pty: PtySession | null): string | null {
  const command = pty?.command.toLowerCase() ?? '';
  if (command.includes('codex')) return 'codex';
  if (command.includes('claude')) return 'claude';
  if (command.includes('opencode')) return 'opencode';
  return null;
}

function parseDisplayLabelTokens(label: string | null): LabelTokens {
  const tokens: LabelTokens = {
    provider: null,
    role: null,
    name: null,
    model: null,
  };
  if (!label) return tokens;

  for (const token of label.split(/\s+/)) {
    const index = token.indexOf(':');
    if (index <= 0) continue;
    const key = token.slice(0, index);
    const value = token.slice(index + 1);
    if (!value) continue;

    if (key === 'provider') tokens.provider = value;
    if (key === 'role') tokens.role = value;
    if (key === 'name') tokens.name = value;
    if (key === 'model') tokens.model = value;
  }

  return tokens;
}

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function commandBasename(command: string | null): string | null {
  if (!command) return null;
  return command.split(/[\\/]/).pop() ?? command;
}

function deriveProviderKind(value: string | null): AgentProviderKind {
  const lower = value?.toLowerCase() ?? '';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('codex') || lower.includes('openai') || lower.includes('gpt')) return 'openai';
  if (lower.includes('shell') || lower.includes('bash') || lower.includes('zsh')) return 'local';
  return value ? 'unknown' : 'local';
}

function providerLabel(provider: AgentProviderKind): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'local':
      return 'Local';
    case 'unknown':
      return 'Agent';
  }
}

function modelLabel(provider: AgentProviderKind, explicitModel: string | null): string {
  if (explicitModel) {
    const formatted = formatModelName(explicitModel);
    if (provider === 'openai' && !formatted.toLowerCase().startsWith('codex')) {
      return `Codex ${formatted}`;
    }
    return formatted;
  }

  switch (provider) {
    case 'anthropic':
      return DEFAULT_CLAUDE_MODEL;
    case 'openai':
      return DEFAULT_CODEX_MODEL;
    case 'local':
      return 'Local Shell';
    case 'unknown':
      return 'Agent Runtime';
  }
}

function formatModelName(value: string): string {
  const parts = value
    .split(/[-_\s]+/)
    .filter(Boolean);

  if (parts[0]?.toLowerCase() === 'gpt' && parts.length > 1) {
    let index = 1;
    const versionParts: string[] = [];
    while (index < parts.length && /^\d+(?:\.\d+)?$/.test(parts[index])) {
      versionParts.push(parts[index]);
      index += 1;
    }
    const version = versionParts.join('.');
    const suffix = parts.slice(index).map(formatModelPart).join(' ');
    return `GPT-${version}${suffix ? ` ${suffix}` : ''}`;
  }

  return parts
    .map(formatModelPart)
    .join(' ')
    .replace(/\b(\d+) (\d+)\b/g, '$1.$2');
}

function formatModelPart(part: string): string {
  const upper = part.toUpperCase();
  if (upper === 'GPT' || upper === 'AI') return upper;
  if (/^\d+(?:\.\d+)+$/.test(part)) return part;
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
