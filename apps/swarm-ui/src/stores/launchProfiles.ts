import { writable } from 'svelte/store';
import type { LaunchProfile, LaunchScopeMode, LaunchTrustPosture } from '../lib/types';

const STORAGE_KEY = 'swarm-ui.launch-profiles';

const TRUST_POSTURES = new Set<LaunchTrustPosture>([
  'trusted-local',
  'safe-review',
  'research',
  'visual-design',
  'custom',
]);

const SCOPE_MODES = new Set<LaunchScopeMode>([
  'follow-canvas',
  'fresh-project',
  'custom',
]);

export const DEFAULT_LAUNCH_PROFILES: LaunchProfile[] = [
  {
    id: 'trusted-local',
    name: 'Trusted Local',
    description: 'Full local access for trusted build sessions.',
    harness: 'codex',
    command: 'codex',
    trustPosture: 'trusted-local',
    defaultRole: 'implementer',
    defaultScopeMode: 'follow-canvas',
  },
  {
    id: 'safe-review',
    name: 'Safe Review',
    description: 'Conservative launch posture for inspection and review.',
    harness: 'claude',
    command: 'claude',
    trustPosture: 'safe-review',
    defaultRole: 'reviewer',
    defaultScopeMode: 'follow-canvas',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Read-first posture for repo archaeology and evidence gathering.',
    harness: 'codex',
    command: 'codex',
    trustPosture: 'research',
    defaultRole: 'researcher',
    defaultScopeMode: 'follow-canvas',
  },
];

function normalizeTrustPosture(value: unknown): LaunchTrustPosture {
  return typeof value === 'string' && TRUST_POSTURES.has(value as LaunchTrustPosture)
    ? value as LaunchTrustPosture
    : 'custom';
}

function normalizeScopeMode(value: unknown): LaunchScopeMode {
  return typeof value === 'string' && SCOPE_MODES.has(value as LaunchScopeMode)
    ? value as LaunchScopeMode
    : 'follow-canvas';
}

export function normalizeLaunchProfile(value?: Partial<LaunchProfile> | null): LaunchProfile | null {
  const id = value?.id?.trim();
  const name = value?.name?.trim();
  const harness = value?.harness?.trim();
  const command = value?.command?.trim();
  if (!id || !name || !harness || !command) return null;

  return {
    id,
    name,
    description: value?.description?.trim() || '',
    harness,
    command,
    trustPosture: normalizeTrustPosture(value?.trustPosture),
    defaultRole: value?.defaultRole?.trim() || '',
    defaultScopeMode: normalizeScopeMode(value?.defaultScopeMode),
  };
}

export function normalizeLaunchProfiles(value?: Partial<LaunchProfile>[] | null): LaunchProfile[] {
  const normalized = (value || [])
    .map((entry) => normalizeLaunchProfile(entry))
    .filter((entry): entry is LaunchProfile => entry !== null);

  return normalized.length > 0 ? normalized : [...DEFAULT_LAUNCH_PROFILES];
}

function loadProfiles(): LaunchProfile[] {
  if (typeof window === 'undefined') return [...DEFAULT_LAUNCH_PROFILES];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_LAUNCH_PROFILES];
    return normalizeLaunchProfiles(JSON.parse(raw) as Partial<LaunchProfile>[]);
  } catch {
    return [...DEFAULT_LAUNCH_PROFILES];
  }
}

function createLaunchProfilesStore() {
  const { subscribe, set, update } = writable<LaunchProfile[]>(loadProfiles());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLaunchProfiles(value)));
      } catch {
        // ignore persistence failures
      }
    });
  }

  return {
    subscribe,
    reset() {
      set([...DEFAULT_LAUNCH_PROFILES]);
    },
    save(profile: LaunchProfile) {
      const normalized = normalizeLaunchProfile(profile);
      if (!normalized) return;
      update((current) => {
        const filtered = current.filter((entry) => entry.id !== normalized.id);
        return [...filtered, normalized];
      });
    },
  };
}

export const launchProfiles = createLaunchProfilesStore();
