# Analyze Overlay and Dead-Node Reconciliation Design

Date: 2026-04-22
Repo: `/Users/mathewfrazier/Desktop/swarm-mcp-active`
Status: proposed, approved for this slice direction pending final spec review

## Purpose

Replace the current thin `Analyze` sidebar page with a large centered operator overlay that can actually explain live machine state, visualize burden clearly, and kill real rogue agent session trees.

This slice also fixes the graph-truth problem that makes dead nodes linger after their backing swarm rows or processes are gone.

The user explicitly chose the implementation order:

1. Do the overlay-first operator deck now
2. Keep the broader shell/operations rethink as a later follow-on phase

## Problem Statement

The current analyzer has two separate failures:

1. Presentation failure
   - the right sidebar is too narrow for operator-grade diagnostics
   - the layout is cluttered, repetitive, and visually weak
   - raw process information is hard to scan
   - charts and graphs are absent or too small to carry meaning

2. Truth failure
   - the graph can remain populated with dead nodes after swarm rows disappear
   - the UI can claim `0 active` while still rendering many historical nodes
   - rogue process trees can continue burning tokens even when the swarm DB is empty

Those need to be fixed together. A more beautiful analyzer without process-truth cleanup would still mislead the operator. A pure backend truth fix without a better analysis surface would still leave the operator staring at a cramped, low-authority UI.

## Design Thesis

Keep the Tron / ENCOM command-deck language, but give analysis its own authoritative stage.

The graph remains the world behind the glass. The analyzer becomes the command center above it.

This should feel like:

- an operations console, not a sidebar form
- real telemetry, not decorative dashboard widgets
- sharp and spacious, not generic card soup
- machine truth first, visualized with confidence, not guessed

## Visual Thesis

Centered command-deck overlay over a dimmed live graph, with thin luminous frames, restrained scanline glow, monospaced telemetry, and one or two dominant visualizations that explain host pressure and rogue-session burden at a glance.

## Content Plan

1. Header and command strip
   - what scan this is, how fresh it is, what scope the graph is on, refresh, kill all, close
2. Hero telemetry
   - dominant visual summaries for host pressure and rogue-session pressure
3. Supporting metrics
   - compact numeric modules for counts, costs, top offenders, and confidence
4. Raw process ledgers
   - exact rows for sessions, helpers, and external burden
5. Footer utility context
   - price catalog date, confidence legend, GPU note, last scan time

## Interaction Thesis

1. Opening `Analyze` should feel like stepping into a command mode: graph dims, overlay rises in place, header and hero telemetry animate in with staggered precision.
2. Live metrics should pulse or sweep subtly when refreshed, but avoid noisy perpetual motion.
3. Row actions should feel deliberate and high-stakes: clear focus, confirm, then the ledger updates and dead graph residue disappears after verification.

## In Scope

### 1. Replace thin Analyze page with centered overlay

- Keep the `Analyze` button in the right mode rail.
- Remove the current narrow analyzer page from the shared shell surface.
- Clicking `Analyze` opens a large centered overlay above the graph.
- The overlay:
  - has a dedicated close `X`
  - supports `Esc` to dismiss
  - dims the graph behind it
  - preserves the Tron / ENCOM shell language

### 2. Build meaningful telemetry visuals

The overlay should include chart-heavy telemetry that maps to real scan values, not filler graphics.

Planned visuals:

- Host Pressure gauge
  - combined CPU / memory burden summary
- Session Pressure strip
  - live counts of agent trees, detached helpers, and external burden
- Summary modules with tiny trend visuals
  - agent sessions
  - hidden / orphan sessions
  - detached helpers
  - estimated live cost
  - top CPU
  - top memory
- Process distribution visual
  - a compact cluster, segmented bar, or burden map derived from real categories

All visuals must have supporting raw numbers adjacent to them.

### 3. Preserve and elevate raw process truth

The overlay must still show dense, scanable raw ledgers:

- `Agent Session Trees`
- `Detached / Helper MCPs`
- `External Burden`

Each row should remain rich enough for real operator decisions:

- root pid / pgid
- child pids or helper set membership
- tty / pty
- instance id and scope when linked
- cwd
- provider / harness / model when known
- runtime
- CPU / memory
- helper count
- token / cost values and confidence labels
- killability and protection messaging

### 4. Real kill behavior for rogue session trees

This slice must support killing the full real process trees, not just deregistering swarm rows.

Supported kill surfaces:

- per-session kill in the overlay
- per-helper kill in the overlay
- machine-wide `Kill All Agent Sessions`
- existing node red close path
- bottom `SwarmStatus` kill-all path

The system must be able to stop cases like:

- terminal Claude session roots with `context7-mcp` children
- detached repo `bun run src/index.ts` MCP processes
- orphan PTYs with surviving children

Protected processes must remain exempt:

- `swarm-server`
- `swarm-ui`
- `tauri dev`
- `vite`
- non-agent external burden processes

### 5. Dead-node reconciliation after verified death

If a node is visually present in the graph but:

- its swarm row is gone, and
- its backing process tree is dead or no longer classifiable as live,

then it must be removed from the graph automatically.

This requires a real fix for stale dead-node persistence, not just a prettier overlay.

Design target:

- after kill or refresh, verified-dead nodes disappear
- the graph should not continue to render old session residue
- the analyzer, DB, and graph should converge back to one truth

## Out of Scope

Explicitly not part of this slice:

- broader shell/operations mode redesign beyond the analyzer overlay
- complete re-architecture of Launch / Chat / Inspect surfaces
- Linux / Windows support
- provider API billing lookups
- speculative GPU metrics
- a decorative animation system disconnected from live scan data
- redesigning the rest of the app into a generic multi-widget analytics dashboard

The broader “option 3” operations rethink is deferred until this overlay-first slice lands.

## UX Structure

### Entry

- `Analyze` remains a mode-rail button
- button state indicates whether the overlay is open

### Overlay layout

Top to bottom:

1. Command header
   - title
   - scan freshness
   - current graph scope
   - refresh
   - kill all
   - close `X`

2. Hero telemetry band
   - large host-load gauge
   - rogue-session burden visualization
   - compact live-stat strip

3. Summary telemetry row
   - high-value metric modules with dense labels and supporting numbers

4. Process ledger body
   - session trees
   - helpers
   - external burden

5. Utility footer
   - confidence legend
   - pricing `as_of`
   - GPU note
   - last scanned timestamp

### Visual direction

- black-charcoal base
- cyan / white outline hierarchy
- restrained warm or toxic accents only when semantically useful
- glow used to emphasize burden and live state, not to bathe the whole screen
- avoid round soft SaaS cards as the primary design grammar
- keep text crisp and operator-readable

## Reference Adaptation

The attached reference dashboards are useful for:

- dominant hero visualizations
- high-information summary modules
- small trend graphics
- making burden “read” immediately

They should not be copied literally.

What to borrow:

- information hierarchy
- visual confidence
- graph-forward telemetry
- live numeric accompaniment

What to avoid:

- generic cybersecurity-marketing copy
- card-grid sameness
- too many competing colors
- visual language that fights the existing ENCOM shell

## Data and Truth Model

Truth priority remains:

1. live OS process truth and analyzer scan
2. `~/.swarm-mcp/swarm.db`
3. graph canvas state

The overlay should communicate this implicitly by:

- treating the scan as the authoritative live source
- showing stale / unlinked / `N/A` states honestly
- never guessing token counts from runtime or CPU

## Technical Design

### Frontend structure

Recommended component split:

- `AnalyzeOverlay.svelte`
  - new centered overlay container
- `AnalyzeHeroTelemetry.svelte`
  - large charts / hero visuals
- `AnalyzeSummaryModules.svelte`
  - compact metric modules
- `AnalyzeLedger.svelte`
  - reusable ledger section shell
- `AnalyzeSessionRow.svelte`
- `AnalyzeHelperRow.svelte`
- `AnalyzeExternalRow.svelte`

The current `AnalyzePanel.svelte` can either be retired or reduced to inner content pieces, but it should no longer be mounted as a thin shell-surface tab page.

### App integration

`App.svelte` becomes responsible for:

- open / close state for the overlay
- preserving the `Analyze` rail button
- dimming the graph behind analysis mode
- hiding the old narrow analyzer content path

### Visual telemetry data

The current `SystemLoadSnapshot` should stay the canonical scan payload for this slice.

View-layer helpers can derive:

- host pressure percentages
- category splits
- top offender emphasis
- visual confidence states

without changing the underlying scan contract unless needed.

### Dead-node fix

This slice should include the watcher/store reconciliation fix for rows that disappear between snapshots.

Likely implementation direction:

- update the watcher delta reconciler to emit removal events when previous snapshot rows are absent from the current snapshot
- ensure Svelte stores actually delete missing instances instead of only merging updates
- keep a fallback full-resnapshot path available for safety, but not as the normal answer

The goal is to make dead-node disappearance automatic, not operator-manual.

## States

### Empty / clean machine

- hero telemetry reads calm, not broken
- session and helper ledgers show explicit empty states
- external burden can still show competing host load if relevant

### Stale graph / real-zero machine

- overlay shows no live agent sessions
- dead nodes are reconciled away on refresh or watcher update
- operator sees the graph clean itself instead of continuing to lie

### Rogue background processes

- overlay shows terminal session trees or detached helpers even when no swarm rows exist
- kill actions remain available
- after kill, rows disappear and dead nodes reconcile away

### Ambiguous attribution

- tokens and cost display `N/A` or `unlinked`
- visuals do not imply false precision

## Manual Verification

1. Open `Analyze` from the rail and confirm a centered overlay appears instead of the narrow sidebar panel.
2. Confirm the graph dims behind the overlay and the overlay closes via `X` and `Esc`.
3. Confirm the hero telemetry and summary modules render meaningful live values from the current scan.
4. Confirm raw process ledgers are readable without excessive wrapping.
5. With live rogue session trees present, use per-row kill and confirm the actual process trees terminate.
6. Use machine-wide kill-all and confirm detached helper MCP processes are removed while `swarm-server` remains alive.
7. Confirm that once rows and processes are truly dead, the graph removes those dead nodes automatically.
8. Confirm a clean machine does not feel empty-broken, and that `N/A` values remain honest.

## Acceptance Bar

This slice is successful when:

- `Analyze` feels like a real command-center overlay instead of a cramped utility sidebar
- the overlay presents visually strong charts and telemetry without abandoning raw operator numbers
- rogue agent trees can be identified and killed from the app
- dead graph residue disappears after verified death
- the graph, analyzer, and machine truth stop contradicting each other in normal operation

## Follow-On Phase

After this slice, the repo can revisit the broader “option 3” operations rethink:

- deeper shell integration
- richer multi-mode operational layouts
- wider system-health views
- expanded cross-platform thinking

That broader redesign is intentionally deferred until the overlay-first slice is shipped and validated.
