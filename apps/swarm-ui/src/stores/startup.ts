import { derived, writable } from 'svelte/store';
import type {
  BindingState,
  Instance,
  KvEntry,
  PtySession,
  RecoveryScopeSummary,
  RecoverySessionItem,
  StartupLaunchDefaults,
  StartupPreferences,
  ThemeProfile,
  ThemeProfileId,
} from '../lib/types';
import { harnessFromCommand, isOrphanAgentPty } from '../lib/ptyRecovery';
import { getThemeProfile, themeProfiles } from '../lib/themeProfiles';
import { bindings, ptySessions } from './pty';
import { allInstances, allKvEntries, uiMeta } from './swarm';

const STORAGE_KEY = 'swarm-ui.startup-preferences';
const LEGACY_LAUNCHER_HARNESS_KEY = 'swarm-ui.launcher.harness';
const LEGACY_LAUNCHER_ROLE_KEY = 'swarm-ui.launcher.role';
const LEGACY_LAUNCHER_SCOPE_KEY = 'swarm-ui.launcher.scope';
const LEGACY_APPEARANCE_KEY = 'swarm-ui.appearance';
const RECENT_DIRECTORY_LIMIT = 10;
export const READABLE_LAUNCH_MIN_BACKGROUND_OPACITY = 0.72;
export const READABLE_LAUNCH_MAX_BACKDROP_BLUR = 48;

const DEFAULT_LAUNCH_DEFAULTS: StartupLaunchDefaults = {
  harness: 'claude',
  role: '',
  scope: '',
  scopePinned: false,
};

export const DEFAULT_STARTUP_PREFERENCES: StartupPreferences = {
  recentDirectories: [],
  selectedDirectory: '',
  launchDefaults: DEFAULT_LAUNCH_DEFAULTS,
  selectedLaunchProfileId: 'trusted-local',
  // Tron Encom Clear (rev 0.7) is the default for fresh installs as of the
  // visual overhaul. Existing users keep their saved preference because
  // `loadStartupPreferences()` reads from localStorage first and only falls
  // back to this default when no value is stored.
  themeProfileId: 'tron-encom-os',
  backgroundOpacityOverride: null,
  backdropBlurOverride: null,
};

function clampBackgroundOpacity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_STARTUP_PREFERENCES.backgroundOpacityOverride;
  }
  return Math.min(1, Math.max(0, value));
}

function clampBackdropBlur(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_STARTUP_PREFERENCES.backdropBlurOverride;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeLaunchDefaults(
  value?: Partial<StartupLaunchDefaults> | null,
): StartupLaunchDefaults {
  const scope = typeof value?.scope === 'string' ? value.scope.trim() : '';
  const scopePinned = Boolean(scope && value?.scopePinned === true);
  return {
    harness: typeof value?.harness === 'string' && value.harness.trim()
      ? value.harness.trim()
      : DEFAULT_LAUNCH_DEFAULTS.harness,
    role: typeof value?.role === 'string' ? value.role.trim() : '',
    scope: scopePinned ? scope : '',
    scopePinned,
  };
}

export function appendRecentDirectory(
  recentDirectories: string[],
  directory: string,
  limit = RECENT_DIRECTORY_LIMIT,
): string[] {
  const trimmed = directory.trim();
  if (!trimmed) return recentDirectories;
  const next = [trimmed, ...recentDirectories.filter((entry) => entry !== trimmed)];
  return next.slice(0, limit);
}

export function formatScopeLabel(scope: string | null, segments = 2): string {
  if (!scope) return 'all scopes';

  const [baseScope] = scope.split('#fresh-');
  const parts = baseScope.split(/[\\/]/).filter(Boolean);
  const compact = baseScope.startsWith('/')
    ? parts.slice(-segments).join('/')
    : parts.slice(-segments).join('/') || baseScope;
  const label = compact || baseScope || scope;

  return scope.includes('#fresh-') ? `${label} fresh` : label;
}

function loadLegacyOpacityOverride(): number | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_APPEARANCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { backgroundOpacity?: number };
    return clampBackgroundOpacity(parsed.backgroundOpacity);
  } catch {
    return null;
  }
}

function loadLegacyPreferences(): Partial<StartupPreferences> {
  if (typeof window === 'undefined') {
    return {};
  }

  return {
    launchDefaults: {
      harness: window.localStorage.getItem(LEGACY_LAUNCHER_HARNESS_KEY) ?? DEFAULT_LAUNCH_DEFAULTS.harness,
      role: window.localStorage.getItem(LEGACY_LAUNCHER_ROLE_KEY) ?? '',
      scope: window.localStorage.getItem(LEGACY_LAUNCHER_SCOPE_KEY) ?? '',
      scopePinned: false,
    },
    backgroundOpacityOverride: loadLegacyOpacityOverride(),
  };
}

export function normalizeStartupPreferences(
  value?: Partial<StartupPreferences> | null,
  legacy: Partial<StartupPreferences> = {},
): StartupPreferences {
  const themeProfileId = typeof value?.themeProfileId === 'string'
    ? value.themeProfileId as ThemeProfileId
    : typeof legacy.themeProfileId === 'string'
      ? legacy.themeProfileId as ThemeProfileId
      : DEFAULT_STARTUP_PREFERENCES.themeProfileId;

  const recentDirectories = Array.isArray(value?.recentDirectories)
    ? value?.recentDirectories.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : Array.isArray(legacy.recentDirectories)
      ? legacy.recentDirectories.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : DEFAULT_STARTUP_PREFERENCES.recentDirectories;

  return {
    recentDirectories,
    selectedDirectory: typeof value?.selectedDirectory === 'string'
      ? value.selectedDirectory.trim()
      : typeof legacy.selectedDirectory === 'string'
        ? legacy.selectedDirectory.trim()
        : DEFAULT_STARTUP_PREFERENCES.selectedDirectory,
    launchDefaults: normalizeLaunchDefaults(value?.launchDefaults ?? legacy.launchDefaults),
    selectedLaunchProfileId: typeof value?.selectedLaunchProfileId === 'string'
      ? value.selectedLaunchProfileId.trim()
      : typeof legacy.selectedLaunchProfileId === 'string'
        ? legacy.selectedLaunchProfileId.trim()
        : DEFAULT_STARTUP_PREFERENCES.selectedLaunchProfileId,
    themeProfileId: getThemeProfile(themeProfileId).id,
    backgroundOpacityOverride: clampBackgroundOpacity(
      value?.backgroundOpacityOverride ?? legacy.backgroundOpacityOverride ?? null,
    ),
    backdropBlurOverride: clampBackdropBlur(
      value?.backdropBlurOverride ?? legacy.backdropBlurOverride ?? null,
    ),
  };
}

export function normalizeStartupPreferencesForLaunch(
  value?: Partial<StartupPreferences> | null,
  legacy: Partial<StartupPreferences> = {},
): StartupPreferences {
  const preferences = normalizeStartupPreferences(value, legacy);
  const themeProfile = getThemeProfile(preferences.themeProfileId);
  const effectiveBackgroundOpacity =
    preferences.backgroundOpacityOverride ?? themeProfile.appearance.defaultBackgroundOpacity;
  const effectiveBackdropBlur =
    preferences.backdropBlurOverride ?? themeProfile.appearance.defaultBackdropBlur;

  let backgroundOpacityOverride = preferences.backgroundOpacityOverride;
  let backdropBlurOverride = preferences.backdropBlurOverride;

  if (effectiveBackgroundOpacity < READABLE_LAUNCH_MIN_BACKGROUND_OPACITY) {
    backgroundOpacityOverride = READABLE_LAUNCH_MIN_BACKGROUND_OPACITY;
  }

  if (effectiveBackdropBlur > READABLE_LAUNCH_MAX_BACKDROP_BLUR) {
    backdropBlurOverride = READABLE_LAUNCH_MAX_BACKDROP_BLUR;
  }

  if (
    backgroundOpacityOverride === preferences.backgroundOpacityOverride
    && backdropBlurOverride === preferences.backdropBlurOverride
  ) {
    return preferences;
  }

  return {
    ...preferences,
    backgroundOpacityOverride,
    backdropBlurOverride,
  };
}

function loadStartupPreferences(): StartupPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_STARTUP_PREFERENCES;
  }

  const legacy = loadLegacyPreferences();

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return normalizeStartupPreferencesForLaunch(undefined, legacy);
    }
    return normalizeStartupPreferencesForLaunch(JSON.parse(raw) as Partial<StartupPreferences>, legacy);
  } catch {
    return normalizeStartupPreferencesForLaunch(undefined, legacy);
  }
}

function parseLayoutNodeCount(value: unknown): number {
  const parsed = typeof value === 'string'
    ? (() => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    })()
    : value;

  if (!parsed || typeof parsed !== 'object') return 0;
  const nodes = (parsed as { nodes?: Record<string, unknown> }).nodes;
  if (!nodes || typeof nodes !== 'object') return 0;
  return Object.keys(nodes).length;
}

export function collectLayoutScopes(
  kvEntries: KvEntry[],
  meta: Record<string, unknown> | null,
): Map<string, number> {
  const scopes = new Map<string, number>();

  for (const entry of kvEntries) {
    if (entry.key !== 'ui/layout') continue;
    if (!entry.scope) continue;
    scopes.set(entry.scope, parseLayoutNodeCount(entry.value));
  }

  if (!meta) {
    return scopes;
  }

  for (const [key, value] of Object.entries(meta)) {
    if (!key.endsWith('::ui/layout')) continue;
    const scope = key.slice(0, -'::ui/layout'.length);
    if (!scope || scopes.has(scope)) continue;
    scopes.set(scope, parseLayoutNodeCount(value));
  }

  return scopes;
}

function parseNameFromLabel(label: string | null): string | null {
  if (!label) return null;
  for (const token of label.split(/\s+/)) {
    if (token.startsWith('name:')) {
      const value = token.slice('name:'.length);
      if (value) return value;
    }
  }
  return null;
}

function parseHarnessFromLabel(label: string | null): string | null {
  if (!label) return null;
  for (const token of label.split(/\s+/)) {
    if (!token.startsWith('provider:')) continue;
    const value = token.slice('provider:'.length);
    if (
      value === 'claude'
      || value === 'codex'
      || value === 'hermes'
      || value === 'openclaw'
      || value === 'opencode'
    ) {
      return value;
    }
  }
  return null;
}

function sessionStatus(instance: Instance): RecoverySessionItem['status'] {
  if (!instance.adopted && instance.status === 'online') {
    return 'adopting';
  }
  return instance.status;
}

function sessionAction(
  instance: Instance,
  harness: string | null,
  bindingState: BindingState,
): RecoverySessionItem['action'] {
  if (!instance.adopted && instance.status !== 'online') {
    return 'cleanup_orphan';
  }

  if (instance.status === 'online') {
    return 'open_scope';
  }

  if (harness && !bindingState.resolved.some(([instanceId]) => instanceId === instance.id)) {
    return 'respawn';
  }

  return 'remove';
}

export function buildRecoverySessionItems(
  instanceMap: Map<string, Instance>,
  bindingState: BindingState,
  ptyMap: Map<string, PtySession> = new Map(),
): RecoverySessionItem[] {
  const items: RecoverySessionItem[] = [...instanceMap.values()].map((instance): RecoverySessionItem => {
    const harness = parseHarnessFromLabel(instance.label ?? null);
    const boundPtyId = bindingState.resolved.find(([instanceId]) => instanceId === instance.id)?.[1] ?? null;
    return {
      id: instance.id,
      kind: 'instance',
      instanceId: instance.id,
      ptyId: boundPtyId,
      scope: instance.scope,
      directory: instance.directory,
      label: instance.label ?? null,
      displayName: parseNameFromLabel(instance.label ?? null),
      harness,
      adopted: instance.adopted,
      status: sessionStatus(instance),
      action: sessionAction(instance, harness, bindingState),
      boundPtyId,
    };
  });

  for (const pty of ptyMap.values()) {
    if (!isOrphanAgentPty(pty, instanceMap, bindingState)) continue;
    items.push({
      id: pty.id,
      kind: 'orphan_pty',
      instanceId: null,
      ptyId: pty.id,
      scope: pty.cwd,
      directory: pty.cwd,
      label: null,
      displayName: null,
      harness: harnessFromCommand(pty.command),
      adopted: false,
      status: 'stale',
      action: 'cleanup_orphan',
      boundPtyId: null,
    });
  }

  const order = new Map<RecoverySessionItem['status'], number>([
    ['adopting', 0],
    ['online', 1],
    ['stale', 2],
    ['offline', 3],
  ]);

  items.sort((left, right) => {
    const scopeCompare = left.scope.localeCompare(right.scope);
    if (scopeCompare !== 0) return scopeCompare;
    const statusCompare = (order.get(left.status) ?? 99) - (order.get(right.status) ?? 99);
    if (statusCompare !== 0) return statusCompare;
    return left.directory.localeCompare(right.directory);
  });

  return items;
}

export function buildRecoveryScopeSummaries(
  sessionItems: RecoverySessionItem[],
  layoutScopes: Map<string, number>,
): RecoveryScopeSummary[] {
  const byScope = new Map<string, RecoveryScopeSummary>();

  for (const [scope, layoutNodeCount] of layoutScopes) {
    byScope.set(scope, {
      scope,
      layoutNodeCount,
      sessionCount: 0,
      liveCount: 0,
      staleCount: 0,
      offlineCount: 0,
      adoptingCount: 0,
      layoutOnly: true,
    });
  }

  for (const item of sessionItems) {
    const current = byScope.get(item.scope) ?? {
      scope: item.scope,
      layoutNodeCount: 0,
      sessionCount: 0,
      liveCount: 0,
      staleCount: 0,
      offlineCount: 0,
      adoptingCount: 0,
      layoutOnly: true,
    };

    current.sessionCount += 1;
    current.layoutOnly = false;

    switch (item.status) {
      case 'adopting':
        current.adoptingCount += 1;
        break;
      case 'online':
        current.liveCount += 1;
        break;
      case 'stale':
        current.staleCount += 1;
        break;
      case 'offline':
        current.offlineCount += 1;
        break;
    }

    byScope.set(item.scope, current);
  }

  return [...byScope.values()].sort((left, right) => left.scope.localeCompare(right.scope));
}

function createStartupPreferencesStore() {
  const { subscribe, set, update } = writable(loadStartupPreferences());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeStartupPreferences(value)));
      } catch {
        // Keep session-local state if persistence fails.
      }
    });
  }

  return {
    subscribe,
    setSelectedDirectory(directory: string) {
      update((current) => ({
        ...current,
        selectedDirectory: directory,
      }));
    },
    addRecentDirectory(directory: string) {
      update((current) => ({
        ...current,
        recentDirectories: appendRecentDirectory(current.recentDirectories, directory),
      }));
    },
    removeRecentDirectory(directory: string) {
      const trimmed = directory.trim();
      update((current) => ({
        ...current,
        recentDirectories: current.recentDirectories.filter((entry) => entry !== trimmed),
      }));
    },
    clearRecentDirectories() {
      update((current) => ({
        ...current,
        recentDirectories: [],
      }));
    },
    setLaunchDefaults(patch: Partial<StartupLaunchDefaults>) {
      update((current) => ({
        ...current,
        launchDefaults: normalizeLaunchDefaults({
          ...current.launchDefaults,
          ...patch,
        }),
      }));
    },
    setSelectedLaunchProfileId(value: string) {
      update((current) => ({
        ...current,
        selectedLaunchProfileId: value.trim(),
      }));
    },
    setThemeProfile(themeProfileId: ThemeProfileId) {
      update((current) => ({
        ...current,
        themeProfileId: getThemeProfile(themeProfileId).id,
      }));
    },
    setBackgroundOpacityOverride(value: number | null) {
      update((current) => ({
        ...current,
        backgroundOpacityOverride: clampBackgroundOpacity(value),
      }));
    },
    setBackdropBlurOverride(value: number | null) {
      update((current) => ({
        ...current,
        backdropBlurOverride: clampBackdropBlur(value),
      }));
    },
    reset() {
      set(DEFAULT_STARTUP_PREFERENCES);
    },
  };
}

export const startupPreferences = createStartupPreferencesStore();

export const startupThemeProfile = derived(startupPreferences, ($preferences): ThemeProfile =>
  getThemeProfile($preferences.themeProfileId),
);

export const recoveryLayoutScopes = derived(
  [allKvEntries, uiMeta],
  ([$kvEntries, $uiMeta]) => collectLayoutScopes($kvEntries, $uiMeta as Record<string, unknown> | null),
);

export const recoverySessionItems = derived(
  [allInstances, bindings, ptySessions],
  ([$instances, $bindings, $ptySessions]) =>
    buildRecoverySessionItems($instances, $bindings, $ptySessions),
);

export const recoveryScopeSummaries = derived(
  [recoverySessionItems, recoveryLayoutScopes],
  ([$sessionItems, $layoutScopes]) => buildRecoveryScopeSummaries($sessionItems, $layoutScopes),
);

export const defaultHomeSection = derived(
  [recoverySessionItems, recoveryScopeSummaries],
  ([$sessionItems, $scopeSummaries]) => {
    const hasLayoutOnlyScopes = $scopeSummaries.some(
      (scope) => scope.layoutOnly && scope.layoutNodeCount > 0,
    );
    const hasRecoverableSessions = $sessionItems.some(
      (item) => item.status === 'online' || item.status === 'stale' || item.status === 'offline',
    );
    if (hasRecoverableSessions || hasLayoutOnlyScopes) {
      return 'sessions';
    }
    return 'start';
  },
);

export const builtInThemeProfiles = themeProfiles;
