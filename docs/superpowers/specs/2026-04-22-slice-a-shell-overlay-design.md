# Slice A — Hybrid Shell Overlay

Date: 2026-04-22
Repo: `/Users/mathewfrazier/Desktop/swarm-mcp-active`
Status: implemented in this slice

## Purpose

Finish the current Encom direction without drifting into the larger product overhaul.

This slice is only about the shell and composition:

- keep the graph as the visual primary surface
- replace the oppressive full-height sidebar with a lighter hybrid shell
- let Launch, Chat, and Inspect read as floating overlays over the graph
- make the opacity control actually capable of a glassy/open feel
- use `DarkFolder.png` as a real UI asset, not just a mood reference

## Design Thesis

The app should feel like a paused strategy game or orchestration deck:

- the graph keeps running visually in the background
- controls stay readable and reachable
- the menu no longer owns the whole right edge
- shell chrome feels like illuminated hardware floating over the grid

## In Scope

### 1. Hybrid shell model

- Remove the persistent wide right sidebar as the main shell.
- Replace it with:
  - a thin persistent mode rail on the right
  - a floating shell surface that opens over the graph
- Keep the graph visible behind the shell at all times while in canvas mode.

### 2. Floating shell surface

- Launch, Chat, and Inspect render inside one shared floating surface.
- The surface:
  - sits above the graph, not flush to the window edge
  - leaves the bottom status bar and most of the canvas visible
  - keeps the active surface readable without turning the app back into a giant side panel
- The active surface should be dismissible without hiding the mode rail.

### 3. DarkFolder actual usage

- `DarkFolder.png` is used as a real shell asset.
- In this slice it is applied to:
  - active mode-button tab treatment
  - floating shell header ornament / silhouette
- It is intentionally decorative-structural, not illustrative wallpaper.

### 4. Real transparency range

- The opacity override must match the UI copy.
- Low values should produce genuinely glassy surfaces.
- Current hard clamps that keep panels near-opaque are removed.
- The graph grid and desktop/window content behind the app should read through much more clearly.

## Out of Scope

These are explicitly deferred:

- plus-button creation flows
- project/folder/note/protocol objects
- project containment and agent occupancy glow
- agent card view / editable role behavior
- protocol hierarchy visualization
- project page / kanban / moodboards
- separate `Encom Glass Theme`
- separate `DarkFolder Silhouette Theme`

## Implementation Notes

### App shell

- `App.svelte` becomes the integration point for:
  - mode rail state
  - floating surface open/close state
  - surface width persistence
  - surface tab switching

### Existing panels

- `Launcher`, `ConversationPanel`, and `Inspector` are reused.
- This slice changes how they are mounted, not their core behavior.

### Status bar

- The status bar should stay centered in the real canvas instead of shifting to compensate for a full-width sidebar.

### Opacity model

- The range remains `0–100` in settings.
- Appearance math should map the slider more directly to visible transparency:
  - very low values: highly translucent glass
  - mid values: translucent HUD panels
  - high values: solid console surfaces

## Manual Verification

1. Enter canvas mode and confirm the graph remains visible behind the shell surface.
2. Toggle Launch, Chat, and Inspect from the right mode rail.
3. Close the floating shell and confirm the rail remains available.
4. Resize the floating shell and reload; width should persist.
5. Use the opacity slider at low values and confirm the shell becomes genuinely see-through.
6. Confirm `DarkFolder.png` is visibly used in the active shell chrome.
7. Confirm the status bar remains visually centered and no longer compensates for a wide sidebar.

## Acceptance Bar

Slice A is successful when the shell stops feeling like a heavy app sidebar and starts feeling like a light orchestration overlay that floats over a still-primary graph.
