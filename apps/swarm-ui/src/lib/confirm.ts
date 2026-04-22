// =============================================================================
// confirm.ts — async in-app replacement for window.confirm()
//
// Tauri's WKWebView silently returns false from window.confirm() without
// showing a dialog. This helper exposes a Promise<boolean> API backed by a
// shared Svelte store that <ConfirmModal /> reads from (mounted once in
// App.svelte). Drop-in replacement for `if (!window.confirm(msg)) return;`.
// =============================================================================

import { writable, get } from 'svelte/store';

export type ConfirmRequest = {
  id: number;
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
};

export const currentConfirm = writable<ConfirmRequest | null>(null);

const resolvers = new Map<number, (ok: boolean) => void>();
let nextId = 1;

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  // If a prior confirm is still open (shouldn't happen with awaited usage, but
  // protects against races), resolve it as `false` before showing the new one
  // so the old Promise doesn't leak.
  const prev = get(currentConfirm);
  if (prev) {
    const prevResolver = resolvers.get(prev.id);
    if (prevResolver) {
      resolvers.delete(prev.id);
      prevResolver(false);
    }
  }

  const id = nextId++;
  const request: ConfirmRequest = {
    id,
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel ?? 'OK',
    cancelLabel: options.cancelLabel ?? 'Cancel',
    danger: options.danger ?? false,
  };

  return new Promise<boolean>((resolve) => {
    resolvers.set(id, resolve);
    currentConfirm.set(request);
  });
}

export function respondToConfirm(id: number, ok: boolean): void {
  const resolver = resolvers.get(id);
  if (!resolver) return;
  resolvers.delete(id);
  currentConfirm.set(null);
  resolver(ok);
}
