import { derived } from 'svelte/store';
import type {
  EncomChrome,
  TerminalTheme,
  ThemeProfile,
  ThemeProfileId,
  WindowVibrancyMaterial,
} from '../lib/types';
import { getThemeProfile } from '../lib/themeProfiles';
import { startupPreferences } from './startup';

// Per-theme macOS vibrancy material. A non-zero Backdrop Blur override applies
// native vibrancy so the frosted-glass backdrop can blur the desktop behind
// the transparent Tauri window. Themes can opt into a material; themes without
// one use HudWindow when the slider is above zero.
export const THEME_VIBRANCY: Record<ThemeProfileId, WindowVibrancyMaterial> = {
  'tron-encom-os': null,
  'liquid-glass-cool': 'hud_window',
  'liquid-glass-warm': 'hud_window',
  'ghostty-dark': null,
  'solar-dusk': null,
  'arctic-console': null,
  'operator-amber': null,
};

export function resolveWindowVibrancyMaterial(
  themeProfileId: ThemeProfileId,
  backdropBlur: number,
): WindowVibrancyMaterial {
  if (clampBackdropBlur(backdropBlur) <= 0) {
    return null;
  }

  return THEME_VIBRANCY[themeProfileId] ?? 'hud_window';
}

export interface AppearanceState {
  themeProfileId: ThemeProfileId;
  themeProfile: ThemeProfile;
  backgroundOpacity: number;
  backgroundOpacityOverride: number | null;
  backdropBlur: number;
  backdropBlurOverride: number | null;
  terminalTheme: Required<TerminalTheme>;
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

function clampBackgroundOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampBackdropBlur(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function resolveBackdropBlurPixels(backdropBlur: number): {
  surface: string;
  sidebar: string;
} {
  const blur = clampBackdropBlur(backdropBlur);
  if (blur <= 0) {
    return {
      surface: '0px',
      sidebar: '0px',
    };
  }

  const surfacePx = Math.round(blur * 0.42);
  return {
    surface: `${surfacePx}px`,
    sidebar: `${surfacePx + 14}px`,
  };
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const hex = match[1].length === 3
    ? [...match[1]].map((char) => `${char}${char}`).join('')
    : match[1];

  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function alphaHexColor(value: string, alpha: number): string {
  const rgb = parseHexColor(value);
  if (!rgb) {
    return value;
  }

  return rgba(rgb[0], rgb[1], rgb[2], clampBackgroundOpacity(alpha));
}

export function resolveBackgroundSurfaceAlphas(backgroundOpacity: number): {
  canvas: number;
  panel: number;
  sidebar: number;
  node: number;
  header: number;
  border: number;
} {
  const opacity = clampBackgroundOpacity(backgroundOpacity);
  return {
    canvas: opacity,
    panel: opacity,
    sidebar: opacity,
    node: opacity,
    header: opacity,
    border: Math.min(0.82, Math.max(0.12, 0.12 + opacity * 0.7)),
  };
}

export function resolveChromeBackgroundSurfaces(
  chrome: EncomChrome,
  backgroundOpacity: number,
): {
  bgBase: string;
  bgPanel: string;
  bgElevated: string;
  bgInput: string;
} {
  const surfaceAlphas = resolveBackgroundSurfaceAlphas(backgroundOpacity);

  return {
    bgBase: alphaHexColor(chrome.bgBase, surfaceAlphas.canvas),
    bgPanel: alphaHexColor(chrome.bgPanel, surfaceAlphas.panel),
    bgElevated: alphaHexColor(chrome.bgElevated, surfaceAlphas.panel),
    bgInput: alphaHexColor(chrome.bgInput, surfaceAlphas.node),
  };
}

export function resolveAppearanceState(
  themeProfileId: ThemeProfileId,
  backgroundOpacityOverride: number | null,
  backdropBlurOverride: number | null,
): AppearanceState {
  const themeProfile = getThemeProfile(themeProfileId);
  const backgroundOpacity = clampBackgroundOpacity(
    backgroundOpacityOverride ?? themeProfile.appearance.defaultBackgroundOpacity,
  );
  const backdropBlur = clampBackdropBlur(
    backdropBlurOverride ?? themeProfile.appearance.defaultBackdropBlur,
  );

  return {
    themeProfileId: themeProfile.id,
    themeProfile,
    backgroundOpacity,
    backgroundOpacityOverride,
    backdropBlur,
    backdropBlurOverride,
    terminalTheme: themeProfile.terminal,
  };
}

function applyAppearance(state: AppearanceState): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const palette = state.themeProfile.appearance;
  // Tag <html> with the active theme id so CSS rules can scope per theme via
  // [data-theme="tron-encom-os"]. This is what lets the Encom font, dotted
  // grid, and sharp-corner overrides apply without affecting legacy themes.
  root.dataset.theme = state.themeProfileId;
  const surfaceAlphas = resolveBackgroundSurfaceAlphas(state.backgroundOpacity);
  const blurPixels = resolveBackdropBlurPixels(state.backdropBlur);

  root.style.setProperty('--canvas-bg', rgba(...palette.canvasRgb, surfaceAlphas.canvas));
  root.style.setProperty('--panel-bg', rgba(...palette.panelRgb, surfaceAlphas.panel));
  root.style.setProperty('--sidebar-bg', rgba(...palette.sidebarRgb, surfaceAlphas.sidebar));
  root.style.setProperty('--sidebar-blur', blurPixels.sidebar);
  root.style.setProperty('--node-bg', rgba(...palette.nodeRgb, surfaceAlphas.node));
  root.style.setProperty('--node-header-bg', rgba(...palette.nodeHeaderRgb, surfaceAlphas.header));
  root.style.setProperty('--node-border', rgba(...palette.nodeBorderRgb, surfaceAlphas.border));
  root.style.setProperty('--node-border-selected', palette.nodeBorderSelected);
  root.style.setProperty('--node-border-mobile', palette.nodeBorderMobile);
  root.style.setProperty('--node-title-fg', palette.nodeTitleFg);
  root.style.setProperty('--node-status-muted', palette.nodeStatusMuted);
  root.style.setProperty('--node-status-muted-dot', palette.nodeStatusMutedDot);
  root.style.setProperty('--surface-blur', blurPixels.surface);

  root.style.setProperty('--terminal-bg', state.terminalTheme.background);
  root.style.setProperty('--terminal-fg', state.terminalTheme.foreground);
  root.style.setProperty('--terminal-cursor', state.terminalTheme.cursor);
  root.style.setProperty('--terminal-selection', state.terminalTheme.selectionBackground);

  root.style.setProperty('--status-online', palette.statusOnline);
  root.style.setProperty('--status-stale', palette.statusStale);
  root.style.setProperty('--status-offline', palette.statusOffline);
  root.style.setProperty('--status-pending', palette.statusPending);

  root.style.setProperty('--edge-task-open', palette.edgeTaskOpen);
  root.style.setProperty('--edge-task-in-progress', palette.edgeTaskInProgress);
  root.style.setProperty('--edge-task-done', palette.edgeTaskDone);
  root.style.setProperty('--edge-task-failed', palette.edgeTaskFailed);
  root.style.setProperty('--edge-task-cancelled', palette.edgeTaskCancelled);
  root.style.setProperty('--edge-message', palette.edgeMessage);
  root.style.setProperty('--edge-dep-blocked', palette.edgeDepBlocked);
  root.style.setProperty('--edge-dep-satisfied', palette.edgeDepSatisfied);

  root.style.setProperty('--badge-planner', palette.badgePlanner);
  root.style.setProperty('--badge-implementer', palette.badgeImplementer);
  root.style.setProperty('--badge-reviewer', palette.badgeReviewer);
  root.style.setProperty('--badge-researcher', palette.badgeResearcher);
  root.style.setProperty('--badge-shell', palette.badgeShell);
  root.style.setProperty('--badge-custom', palette.badgeCustom);

  // Encom-only chrome tokens. Themes without a `chrome` block clear these so
  // a stale value from a previous theme switch can't bleed into the legacy
  // theme being switched into. The Encom-scoped CSS in app.css consumes these
  // (--led-line, --led-halo, --glow, --bg-base, etc) under [data-theme].
  const chrome = state.themeProfile.chrome;
  if (chrome) {
    root.style.setProperty('--led-line', chrome.ledLine);
    root.style.setProperty('--led-line-s', chrome.ledLineSoft);
    root.style.setProperty('--led-line-x', chrome.ledLineBright);
    root.style.setProperty('--led-halo', chrome.ledHalo);
    root.style.setProperty('--led-halo-x', chrome.ledHaloBright);
    root.style.setProperty('--glow', chrome.glow);
    root.style.setProperty('--glow-s', chrome.glowSoft);
    const chromeSurfaces = resolveChromeBackgroundSurfaces(chrome, state.backgroundOpacity);
    root.style.setProperty('--bg-base', chromeSurfaces.bgBase);
    root.style.setProperty('--bg-panel', chromeSurfaces.bgPanel);
    root.style.setProperty('--bg-elevated', chromeSurfaces.bgElevated);
    root.style.setProperty('--bg-input', chromeSurfaces.bgInput);
    root.style.setProperty('--fg-primary', chrome.fgPrimary);
    root.style.setProperty('--fg-secondary', chrome.fgSecondary);
    root.style.setProperty('--fg-muted', chrome.fgMuted);
    root.style.setProperty('--fg-dim', chrome.fgDim);
    root.style.setProperty('--accent', chrome.accent);
    root.style.setProperty('--accent-dim', chrome.accentDim);
    root.style.setProperty('--c-amber', chrome.accentAmber);
    root.style.setProperty('--c-red', chrome.accentRed);
    root.style.setProperty('--c-violet', chrome.accentViolet);
    root.style.setProperty('--c-tron', chrome.accentTron);
    root.style.setProperty('--grid-color', chrome.gridColor);
  } else {
    // Clear so the next legacy theme doesn't inherit Encom values.
    root.style.removeProperty('--led-line');
    root.style.removeProperty('--led-line-s');
    root.style.removeProperty('--led-line-x');
    root.style.removeProperty('--led-halo');
    root.style.removeProperty('--led-halo-x');
    root.style.removeProperty('--glow');
    root.style.removeProperty('--glow-s');
    root.style.removeProperty('--bg-base');
    root.style.removeProperty('--bg-panel');
    root.style.removeProperty('--bg-elevated');
    root.style.removeProperty('--bg-input');
    root.style.removeProperty('--fg-primary');
    root.style.removeProperty('--fg-secondary');
    root.style.removeProperty('--fg-muted');
    root.style.removeProperty('--fg-dim');
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-dim');
    root.style.removeProperty('--c-amber');
    root.style.removeProperty('--c-red');
    root.style.removeProperty('--c-violet');
    root.style.removeProperty('--c-tron');
    root.style.removeProperty('--grid-color');
  }
}

export const appearance = derived(startupPreferences, ($preferences) =>
  resolveAppearanceState(
    $preferences.themeProfileId,
    $preferences.backgroundOpacityOverride,
    $preferences.backdropBlurOverride,
  ),
);

// Tracks the last vibrancy material actually sent to Tauri so we don't fire
// the invoke on every CSS-var update (subscribe runs on every prefs change).
let lastVibrancyMaterial: WindowVibrancyMaterial | undefined;

async function syncWindowVibrancy(
  themeProfileId: ThemeProfileId,
  backdropBlur: number,
): Promise<void> {
  const material = resolveWindowVibrancyMaterial(themeProfileId, backdropBlur);
  if (material === lastVibrancyMaterial) {
    return;
  }
  lastVibrancyMaterial = material;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('ui_set_window_vibrancy', { material });
  } catch (err) {
    // Non-Tauri environments (tests, web preview) are expected to throw on
    // the dynamic import or the invoke. Stay silent — vibrancy is a native
    // chrome effect with no web equivalent.
    console.debug('[appearance] vibrancy sync skipped:', err);
  }
}

if (typeof window !== 'undefined') {
  appearance.subscribe((value) => {
    applyAppearance(value);
    void syncWindowVibrancy(value.themeProfileId, value.backdropBlur);
  });
}
