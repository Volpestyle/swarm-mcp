// =============================================================================
// terminal.ts — Terminal initialization and lifecycle helpers
//
// This is the containment boundary for the terminal rendering library.
// Primary target: ghostty-web. Fallback: xterm.js.
//
// If ghostty-web proves unviable in the Tauri webview, ONLY this file needs
// to change — all consumers use the TerminalHandle interface.
//
// Architecture rules:
// - Terminal rendering MUST NOT trigger graph recomputation
// - PTY byte streams go directly into term.write(), never through stores
// - Lifecycle is tied to Svelte onMount/onDestroy in TerminalNode.svelte
// =============================================================================

import type { ITerminalOptions } from 'xterm';
import type { TerminalOptions, TerminalTheme, TerminalHandle } from './types';

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_FONT_FAMILY = 'Menlo, Monaco, "Cascadia Code", monospace';

const DEFAULT_THEME: TerminalTheme = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: 'rgba(51, 70, 124, 0.45)',
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let handleCounter = 0;

/**
 * Whether we're using ghostty-web or the xterm.js fallback.
 * Determined at first createTerminal() call by probing for ghostty-web.
 */
let backend: 'ghostty' | 'xterm' | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a terminal instance attached to the given DOM container.
 *
 * This function detects whether ghostty-web is available and falls back to
 * xterm.js if not. The returned TerminalHandle provides a uniform API
 * regardless of which backend is active.
 */
export function createTerminal(
  container: HTMLElement,
  options?: TerminalOptions,
): TerminalHandle {
  const id = `term-${++handleCounter}`;
  const opts = resolveOptions(options);

  // Detect backend on first call
  if (backend === null) {
    backend = isGhosttyAvailable() ? 'ghostty' : 'xterm';
    console.info(`[terminal] using backend: ${backend}`);
  }

  if (backend === 'ghostty') {
    return createGhosttyTerminal(id, container, opts);
  }

  return createXtermTerminal(id, container, opts);
}

/**
 * Destroy a terminal instance and clean up all resources.
 * Safe to call multiple times.
 */
export function destroyTerminal(handle: TerminalHandle): void {
  handle.dispose();
}

/**
 * Write raw PTY output bytes to the terminal display.
 * This is the hot path — called on every PTY data event.
 */
export function writeToTerminal(handle: TerminalHandle, data: Uint8Array): void {
  handle.write(data);
}

/**
 * Resize the terminal grid. Called from ResizeObserver in TerminalNode.
 */
export function resizeTerminal(handle: TerminalHandle, cols: number, rows: number): void {
  handle.resize(cols, rows);
}

// ---------------------------------------------------------------------------
// ghostty-web backend
// ---------------------------------------------------------------------------

// ghostty-web global type (loaded via script tag or wasm init)
// The exact API shape depends on the ghostty-web version; this is a
// reasonable interface based on available documentation.
interface GhosttyTerminal {
  open(container: HTMLElement): void;
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  onData: (callback: (data: string) => void) => void;
  onResize: (callback: (size: { cols: number; rows: number }) => void) => void;
  dispose(): void;
}

interface GhosttyModule {
  Terminal: new (config: Record<string, unknown>) => GhosttyTerminal;
}

function isGhosttyAvailable(): boolean {
  try {
    // ghostty-web is expected to be loaded as a global or importable module
    return typeof (globalThis as Record<string, unknown>).Ghostty !== 'undefined';
  } catch {
    return false;
  }
}

function getGhosttyModule(): GhosttyModule {
  return (globalThis as Record<string, unknown>).Ghostty as GhosttyModule;
}

function createGhosttyTerminal(
  id: string,
  container: HTMLElement,
  opts: ResolvedOptions,
): TerminalHandle {
  const Ghostty = getGhosttyModule();
  const term = new Ghostty.Terminal({
    fontSize: opts.fontSize,
    fontFamily: opts.fontFamily,
    theme: opts.theme,
  });

  term.open(container);

  // Wire up callbacks (populated by the consumer via the handle)
  let dataCallback: ((data: string) => void) | null = null;
  let resizeCallback: ((size: { cols: number; rows: number }) => void) | null = null;

  term.onData((data) => {
    if (dataCallback) dataCallback(data);
  });

  term.onResize((size) => {
    if (resizeCallback) resizeCallback(size);
  });

  const handle: TerminalHandle & {
    onData: (cb: (data: string) => void) => void;
    onResize: (cb: (size: { cols: number; rows: number }) => void) => void;
  } = {
    id,
    write: (data: Uint8Array) => {
      term.write(data);
    },
    resize: (cols: number, rows: number) => {
      term.resize(cols, rows);
    },
    dispose: () => {
      dataCallback = null;
      resizeCallback = null;
      term.dispose();
    },
    // Extended API for event wiring
    onData: (cb) => { dataCallback = cb; },
    onResize: (cb) => { resizeCallback = cb; },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// xterm.js fallback backend
// ---------------------------------------------------------------------------

// Dynamic import of xterm to avoid bundling it when ghostty-web is available.
// In the scaffold, xterm.js would be an optional dependency.

type XtermTerminal = import('xterm').Terminal;
type XtermModule = typeof import('xterm');

// Lazy-loaded xterm module reference
let xtermModule: XtermModule | null = null;

async function loadXterm(): Promise<XtermModule> {
  if (xtermModule) return xtermModule;
  // Dynamic import — xterm must be in package.json dependencies
  const mod = await import('xterm');
  xtermModule = mod;
  return mod;
}

function createXtermTerminal(
  id: string,
  container: HTMLElement,
  opts: ResolvedOptions,
): TerminalHandle {
  // Since createTerminal is sync, we create a deferred initialization pattern.
  // The terminal starts buffering writes until xterm loads, then replays them.
  const writeBuffer: Uint8Array[] = [];
  let term: XtermTerminal | null = null;
  let disposed = false;
  let dataCallback: ((data: string) => void) | null = null;
  let resizeCallback: ((size: { cols: number; rows: number }) => void) | null = null;
  const disposables: Array<{ dispose: () => void }> = [];

  // Async init
  loadXterm()
    .then((xterm) => {
      if (disposed) return;

      const options: ITerminalOptions = {
        fontSize: opts.fontSize,
        fontFamily: opts.fontFamily,
        allowTransparency: true,
        theme: {
          background: opts.theme.background,
          foreground: opts.theme.foreground,
          cursor: opts.theme.cursor,
          selectionBackground: opts.theme.selectionBackground,
        },
        cursorBlink: true,
        allowProposedApi: true,
      };

      term = new xterm.Terminal(options);

      term.open(container);

      // Replay buffered writes
      for (const chunk of writeBuffer) {
        term.write(chunk);
      }
      writeBuffer.length = 0;

      // Wire up event callbacks
      if (dataCallback) {
        disposables.push(term.onData(dataCallback));
      }
      if (resizeCallback) {
        disposables.push(term.onResize(resizeCallback));
      }
    })
    .catch((err) => {
      console.error('[terminal] failed to load xterm.js:', err);
      // Show fallback message in container
      container.textContent = 'Terminal unavailable: failed to load xterm.js';
    });

  const handle: TerminalHandle & {
    onData: (cb: (data: string) => void) => void;
    onResize: (cb: (size: { cols: number; rows: number }) => void) => void;
  } = {
    id,
    write: (data: Uint8Array) => {
      if (term) {
        term.write(data);
      } else {
        // Buffer until xterm loads
        writeBuffer.push(data);
      }
    },
    resize: (cols: number, rows: number) => {
      if (term) {
        term.resize(cols, rows);
      }
      // Resize before init is a no-op; xterm will use container size on open
    },
    dispose: () => {
      disposed = true;
      dataCallback = null;
      resizeCallback = null;
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      if (term) {
        term.dispose();
        term = null;
      }
      writeBuffer.length = 0;
    },
    // Extended API for event wiring
    onData: (cb) => {
      dataCallback = cb;
      if (term) {
        disposables.push(term.onData(cb));
      }
    },
    onResize: (cb) => {
      resizeCallback = cb;
      if (term) {
        disposables.push(term.onResize(cb));
      }
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Options resolution
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  fontSize: number;
  fontFamily: string;
  theme: Required<TerminalTheme>;
}

function resolveOptions(options?: TerminalOptions): ResolvedOptions {
  return {
    fontSize: options?.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: options?.fontFamily ?? DEFAULT_FONT_FAMILY,
    theme: {
      background: options?.theme?.background ?? DEFAULT_THEME.background!,
      foreground: options?.theme?.foreground ?? DEFAULT_THEME.foreground!,
      cursor: options?.theme?.cursor ?? DEFAULT_THEME.cursor!,
      selectionBackground: options?.theme?.selectionBackground ?? DEFAULT_THEME.selectionBackground!,
    },
  };
}

// ---------------------------------------------------------------------------
// Extended handle type for consumers that need event wiring
// ---------------------------------------------------------------------------

/**
 * Extended terminal handle that includes onData and onResize callbacks.
 * Both ghostty and xterm backends return this extended type, but the
 * base TerminalHandle is the public contract for most consumers.
 */
export type ExtendedTerminalHandle = TerminalHandle & {
  /** Register callback for user keyboard/paste input */
  onData: (cb: (data: string) => void) => void;
  /** Register callback for terminal-initiated resize */
  onResize: (cb: (size: { cols: number; rows: number }) => void) => void;
};

/**
 * Type guard to check if a handle supports the extended event API.
 */
export function isExtendedHandle(
  handle: TerminalHandle,
): handle is ExtendedTerminalHandle {
  return 'onData' in handle && 'onResize' in handle;
}
