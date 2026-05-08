import { writable } from 'svelte/store';

// Graph nodes subscribe to this so PTY-backed terminals can suspend while the
// immersive workspace overlay is mounted. That keeps the graph geometry in the
// DOM for FLIP-style open/close animation without double-mounting Ghostty
// against the same PTY sessions.
export const workspaceOverlayActive = writable(false);
