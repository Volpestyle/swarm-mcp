import { writable } from 'svelte/store';

export interface AppearanceSettings {
  backgroundOpacity: number;
}

const STORAGE_KEY = 'swarm-ui.appearance';

const DEFAULT_APPEARANCE: AppearanceSettings = {
  backgroundOpacity: 0.68,
};

function clampBackgroundOpacity(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_APPEARANCE.backgroundOpacity;
  }

  return Math.min(1, Math.max(0.25, value));
}

function normalizeAppearance(
  value?: Partial<AppearanceSettings> | null,
): AppearanceSettings {
  return {
    backgroundOpacity: clampBackgroundOpacity(
      value?.backgroundOpacity ?? DEFAULT_APPEARANCE.backgroundOpacity,
    ),
  };
}

function loadAppearance(): AppearanceSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_APPEARANCE;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE;
    }

    return normalizeAppearance(JSON.parse(raw) as Partial<AppearanceSettings>);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
}

function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  const canvasOpacity = Math.min(0.18, settings.backgroundOpacity * 0.22);
  const panelOpacity = Math.min(0.92, settings.backgroundOpacity);
  const nodeOpacity = Math.min(0.96, settings.backgroundOpacity + 0.08);
  const headerOpacity = Math.min(0.98, settings.backgroundOpacity + 0.14);
  const terminalOpacity = Math.max(0.18, settings.backgroundOpacity - 0.10);
  const borderOpacity = Math.min(0.60, Math.max(0.28, settings.backgroundOpacity * 0.65));
  const surfaceBlur = settings.backgroundOpacity < 0.98 ? '20px' : '0px';

  root.style.setProperty('--canvas-bg', rgba(17, 17, 27, canvasOpacity));
  root.style.setProperty('--panel-bg', rgba(30, 30, 46, panelOpacity));
  root.style.setProperty('--node-bg', rgba(30, 30, 46, nodeOpacity));
  root.style.setProperty('--node-header-bg', rgba(24, 24, 37, headerOpacity));
  root.style.setProperty('--terminal-bg', rgba(26, 27, 38, terminalOpacity));
  root.style.setProperty('--node-border', rgba(108, 112, 134, borderOpacity));
  root.style.setProperty('--surface-blur', surfaceBlur);
}

function createAppearanceStore() {
  const initialValue = loadAppearance();
  const { subscribe, set, update } = writable(initialValue);

  if (typeof window !== 'undefined') {
    applyAppearance(initialValue);

    subscribe((value) => {
      const normalized = normalizeAppearance(value);
      applyAppearance(normalized);

      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      } catch {
        // Ignore persistence failures and keep the session-local appearance.
      }
    });
  }

  return {
    subscribe,
    setBackgroundOpacity(value: number) {
      update((current) => ({
        ...current,
        backgroundOpacity: clampBackgroundOpacity(value),
      }));
    },
    reset() {
      set(DEFAULT_APPEARANCE);
    },
  };
}

export const appearance = createAppearanceStore();
