export interface SkillSuggestion {
  id: string;
  label: string;
  value: string;
}

const CODEX_SUGGESTIONS: SkillSuggestion[] = [
  { id: 'codex-systematic-debugging', label: 'Debugging', value: 'superpowers-systematic-debugging' },
  { id: 'codex-tdd', label: 'TDD', value: 'superpowers-test-driven-development' },
  { id: 'codex-verification', label: 'Verify', value: 'superpowers-verification-before-completion' },
  { id: 'codex-tauri', label: 'Tauri', value: 'tauri' },
  { id: 'codex-playwright', label: 'Browser QA', value: 'playwright' },
  { id: 'codex-frontend', label: 'Frontend', value: 'build-web-apps:frontend-app-builder' },
];

const CLAUDE_SUGGESTIONS: SkillSuggestion[] = [
  { id: 'claude-plan', label: 'Planning', value: 'planning, todo tracking, implementation sequencing' },
  { id: 'claude-review', label: 'Review', value: 'code review, regression hunting, risk callouts' },
  { id: 'claude-ui', label: 'UI Polish', value: 'Svelte UI polish, visual parity, interaction QA' },
  { id: 'claude-swarm', label: 'Swarm', value: 'swarm register, poll_messages, broadcast, task handoff' },
  { id: 'claude-terminal', label: 'Terminal', value: 'terminal workflow, shell commands, build/test loops' },
  { id: 'claude-docs', label: 'Docs', value: 'spec updates, manual QA notes, handoff summaries' },
];

const COMMON_SUGGESTIONS: SkillSuggestion[] = [
  { id: 'common-rg', label: 'Search', value: 'rg, git diff, targeted file reads' },
  { id: 'common-qa', label: 'QA', value: 'manual QA, screenshot comparison, smoke testing' },
  { id: 'common-swarm', label: 'Swarm', value: 'register, whoami, list_instances, poll_messages, list_tasks' },
];

export function skillSuggestionsForHarness(harness: string | null | undefined): SkillSuggestion[] {
  const normalized = harness?.toLowerCase() ?? '';
  if (normalized.includes('codex')) return CODEX_SUGGESTIONS;
  if (normalized.includes('claude')) return CLAUDE_SUGGESTIONS;
  return COMMON_SUGGESTIONS;
}

export function appendSkillSuggestion(current: string, suggestion: string): string {
  const trimmedCurrent = current.trim();
  const trimmedSuggestion = suggestion.trim();
  if (!trimmedSuggestion) return current;

  const existing = trimmedCurrent
    .split(/[\n,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (existing.includes(trimmedSuggestion.toLowerCase())) {
    return current;
  }

  return trimmedCurrent ? `${trimmedCurrent}\n${trimmedSuggestion}` : trimmedSuggestion;
}
