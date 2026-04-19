import { writable, get } from 'svelte/store';

export type HarnessName = 'claude' | 'codex' | 'opencode';

export type HarnessAliases = Record<HarnessName, string>;

const STORAGE_KEY = 'swarm-ui.harness-aliases';

export const HARNESS_NAMES: HarnessName[] = ['claude', 'codex', 'opencode'];

const DEFAULT_ALIASES: HarnessAliases = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
};

function sanitizeAlias(harness: HarnessName, value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ALIASES[harness];
  const trimmed = value.trim();
  return trimmed.length === 0 ? DEFAULT_ALIASES[harness] : trimmed;
}

function normalize(value?: Partial<HarnessAliases> | null): HarnessAliases {
  return {
    claude: sanitizeAlias('claude', value?.claude),
    codex: sanitizeAlias('codex', value?.codex),
    opencode: sanitizeAlias('opencode', value?.opencode),
  };
}

function load(): HarnessAliases {
  if (typeof window === 'undefined') return { ...DEFAULT_ALIASES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ALIASES };
    return normalize(JSON.parse(raw) as Partial<HarnessAliases>);
  } catch {
    return { ...DEFAULT_ALIASES };
  }
}

function createHarnessAliasesStore() {
  const { subscribe, set, update } = writable<HarnessAliases>(load());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(value)));
      } catch {
        // ignore persistence failures
      }
    });
  }

  return {
    subscribe,
    setAlias(harness: HarnessName, value: string) {
      update((current) => ({ ...current, [harness]: sanitizeAlias(harness, value) }));
    },
    reset() {
      set({ ...DEFAULT_ALIASES });
    },
  };
}

export const harnessAliases = createHarnessAliasesStore();

function isKnownHarness(name: string): name is HarnessName {
  return (HARNESS_NAMES as string[]).includes(name);
}

/**
 * Resolve a harness name to the actual shell command the user has aliased it
 * to. Unknown names pass through unchanged so non-harness custom commands
 * (if ever added) are not mangled.
 */
export function resolveHarnessCommand(harness: string): string {
  if (!isKnownHarness(harness)) return harness;
  const alias = get(harnessAliases)[harness];
  return alias && alias.trim().length > 0 ? alias : harness;
}
