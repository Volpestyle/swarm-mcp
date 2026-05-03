# Agentic Orchestration OS Overhaul Master Spec

Date: 2026-04-22
Repo: `/Users/mathewfrazier/Desktop/swarm-mcp-active`
Execution lane: implement the major overhaul in `swarm-mcp-lab` after copying the current active baseline
Status: draft for review

## Purpose

Define the authority vision, architecture, and phase order for turning `swarm-ui` from a graph of terminal-heavy nodes into an agent orchestration product with first-class agents, projects, assets, and branded launch surfaces.

This spec is intentionally broad and authoritative. Detailed task-by-task implementation plans should be written per phase, not for the whole overhaul at once.

## Product Thesis

The product is not a terminal dashboard.

It is a local-first orchestration OS where:

- the graph is the living stage
- agents feel like real workers with identity and editable behavior
- projects are first-class context spaces
- the terminal is an execution mode, not the whole identity of an agent
- the UI stays minimal, open, high-contrast, and visually impressive without becoming cluttered

## Design Pillars

### 1. Graph-first workspace

The canvas is the primary scene.

- menus, shells, and inspectors float over the graph
- the graph should remain visible as much as possible
- the product should feel closer to a strategy deck or command OS than a panel stack

### 2. Agents over terminals

Agents must be represented as first-class product entities.

- default presentation should be an agent card, not a raw terminal
- terminals remain available but secondary
- identity, skills, permissions posture, and current task must be visible without opening the terminal

### 3. Projects over loose folders

Projects must be first-class spaces inside the product.

- a project is more than a scope string or a directory path
- projects hold notes, protocols, images, screenshots, moodboards, and assigned agents
- project boundaries on the canvas should connect to a dedicated project page

### 4. Deterministic behavior

If the UI allows the user to edit something that implies behavior, it must map to a real runtime effect.

- `mission`, `persona`, `skills`, `memory`, `permissions` must affect bootstrap/runtime configuration
- purely visual settings must be presented as purely visual
- the UI must not imply capabilities it does not actually enforce

### 5. Minimalism with atmosphere

The product must stay sparse and legible even as features grow.

- avoid dashboard-card sprawl
- do not wallpaper the working canvas with branding art
- use strong composition, restrained motion, and limited high-contrast surfaces
- keep the graph open, breathable, and readable

## Core Model

### Agent

An `Agent` is a first-class entity with:

- identity: emoji/avatar, name, provider, role
- behavioral configuration: mission, persona, specialty, skills, memory, permissions posture
- runtime configuration: harness, launch profile, working root, scope behavior
- working state: current task, current project, current focus, health, recent activity
- views: overview, terminal, tasks, context, history

### Terminal Session

A `Terminal Session` is the execution surface attached to an agent runtime.

- it is not the agent itself
- an agent may have a terminal session
- the default card view should not require the terminal to understand the agent

### Launch Profile

A `Launch Profile` is a reusable runtime preset.

It defines:

- harness command or wrapper
- trust/permission posture
- default working directory behavior
- default scope behavior
- optional bootstrap template
- brand-facing label such as `Trusted Local`, `Safe Review`, `Research`, `Visual Design`

### Project Space

A `Project Space` is a first-class workspace construct.

It contains:

- project root and optional additional roots
- project boundary on the canvas
- project page
- notes
- folders
- protocols
- moodboards
- screenshots
- images and other assets
- assigned agents
- task/status overview

### Scope

`Scope` remains a swarm identity and collaboration boundary.

- scope determines who sees whom in the swarm
- scope does not equal sandboxing
- scope should not be overloaded to mean project, security boundary, or asset container

### Asset

An `Asset` is a first-class project object.

Examples:

- image
- screenshot
- note
- protocol
- folder
- reference link

Assets must be previewable and attachable to projects and agents.

### Theme

A `Theme` is a presentation layer.

- themes control color, typography, surface treatment, and motion language
- themes do not change product structure or capabilities

## Architecture Decisions

### 1. Use the existing Tauri desktop shell as the product entrypoint

Current repo state already has the correct base:

- Tauri desktop shell in `apps/swarm-ui`
- live swarm state through the shared SQLite database
- launcher/bootstrap flow through the existing PTY + binder path

The overhaul should extend this foundation rather than replacing it.

### 2. Productize app launch

The product must support a real app-icon launch flow.

- enable Tauri bundling
- define a proper icon set
- support a packaged app launch from Finder/Dock
- preserve developer-mode terminal launch for active development

The long-term user path should not depend on opening a terminal first.

### 3. Make launch trust posture explicit

The product should not hide “full permission” behavior.

Recommended model:

- store per-harness wrapper commands in launch profiles
- surface trust posture visually in the UI
- label dangerous modes clearly

The app can support a helper that opens Terminal with a prefilled command as a transitional path, but the product should prefer direct bundled launch plus explicit harness wrappers.

### 4. Keep swarm state and UI metadata distinct but connected

The existing `swarm.db` remains the source of truth for:

- instances
- tasks
- messages
- locks
- kv

The overhaul should add explicit UI/domain metadata for:

- agent profiles
- projects
- project assets
- project memberships
- protocol graphs
- screenshot records

Recommended direction:

- extend the same local SQLite file with `ui_*` tables or a similarly explicit namespaced schema
- avoid leaving critical product data only in localStorage

### 5. Separate communication, project, and filesystem concepts

These concepts must not be merged:

- `scope`: swarm collaboration boundary
- `working directory/root`: where the runtime starts on disk
- `project space`: semantic grouping of context, assets, and agent assignment

This avoids fake-smart behavior and makes the system understandable.

### 6. Treat images and screenshots as first-class assets, not terminal assumptions

The product should not rely on PTY sessions being reliably multimodal.

Recommended behavior:

- images exist as project assets
- screenshots are captured and stored explicitly
- agents receive file paths, metadata, notes, and asset attachments
- future multimodal analysis can be layered on top

## UX Specification

### Launch

Desired user flow:

1. Click app icon.
2. App opens directly into startup/home.
3. Choose or confirm launch profile and starting location.
4. Enter canvas or open a project.
5. Spawn an agent with one click.
6. Agent launches with explicit runtime posture and visible identity.

### Agent Interaction

Desired user flow:

1. See agents as readable cards on the graph.
2. Open terminal only when needed.
3. Edit bio, mission, skills, and trust posture from the card or inspector.
4. Know what the agent is doing now without parsing terminal text.
5. Talk to the agent through a first-class prompt/message flow, not only through the terminal.

### Project Interaction

Desired user flow:

1. Create or open a project from Home or the canvas.
2. See project boundary on the graph.
3. Drag agents into the project or explicitly attach them.
4. See what assets and notes belong to that project.
5. Open the project page for deeper management.
6. Track which agents are assigned and what they are doing.

### Visual Design Work

Desired user flow:

1. Add images, screenshots, and reference art into a project.
2. Keep them visible in a dedicated project or moodboard surface.
3. Attach those assets to agents or protocols.
4. Avoid relying on raw terminal panes to communicate visual context.

## Visual Direction

### Default theme

`Tron Encom OS` remains the sharp tactical default.

Visual rules:

- black or near-black base
- white LED hairlines and glow for chrome
- limited accent use
- graph-first openness
- minimal clutter

### Separate secondary themes

Future theme split:

- `Encom Glass Deck`: translucent, cinematic, more atmospheric
- `DarkFolder Silhouette`: object/silhouette-led theme built from the folder language

These should be separate themes, not overloaded variants inside the same theme.

### Startup / Home hero

The `FrazierCode Tron 2` artwork should be used in startup/home only.

Recommended treatment:

- wide cropped hero
- darkened/ghosted so text remains calm and legible
- operational UI remains primary
- artwork credit is visible and tasteful

Recommended credit pattern:

- `Artwork by <friend name>` in the hero frame edge and/or About section

### App icon

The app icon should be derived from the visual language, not the full poster.

Recommended mark direction:

- simplified ring/helmet/light-cycle silhouette
- black field
- amber or white/amber linework
- legible at small sizes

## Phase Roadmap

Implementation plans:

- Phase 0: `docs/superpowers/plans/2026-04-22-phase-0-lab-baseline-and-team-execution.md`
- Phase 1: `docs/superpowers/plans/2026-04-22-phase-1-launch-productization.md`
- Phase 2: `docs/superpowers/plans/2026-04-22-phase-2-acceleration-tooling.md`
- Phase 3: `docs/superpowers/plans/2026-04-22-phase-3-agent-identity-overhaul.md`
- Phase 4: `docs/superpowers/plans/2026-04-22-phase-4-project-spaces.md`
- Phase 5: `docs/superpowers/plans/2026-04-22-phase-5-assets-and-multimodal-context.md`
- Phase 6: `docs/superpowers/plans/2026-04-22-phase-6-startup-branding-and-credit.md`
- Phase 7: `docs/superpowers/plans/2026-04-22-phase-7-themes-and-protocol-views.md`

### Phase 0: Baseline Freeze and Lab Setup

Goal:

- preserve the current Encom slice as baseline
- copy active baseline into `swarm-mcp-lab`
- execute the major overhaul in the lab lane

Acceptance:

- active remains usable reference
- lab starts from the same baseline

### Phase 1: Launch Productization

Status: complete

Goal:

- real app icon
- bundled desktop app
- explicit launch profiles and trust postures
- remove “type into terminal to launch the product” as the main path

Acceptance:

- app launches from Finder/Dock
- launch posture is explicit
- harness wrappers are configurable and reusable

### Phase 2: Acceleration Tooling

Status: complete

Goal:

- internal screenshot capture
- CLI control for key UI actions
- export/import and visual regression support

Acceptance:

- app state can be captured and reviewed quickly
- agents and scripts can operate the UI more directly

### Post-Phase-2 Reliability Sync: Listener Health

Status: complete

Goal:

- make agent listening state observable before Phase 3 changes the node presentation
- expose whether agents are polling messages, sitting in `wait_for_activity`, carrying unread work, or merely alive by heartbeat
- keep the real multi-agent workflow from stalling silently when a node looks active but is not consuming swarm work

Acceptance:

- `poll_messages` emits `agent.polled`, including empty polls
- `wait_for_activity` emits `agent.waiting` and `agent.wait_returned`
- graph node data includes unread-message count and listener-health state
- node headers and Inspector show listener-health state such as `Listening`, `Polled`, `Needs poll`, `Register needed`, or `Unverified`
- lab verification passes with `bun run check` and a Tauri debug build

### Phase 3: Agent Identity Overhaul

Status: complete

Goal:

- agents become overview-first cards
- terminal becomes a tab or expandable mode
- editable agent identity maps to real runtime behavior

Acceptance:

- a user can understand an agent without opening the terminal
- editing agent settings changes actual launch/bootstrap/runtime behavior
- Phase 3 preserves the listener-health badges and Inspector details from the post-Phase-2 reliability sync

Closeout note, 2026-04-25:

- Phase 3 closed with the active-style terminal node as the default launch-proof surface and Agent Deck v2 as the agent-first card surface.
- Saved Agent Profiles own command, harness, role, permission posture, tier order, role emoji, and visual accent.
- Richer project/note-backed step tracking and first-class custom harness swarm bootstrap are intentionally deferred to later runtime/project slices.

### Phase 4: Project Spaces

Goal:

- project boundaries
- project pages
- project assets and memberships
- clear project-aware agent attachment flow

Acceptance:

- projects are real product objects, not just folders or scopes

### Phase 5: Asset and Multimodal Layer

Goal:

- screenshots, images, notes, protocols, and references become first-class project assets
- visual context enters the product through asset surfaces, not terminal hope

Acceptance:

- visual design work can be organized and attached without leaving the product model

### Phase 6: Startup, Branding, and Credit

Goal:

- strong branded startup experience
- tasteful artwork integration
- explicit friend credit
- app icon finalized

Acceptance:

- startup feels premium and intentional without polluting the working canvas

### Phase 7: Secondary Themes and Protocol Views

Goal:

- split `Encom Glass Deck` and `DarkFolder Silhouette` into real separate themes
- add clearer protocol/workflow visualization surfaces

Acceptance:

- alternate looks feel intentional and distinct
- protocol views improve understanding instead of adding clutter

## Non-Goals

These are explicitly not part of the early overhaul baseline:

- fake sandboxing through visual project boundaries
- pretending terminal sessions are reliable image-native surfaces
- stuffing branding artwork across the live working canvas
- shipping editable “skills” UI that does not change behavior
- merging all phases into one uncontrolled implementation wave

## Verification Strategy

Each phase must include:

- focused automated tests where practical
- build verification for the affected surfaces
- manual click-through checklist
- visual QA with screenshots

The overhaul is only successful if the product becomes easier to use and iterate on, not just more visually dramatic.

## Approval Gate

After review of this spec, write or approve a separate implementation plan per phase.

Do not attempt the whole overhaul from this master spec in one execution pass.
