// =============================================================================
// fullscreenContext.ts — Context key + type for the FullscreenWorkspace
//
// App.svelte calls setContext(FULLSCREEN_WORKSPACE_CONTEXT, { open }), and
// TerminalNode reads it via getContext to request fullscreen without
// coupling to SvelteFlow's event routing.
// =============================================================================

export const FULLSCREEN_WORKSPACE_CONTEXT = Symbol('fullscreenWorkspace');

export interface FullscreenWorkspaceContext {
  /** Open the workspace with the given node in pane A. */
  open: (nodeId: string) => void;
}
