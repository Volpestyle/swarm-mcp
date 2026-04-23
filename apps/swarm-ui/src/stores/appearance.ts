import { derived } from 'svelte/store';
import type { TerminalTheme, ThemeProfile, ThemeProfileId } from '../lib/types';
import { getThemeProfile } from '../lib/themeProfiles';
import { startupPreferences } from './startup';

export interface AppearanceState {
  themeProfileId: ThemeProfileId;
  themeProfile: ThemeProfile;
  backgroundOpacity: number;
  backgroundOpacityOverride: number | null;
  terminalTheme: Required<TerminalTheme>;
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

function clampBackgroundOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveAppearanceState(
  themeProfileId: ThemeProfileId,
  backgroundOpacityOverride: number | null,
): AppearanceState {
  const themeProfile = getThemeProfile(themeProfileId);
  const backgroundOpacity = clampBackgroundOpacity(
    backgroundOpacityOverride ?? themeProfile.appearance.defaultBackgroundOpacity,
  );

  return {
    themeProfileId: themeProfile.id,
    themeProfile,
    backgroundOpacity,
    backgroundOpacityOverride,
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
  const isEncom = state.themeProfileId === 'tron-encom-os';
  const canvasOpacity = isEncom
    ? state.backgroundOpacity
    : Math.min(0.18, 0.02 + state.backgroundOpacity * 0.16);
  const panelOpacity = isEncom
    ? Math.min(0.94, Math.max(0.02, 0.02 + state.backgroundOpacity * 0.92))
    : Math.min(0.88, Math.max(0.1, 0.1 + state.backgroundOpacity * 0.78));
  const nodeOpacity = isEncom
    ? Math.min(0.94, Math.max(0.03, 0.03 + state.backgroundOpacity * 0.89))
    : Math.min(0.9, Math.max(0.12, 0.12 + state.backgroundOpacity * 0.76));
  const headerOpacity = isEncom
    ? Math.min(0.96, Math.max(0.02, 0.02 + state.backgroundOpacity * 0.94))
    : Math.min(0.92, Math.max(0.08, 0.08 + state.backgroundOpacity * 0.82));
  const borderOpacity = isEncom
    ? Math.min(0.74, Math.max(0.08, 0.08 + state.backgroundOpacity * 0.66))
    : Math.min(0.62, Math.max(0.12, 0.12 + state.backgroundOpacity * 0.5));
  const sidebarOpacity = isEncom
    ? Math.min(0.82, Math.max(0.02, 0.02 + state.backgroundOpacity * 0.8))
    : Math.min(0.56, Math.max(0.08, 0.08 + state.backgroundOpacity * 0.48));
  const blurStrength = Math.round(24 + (1 - state.backgroundOpacity) * 18);
  const surfaceBlur = state.backgroundOpacity < 0.99 ? `${blurStrength}px` : '0px';
  const sidebarBlur = state.backgroundOpacity < 0.99 ? `${blurStrength + 14}px` : '0px';

  root.style.setProperty('--canvas-bg', rgba(...palette.canvasRgb, canvasOpacity));
  root.style.setProperty('--panel-bg', rgba(...palette.panelRgb, panelOpacity));
  root.style.setProperty('--sidebar-bg', rgba(...palette.sidebarRgb, sidebarOpacity));
  root.style.setProperty('--sidebar-blur', sidebarBlur);
  root.style.setProperty('--node-bg', rgba(...palette.nodeRgb, nodeOpacity));
  root.style.setProperty('--node-header-bg', rgba(...palette.nodeHeaderRgb, headerOpacity));
  root.style.setProperty('--node-border', rgba(...palette.nodeBorderRgb, borderOpacity));
  root.style.setProperty('--node-border-selected', palette.nodeBorderSelected);
  root.style.setProperty('--node-border-mobile', palette.nodeBorderMobile);
  root.style.setProperty('--node-title-fg', palette.nodeTitleFg);
  root.style.setProperty('--node-status-muted', palette.nodeStatusMuted);
  root.style.setProperty('--node-status-muted-dot', palette.nodeStatusMutedDot);
  root.style.setProperty('--surface-blur', surfaceBlur);

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
    root.style.setProperty('--bg-base', chrome.bgBase);
    root.style.setProperty('--bg-panel', chrome.bgPanel);
    root.style.setProperty('--bg-elevated', chrome.bgElevated);
    root.style.setProperty('--bg-input', chrome.bgInput);
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
  ),
);

if (typeof window !== 'undefined') {
  appearance.subscribe((value) => {
    applyAppearance(value);
  });
}
