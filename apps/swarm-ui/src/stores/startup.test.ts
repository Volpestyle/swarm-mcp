import { describe, expect, it } from 'bun:test';

import type { KvEntry } from '../lib/types';
import { resolveAppearanceState } from './appearance';
import {
  DEFAULT_STARTUP_PREFERENCES,
  appendRecentDirectory,
  buildRecoveryScopeSummaries,
  collectLayoutScopes,
  formatScopeLabel,
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
  it('defaults fresh installs to Tron Encom OS', () => {
    expect(DEFAULT_STARTUP_PREFERENCES.themeProfileId).toBe('tron-encom-os');
  });

  it('prepends and deduplicates recent directories', () => {
    const result = appendRecentDirectory(
      ['/Users/example/Desktop/beta', '/Users/example/Desktop/alpha'],
      '/Users/example/Desktop/alpha',
      3,
    );

    expect(result).toEqual([
      '/Users/example/Desktop/alpha',
      '/Users/example/Desktop/beta',
    ]);
  });

  it('includes layout-only scopes from scoped ui/layout data', () => {
    const layoutScopes = collectLayoutScopes(
      [
        makeKvEntry('/Users/example/Desktop/project-a', {
          nodes: {
            alpha: { x: 10, y: 20 },
          },
        }),
      ],
      {
        '/Users/example/Desktop/project-b::ui/layout': {
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
        scope: '/Users/example/Desktop/project-a',
        layoutNodeCount: 1,
        sessionCount: 0,
        liveCount: 0,
        staleCount: 0,
        offlineCount: 0,
        adoptingCount: 0,
        layoutOnly: true,
      },
      {
        scope: '/Users/example/Desktop/project-b',
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
    expect(formatScopeLabel('/Users/example/Desktop/auto')).toBe('Desktop/auto');
    expect(
      formatScopeLabel('/Users/example/Desktop/swarm-mcp-active#fresh-20260421t050000z'),
    ).toBe('Desktop/swarm-mcp-active fresh');
  });
});

describe('resolveAppearanceState', () => {
  it('applies the selected theme profile and explicit opacity override', () => {
    const state = resolveAppearanceState('operator-amber', 0.91);

    expect(state.themeProfile.id).toBe('operator-amber');
    expect(state.backgroundOpacity).toBe(0.91);
    expect(state.terminalTheme.background).toBe('#0d0a04');
    expect(state.terminalTheme.cursor).toBe('#ffc14d');
  });

  it('falls back to the theme default opacity when there is no override', () => {
    const state = resolveAppearanceState('arctic-console', null);

    expect(state.themeProfile.id).toBe('arctic-console');
    expect(state.backgroundOpacity).toBe(0.62);
    expect(state.terminalTheme.background).toBe('#0f1924');
  });

  it('allows a fully glassy zero-opacity override', () => {
    const state = resolveAppearanceState('tron-encom-os', 0);

    expect(state.themeProfile.id).toBe('tron-encom-os');
    expect(state.backgroundOpacity).toBe(0);
  });
});

describe('normalizeStartupPreferences', () => {
  it('preserves an explicit zero-opacity override', () => {
    const prefs = normalizeStartupPreferences({
      backgroundOpacityOverride: 0,
    });

    expect(prefs.backgroundOpacityOverride).toBe(0);
  });
});
