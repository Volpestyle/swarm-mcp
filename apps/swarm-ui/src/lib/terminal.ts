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
import { get } from 'svelte/store';
import type { TerminalHandle, TerminalOptions, TerminalTheme } from './types';
import { appearance } from '../stores/appearance';

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_FAMILY = 'Monaco, Menlo, "Courier New", monospace';

// Mix: ghostty-web demo bg/fg (#1e1e1e / #d4d4d4) over Catppuccin Mocha ANSI
// palette — chrome matches the demo exactly while programs keep the richer
// 16-color palette for syntax highlighting. Background must stay opaque:
// ghostty-web's canvas compositor accumulates alpha paints, so values with
// alpha < 1 ghost prior frames through on clear/selection.
const DEFAULT_THEME: Required<TerminalTheme> = get(appearance).terminalTheme;

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
  let forcedViewport: { cols: number; rows: number } | null = null;

  const applyViewport = (cols: number, rows: number) => {
    if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
    }
  };

  const fitToContainer = () => {
    if (disposed) return;

    if (forcedViewport) {
      applyViewport(forcedViewport.cols, forcedViewport.rows);
      return;
    }

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
    applyViewport(cols, rows);
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

  const repaint = () => {
    if (!term.renderer || !term.wasmTerm) {
      return;
    }
    term.renderer.render(term.wasmTerm, true, term.viewportY, term);
  };

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
    refit: () => fitToContainer(),
    setTheme: (theme) => {
      if (!term.renderer) {
        return;
      }
      term.renderer.setTheme({ ...DEFAULT_THEME, ...theme });
      repaint();
    },
    getSize: () => ({ cols: term.cols, rows: term.rows }),
    setViewportSize: (cols, rows) => {
      forcedViewport = { cols, rows };
      fitToContainer();
    },
    clearViewportSize: () => {
      forcedViewport = null;
      fitToContainer();
    },
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

export function refitTerminal(handle: TerminalHandle): void {
  handle.refit();
}

interface ResolvedOptions {
  fontSize: number;
  fontFamily: string;
  theme: Required<TerminalTheme>;
}

function resolveOptions(options?: TerminalOptions): ResolvedOptions {
  const activeTheme = get(appearance).terminalTheme;
  return {
    fontSize: options?.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: options?.fontFamily ?? DEFAULT_FONT_FAMILY,
    theme: { ...activeTheme, ...options?.theme },
  };
}
