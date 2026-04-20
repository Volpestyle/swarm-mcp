// =============================================================================
// focus.ts — Cross-component signal to ask the canvas to focus on one node
//
// Launcher.svelte writes here after a successful spawn; a small helper
// component inside <SvelteFlow> (ViewportFocus.svelte) subscribes and calls
// xyflow's fitView against the requested node once it appears in the graph.
// =============================================================================

import { writable } from 'svelte/store';

export interface FocusRequest {
  nodeId: string;
  /** Monotonically incrementing token so duplicate requests for the same node still re-fire. */
  token: number;
}

let nextToken = 1;

export const focusRequest = writable<FocusRequest | null>(null);

export function requestNodeFocus(nodeId: string): void {
  focusRequest.set({ nodeId, token: nextToken++ });
}
