import anthropicLogoUrl from '../assets/anthropic-logo.png';
import nousLogoUrl from '../assets/nous-logo.png';
import openAiLogoUrl from '../assets/openai-old-logo.png';
import openClawLogoUrl from '../assets/openclaw-logo.jpg';

export type AgentProviderId = 'openclaw' | 'codex' | 'claude' | 'hermes' | 'opencode';

export interface AgentProviderChoice {
  id: AgentProviderId | string;
  harness: string;
  label: string;
  company: string;
  command: string;
  logoUrl: string | null;
  logoAlt: string;
  accent: string;
  gradient: string;
  aura: string;
  brandLine: string;
  signal: string;
  summary: string;
}

export const PRIMARY_AGENT_PROVIDER_CHOICES: AgentProviderChoice[] = [
  {
    id: 'openclaw',
    harness: 'openclaw',
    label: 'OpenClaw',
    company: 'OpenClaw',
    command: 'openclaw chat',
    logoUrl: openClawLogoUrl,
    logoAlt: 'OpenClaw logo',
    accent: '#ff6b4a',
    gradient: 'linear-gradient(145deg, rgba(255, 107, 74, 0.28), rgba(89, 38, 255, 0.14) 52%, rgba(9, 13, 26, 0.9))',
    aura: 'rgba(255, 107, 74, 0.42)',
    brandLine: 'Local orchestration runtime with claw-on-the-glass presence.',
    signal: 'Runtime-first',
    summary: 'OpenClaw local terminal UI through the embedded runtime.',
  },
  {
    id: 'codex',
    harness: 'codex',
    label: 'OpenAI Codex',
    company: 'OpenAI',
    command: 'codex',
    logoUrl: openAiLogoUrl,
    logoAlt: 'OpenAI Codex logo',
    accent: '#10a37f',
    gradient: 'linear-gradient(145deg, rgba(16, 163, 127, 0.26), rgba(57, 118, 255, 0.12) 54%, rgba(8, 16, 22, 0.92))',
    aura: 'rgba(16, 163, 127, 0.38)',
    brandLine: 'Terminal coding agent wired for fast repo moves.',
    signal: 'Code engine',
    summary: 'Terminal coding agent with the swarm MCP prewired.',
  },
  {
    id: 'claude',
    harness: 'claude',
    label: 'Claude Code',
    company: 'Anthropic',
    command: 'claude',
    logoUrl: anthropicLogoUrl,
    logoAlt: 'Anthropic Claude Code logo',
    accent: '#d97757',
    gradient: 'linear-gradient(145deg, rgba(217, 119, 87, 0.28), rgba(244, 214, 170, 0.1) 48%, rgba(18, 12, 10, 0.92))',
    aura: 'rgba(217, 119, 87, 0.4)',
    brandLine: 'Careful reasoning lane with strong handoff discipline.',
    signal: 'Reasoning lane',
    summary: 'Claude Code terminal session with swarm bootstrap.',
  },
  {
    id: 'opencode',
    harness: 'opencode',
    label: 'OpenCode',
    company: 'OpenCode',
    command: 'opencode',
    logoUrl: null,
    logoAlt: 'OpenCode logo',
    accent: '#7dd3fc',
    gradient: 'linear-gradient(145deg, rgba(125, 211, 252, 0.26), rgba(45, 90, 255, 0.14) 52%, rgba(5, 12, 26, 0.94))',
    aura: 'rgba(125, 211, 252, 0.38)',
    brandLine: 'OpenCode terminal agent for alternate coding lanes.',
    signal: 'Open lane',
    summary: 'OpenCode TUI with swarm registration guidance.',
  },
  {
    id: 'hermes',
    harness: 'hermes',
    label: 'Hermes / Nous',
    company: 'Nous Research',
    command: 'hermes --tui',
    logoUrl: nousLogoUrl,
    logoAlt: 'Nous Research Hermes logo',
    accent: '#ffd84f',
    gradient: 'linear-gradient(145deg, rgba(255, 216, 79, 0.28), rgba(185, 110, 44, 0.16) 52%, rgba(9, 9, 10, 0.94))',
    aura: 'rgba(255, 216, 79, 0.42)',
    brandLine: 'Gold-on-glass Hermes Agent TUI for open-model exploration.',
    signal: 'Hermes TUI',
    summary: 'Nous Hermes Agent TUI through the embedded terminal.',
  },
];

export function agentProviderChoiceForHarness(
  harness: string | null | undefined,
): AgentProviderChoice | null {
  const normalized = harness?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  const firstToken = normalized.split(/\s+/)[0] ?? normalized;
  const alias: Record<string, string> = {
    anthropic: 'claude',
    gpt: 'codex',
    nous: 'hermes',
    'nous-research': 'hermes',
    openai: 'codex',
    opencode: 'opencode',
    'open-code': 'opencode',
  };
  const canonical = normalized.includes('open code')
    ? 'opencode'
    : alias[normalized] ?? alias[firstToken] ?? firstToken;
  return PRIMARY_AGENT_PROVIDER_CHOICES.find((choice) =>
    choice.id === canonical || choice.harness === canonical
  ) ?? null;
}

export function providerLogoForProvider(provider: string | null | undefined): string | null {
  const normalized = provider?.trim().toLowerCase() ?? '';
  if (!normalized) return null;
  if (normalized.includes('codex') || normalized.includes('openai') || normalized.includes('gpt')) {
    return openAiLogoUrl;
  }
  if (normalized.includes('claude') || normalized.includes('anthropic')) {
    return anthropicLogoUrl;
  }
  if (normalized.includes('hermes') || normalized.includes('nous')) {
    return nousLogoUrl;
  }
  if (normalized.includes('openclaw')) {
    return openClawLogoUrl;
  }
  if (normalized.includes('opencode') || normalized.includes('open-code') || normalized.includes('open code')) {
    return null;
  }
  return null;
}
