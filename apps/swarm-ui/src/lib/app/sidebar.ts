const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 900;
const SIDEBAR_STORAGE_KEY = 'swarm-ui:sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'swarm-ui:sidebar-collapsed';

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width));
}

export function loadSidebarState(): {
  width: number;
  collapsed: boolean;
} {
  let width = 320;
  let collapsed = false;

  if (typeof window === 'undefined') {
    return { width, collapsed };
  }

  const saved = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (saved) {
    const parsed = Number.parseInt(saved, 10);
    if (Number.isFinite(parsed)) {
      width = clampSidebarWidth(parsed);
    }
  }

  collapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  return { width, collapsed };
}

export function persistSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    SIDEBAR_STORAGE_KEY,
    String(Math.round(clampSidebarWidth(width))),
  );
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

export function resolveSidebarWidth(
  viewportWidth: number,
  pointerClientX: number,
): number {
  return clampSidebarWidth(viewportWidth - pointerClientX);
}
