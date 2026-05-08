import { derived, writable } from 'svelte/store';
import type { AgentProfile, AgentProfileDraft, AgentRuntimeProfile } from '../lib/types';
import { inferLaunchCommandFromPermissions } from '../lib/permissionPostures';

const STORAGE_KEY = 'swarm-ui.agent-profiles';
const SELECTED_PROFILE_KEY = 'swarm-ui.selected-agent-profile';
const RUNTIME_PROFILES_KEY = 'swarm-ui.agent-runtime-profiles';

export const EMPTY_AGENT_PROFILE_DRAFT: AgentProfileDraft = {
  name: '',
  workingDirectory: '',
  harness: 'claude',
  role: '',
  scope: '',
  nodeName: '',
  label: '',
  mission: '',
  persona: '',
  specialty: '',
  skills: '',
  context: '',
  memory: '',
  permissions: '',
  launchCommand: '',
  customInstructions: '',
  emoji: '',
  roleAccent: '',
  tierRank: 0,
};

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function createProfileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRank(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function normalizeAgentProfileDraft(
  value?: Partial<AgentProfileDraft> | null,
): AgentProfileDraft {
  const harness = trimString(value?.harness) || EMPTY_AGENT_PROFILE_DRAFT.harness;
  const permissions = trimString(value?.permissions);
  const launchCommand = trimString(value?.launchCommand)
    || inferLaunchCommandFromPermissions(harness, permissions);

  return {
    name: trimString(value?.name),
    workingDirectory: trimString(value?.workingDirectory),
    harness,
    role: trimString(value?.role),
    scope: trimString(value?.scope),
    nodeName: trimString(value?.nodeName),
    label: trimString(value?.label),
    mission: trimString(value?.mission),
    persona: trimString(value?.persona),
    specialty: trimString(value?.specialty),
    skills: trimString(value?.skills),
    context: trimString(value?.context),
    memory: trimString(value?.memory),
    permissions,
    launchCommand,
    customInstructions: trimString(value?.customInstructions),
    emoji: trimString(value?.emoji),
    roleAccent: trimString(value?.roleAccent),
    tierRank: normalizeRank(value?.tierRank),
  };
}

function normalizeAgentProfile(
  value?: Partial<AgentProfile> | null,
): AgentProfile | null {
  const draft = normalizeAgentProfileDraft(value);
  if (!draft.name) return null;

  return {
    ...draft,
    id: trimString(value?.id) || createProfileId(),
    updatedAt: typeof value?.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Date.now(),
  };
}

export function rankAgentProfiles(items: AgentProfile[]): AgentProfile[] {
  return [...items].sort((left, right) => {
    const leftRank = normalizeRank(left.tierRank) || Number.MAX_SAFE_INTEGER;
    const rightRank = normalizeRank(right.tierRank) || Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.name.localeCompare(right.name);
  });
}

function withContiguousRanks(items: AgentProfile[]): AgentProfile[] {
  return items.map((profile, index) => ({
    ...profile,
    tierRank: index + 1,
  }));
}

export function moveAgentProfileInTier(
  items: AgentProfile[],
  id: string,
  direction: 'up' | 'down' | 'top',
): AgentProfile[] {
  const ranked = withContiguousRanks(rankAgentProfiles(items));
  const index = ranked.findIndex((profile) => profile.id === id);
  if (index < 0) return ranked;

  const [profile] = ranked.splice(index, 1);
  if (!profile) return ranked;

  if (direction === 'top') {
    ranked.unshift(profile);
  } else if (direction === 'up') {
    ranked.splice(Math.max(0, index - 1), 0, profile);
  } else {
    ranked.splice(Math.min(ranked.length, index + 1), 0, profile);
  }

  return withContiguousRanks(ranked);
}

function loadProfiles(): AgentProfile[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<AgentProfile>[];
    if (!Array.isArray(parsed)) return [];

    return rankAgentProfiles(
      parsed
        .map((entry) => normalizeAgentProfile(entry))
        .filter((entry): entry is AgentProfile => entry !== null),
    );
  } catch {
    return [];
  }
}

function loadSelectedProfileId(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(SELECTED_PROFILE_KEY) ?? '';
}

function normalizeAgentRuntimeProfile(
  value?: Partial<AgentRuntimeProfile> | null,
): AgentRuntimeProfile | null {
  const instanceId = trimString(value?.instanceId);
  if (!instanceId) return null;

  return {
    instanceId,
    name: trimString(value?.name),
    role: trimString(value?.role),
    persona: trimString(value?.persona),
    mission: trimString(value?.mission),
    skills: trimString(value?.skills),
    permissions: trimString(value?.permissions),
    updatedAt: typeof value?.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Date.now(),
  };
}

function loadRuntimeProfiles(): Record<string, AgentRuntimeProfile> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(RUNTIME_PROFILES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<AgentRuntimeProfile>>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: Record<string, AgentRuntimeProfile> = {};
    for (const [instanceId, value] of Object.entries(parsed)) {
      const normalized = normalizeAgentRuntimeProfile({ ...value, instanceId });
      if (normalized) out[normalized.instanceId] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

function createAgentProfilesStore() {
  const { subscribe, set, update } = writable<AgentProfile[]>(loadProfiles());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rankAgentProfiles(value)));
      } catch {
        // Keep session-local state if persistence fails.
      }
    });
  }

  return {
    subscribe,
    saveDraft(draft: AgentProfileDraft, existingId: string | null = null): AgentProfile {
      const normalizedDraft = normalizeAgentProfileDraft(draft);
      const nextProfile = normalizeAgentProfile({
        ...normalizedDraft,
        id: existingId || undefined,
        updatedAt: Date.now(),
      });

      if (!nextProfile) {
        throw new Error('profile name is required');
      }

      update((current) => {
        const filtered = current.filter((profile) => profile.id !== nextProfile.id);
        const existing = current.find((profile) => profile.id === nextProfile.id);
        const rankedProfile = {
          ...nextProfile,
          tierRank: nextProfile.tierRank || existing?.tierRank || filtered.length + 1,
        };
        return withContiguousRanks(rankAgentProfiles([rankedProfile, ...filtered]));
      });

      return nextProfile;
    },
    deleteProfile(id: string): void {
      update((current) => withContiguousRanks(current.filter((profile) => profile.id !== id)));
    },
    moveProfile(id: string, direction: 'up' | 'down' | 'top'): void {
      update((current) => moveAgentProfileInTier(current, id, direction));
    },
    reset(): void {
      set([]);
    },
  };
}

export const agentProfiles = createAgentProfilesStore();

export const selectedAgentProfileId = writable<string>(loadSelectedProfileId());

if (typeof window !== 'undefined') {
  selectedAgentProfileId.subscribe((value) => {
    try {
      window.localStorage.setItem(SELECTED_PROFILE_KEY, value);
    } catch {
      // ignore persistence failures
    }
  });
}

export const selectedAgentProfile = derived(
  [agentProfiles, selectedAgentProfileId],
  ([$profiles, $selectedId]) => $profiles.find((profile) => profile.id === $selectedId) ?? null,
);

function createAgentRuntimeProfilesStore() {
  const { subscribe, set, update } = writable<Record<string, AgentRuntimeProfile>>(
    loadRuntimeProfiles(),
  );

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(RUNTIME_PROFILES_KEY, JSON.stringify(value));
      } catch {
        // Keep session-local state if persistence fails.
      }
    });
  }

  return {
    subscribe,
    save(profile: AgentRuntimeProfile): void {
      const normalized = normalizeAgentRuntimeProfile({
        ...profile,
        updatedAt: Date.now(),
      });
      if (!normalized) return;
      update((current) => ({
        ...current,
        [normalized.instanceId]: normalized,
      }));
    },
    delete(instanceId: string): void {
      update((current) => {
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
    },
    reset(): void {
      set({});
    },
  };
}

export const agentRuntimeProfiles = createAgentRuntimeProfilesStore();

export function agentProfileToDraft(profile: AgentProfile | null | undefined): AgentProfileDraft {
  return normalizeAgentProfileDraft(profile ?? EMPTY_AGENT_PROFILE_DRAFT);
}

export function buildAgentProfilePrompt(
  value: Partial<AgentProfileDraft>,
): string {
  const draft = normalizeAgentProfileDraft(value);
  const lines: string[] = [];

  if (draft.mission) {
    lines.push(`Mission: ${draft.mission}`);
  }
  if (draft.persona) {
    lines.push(`Persona: ${draft.persona}`);
  }
  if (draft.specialty) {
    lines.push(`Specialty: ${draft.specialty}`);
  }
  if (draft.skills) {
    lines.push(`Skills and tools to lean on: ${draft.skills}`);
  }
  if (draft.context) {
    lines.push(`Context and look-back guidance: ${draft.context}`);
  }
  if (draft.memory) {
    lines.push(`Memory and carry-forward notes: ${draft.memory}`);
  }
  if (draft.permissions) {
    lines.push(`Permissions and access posture: ${draft.permissions}`);
  }
  if (draft.customInstructions) {
    lines.push(`Additional custom instructions: ${draft.customInstructions}`);
  }

  return lines.join('\n');
}
