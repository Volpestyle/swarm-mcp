import { readable } from 'svelte/store';
import type { SystemLoadSnapshot } from '../lib/types';
import { scanSystemLoad } from './pty';

const SYSTEM_LOAD_REFRESH_MS = 15_000;

export const systemLoadSnapshot = readable<SystemLoadSnapshot | null>(null, (set) => {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function refresh(): Promise<void> {
    try {
      const snapshot = await scanSystemLoad(null);
      if (!disposed) set(snapshot);
    } catch {
      if (!disposed) set(null);
    } finally {
      if (!disposed) {
        timer = setTimeout(refresh, SYSTEM_LOAD_REFRESH_MS);
      }
    }
  }

  void refresh();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  };
});
