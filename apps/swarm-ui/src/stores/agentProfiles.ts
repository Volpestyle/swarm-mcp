import { derived, writable } from 'svelte/store';
import type { AgentProfile, AgentProfileDraft } from '../lib/types';

const STORAGE_KEY = 'swarm-ui.agent-profiles';
const SELECTED_PROFILE_KEY = 'swarm-ui.selected-agent-profile';

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

export function normalizeAgentProfileDraft(
  value?: Partial<AgentProfileDraft> | null,
): AgentProfileDraft {
  return {
    name: trimString(value?.name),
    workingDirectory: trimString(value?.workingDirectory),
    harness: trimString(value?.harness) || EMPTY_AGENT_PROFILE_DRAFT.harness,
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
    permissions: trimString(value?.permissions),
    launchCommand: trimString(value?.launchCommand),
    customInstructions: trimString(value?.customInstructions),
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

function sortProfiles(items: AgentProfile[]): AgentProfile[] {
  return [...items].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.name.localeCompare(right.name);
  });
}

function loadProfiles(): AgentProfile[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<AgentProfile>[];
    if (!Array.isArray(parsed)) return [];

    return sortProfiles(
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

function createAgentProfilesStore() {
  const { subscribe, set, update } = writable<AgentProfile[]>(loadProfiles());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sortProfiles(value)));
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
        return sortProfiles([nextProfile, ...filtered]);
      });

      return nextProfile;
    },
    deleteProfile(id: string): void {
      update((current) => current.filter((profile) => profile.id !== id));
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
