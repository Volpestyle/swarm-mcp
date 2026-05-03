import { derived, writable } from 'svelte/store';
import type {
  AgentProfile,
  AgentProfileDraft,
  AgentTeam,
  AgentTeamDraft,
  AgentTeamMember,
} from '../lib/types';
import { normalizeAgentProfileDraft } from './agentProfiles';

const STORAGE_KEY = 'swarm-ui.agent-teams';
const SELECTED_TEAM_KEY = 'swarm-ui.selected-agent-team';

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function createTeamId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTeamMember(value?: Partial<AgentTeamMember> | null): AgentTeamMember | null {
  const rawProfile = value?.profile;
  const hasMeaningfulProfile = Boolean(rawProfile) && [
    rawProfile?.name,
    rawProfile?.workingDirectory,
    rawProfile?.harness,
    rawProfile?.role,
    rawProfile?.scope,
    rawProfile?.nodeName,
    rawProfile?.label,
    rawProfile?.mission,
    rawProfile?.persona,
    rawProfile?.specialty,
    rawProfile?.skills,
    rawProfile?.context,
    rawProfile?.memory,
    rawProfile?.permissions,
    rawProfile?.launchCommand,
    rawProfile?.customInstructions,
  ].some((entry) => trimString(entry).length > 0);

  if (!hasMeaningfulProfile) {
    return null;
  }

  const profile = normalizeAgentProfileDraft(rawProfile);

  return {
    profileId: trimString(value?.profileId) || null,
    profile,
  };
}

export function normalizeAgentTeamDraft(
  value?: Partial<AgentTeamDraft> | null,
): AgentTeamDraft {
  const members = Array.isArray(value?.members)
    ? value.members
        .map((entry) => normalizeTeamMember(entry))
        .filter((entry): entry is AgentTeamMember => entry !== null)
    : [];

  return {
    name: trimString(value?.name),
    members,
  };
}

function normalizeAgentTeam(value?: Partial<AgentTeam> | null): AgentTeam | null {
  const draft = normalizeAgentTeamDraft(value);
  if (!draft.name || draft.members.length === 0) return null;

  return {
    ...draft,
    id: trimString(value?.id) || createTeamId(),
    updatedAt: typeof value?.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : Date.now(),
  };
}

function sortTeams(items: AgentTeam[]): AgentTeam[] {
  return [...items].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.name.localeCompare(right.name);
  });
}

function loadTeams(): AgentTeam[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<AgentTeam>[];
    if (!Array.isArray(parsed)) return [];

    return sortTeams(
      parsed
        .map((entry) => normalizeAgentTeam(entry))
        .filter((entry): entry is AgentTeam => entry !== null),
    );
  } catch {
    return [];
  }
}

function loadSelectedTeamId(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(SELECTED_TEAM_KEY) ?? '';
}

function createAgentTeamsStore() {
  const { subscribe, set, update } = writable<AgentTeam[]>(loadTeams());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sortTeams(value)));
      } catch {
        // Keep session-local state if persistence fails.
      }
    });
  }

  return {
    subscribe,
    saveDraft(draft: AgentTeamDraft, existingId: string | null = null): AgentTeam {
      const normalizedDraft = normalizeAgentTeamDraft(draft);
      const nextTeam = normalizeAgentTeam({
        ...normalizedDraft,
        id: existingId || undefined,
        updatedAt: Date.now(),
      });

      if (!nextTeam) {
        throw new Error('team name and at least one member are required');
      }

      update((current) => {
        const filtered = current.filter((team) => team.id !== nextTeam.id);
        return sortTeams([nextTeam, ...filtered]);
      });

      return nextTeam;
    },
    deleteTeam(id: string): void {
      update((current) => current.filter((team) => team.id !== id));
    },
    reset(): void {
      set([]);
    },
  };
}

export const agentTeams = createAgentTeamsStore();

export const selectedAgentTeamId = writable<string>(loadSelectedTeamId());

if (typeof window !== 'undefined') {
  selectedAgentTeamId.subscribe((value) => {
    try {
      window.localStorage.setItem(SELECTED_TEAM_KEY, value);
    } catch {
      // Ignore persistence failures.
    }
  });
}

export const selectedAgentTeam = derived(
  [agentTeams, selectedAgentTeamId],
  ([$teams, $selectedId]) => $teams.find((team) => team.id === $selectedId) ?? null,
);

export function profilesToTeamDraft(
  name: string,
  profiles: AgentProfile[],
): AgentTeamDraft {
  return {
    name: trimString(name),
    members: profiles.map((profile) => ({
      profileId: profile.id,
      profile: normalizeAgentProfileDraft(profile),
    })),
  };
}

export function createFreshTeamScope(baseScope: string, teamName: string): string {
  const safeName = teamName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'team';
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'z')
    .toLowerCase();
  return `${baseScope}#team-${safeName}-${stamp}`;
}
