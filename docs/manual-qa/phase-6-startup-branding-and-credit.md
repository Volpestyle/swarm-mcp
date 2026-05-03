# Phase 6 Startup Branding Manual QA

1. Open `/Users/mathewfrazier/Applications/Swarm UI Lab.app` and land on Home with the Tron Encom OS theme active.
Expected: the prior full-screen FrazierCode Agentic start image appears with the centered play button.

2. Click the centered play button.
Expected: the app enters the canvas normally.

3. Open FrazierCode `[Agentic]`.
Expected: the FrazierCode Agentic raster artwork is visible in the archive panel.

4. Open Inspect, then Art Preview.
Expected: the FrazierCode Agentic raster artwork is visible alongside the project folder preview.

5. Open Settings and adjust Opacity Override.
Expected: `0%` is fully clear/glassy and `100%` is fully black/opaque on the main surfaces.

6. Resize Home to a narrow viewport by dragging the app window edge or corner inward.
Expected: this means making the app window itself skinny, not zooming, not resizing a sidebar, and not resizing a canvas node. The start image and play button should remain usable without clipping.
