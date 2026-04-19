import { writable, type Readable } from 'svelte/store';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { TerminalHandle } from './types';
import {
  createTerminal,
  destroyTerminal,
  refitTerminal,
  writeToTerminal,
} from './terminal';
import {
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
  private attachedAnchor: HTMLElement | null = null;
  private exitCodeValue: number | null = null;
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
    this.inputUnlisten = null;
    this.dataUnlisten = null;
    this.exitUnlisten = null;

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

      this.inputUnlisten = handle.onData((input: string) => {
        void writeToPty(this.ptyId, encoder.encode(input));
      });

      handle.onResize(({ cols, rows }) => {
        void resizePty(this.ptyId, cols, rows);
      });

      try {
        const { cols, rows } = handle.getSize();
        if (cols > 0 && rows > 0) {
          void resizePty(this.ptyId, cols, rows);
        }
      } catch (err) {
        console.debug('[terminalSurface] initial PTY resize skipped:', err);
      }

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

      markPtyTerminalReady(this.ptyId);
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  private refit(): void {
    if (!this.handle) return;
    refitTerminal(this.handle);
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
    await nextAnimationFrame();
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
