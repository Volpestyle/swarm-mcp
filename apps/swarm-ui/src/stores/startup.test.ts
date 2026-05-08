import { describe, expect, it } from 'bun:test';

import type { BindingState, Instance, KvEntry, PtySession } from '../lib/types';
import { getThemeProfile } from '../lib/themeProfiles';
import {
  resolveAppearanceState,
  resolveBackdropBlurPixels,
  resolveBackgroundSurfaceAlphas,
  resolveChromeBackgroundSurfaces,
  resolveWindowVibrancyMaterial,
} from './appearance';
import {
  READABLE_LAUNCH_MAX_BACKDROP_BLUR,
  READABLE_LAUNCH_MIN_BACKGROUND_OPACITY,
  appendRecentDirectory,
  buildRecoverySessionItems,
  buildRecoveryScopeSummaries,
  collectLayoutScopes,
  formatScopeLabel,
  normalizeStartupPreferencesForLaunch,
  normalizeStartupPreferences,
} from './startup';

function makeKvEntry(scope: string, value: unknown): KvEntry {
  return {
    scope,
    key: 'ui/layout',
    value: JSON.stringify(value),
    updated_at: 0,
  };
}

describe('startup preferences helpers', () => {
  it('prepends and deduplicates recent directories', () => {
    const result = appendRecentDirectory(
      ['/Users/mathewfrazier/Desktop/beta', '/Users/mathewfrazier/Desktop/alpha'],
      '/Users/mathewfrazier/Desktop/alpha',
      3,
    );

    expect(result).toEqual([
      '/Users/mathewfrazier/Desktop/alpha',
      '/Users/mathewfrazier/Desktop/beta',
    ]);
  });

  it('includes layout-only scopes from scoped ui/layout data', () => {
    const layoutScopes = collectLayoutScopes(
      [
        makeKvEntry('/Users/mathewfrazier/Desktop/project-a', {
          nodes: {
            alpha: { x: 10, y: 20 },
          },
        }),
      ],
      {
        '/Users/mathewfrazier/Desktop/project-b::ui/layout': {
          nodes: {
            beta: { x: 30, y: 40 },
            gamma: { x: 50, y: 60 },
          },
        },
      },
    );
    const summaries = buildRecoveryScopeSummaries([], layoutScopes);

    expect(summaries).toEqual([
      {
        scope: '/Users/mathewfrazier/Desktop/project-a',
        layoutNodeCount: 1,
        sessionCount: 0,
        liveCount: 0,
        staleCount: 0,
        offlineCount: 0,
        adoptingCount: 0,
        layoutOnly: true,
      },
      {
        scope: '/Users/mathewfrazier/Desktop/project-b',
        layoutNodeCount: 2,
        sessionCount: 0,
        liveCount: 0,
        staleCount: 0,
        offlineCount: 0,
        adoptingCount: 0,
        layoutOnly: true,
      },
    ]);
  });

  it('formats path-like and fresh scope labels clearly', () => {
    expect(formatScopeLabel('auto')).toBe('auto');
    expect(formatScopeLabel('/Users/mathewfrazier/Desktop/auto')).toBe('Desktop/auto');
    expect(
      formatScopeLabel('/Users/mathewfrazier/Desktop/swarm-mcp-active#fresh-20260421t050000z'),
    ).toBe('Desktop/swarm-mcp-active fresh');
  });

  it('includes orphan harness PTYs as clearable stale sessions', () => {
    const bindingState: BindingState = { pending: [], resolved: [] };
    const pty: PtySession = {
      id: 'pty-1',
      command: 'codex',
      cwd: '/Users/mathewfrazier/Desktop/project-a',
      started_at: 100,
      exit_code: null,
      bound_instance_id: null,
      launch_token: null,
      cols: 120,
      rows: 40,
      lease: null,
    };

    const items = buildRecoverySessionItems(
      new Map<string, Instance>(),
      bindingState,
      new Map([[pty.id, pty]]),
    );

    expect(items).toMatchObject([
      {
        id: 'pty-1',
        kind: 'orphan_pty',
        instanceId: null,
        ptyId: 'pty-1',
        scope: '/Users/mathewfrazier/Desktop/project-a',
        status: 'stale',
        action: 'cleanup_orphan',
      },
    ]);
  });
});

describe('resolveAppearanceState', () => {
  it('applies the selected theme profile and explicit opacity override', () => {
    const state = resolveAppearanceState('operator-amber', 0.91, null);

    expect(state.themeProfile.id).toBe('operator-amber');
    expect(state.backgroundOpacity).toBe(0.91);
    expect(state.backdropBlur).toBe(36);
    expect(state.terminalTheme.background).toBe('#0d0a04');
    expect(state.terminalTheme.cursor).toBe('#ffc14d');
  });

  it('falls back to the theme default opacity when there is no override', () => {
    const state = resolveAppearanceState('arctic-console', null, null);

    expect(state.themeProfile.id).toBe('arctic-console');
    expect(state.backgroundOpacity).toBe(0.62);
    expect(state.backdropBlur).toBe(58);
    expect(state.terminalTheme.background).toBe('#0f1924');
  });

  it('allows a fully glassy zero-opacity override', () => {
    const state = resolveAppearanceState('tron-encom-os', 0, 0);

    expect(state.themeProfile.id).toBe('tron-encom-os');
    expect(state.backgroundOpacity).toBe(0);
    expect(state.backdropBlur).toBe(0);
  });

  it('maps the opacity override from fully clear to fully black surfaces', () => {
    expect(resolveBackgroundSurfaceAlphas(0)).toMatchObject({
      canvas: 0,
      panel: 0,
      sidebar: 0,
      node: 0,
      header: 0,
    });
    expect(resolveBackgroundSurfaceAlphas(1)).toMatchObject({
      canvas: 1,
      panel: 1,
      sidebar: 1,
      node: 1,
      header: 1,
    });
  });

  it('applies opacity to Encom chrome background tokens', () => {
    const chrome = getThemeProfile('tron-encom-os').chrome;

    expect(chrome).toBeDefined();
    expect(resolveChromeBackgroundSurfaces(chrome!, 0)).toMatchObject({
      bgBase: 'rgba(0, 0, 0, 0.000)',
      bgPanel: 'rgba(5, 7, 10, 0.000)',
      bgElevated: 'rgba(11, 15, 20, 0.000)',
      bgInput: 'rgba(2, 4, 10, 0.000)',
    });
    expect(resolveChromeBackgroundSurfaces(chrome!, 0.5)).toMatchObject({
      bgBase: 'rgba(0, 0, 0, 0.500)',
      bgPanel: 'rgba(5, 7, 10, 0.500)',
      bgElevated: 'rgba(11, 15, 20, 0.500)',
      bgInput: 'rgba(2, 4, 10, 0.500)',
    });
  });

  it('maps blur overrides independently from opacity', () => {
    expect(resolveBackdropBlurPixels(0)).toEqual({
      surface: '0px',
      sidebar: '0px',
    });
    expect(resolveBackdropBlurPixels(50)).toEqual({
      surface: '21px',
      sidebar: '35px',
    });
    expect(resolveAppearanceState('tron-encom-os', 0, 75)).toMatchObject({
      backgroundOpacity: 0,
      backdropBlur: 75,
    });
  });

  it('enables native window vibrancy for any non-zero blur override', () => {
    expect(resolveWindowVibrancyMaterial('tron-encom-os', 0)).toBeNull();
    expect(resolveWindowVibrancyMaterial('tron-encom-os', 75)).toBe('hud_window');
    expect(resolveWindowVibrancyMaterial('liquid-glass-cool', 82)).toBe('hud_window');
  });
});

describe('normalizeStartupPreferences', () => {
  it('preserves an explicit zero-opacity override', () => {
    const prefs = normalizeStartupPreferences({
      backgroundOpacityOverride: 0,
    });

    expect(prefs.backgroundOpacityOverride).toBe(0);
  });

  it('preserves an explicit zero-blur override', () => {
    const prefs = normalizeStartupPreferences({
      backdropBlurOverride: 0,
    });

    expect(prefs.backdropBlurOverride).toBe(0);
  });

  it('preserves the selected launch profile id', () => {
    const prefs = normalizeStartupPreferences({
      selectedLaunchProfileId: 'trusted-local',
    });

    expect(prefs.selectedLaunchProfileId).toBe('trusted-local');
  });

  it('ignores legacy launcher scopes unless they are explicitly pinned', () => {
    const prefs = normalizeStartupPreferences({
      launchDefaults: {
        harness: 'codex',
        role: 'implementer',
        scope: '/old-channel',
        scopePinned: false,
      },
    });

    expect(prefs.launchDefaults.scope).toBe('');
    expect(prefs.launchDefaults.scopePinned).toBe(false);
  });

  it('preserves explicitly pinned launcher scopes', () => {
    const prefs = normalizeStartupPreferences({
      launchDefaults: {
        harness: 'codex',
        role: 'implementer',
        scope: '/Users/mathewfrazier/Desktop',
        scopePinned: true,
      },
    });

    expect(prefs.launchDefaults.scope).toBe('/Users/mathewfrazier/Desktop');
    expect(prefs.launchDefaults.scopePinned).toBe(true);
  });

  it('corrects unreadable saved appearance values on launch', () => {
    const prefs = normalizeStartupPreferencesForLaunch({
      themeProfileId: 'tron-encom-os',
      backgroundOpacityOverride: 0,
      backdropBlurOverride: 100,
    });

    expect(prefs.backgroundOpacityOverride).toBe(READABLE_LAUNCH_MIN_BACKGROUND_OPACITY);
    expect(prefs.backdropBlurOverride).toBe(READABLE_LAUNCH_MAX_BACKDROP_BLUR);
  });

  it('corrects over-glassy theme defaults on launch without changing the selected theme', () => {
    const prefs = normalizeStartupPreferencesForLaunch({
      themeProfileId: 'liquid-glass-cool',
      backgroundOpacityOverride: null,
      backdropBlurOverride: null,
    });

    expect(prefs.themeProfileId).toBe('liquid-glass-cool');
    expect(prefs.backgroundOpacityOverride).toBe(READABLE_LAUNCH_MIN_BACKGROUND_OPACITY);
    expect(prefs.backdropBlurOverride).toBe(READABLE_LAUNCH_MAX_BACKDROP_BLUR);
  });
});
