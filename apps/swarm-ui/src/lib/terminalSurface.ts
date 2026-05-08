import { get, writable, type Readable } from 'svelte/store';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { PtySession, TerminalHandle } from './types';
import {
  createTerminal,
  destroyTerminal,
  refitTerminal,
  writeToTerminal,
} from './terminal';
import { appearance } from '../stores/appearance';
import {
  LOCAL_PTY_LEASE_HOLDER,
  getPtySessionSnapshot,
  isMobileControlledSession,
  ptySessions,
  requestPtyLease,
  getPtyBuffer,
  markPtyTerminalReady,
  resizePty,
  subscribeToPty,
  subscribeToPtyExit,
  writeToPty,
} from '../stores/pty';

const surfaces = new Map<string, TerminalSurface>();

type SurfaceAttachment = {
  ready: Promise<void>;
  stable: Promise<void>;
  release: () => void;
};

type SurfaceOptions = {
  fontSize?: number;
};

const DEFAULT_FONT_SIZE = 14;

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

class TerminalSurface {
  readonly ptyId: string;
  readonly host: HTMLDivElement;
  readonly exitCode: Readable<number | null>;

  private readonly setExitCode: (value: number | null) => void;
  private readonly fontSize: number;
  private readonly onDispose: (ptyId: string) => void;
  private handle: TerminalHandle | null = null;
  private initPromise: Promise<void> | null = null;
  private inputUnlisten: (() => void) | null = null;
  private dataUnlisten: UnlistenFn | null = null;
  private exitUnlisten: UnlistenFn | null = null;
  private sessionUnlisten: (() => void) | null = null;
  private appearanceUnlisten: (() => void) | null = null;
  private focusInListener: (() => void) | null = null;
  private attachedAnchor: HTMLElement | null = null;
  private exitCodeValue: number | null = null;
  private currentSession: PtySession | null = null;
  private mobileControlled = false;
  private suppressResizeSync = false;
  private reclaimingDesktopControl = false;
  private leaseRequestPromise: Promise<void> | null = null;
  private lastDesktopSize: { cols: number; rows: number } | null = null;
  private disposed = false;

  constructor(
    ptyId: string,
    options: SurfaceOptions,
    onDispose: (ptyId: string) => void,
  ) {
    const exitCodeStore = writable<number | null>(null);

    this.ptyId = ptyId;
    this.fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
    this.onDispose = onDispose;
    this.exitCode = { subscribe: exitCodeStore.subscribe };
    this.setExitCode = exitCodeStore.set;
    this.host = document.createElement('div');
    this.host.className = 'terminal-container nodrag nopan nowheel';
    this.host.dataset.ptySurface = ptyId;
  }

  attach(anchor: HTMLElement): SurfaceAttachment {
    this.attachedAnchor = anchor;
    if (this.host.parentElement !== anchor) {
      anchor.appendChild(this.host);
    }

    const ready = this.ensureInitialized().then(() => {
      if (this.disposed || this.attachedAnchor !== anchor) return;
      this.refit();
    });

    const stable = ready.then(async () => {
      if (this.disposed || this.attachedAnchor !== anchor) return;
      await this.waitForStableAttach(anchor);
    });

    return {
      ready,
      stable,
      release: () => {
        this.release(anchor);
      },
    };
  }

  focus(): void {
    if (this.handle) {
      this.handle.focus();
      return;
    }

    const target = this.host.querySelector(
      'textarea, .xterm-helper-textarea, [tabindex]',
    ) as HTMLElement | null;
    target?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.inputUnlisten?.();
    this.dataUnlisten?.();
    this.exitUnlisten?.();
    this.sessionUnlisten?.();
    this.appearanceUnlisten?.();
    this.inputUnlisten = null;
    this.dataUnlisten = null;
    this.exitUnlisten = null;
    this.sessionUnlisten = null;
    this.appearanceUnlisten = null;
    if (this.focusInListener) {
      this.host.removeEventListener('focusin', this.focusInListener, true);
      this.focusInListener = null;
    }

    if (this.host.parentElement) {
      this.host.parentElement.removeChild(this.host);
    }

    if (this.handle) {
      destroyTerminal(this.handle);
      this.handle = null;
    }

    this.attachedAnchor = null;
    this.initPromise = null;
    this.onDispose(this.ptyId);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.handle) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const handle = await createTerminal(this.host, { fontSize: this.fontSize });

      if (this.disposed) {
        handle.dispose();
        return;
      }

      this.handle = handle;
      const encoder = new TextEncoder();

      this.appearanceUnlisten = appearance.subscribe((nextAppearance) => {
        this.handle?.setTheme(nextAppearance.terminalTheme);
      });

      this.inputUnlisten = handle.onData((input: string) => {
        void this.forwardInput(input, encoder);
      });

      handle.onResize(({ cols, rows }) => {
        if (this.suppressResizeSync) return;
        if (!this.mobileControlled) {
          this.lastDesktopSize = { cols, rows };
        }
        void this.syncViewportToPty();
      });

      if (!this.sessionUnlisten) {
        this.sessionUnlisten = ptySessions.subscribe((sessions) => {
          this.handleSessionUpdate(sessions.get(this.ptyId) ?? null);
        });
      }

      this.handleSessionUpdate(this.currentSession ?? getPtySessionSnapshot(this.ptyId));
      void this.syncViewportToPty();
      markPtyTerminalReady(this.ptyId);
      this.focusInListener = () => {
        if (this.mobileControlled) return;
        void this.syncViewportToPty();
      };
      this.host.addEventListener('focusin', this.focusInListener, true);

      const [buffer, dataListener, exitListener] = await Promise.all([
        getPtyBuffer(this.ptyId).catch((err) => {
          console.debug('[terminalSurface] buffer replay skipped:', err);
          return null;
        }),
        subscribeToPty(this.ptyId, (bytes) => {
          if (this.handle) writeToTerminal(this.handle, bytes);
        }).catch((err) => {
          console.error('[terminalSurface] failed to subscribe to PTY data:', err);
          return null;
        }),
        subscribeToPtyExit(this.ptyId, (code) => {
          this.exitCodeValue = code;
          this.setExitCode(code);
          this.disposeIfOrphaned();
        }).catch((err) => {
          console.error('[terminalSurface] failed to subscribe to PTY exit:', err);
          return null;
        }),
      ]);

      if (this.disposed) {
        dataListener?.();
        exitListener?.();
        return;
      }

      this.dataUnlisten = dataListener;
      this.exitUnlisten = exitListener;

      if (buffer && buffer.length > 0 && this.handle) {
        writeToTerminal(this.handle, buffer);
      }

    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  private refit(): void {
    if (!this.handle) return;
    if (this.mobileControlled && this.currentSession) {
      this.applyRemoteViewport(this.currentSession);
      return;
    }
    refitTerminal(this.handle);
    void this.syncViewportToPty();
  }

  private repaint(): void {
    this.handle?.repaint();
  }

  private release(anchor: HTMLElement): void {
    if (this.attachedAnchor !== anchor) return;
    this.attachedAnchor = null;

    if (this.host.parentElement === anchor) {
      anchor.removeChild(this.host);
    }

    this.disposeIfOrphaned();
  }

  private disposeIfOrphaned(): void {
    if (this.attachedAnchor) return;
    if (this.exitCodeValue === null) return;
    this.dispose();
  }

  private async waitForStableAttach(anchor: HTMLElement): Promise<void> {
    this.refit();
    await nextAnimationFrame();
    await nextAnimationFrame();

    if (this.disposed || this.attachedAnchor !== anchor) return;

    this.refit();
    this.repaint();
    this.focus();
    await nextAnimationFrame();
    this.refit();
    this.repaint();
  }

  private async forwardInput(
    input: string,
    encoder: TextEncoder,
  ): Promise<void> {
    if (this.mobileControlled) return;
    await this.ensureDesktopLease();
    await writeToPty(this.ptyId, encoder.encode(input));
  }

  private handleSessionUpdate(session: PtySession | null): void {
    const wasMobileControlled = this.mobileControlled;

    this.currentSession = session;
    this.mobileControlled = isMobileControlledSession(session);
    this.host.classList.toggle('mobile-controlled-view', this.mobileControlled);

    if (!this.handle || !session) {
      return;
    }

    if (this.mobileControlled) {
      if (!wasMobileControlled) {
        this.lastDesktopSize = this.handle.getSize();
      }
      this.applyRemoteViewport(session);
      return;
    }

    if (wasMobileControlled) {
      void this.restoreDesktopControl();
    }
  }

  private applyRemoteViewport(session: PtySession): void {
    if (!this.handle) return;
    this.withSuppressedResize(() => {
      this.handle?.setViewportSize(session.cols, session.rows);
    });
  }

  private async restoreDesktopControl(): Promise<void> {
    if (!this.handle || this.reclaimingDesktopControl) return;
    this.reclaimingDesktopControl = true;
    try {
      await this.ensureDesktopLease();

      if (this.lastDesktopSize) {
        const { cols, rows } = this.lastDesktopSize;
        this.withSuppressedResize(() => {
          this.handle?.setViewportSize(cols, rows);
        });
        await resizePty(this.ptyId, cols, rows);
        await nextAnimationFrame();
        await nextAnimationFrame();
      }

      if (!this.mobileControlled) {
        this.withSuppressedResize(() => {
          this.handle?.clearViewportSize();
        });
      }
    } catch (err) {
      console.warn('[terminalSurface] failed to restore desktop control:', err);
    } finally {
      this.reclaimingDesktopControl = false;
    }
  }

  private withSuppressedResize(action: () => void): void {
    this.suppressResizeSync = true;
    try {
      action();
    } finally {
      queueMicrotask(() => {
        this.suppressResizeSync = false;
      });
    }
  }

  private async ensureDesktopLease(): Promise<void> {
    const session = this.currentSession ?? get(ptySessions).get(this.ptyId) ?? null;
    if (this.mobileControlled || isMobileControlledSession(session)) return;
    if (session?.lease?.holder === LOCAL_PTY_LEASE_HOLDER) return;
    if (!this.leaseRequestPromise) {
      this.leaseRequestPromise = requestPtyLease(this.ptyId)
        .catch((err) => {
          throw err;
        })
        .finally(() => {
          this.leaseRequestPromise = null;
        });
    }
    await this.leaseRequestPromise;
  }

  private async syncViewportToPty(): Promise<void> {
    if (!this.handle) return;
    if (this.mobileControlled || this.suppressResizeSync) return;

    try {
      await this.ensureDesktopLease();
      const { cols, rows } = this.handle.getSize();
      if (cols > 0 && rows > 0) {
        this.lastDesktopSize = { cols, rows };
        await resizePty(this.ptyId, cols, rows);
      }
    } catch (err) {
      console.debug('[terminalSurface] PTY resize skipped:', err);
    }
  }
}

export function getTerminalSurface(
  ptyId: string,
  options: SurfaceOptions = {},
): TerminalSurface {
  let surface = surfaces.get(ptyId);
  if (!surface) {
    surface = new TerminalSurface(ptyId, options, (disposedPtyId) => {
      surfaces.delete(disposedPtyId);
    });
    surfaces.set(ptyId, surface);
  }
  return surface;
}

export function disposeAllTerminalSurfaces(): void {
  for (const surface of surfaces.values()) {
    surface.dispose();
  }
  surfaces.clear();
}
