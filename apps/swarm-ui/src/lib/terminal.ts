// =============================================================================
// terminal.ts — ghostty-web terminal lifecycle
//
// Single code path: the only terminal backend is `ghostty-web` (Coder's
// WASM-backed, xterm.js-API-compatible port of Ghostty's VT parser).
//
// Architecture rules:
// - Terminal rendering MUST NOT trigger graph recomputation.
// - PTY byte streams go directly into term.write(), never through stores.
// - Lifecycle is tied to Svelte onMount/onDestroy in TerminalNode.svelte.
// =============================================================================

import { init, Terminal } from 'ghostty-web';
import type { TerminalHandle, TerminalOptions, TerminalTheme } from './types';

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_FONT_FAMILY = "'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', monospace";

// Catppuccin Mocha. Background must be fully opaque — ghostty-web's canvas
// renderer composites bg paints without clearing first, so any alpha < 1 causes
// previous frames to ghost through (visible on `clear`, selection drops, etc).
const DEFAULT_THEME: Required<TerminalTheme> = {
  background: '#181825',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

let handleCounter = 0;
let initPromise: Promise<void> | null = null;

function parsePixels(value: string): number {
  return Number.parseInt(value, 10) || 0;
}

/** Loads the ghostty-web WASM module once. Shared across all terminals. */
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/** Create a ghostty-web terminal attached to `container`. */
export async function createTerminal(
  container: HTMLElement,
  options?: TerminalOptions,
): Promise<TerminalHandle> {
  await ensureInit();

  const id = `term-${++handleCounter}`;
  const resolved = resolveOptions(options);

  const term = new Terminal({
    fontSize: resolved.fontSize,
    fontFamily: resolved.fontFamily,
    allowTransparency: true,
    cursorBlink: true,
    theme: resolved.theme,
  });

  let disposed = false;
  let resizeFrame = 0;
  let resizeObserver: ResizeObserver | null = null;

  const fitToContainer = () => {
    if (disposed) return;

    const element = term.element;
    const renderer = term.renderer;
    const metrics = renderer?.getMetrics?.();
    if (!element || !metrics || metrics.width === 0 || metrics.height === 0) {
      return;
    }

    const computed = window.getComputedStyle(element);
    const horizontalPadding =
      parsePixels(computed.paddingLeft) + parsePixels(computed.paddingRight);
    const verticalPadding =
      parsePixels(computed.paddingTop) + parsePixels(computed.paddingBottom);
    const usableWidth = element.clientWidth - horizontalPadding;
    const usableHeight = element.clientHeight - verticalPadding;
    if (usableWidth <= 0 || usableHeight <= 0) return;

    const cols = Math.max(2, Math.floor(usableWidth / metrics.width));
    const rows = Math.max(1, Math.floor(usableHeight / metrics.height));
    if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
    }
  };

  const scheduleFit = () => {
    if (disposed || resizeFrame !== 0) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      fitToContainer();
    });
  };

  term.open(container);
  fitToContainer();

  resizeObserver = new ResizeObserver(() => {
    scheduleFit();
  });
  resizeObserver.observe(container);

  // Refit again after layout and after fonts settle. We remeasure first so the
  // terminal grid tracks the real glyph metrics rather than fallback-font math.
  requestAnimationFrame(() => requestAnimationFrame(scheduleFit));
  if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts.ready
      .then(() => {
        term.renderer?.remeasureFont?.();
        scheduleFit();
      })
      .catch(() => {});
  }

  return {
    id,
    write: (data) => term.write(data),
    resize: () => fitToContainer(),
    getSize: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => term.focus(),
    dispose: () => {
      disposed = true;
      if (resizeFrame !== 0) {
        cancelAnimationFrame(resizeFrame);
      }
      resizeObserver?.disconnect();
      term.dispose();
    },
    onData: (cb) => {
      const disp = term.onData(cb);
      return () => disp.dispose();
    },
    onResize: (cb) => {
      const disp = term.onResize(cb);
      return () => disp.dispose();
    },
  };
}

export function destroyTerminal(handle: TerminalHandle): void {
  handle.dispose();
}

export function writeToTerminal(
  handle: TerminalHandle,
  data: Uint8Array | string,
): void {
  handle.write(data);
}

export function resizeTerminal(
  handle: TerminalHandle,
  cols: number,
  rows: number,
): void {
  handle.resize(cols, rows);
}

interface ResolvedOptions {
  fontSize: number;
  fontFamily: string;
  theme: Required<TerminalTheme>;
}

function resolveOptions(options?: TerminalOptions): ResolvedOptions {
  return {
    fontSize: options?.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: options?.fontFamily ?? DEFAULT_FONT_FAMILY,
    theme: { ...DEFAULT_THEME, ...options?.theme },
  };
}
