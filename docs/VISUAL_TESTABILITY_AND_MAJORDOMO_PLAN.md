# Visual Testability And Majordomo Plan

Updated: 2026-05-08.

This plan exists because screen-stealing native click automation is not a
reliable verification strategy for `swarm-ui` today. The app should be testable
while the operator keeps using the laptop, and agents should be able to inspect
the thing they created visually, not only inspect source code.

## Non-Negotiable Rule

Do not claim a native UI workflow is proven because:

- the app launched,
- a screenshot showed a window,
- a browser/Vite mock rendered the right shape,
- a unit test passed,
- or a synthetic macOS click was attempted.

Those are separate proof levels. The app needs a first-class proof path that can
render, click, inspect, and screenshot surfaces without taking over the
operator's desktop.

## Problem To Fix

The current verification stack has a gap:

- Tauri/Rust commands can be unit-tested.
- Vite/browser surfaces can be screenshot with Playwright.
- The real Tauri app can be launched.
- Native macOS click automation is unreliable without Accessibility/TCC grants.
- The app's own `ui_capture_screenshot` command honestly reports unsupported.

That means an agent can currently spend time trying to click the user's visible
app window and still fail to prove the workflow. That wastes operator attention,
tokens, and money.

## Target Outcome

The operator should be able to keep working while agents produce a visual proof
pack like:

```
output/visual-atlas/2026-05-07T22-10-00/
  index.md
  feature-map.json
  home-start.png
  canvas-empty.png
  canvas-note-created.png
  majordomo-closed.png
  majordomo-open.png
  launcher-preflight.png
  project-task-board.png
  ...
```

Each screenshot should be tied to:

- the surface name,
- the exact button/control exercised,
- the expected result,
- actual DOM/semantic state,
- console errors,
- and whether native IPC was real or mocked.

## Gap Review Amendments

This section closes the misses found after comparing the user's requests against
the first version of this plan.

1. End-to-end visible workflow proof is not optional. The app needs a native
   command-bus workflow that creates a real note file, opens the visible canvas
   document surface, captures semantic state, and writes proof artifacts without
   pretending a browser mock is native proof.
2. Visual atlas coverage must be exhaustive, not "major surfaces only." Every
   app surface and every operator-facing button/control must be registered,
   screenshotted, or explicitly exempted with a reason.
3. Majordomo is default-on for the lab profile. The app still has deterministic
   fallback survey logic, but the desired product state is a running
   `role:majordomo` runtime assistant connected to the pyramid host.
4. App-region capture needs a concrete implementation path. The MVP should use
   in-webview DOM/region capture and a Tauri file-write bridge, not whole-screen
   desktop capture. Native WebView snapshot support is a later hardening path.
5. Dated session folders are the storage source of truth for closeout survey
   responses. Top-level `surveys/` is for templates and indexes, not the primary
   location for completed survey documents.
6. Closeout triggers must be explicit: app quit, project close, End Session,
   stop-all/leave-running-agent flows, and forced-quit recovery.
7. Majordomo CLI should route live tweak commands such as "move this button
   right" through the runtime tweak store, then preserve the source patch only
   after the user accepts the visual result.
8. Every survey, proof pack, Majordomo closeout, and CLI closeout must include
   app identity: app name, variant (`lab`, `active`, or `local`), app version,
   Tauri/runtime shell, run kind, source root, executable path, bundle path,
   git branch/commit/dirty state, active project root, scope/channel, session
   id, and whether the Dock/bundled app was the thing actually running.
9. The Home first viewport must show a readable app/version/runpath strip. The
   operator should not have to hunt through About, Activity Monitor, or Terminal
   to know whether they are using `swarm-mcp-lab`, `swarm-mcp-active`, a Tauri
   dev binary, or a Dock/app-bundle build.
10. Agent/PTY cards need a deliberate report gesture contract. Report capture
    must work for agent cards and terminal nodes, but normal double-click inside
    a terminal must not steal shell focus, selection, copy, or terminal-native
    interactions.

## Architecture

### 1. Visual Atlas Mode

Add a deterministic visual atlas that renders every app surface in known fixture
states.

Entry options:

- `http://127.0.0.1:1420/?visual-atlas=1`
- or a dev-only `appMode = 'visual-atlas'`.

The atlas should render at minimum:

- Home command deck.
- Workspace Kit closed/open and each lane.
- Canvas empty state.
- Canvas with project boundary.
- Canvas with note/document surface.
- Canvas with browser node.
- Canvas with agent terminal node fixture.
- Canvas with Majordomo closed/open/error/answering states.
- Launcher default/preflight/full-access warning states.
- Project Page cockpit.
- Task Board empty/imported/selected/launched/stale states.
- Review/Ship.
- Proof Pack result.
- Post-session improvement.
- Analyze panel.
- Settings modal.
- Mobile access modal.
- FrazierCode archive.

Every surface gets a stable `data-surface` id. Every operator-facing button,
input, toggle, tab, menu item, icon button, canvas affordance, and destructive
control gets a stable `data-testid`.

Coverage contract:

- The app exports `feature-map.json` generated from registered surfaces and
  controls.
- The visual atlas exports `coverage.json`.
- Every registered surface/control is one of:
  - `screenshot-covered`,
  - `semantic-covered`,
  - `native-only-manual`,
  - `hidden-debug-exempt`,
  - or `missing-coverage`.
- `missing-coverage` fails the visual atlas command.
- Exemptions require a reason and owner.

Initial registry files:

```text
apps/swarm-ui/src/lib/featureMap.ts
apps/swarm-ui/src/lib/visualAtlasRegistry.ts
apps/swarm-ui/src/visual-atlas/VisualAtlas.svelte
```

Macro Phase 1/2 implementation note: these files now exist and are wired through
`?visual-atlas=1`. The current registry covers 12 surfaces and 24 controls, with
clickability/reportability metadata for asset-like controls and no
`missing-coverage` entries.

The registry must include enough metadata for Majordomo to answer:

- what the surface/control is for,
- where it appears,
- what should happen when used,
- what proof exists,
- and which recent learning notes mention it.

### Asset Clickability And Reportability Contract

Every visible asset-like thing must be classified separately for primary
clickability and report capture. Do not assume "not clickable" means "not
reportable."

Asset-like things include:

- project asset bubbles,
- Canvas Document / note surfaces,
- media/image thumbnails,
- browser snapshots,
- app/native surface nodes,
- file cards,
- proof pack rows,
- FrazierCode/archive imagery,
- agent cards,
- PTY/terminal cards,
- disabled or unavailable feature cards,
- and decorative assets that are visible enough for a user to complain about.

Each registered asset/control needs:

```ts
type Clickability =
  | 'primary-clickable'
  | 'selectable-only'
  | 'noninteractive'
  | 'disabled'
  | 'decorative';

type Reportability =
  | 'reportable'
  | 'reportable-in-feedback-mode'
  | 'context-menu-only'
  | 'native-only-manual'
  | 'exempt';
```

Rules:

- `primary-clickable`: normal click performs the primary action, such as open
  file, open document surface, select project, or launch detail view.
- `selectable-only`: normal click selects/focuses the asset; Enter or an
  explicit button performs the primary action.
- `noninteractive`: normal click does nothing, but feedback mode still needs a
  highlight/crop target unless explicitly exempted.
- `disabled`: normal click does not act, but report capture must still work so
  the operator can report confusing disabled state.
- `decorative`: can be exempt only when it has an owner and reason. If it is
  large, branded, or visually prominent, default to reportable instead.
- In feedback/report mode, report capture wins over primary click. Clicking a
  clickable asset in report mode should open the capture overlay, not open the
  file or launch the agent.
- Outside feedback mode, right-click/two-finger click should offer
  `Report this asset` for both clickable and non-clickable visible assets.
- Non-clickable visible assets must still get a `data-report-target` or wrapper
  hitbox so the highlight/crop system can find them.
- Visual atlas coverage must include at least one clickable asset, one
  non-clickable/reportable asset, one disabled/reportable asset, and one
  explicit decorative exemption.
- Survey sidecars should record `clickability`, `reportability`,
  `primaryAction`, and `reportAction` for each captured asset.

### 2. Headless Screenshot Runner

Add a CLI command that drives the atlas in headless Chromium so it does not need
the app to be frontmost:

```bash
swarm-mcp ui visual-atlas --out output/visual-atlas/latest
```

First implementation can use the Playwright CLI or local CDP browser engine.
The important part is that it is deterministic and does not touch the user's
active desktop.

The runner should:

1. Start or reuse the Vite dev server.
2. Open visual atlas mode in headless browser.
3. Capture one screenshot per surface/state.
4. Export DOM/semantic snapshots.
5. Save console warnings/errors.
6. Compare atlas coverage against the feature/control registry.
7. Write `coverage.json`.
8. Write `index.md` summarizing pass/fail and linking images.

Macro Phase 1 implementation note: `swarm-mcp ui visual-atlas --out <dir>
[--json]` now starts a temporary Vite server when needed, drives the atlas
through headless Chrome/CDP, writes screenshots and semantic snapshots, and
shuts down its owned browser/server processes. Latest evidence:
`output/visual-atlas/macro-phase-1/`.

Browser/Dock hygiene:

- Default atlas/proof browser runs must be headless.
- If a headed browser is required, the agent must say it before running it and
  close the browser process afterward.
- Playwright/Chromium/Chrome-for-testing can create temporary Dock icons on
  macOS. Those icons are triggered by browser automation, not by the Tauri app
  itself.
- A visual test that leaves extra Chrome/Dock icons open is incomplete cleanup,
  not a user problem.
- The long-term runner should own browser lifecycle: launch, capture, close, and
  verify no leftover testing browser process remains.
- Until that cleanup exists, it is safe for the operator to quit/remove the
  temporary Chrome icon, or ignore it during the session if it is not in the way.

### 3. App Semantic Snapshot Bus

Add a frontend-owned semantic snapshot function for the real app state:

```ts
window.__SWARM_UI_PROOF__.snapshot()
```

It should return JSON with:

- current mode,
- active project,
- visible panels,
- canvas nodes and node bounds,
- app surfaces and document paths,
- buttons/textboxes with labels and disabled state,
- selected node/edge,
- current toasts/errors,
- relevant feature-map ids.

Macro Phase 2 implementation note: the normal app now exposes
`window.__SWARM_UI_PROOF__.snapshot()`, `captureRegion()`, `startAreaCapture()`,
`runCloseout()`, and `applyTweak()`. `captureRegion()` is explicitly
`app-region-dom` or `app-region-partial`; it does not claim native desktop
pixels or Screen Recording proof.

This can be called from Browser/Playwright in dev mode and later from a Tauri
command bridge.

### 4. Native Command Bus

Add UI commands that do not rely on macOS mouse clicks:

- `ui.app.identity`
- `ui.app.home-version`
- `ui.canvas.enter`
- `ui.canvas.create-note`
- `ui.canvas.open-note`
- `ui.canvas.save-note`
- `ui.canvas.open-majordomo`
- `ui.majordomo.start-runtime`

Macro Phase 2 implementation note: the first native write commands are
`ui_save_area_capture` and `ui_save_session_closeout`. They persist
PNG/Markdown/JSON proof sidecars under the shared learning folder and are
covered by Rust tests.

Macro Phase 2 evidence note: `output/visual-atlas/macro-phase-2/` contains the
current atlas proof: 12 surfaces, 24 controls, and 0 coverage issues. The
runner also verified cleanup by leaving no Vite listener, visual-atlas Chrome
process, or temporary `.chrome-profile` directory behind.
- `ui.majordomo.ask`
- `ui.feedback.start-report-area`
- `ui.feedback.capture-area`
- `ui.feedback.cancel-area`
- `ui.feedback.closeout`
- `ui.tweak.apply`
- `ui.tweak.persist-to-source`
- `ui.canvas.open-workspace-kit`
- `ui.canvas.open-launcher`
- `ui.canvas.snapshot`

These should route through the same frontend handlers as real buttons.
They are not a replacement for human UI, they are a proof/control path for
agents.

### 5. App Identity, Version, And Runpath

Use the existing `ui_build_provenance` Tauri command as the first source seam.
It already returns:

- app version,
- build profile,
- run kind,
- git branch,
- git commit,
- dirty state,
- build timestamp when compiled with metadata,
- executable modified timestamp,
- executable path,
- app bundle path,
- current working directory,
- source root,
- and manifest directory.

The app should normalize that into an operator-facing identity packet:

```ts
type AppIdentity = {
  appName: 'swarm-ui';
  appVariant: 'lab' | 'active' | 'local' | 'unknown';
  appVersion: string;
  shell: 'tauri';
  tauriMajor: 2;
  runKind:
    | 'tauri-dev'
    | 'app-bundle'
    | 'debug-binary'
    | 'release-binary'
    | 'browser-preview';
  buildProfile: 'debug' | 'release';
  sourceRoot: string;
  currentWorkingDirectory: string;
  executablePath: string;
  appBundlePath: string | null;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  buildUnix: number | null;
  executableModifiedUnix: number | null;
  dockStatus: 'not-this-run' | 'this-bundle-run' | 'unknown';
};
```

Operator-visible requirements:

1. Home first viewport shows at least:
   - `LAB` / `ACTIVE` / `LOCAL`,
   - `v<appVersion>` with a numeric/alphanumeric version value,
   - `DEV` / `BUNDLE` / `DEBUG` / `RELEASE` / `PREVIEW`,
   - compact run path,
   - and Dock/bundle status.
2. The full tooltip/details view exposes source root, executable path, bundle
   path, branch, commit, dirty state, build stamp, and modified stamp.
3. Majordomo answers "what version is this?" from the same identity packet.
4. Closeout survey markdown and JSON store the same identity packet.
5. Proof packs and visual atlas `index.md` store the identity packet.
6. If the current run is `tauri-dev`, the UI must say the Dock app is not this
   run. If the current run is `app-bundle`, the UI must say this is the bundled
   app path being exercised.
7. Later hardening can add an installed Dock-app freshness check by comparing
   known bundle paths under `/Applications`, `~/Applications`, and Tauri build
   output against the current source/build timestamp. The MVP must not pretend
   Dock is updated if it only proved a dev binary.

This directly answers the recurring "am I using the right app?" problem. It is
also a survey requirement because feedback without app identity is hard to
trust later.

### Required Run This Version Block

After any implementation or CLI-driven edit, Codex, Claude, Majordomo, the CLI,
or any other agent must include a runpath block in the closeout. This applies
even when the work was "just one small UI change."

Minimum block:

```text
Run This Version
App: swarm-ui LAB v0.1.0
Source root: /Users/mathewfrazier/Desktop/swarm-mcp-lab
Native dev runpath:
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui && bunx tauri dev

Browser preview only:
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui && bun run dev -- --host 127.0.0.1
http://127.0.0.1:1420/

Dock bundle: not confirmed updated
Evidence: tests/checks/screenshots run this session
```

Rules:

- If the app was verified through `bunx tauri dev`, label it `Native dev`.
- If the app was verified through Vite/Playwright/browser preview, label it
  `Browser preview only`.
- If the Dock/app bundle was not rebuilt and verified, say `Dock bundle: not
  confirmed updated`.
- If the Dock/app bundle was rebuilt, include the exact app bundle path and
  timestamp.
- If multiple repo copies exist, include the exact `sourceRoot` and app variant
  (`LAB`, `ACTIVE`, `LOCAL`, or `UNKNOWN`).
- Surveys, proof packs, and visual atlas indexes should store this same block
  or a structured equivalent.

### 6. Native Screenshot Path

MVP app-region capture should not depend on macOS screen capture permissions.
Use this two-part path:

1. Frontend capture: `window.__SWARM_UI_PROOF__.captureRegion(draft)` captures
   the selected DOM/app region as a PNG data URL. Prefer a focused dependency
   such as `modern-screenshot` or `html-to-image` for DOM serialization, with
   explicit limitations for terminal/canvas/WebGL content.
2. Tauri file bridge: `ui_save_area_capture` receives the PNG data URL plus
   metadata and writes the image, sidecar markdown, and JSON into the dated
   session folder.

The command result must include a proof level:

- `app-region-dom`: in-webview DOM/region capture, no macOS screen permission.
- `app-region-partial`: some content could not be serialized; note limitations.
- `native-webview`: future native WebView snapshot.
- `manual-native`: human/manual capture.

Longer term, add one of:

- a Tauri plugin that captures the main `WKWebView` via native snapshot APIs,
- a hidden/offscreen proof webview for atlas rendering,
- or a documented macOS permission setup for active-window screenshots.

Until this exists, native pixel screenshots remain human/manual or
browser-atlas-only.

## Majordomo CLI In Home

The app should have a real command surface in Home, not only a decorative
Majordomo button.

Working name: `Majordomo CLI`.

Location:

- Home main menu / command deck.
- Also reachable from canvas right rail.

Initial behavior:

- User types natural commands or slash commands.
- Majordomo answers from a local feature map before it becomes fully agentic.
- It can explain "what features exist", "where is notes", "what is tested",
  "open task board", "create note", "show visual atlas".

MVP command set:

```text
/features
/open canvas
/open workspace-kit
/create note
/open notes
/open launcher
/open task-board
/proof current
/proof atlas
/why-not-tested <feature>
```

Majordomo needs to know:

- `docs/CURRENT_APP_FEATURES.md`
- the feature map generated from `data-surface` / `data-testid`
- available Tauri IPC commands
- available MCP/CLI tools
- the shared learning folder:
  `/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/`
- current proof status
- known defects
- recent visual mismatches and open learning action items

This makes Majordomo the internal app assistant and feature map, not just a
button with vibes.

### Omnipresent Majordomo Contact Surface

Majordomo is not only another chat panel. It is the operator's chief contact for
running swarms, launching agents, clarifying intent, finding slippage, and
making sure the operator's will is being implemented.

Product shape:

- Add a persistent `Ask Majordomo` / `Clarify Will` button that is reachable
  from Home, Canvas, Project Page, Task Board, report mode, and closeout survey.
- The button opens a compact command drawer or popover rather than forcing the
  operator into the right rail.
- The drawer can expand into a full Majordomo conversation when the topic needs
  more space.
- It should route to the same runtime Majordomo/Hermes session when online, and
  fall back to deterministic app logic when offline.

Core modes:

1. `Idea Dump`: accepts messy run-on text, adds paragraph breaks, extracts
   intent, constraints, open questions, and candidate tasks.
2. `Clarify My Will`: when intent is unclear, shows a special popup with several
   concrete interpretation choices, not a blank "please clarify" wall.
3. `Run This Swarm`: turns clarified intent into a proposed workflow, agent
   roles, scope/channel, files, verification bar, and cleanup policy.
4. `Check Slippage`: compares current work against the plan, feature map,
   launch state, proof evidence, and recent survey learnings.
5. `Ask Feature Map`: answers what exists, what is hidden, what is tested, and
   what proof level exists.

Clarification popup requirements:

- Preserve the operator's original words.
- Show a cleaned/structured version side by side.
- Offer 3-5 interpretation options such as:
  - "Implement this now"
  - "Add it to the plan"
  - "Ask agents for research first"
  - "Create survey/learning item"
  - "Launch a swarm for this"
- Include an optional text box for corrections.
- Let the operator choose "use cleaned version" or "send original anyway."
- Save the cleaned intent, selected interpretation, and any follow-up questions
  into the project/session learning record.

This button is distinct from:

- broadcast-to-channel, which talks to all agents;
- individual agent chat, which talks to one agent;
- shell/PTY, which is raw terminal interaction;
- and settings/debug controls.

Majordomo can use those channels, but the operator should have one obvious
chief-contact surface that always works.

### Majordomo Mental Map

Majordomo needs a durable mental map before it can ask smart questions. It
should not invent what the user should have experienced. It should read:

- app mission and product spine,
- every visible surface,
- every hidden command/API capability,
- current proof level for each feature,
- known defects,
- previous session surveys,
- previous visual mismatch captures,
- open learning action items,
- and feature-specific learning notes.

The starting authority is:

```text
docs/CURRENT_APP_FEATURES.md
docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/action-items/open.md
```

With that map, Majordomo can ask adaptive questions like:

- "Last time the Majordomo button felt decorative. Did it open a useful command
  surface this time?"
- "The notes flow previously needed a real file and visible canvas document. Did
  you see both?"
- "The proof gap was native clicking versus browser proof. Did the agent show a
  screenshot of the actual surface you cared about?"

### Runtime Majordomo Assistant

Majordomo should be both a visible 3D/pyramid host and a default-on runtime
agent in the lab profile. The panel should not only display swarm stats; it
should bind to a real `role:majordomo` instance that is active in the same
project/channel.

Hermes recommendation:

- Use Hermes as the first real Majordomo runtime, launched as a visible
  swarm-owned PTY through the existing harness path.
- Do not start with a hidden background daemon or a separate native app-service
  adapter. The PTY path is the smallest durable product shape because it is
  visible on the canvas, killable through existing controls, and already fits
  the swarm instance/PTY binding model.
- Treat a later Hermes ACP/MCP/native adapter as a hardening layer after the
  visible PTY lifecycle is reliable.

Local Hermes findings from this planning pass:

- `Hermes` resolves to `/Users/mathewfrazier/.local/bin/Hermes`.
- That entrypoint symlinks into
  `/Users/mathewfrazier/.hermes/hermes-agent/venv/bin/hermes`.
- The CLI entrypoint imports `hermes_cli.main:main` from
  `/Users/mathewfrazier/.hermes/hermes-agent`.
- Hermes supports `--tui`, `-z/--oneshot`, `--model`, `--provider`,
  `--toolsets`, `--resume`, `--continue`, `--source`, `--pass-session-id`,
  `--accept-hooks`, and MCP configuration through `hermes mcp ...`.
- `hermes status` currently reports model `grok-4.3`, provider `xAI`, gateway
  stopped, and zero active sessions.
- `hermes mcp list` currently shows `twozero_td` enabled at
  `http://localhost:40404/mcp`; swarm MCP still needs an explicit Hermes MCP
  config or a bootstrap path if Majordomo should call swarm tools directly.

Candidate swarm MCP config to validate during implementation:

```bash
Hermes mcp add swarm-ui-lab \
  --command bun \
  --args run /Users/mathewfrazier/Desktop/swarm-mcp-lab/src/index.ts
```

Do not assume this is accepted until `Hermes mcp test swarm-ui-lab` passes and
Majordomo can list or use the expected swarm tools. If Hermes MCP config is not
ready, bootstrap Majordomo with app/CLI instructions and keep the app-owned
survey fallback.

Current source seams:

- `apps/swarm-ui/src/panels/MajordomoArchitect.svelte` is the visible pyramid
  host panel and already reads instances, tasks, messages, and events.
- `apps/swarm-ui/src/lib/agentRolePresets.ts` already defines
  `Majordomo / Grand Architect`.
- `apps/swarm-ui/src-tauri/src/launch.rs` already includes `majordomo` as a
  known role and canonicalizes `Grand Architect` to `majordomo`.
- `apps/swarm-ui/src-tauri/src/launch.rs` already recognizes `hermes` as a
  harness-shell role.
- `apps/swarm-ui/src/stores/harnessAliases.ts` already defaults Hermes to
  `hermes --tui` and normalizes a raw `hermes` alias back to `hermes --tui`.
- `apps/swarm-ui/src/stores/pty.ts` already exposes `spawnShell(cwd, options)`
  with `harness`, `role`, `scope`, `name`, `label`, and
  `bootstrapInstructions`.
- `apps/swarm-ui/src/lib/postSessionImprovement.ts` already has a useful label
  pattern for owner/run/timeout metadata.

MVP behavior:

1. The Majordomo panel shows runtime state: `offline`, `launching`, `online`,
   `stale`, `blocked`, or `timeout-soon`.
2. In the lab profile, opening a project or entering Canvas should auto-bind to
   an existing `role:majordomo` instance or show a prominent `Start Majordomo`
   action if none exists.
3. If the user has enabled auto-start, the app starts Majordomo after project
   open once launch preflight passes.
4. `Start Majordomo` launches the selected/default harness with:
   - default harness: `hermes`,
   - default command: `hermes --tui`, or the user's configured Hermes alias,
   - optional model/provider overrides from app settings:
     `--model <model>` and `--provider <provider>`,
   - optional `--source swarm-ui-majordomo` so Hermes sessions are filterable,
   - `role: majordomo`,
   - `name: majordomo_runtime_<short id>`,
   - label tokens:
     `owner:majordomo runtime_ai_assistant:true project:<id> timeout_m:<n> source:majordomo_runtime`,
   - scope set to the active project/channel,
   - cwd set to the active project root,
   - bootstrap instructions that require reading the feature map, visual plan,
     shared learning README, dated capture folders, and open action items.
5. If a live `role:majordomo` instance already exists, the pyramid host binds to
   it instead of spawning a duplicate.
6. Majordomo can be suspended/killed with the same honest controls used for other
   agents. It should appear in swarm state, Analyze, and any Resume Center style
   surfaces with its timeout and purpose visible.
7. At session closeout, the runtime Majordomo receives the captured areas,
   feature map, recent plan notes, and survey state, then proposes smart
   multiple-choice questions. The app still owns the UI and persistence so survey
   capture works even if the agent fails.
8. Testing Majordomo must include cleanup: launch one Majordomo PTY, verify it
   appears as `role:majordomo`, ask or bootstrap one visible command, then stop it
   through app-owned controls and verify there is no live orphan PTY, hidden
   Hermes session, or invisible process consuming resources.
9. If the operator chooses to leave Majordomo running after app close, the app
   must show that choice in Resume Center/Analyze with timeout, project, model,
   provider, and a visible stop action.

The runtime assistant is the target product experience. The app must still run
deterministic survey logic from the local feature map if the agent is offline,
blocked, or unavailable.

Majordomo runtime prompt must include:

```text
You are the runtime Majordomo for swarm-ui.
Read:
- docs/CURRENT_APP_FEATURES.md
- docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md
- /Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
- /Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/action-items/open.md

Stay active for session guidance, feature questions, survey closeout, area
capture interpretation, visual proof expectations, and live tweak commands.
Do not claim proof you did not see. When idle, wait for activity.
```

Recommended Hermes bootstrap additions:

```text
You are running inside swarm-ui as the visible Majordomo runtime.
Your PTY is owned by the app and may be stopped at session closeout.
Use source tag swarm-ui-majordomo when available.

Know these roots:
- swarm-ui lab source: /Users/mathewfrazier/Desktop/swarm-mcp-lab
- shared learning: /Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution
- Hermes source/config root: /Users/mathewfrazier/.hermes/hermes-agent

Know these swarm seams:
- MCP server: src/index.ts
- UI launch/PTY lifecycle: apps/swarm-ui/src/stores/pty.ts
- Tauri harness launch: apps/swarm-ui/src-tauri/src/launch.rs
- feature map: docs/CURRENT_APP_FEATURES.md
- visual/testability plan: docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md

Responsibilities:
- answer feature/version/runpath questions from app identity and feature map,
- help the operator open app surfaces through app command bus actions,
- interpret reported area captures,
- propose adaptive closeout questions,
- never hide a launch, failure, or cleanup requirement,
- and never claim visual proof without a screenshot or semantic snapshot.
```

Questions worth asking Hermes directly, if Mathew wants to open it:

1. What is the preferred command for a TUI session that can be launched inside a
   managed PTY and closed cleanly?
2. What exact model/provider names should swarm-ui expose for your current
   Grok/xAI profile?
3. Can a startup prompt/context file be passed without typing into the TUI, or
   should the app auto-type bootstrap instructions after launch?
4. What is the best graceful-exit sequence: slash command, Ctrl-C, EOF, or
   process signal?
5. Can you connect to a stdio MCP server for this repo with `hermes mcp add`,
   and what command/args format do you prefer?
6. Where should swarm-ui read session ids/logs if it needs to prove cleanup?

This is useful, but not a blocker. The current local CLI help already gives
enough to plan the first PTY-based implementation.

### Majordomo/Hermes Lifecycle Contract

Majordomo runtime sessions need a no-ghost contract:

1. Preflight the Hermes command before launch.
2. Create one app-owned launch record with `launchId`, `instanceId`, `ptyId`,
   project id, scope, model, provider, source tag, timeout, and cleanup policy.
3. Bind the visible pyramid host to the existing matching `role:majordomo`
   instance before spawning a duplicate.
4. Show `launching`, `online`, `blocked`, `stale`, `timeout-soon`, `stopping`,
   `stopped`, or `failed` state in the panel and Analyze/Resume Center.
5. On app close, test finish, or `Stop Majordomo`, try graceful exit first, then
   close the PTY, then use the existing kill/deregister path if still alive.
6. After stopping, verify the PTY is closed, the instance row is removed or
   marked stopped, and no hidden Hermes process remains attached to the app
   session.
7. If cleanup fails, show the failed process/instance id and the exact cleanup
   action rather than losing it in the background.

### Closeout Survey Loading Contract

The survey UI must be app-owned and nonblocking:

1. On normal closeout, show the closeout/survey shell immediately.
2. Render captured issue images and a deterministic 4-8 question fallback from
   the local feature map immediately.
3. Start Majordomo/Hermes analysis in parallel when available.
4. Show a playful loading state while Majordomo builds tailored questions, but
   do not freeze quit, project close, or stop-all flow.
5. If Majordomo answers before the timeout, merge its questions into the survey.
6. If Majordomo times out or errors, keep the fallback questions and record the
   timeout in `closeout-survey.json`.
7. Let the operator skip, save partial answers, or leave agents running through
   a visible tracked path.

Suggested timeout policy:

- 0 seconds: show survey shell and fallback questions.
- 1-3 seconds: show loading animation and captured screenshots.
- 10-20 seconds: accept a Majordomo question set if ready.
- After timeout: continue with fallback and record `majordomoQuestionStatus`.

### Apple Permission Boundaries

The plan should avoid macOS permissions where possible, then label the boundary
honestly when it cannot.

Target operator machine for this overhaul:

```text
Device: MacBook Air
OS: macOS Tahoe 26.4.1 (25E253)
```

Before any agent claims native clickability or native screenshots are working,
run and record a permission preflight. This prevents the bad pattern where an
agent says a workflow is verified while macOS silently blocked clicking,
keyboard input, screenshots, or app automation.

- Internal app command bus, semantic snapshots, DOM-region capture, and Tauri
  file writes should not need Accessibility or Screen Recording.
- OS-level synthetic clicks/keyboard into a Tauri window usually need
  Accessibility permission for the controlling app/process.
- Full-screen or whole-window desktop screenshots outside the app usually need
  Screen Recording permission.
- AppleScript control of Chrome, Terminal, Ghostty, or other apps may need
  Automation permission.
- File access outside normal app/dev paths can trigger Files and Folders or
  Full Disk Access prompts, depending on path and packaged-app entitlement state.
- Browser/Playwright proof can create temporary Chrome/Chromium Dock icons; the
  long-term runner must launch headless and clean up those processes.

Permission preflight checklist:

- Accessibility: grant to the controller actually sending OS clicks/keys, such
  as Codex Desktop, Terminal/Ghostty, or the browser automation host.
- Screen & System Audio Recording / Screen Recording: grant to the controller
  taking native desktop/window screenshots.
- Automation: grant when AppleScript or System Events controls Chrome, Finder,
  Terminal, Ghostty, Obsidian, or the Tauri app.
- Files and Folders / Full Disk Access: grant only if the packaged app or test
  runner needs protected paths outside normal dev/project folders.
- Local Network is normally not required for `127.0.0.1`, but note it if a LAN
  browser, mobile companion, or external device workflow is tested.
- After changing TCC permissions, quit and relaunch the affected app/process
  before retesting.

Proof reports must state the permission status:

```text
Native click proof: confirmed | blocked by Accessibility | not attempted
Native screenshot proof: confirmed | blocked by Screen Recording | not attempted
Automation proof: confirmed | blocked by Automation | not attempted
Internal app proof: semantic/app-region-dom/native-command
```

Proof should prefer app-internal command/snapshot/capture paths first. Native
desktop clicking is manual or permission-gated proof until the app has a
reliable internal runner.

### Zero-Context Handoff Bundle

A new agent starting with zero thread context should read these first:

```text
/Users/mathewfrazier/Desktop/swarm-mcp-lab/AGENTS.md
/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/CURRENT_APP_FEATURES.md
/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md
/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/superpowers/plans/2026-05-08-majordomo-visual-proof-and-learning.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/action-items/open.md
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src/stores/harnessAliases.ts
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src/stores/pty.ts
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri/src/launch.rs
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src/panels/MajordomoArchitect.svelte
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src/lib/agentRolePresets.ts
/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src/panels/Launcher.svelte
/Users/mathewfrazier/.local/bin/Hermes
/Users/mathewfrazier/.hermes/hermes-agent
```

Execution guidance for the real build:

- One lead Codex/Claude should coordinate the plan ledger and final proof.
- Use subagents only after the user authorizes execution, and split them by
  non-overlapping files.
- Suggested lanes:
  - feature registry and visual atlas,
  - area capture and survey persistence,
  - Hermes/Majordomo lifecycle,
  - operator workflow verification and ghost-session guard,
  - docs/proof pack/runpath closeout.
- Recommended skills: `superpowers:subagent-driven-development` for multi-agent
  execution, `superpowers:executing-plans` for single-agent execution,
  `superpowers:verification-before-completion` before claiming done, the repo
  `tauri` skill for IPC/security boundaries, and browser/frontend testing
  skills for atlas screenshots.

## Session-End Experiental Learning Evolution Survey

The app should end every normal session with a lightweight learning survey. The
survey can be presented by Majordomo on behalf of the app, or by an app-owned
session-close surface if Majordomo is not running. The goal is not paperwork; it
is to turn user frustration, visual mismatch, missing affordances, and delight
into durable product memory.

Exception: if the app is force quit, killed, crashes, or the machine shuts down,
do not block shutdown. On next launch, show a small recovery prompt:

```text
Last session ended abruptly. Record anything broken or missing?
```

If the user says no, do not nag. If the user says yes, open the same survey with
the first question focused on what forced the exit.

### Storage Location

Store session learning under:

```text
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/
```

Use this structure:

```text
Experiental Learning Evolution/
  README.md
  surveys/
    SESSION_SURVEY_TEMPLATE.md
    SESSION_SURVEY_TEMPLATE.json
    index.md
  area-captures/
    2026-05-07/
      session-<id>/
        001-majordomo-button.png
        001-majordomo-button.md
        closeout-survey.md
        closeout-survey.json
  visual-mismatches/
    2026-05-07-majordomo-button-gap.md
  feature-learning/
    notes-flow.md
    majordomo-cli.md
  action-items/
    open.md
    done.md
```

Rules:

- Markdown is for humans and agents to read quickly.
- JSON is for the app to query and trend over time.
- Area captures are internal app/webview crops, not whole-screen macOS
  screenshots.
- Area captures are grouped first by date, then by session, so each day's issues
  have a natural folder.
- The dated session folder is the source of truth for that session's screenshot
  captures, sidecars, closeout survey markdown, and closeout JSON.
- Top-level `surveys/` stores templates and cross-session indexes only.
- Visual mismatch notes must include screenshot/atlas references when available.
- Each survey should link to the feature ids or surface ids involved.
- Action items should be extracted automatically, but the raw survey must remain
  intact.

### Point-And-Report Area Capture

The app should let the operator report a specific area without taking a full
Apple desktop screenshot.

Preferred interaction:

- A feedback mode toggle in the app chrome: `Report area`.
- In feedback mode, hover highlights the nearest surface/control.
- Click, two-finger click, or double-click starts capture confirmation for that
  highlighted app area.
- Outside feedback mode, two-finger click/right-click should offer
  `Report this area` in context menus.
- Assets that are normally clickable still open normally outside feedback mode.
  In feedback mode, the same click targets the screenshot/report overlay.
- Assets that are not normally clickable must still be targetable in feedback
  mode if they are visible operator-facing UI.

Important gesture conflict: canvas double-click already opens provider/launch
behavior in some places. Do not steal that default blindly. Double-click should
only report an area when feedback mode is active or the target has no existing
double-click behavior.

Agent and PTY card rule:

- Inside a Ghostty/PTY terminal body, normal double-click stays terminal-native
  for selection/focus behavior.
- Inside a terminal body, report capture is available through feedback mode,
  context menu `Report this terminal area`, or an explicit report affordance on
  the node chrome/header.
- Inside an agent card header/body outside the terminal emulator, double-click
  can start report capture only when feedback mode is active. Otherwise it
  preserves existing node inspect/selection/launch behavior.
- If the user needs to report terminal output itself, the capture target is the
  terminal viewport rectangle with metadata `surfaceId: terminal-node`,
  `targetKind: pty`, `ptyId`, `instanceId`, and `captureLimitations` describing
  whether DOM capture, canvas capture, or native/manual proof was used.
- The visual atlas must include an agent card and a PTY card fixture showing the
  report affordance and documenting which gestures are reserved.

Capture requirements:

- Capture only the selected app surface/control/region.
- Do not capture the whole macOS screen.
- Attach surface id, test id, DOM/component path, bounds, mode, project id, and
  active feature id.
- Let the user add optional text immediately.
- Save the capture into `area-captures/`.
- Add the capture reference into the session closeout survey.
- Preserve the asset's normal primary action outside report mode.
- Record whether the target was normally clickable, selectable-only,
  noninteractive, disabled, or decorative.

### Capture Confirmation Overlay

Before the snap happens:

1. Expand Majordomo if it is collapsed.
2. Darken everything except:
   - the selected problem area,
   - the Majordomo box,
   - and the bottom confirmation controls.
3. Exception: if Majordomo itself is the problem area, do not exempt it from the
   capture target. The user must be able to screenshot the pyramid host/panel.
4. Draw a thick red glowing LED/RGB rectangle around the screenshot area.
   - The glow faces outward.
   - The inside of the capture stays visually clean.
   - The red outline is visible to the user but excluded from the final crop
     unless the user explicitly includes overlay chrome.
5. Place two large, undimmed confirmation buttons below the capture rectangle:
   - `❌` cancels.
   - `✅` captures.
6. The buttons must sit outside the crop bounds. If the crop is near the bottom
   edge, the buttons move above or to the side automatically.
7. The user can drag the rectangle or resize it from corners/edges before
   accepting.
8. The overlay should show a small label with the detected surface/feature id,
   but that label is outside the crop by default.
9. The overlay wizard must expose visible `Back`, `Next`, and `Confirm`
   controls when capture requires more than one step. Agents must screenshot
   each step and prove the screen changed after pressing `Next`.

State model:

```ts
type AreaCaptureDraft = {
  id: string;
  sessionId: string;
  dateKey: string;
  surfaceId: string | null;
  testId: string | null;
  featureId: string | null;
  clickability: 'primary-clickable' | 'selectable-only' | 'noninteractive' | 'disabled' | 'decorative';
  reportability: 'reportable' | 'reportable-in-feedback-mode' | 'context-menu-only' | 'native-only-manual' | 'exempt';
  primaryAction: string | null;
  reportAction: string;
  bounds: { x: number; y: number; width: number; height: number };
  majordomoExpandedBeforeCapture: boolean;
  targetIsMajordomo: boolean;
  overlayIncluded: false;
  note: string;
};
```

MVP implementation path:

1. Use the frontend semantic snapshot to identify the surface/control under the
   pointer.
2. Show the confirmation overlay and let the user resize/move the region.
3. Capture a DOM/app-region image for that element or region in dev/proof mode.
4. Store a markdown note plus image path in
   `area-captures/<YYYY-MM-DD>/session-<id>/`.
5. During closeout, show captured areas first and ask smart multiple-choice
   questions for each.

Click/report edge cases:

- If an asset has an `Open` button and a surrounding card, both the card and
  button need separate ids if they do different things.
- If an asset is hidden behind a project boundary, group, scroll region, or
  collapsed panel, report mode should either reveal the visible target or state
  that the asset is currently hidden and cannot be captured.
- If a crop target is partly offscreen, the overlay should auto-scroll or ask
  the user to resize the crop.
- If the target is inside a PTY/canvas/WebGL surface where DOM capture is
  partial, save `captureLimitations` and require native/manual proof before
  final acceptance.

Longer-term native path:

- Add a WebView/internal snapshot bridge that crops the selected app region.
- If native webview capture is unavailable, use the visual atlas or frontend DOM
  capture path and label the proof level honestly.

### Smart Multiple-Choice Closeout

Each captured area should seed a compact closeout card:

```text
Captured: Home / Majordomo button
Expected by map: opens command surface, answers /features, can create note.
What went wrong?
[Did not open] [Looked wrong] [Wrong wording] [Wrong position] [Too hidden]
[No proof] [Actually fine now]
Optional note: ...
```

Majordomo should generate the choices from:

- feature map expected behavior,
- known previous issues for that surface,
- recent visual mismatch patterns,
- current proof level,
- runtime analysis of what happened in this session,
- and the exact area the user captured.

Common resolution choices:

- fix visual layout,
- rename or relabel,
- move the control,
- make it more visible,
- change the interaction,
- turn it into a node,
- turn it into a panel,
- turn it into an app-surface document,
- add command support,
- add proof/atlas coverage,
- mark as fixed this session,
- or leave as an intentional design.

The optional text box should stay optional. The app should still get useful
structured learning from the multiple-choice path when the user is tired.

### Fun Adaptive Survey Experience

The survey should feel like a friendly operator debrief, not a medical form.
Use emoji/rating chips for the general experience, then adapt only where the
answer shows friction.

Top-level experience chips:

```text
How did this area feel?
😄 Good    😐 Okay    🥱 Boring    😡 Bad
```

Rules:

- If the user chooses `😄 Good`, do not interrogate that area. Ask at most one
  light follow-up like `Keep it as-is?` or skip it entirely.
- If the user chooses `😐 Okay`, ask one improvement-oriented multiple-choice
  question.
- If the user chooses `🥱 Boring`, ask whether it needs clearer energy,
  hierarchy, motion, wording, or a more useful default action.
- If the user chooses `😡 Bad`, expand into visual/interaction/proof follow-ups
  and show the optional text box.
- If the user chooses skip, record `skipped` and move on.
- If a menu/surface is already confirmed good by recent feedback and no new
  issue was captured for it, do not ask about it again this session.

Runtime analysis before closeout:

1. Load the full feature map.
2. Load recent plan/status docs.
3. Load the current app identity packet from `ui_build_provenance`.
4. Load recent surveys, visual mismatches, feature-learning notes, and open
   action items.
5. Compare the session's active surfaces, captured areas, launched agents,
   proof packs, note/document creation, and errors against expected behavior.
6. Ask about only the relevant surfaces:
   - explicitly reported areas,
   - surfaces touched this session,
   - areas with unresolved prior issues,
   - or features whose proof level changed.

The survey response should become one readable markdown document plus JSON in
the dated session folder. The markdown document must embed or link the captured
images inline so agents and Obsidian readers can see the issue without hunting.

### Adaptive Survey Execution Protocol

The closeout survey should continuously improve the platform without becoming a
drag. Use this execution protocol:

1. **Collect context silently first.** Gather app identity, project, runpath,
   scope/channel, touched surfaces, commands run, created files, launched agents,
   proof packs, console/native errors, visual atlas results, and area captures.
2. **Build issue candidates.** Convert evidence into candidate cards:
   `visual-mismatch`, `interaction-mismatch`, `proof-mismatch`,
   `missing-feature`, `workflow-drag`, `version-confusion`, `agent-runtime`,
   `file-artifact`, or `positive-signal`.
3. **Prioritize what to ask.** Ask first about explicit user reports, then
   touched surfaces with defects, then unresolved prior issues, then version or
   proof confusion. Do not ask about stable surfaces that were not touched and
   have no open issue.
4. **Ask 4 to 8 initial questions.** Keep the first pass short. Only expand the
   branches the user marks okay/boring/bad, or branches tied to a captured area.
5. **Use smart multiple-choice first.** Each card should have 4 to 7 useful
   choices plus `Actually fine now`, `Skip`, and optional text. Multiple choice
   keeps learning useful when the operator is tired.
6. **Preserve exact words.** Store the user's raw complaint separately from the
   normalized task/action item.
7. **Extract protocol updates.** Each response should update one or more durable
   buckets: feature map expectation, visual atlas coverage, proof requirement,
   UI preference, wording preference, action item, or regression guard.
8. **Trend over time.** If the same surface gets repeated bad/boring/proof
   mismatch responses, raise priority and make Majordomo ask whether the issue
   is still the same, changed, or fixed.
9. **Close with execution.** The survey output must include proposed follow-up
   tasks with owner, target file/surface, proof level required, and whether the
   task is visual, interaction, backend, proof, docs, or runtime-agent work.

Question card types:

```ts
type SurveyQuestionCard =
  | { kind: 'version-confusion'; asks: ['wrong-app', 'wrong-runpath', 'dock-stale', 'dev-vs-bundle'] }
  | { kind: 'visual-mismatch'; asks: ['spacing', 'size', 'color', 'contrast', 'hierarchy', 'motion', 'polish'] }
  | { kind: 'interaction-mismatch'; asks: ['no-response', 'wrong-response', 'too-slow', 'no-feedback', 'wrong-surface'] }
  | { kind: 'proof-mismatch'; asks: ['source-only', 'browser-mock', 'native-not-clicked', 'screenshot-missing', 'artifact-missing'] }
  | { kind: 'file-artifact'; asks: ['file-not-created', 'file-hidden', 'wrong-format', 'not-openable', 'not-on-canvas'] }
  | { kind: 'agent-runtime'; asks: ['not-running', 'not-listening', 'wrong-scope', 'timeout-confusing', 'no-status'] }
  | { kind: 'workflow-drag'; asks: ['blocked-laptop', 'too-many-restarts', 'manual-repeat', 'version-hunt', 'slow-proof'] };
```

Learning extraction:

- `expected` is what the feature map said should happen or what the operator
  said they expected.
- `actual` is what the app, screenshot, proof pack, or operator observed.
- `gap` is the smallest concrete mismatch.
- `nextProof` is the proof level required before an agent can claim done.
- `nextAction` names the likely code/doc/visual/runtime area.

This is the anti-sloppiness mechanism: every complaint becomes a visible
artifact, a structured learning record, and an execution/proof requirement.

### Closeout Triggers

Run closeout when any of these normal session exits happen:

- user clicks `End Session`,
- user closes a project,
- user exits the app through the app UI,
- user chooses to stop all agents,
- user chooses to leave a background/runtime agent running,
- user closes the last active project window,
- or a configured idle-end timer fires and the user confirms they are done.

Do not run closeout during:

- force quit,
- crash,
- OS shutdown,
- hard process kill,
- or urgent quit where the user explicitly chooses `Quit Now`.

After an abrupt end, show the next-launch recovery prompt once and store any
response in the new day's session folder.

### Initial Survey Shape

Ask only 4 to 8 questions at first. The app should adapt based on answers. A
normal close should feel like a good product conversation, not a tax form.

Required first-pass questions:

1. What were you trying to accomplish in this session?
2. Did the app help you move faster, slower, or about the same?
3. What felt visually wrong, awkward, ugly, hidden, or surprising?
4. What button, surface, or feature did you expect to work differently?
5. Did any agent claim proof that did not match what you saw?
6. What should Majordomo or the app remember for next time?
7. What is the one change that would make the next session feel better?
8. Optional: should the app create follow-up tasks from this feedback?

The survey should accept:

- short text,
- long text,
- screenshots/visual atlas references,
- point-and-report area captures,
- emoji/rating chips,
- smart multiple-choice choices,
- voice-to-text later,
- rating chips where useful,
- and "skip" without guilt.

### Adaptive Follow-Up Logic

If a rating is unsatisfactory, Majordomo should draw out the concrete mismatch.
It should not ask generic "why?" loops. It should ask visual and behavioral
questions that help an agent reproduce the gap.

For visual dissatisfaction:

- What did you expect to see?
- What did you actually see?
- Where on the screen was the problem?
- Was it spacing, size, color, contrast, motion, wording, hierarchy, or missing
  state?
- Did it look bad, or did it fail to communicate what it was?
- Should the control feel calm, powerful, playful, quiet, technical, or
  premium?
- Can the visual atlas screenshot capture this state now?

For interaction dissatisfaction:

- What did you click or try to do?
- What happened?
- What should have happened instead?
- Did you need a visible result, a file, a message, a node, or a panel?
- Was the failure silent, confusing, too slow, or just wrong?
- Would a command from Majordomo have made it easier?

For agent/proof dissatisfaction:

- What did the agent say was verified?
- What did you personally see?
- Was the proof source code, browser mock, native app, screenshot, or actual
  click-through?
- What proof would have satisfied you?
- Should this become a required acceptance check?

For missing feature or hidden surface dissatisfaction:

- What feature did you look for?
- Where did you expect it to live?
- What words/icons would have made it obvious?
- Should Majordomo know how to open or explain it?
- Should this be a Home command, canvas command, project command, or advanced
  command?

For workflow drag:

- What made you wait?
- What made you stop using your laptop?
- What could run headlessly next time?
- What should the app remember so you do not repeat setup?

### Full Question Bank

Majordomo can pull from this bank when needed, but should not dump all 30 at
once.

1. What job were you trying to get done?
2. What was the first moment the app felt helpful?
3. What was the first moment the app felt in your way?
4. Which surface did you use most?
5. Which surface did you avoid because it looked confusing?
6. Which button looked wrong, too small, too hidden, or out of place?
7. Which click produced no visible response or the wrong response?
8. Which feature did you believe existed but could not find?
9. Which feature exists but feels half-hidden?
10. What did you expect Majordomo to know?
11. Did Majordomo feel like a real assistant or a decorative button?
12. Did the app produce a real file/artifact when you expected one?
13. Did any proof claim feel dishonest or incomplete?
14. What screenshot would have convinced you the work was real?
15. Did the app steal your attention when it should have worked in the
    background?
16. Did any labels use internal language you should not need to understand?
17. Did any advanced controls appear in the normal happy path?
18. Did any important warning appear too late?
19. Did any command feel risky without enough explanation?
20. Did the canvas feel alive and useful or decorative?
21. Were agents visibly listening?
22. Were agent messages and task states easy to connect?
23. Did project, task, note, browser, and agent concepts stay distinct?
24. Did you lose context when switching surfaces?
25. What should be one click next time?
26. What should be hidden until Advanced?
27. What should be automated on session close?
28. What should be remembered as a preference?
29. What should become a task for the next build?
30. What would make this feel like a serious control room instead of a lab?

### Survey Output Format

Each session survey markdown should include:

```md
# Session Learning - <date> - <session id>

Project: <project name/path>
App: swarm-ui <LAB|ACTIVE|LOCAL> v<version>
Shell: Tauri 2 / <run kind> / <build profile>
Run path: <executable path or bundle path>
Source root: <source root>
Dock status: <not-this-run | this-bundle-run | unknown>
Git: <branch>@<commit><dirty marker>
Session end: normal | forced quit recovery | crash recovery
Primary surfaces: <surface ids>
Visual atlas run: <path or not captured>
Area captures: <paths or none>
Dated learning folder: <path>

## Quick Answers

## Area Captures

![Captured area](./001-majordomo-button.png)

## Unsatisfactory Areas

## Visual Mismatches

## Interaction Mismatches

## Proof Mismatches

## Feature Requests

## Preferences To Remember

## Proposed Follow-Up Tasks

## Raw Transcript
```

The companion JSON should include the same data as structured fields:

```json
{
  "sessionId": "...",
  "endedAt": "...",
  "endKind": "normal",
  "appIdentity": {
    "appName": "swarm-ui",
    "appVariant": "lab",
    "appVersion": "0.1.0",
    "shell": "tauri",
    "tauriMajor": 2,
    "runKind": "tauri-dev",
    "buildProfile": "debug",
    "sourceRoot": "...",
    "currentWorkingDirectory": "...",
    "executablePath": "...",
    "appBundlePath": null,
    "gitBranch": "...",
    "gitCommit": "...",
    "gitDirty": true,
    "dockStatus": "not-this-run"
  },
  "projectRoot": "...",
  "surfaceIds": [],
  "ratings": {},
  "unsatisfactoryAreas": [],
  "areaCaptures": [],
  "dailyFolder": "...",
  "closeoutDocument": "...",
  "visualMismatches": [],
  "interactionMismatches": [],
  "proofMismatches": [],
  "featureRequests": [],
  "preferences": [],
  "followUpTasks": []
}
```

### Contradictions To Handle

- The user wants a survey every session, but not a 30-question burden every
  time. Resolve this with 4 to 8 initial questions plus adaptive follow-ups.
- The user wants background/offscreen testing, but some native behaviors are OS
  permission-bound. Resolve this with visual atlas and command bus proof first,
  then explicit native/manual proof only where needed.
- The user wants Majordomo to be the main internal assistant, but Majordomo must
  not become a magic black box. Resolve this with a visible feature map, source
  links, proof levels, and stored survey artifacts.
- The user wants double-click/two-finger report capture, but the canvas already
  uses some gestures. Resolve this with feedback mode plus context-menu
  `Report this area`, and only use double-click capture when it cannot collide.
- The user wants screenshots of a bad area, but not whole-screen Mac captures.
  Resolve this with internal app/webview region capture and honest proof-level
  labels when native webview capture is unavailable.
- The user wants the Majordomo box visible during capture, but also needs to
  report Majordomo itself. Resolve this by exempting Majordomo from dimming only
  when it is not the capture target.
- The user wants a fun survey, but not noisy questioning about things that are
  already good. Resolve this with emoji chips, skip, runtime analysis, and
  asking only about touched/reported/unresolved surfaces.
- The user wants creative probing, but not sloppy speculation. Resolve this by
  asking concrete "expected vs actual" questions and saving evidence references.
- The user wants acceleration, but agents can get lazy over time. Resolve this
  by extracting follow-up tasks, linking proof gaps, and reviewing trend history
  before claiming a feature is done.
- The user expects clicking the Dock icon to be the latest app, but development
  often runs through `tauri-dev`. Resolve this by showing version/runpath on
  Home, recording the runpath in surveys/proof packs, and labeling Dock/bundle
  freshness honestly instead of implying a dev run updated the Dock app.

### Anti-Sloppiness Rules

- Never summarize feedback into vague praise like "improve UI."
- Always preserve the user's exact complaint in Raw Transcript.
- Convert each complaint into at least one of: visual mismatch, interaction
  mismatch, proof mismatch, feature request, preference, or follow-up task.
- If feedback says "ugly" or "doesn't look good," ask what should be seen,
  where it should sit, and what feeling it should create.
- If feedback says "it didn't work," ask what was clicked, what happened, and
  what artifact should have appeared.
- If feedback says "agent said verified," ask what evidence level would count.
- Do not close a survey with only ratings; collect at least one sentence of
  qualitative learning unless the user explicitly skips.
- Before each new implementation session, Majordomo should read recent open
  survey action items and known proof mismatches.
- Before asking closeout questions, Majordomo should load captured areas and ask
  about those surfaces first.

### Obsidian And Shared Knowledge

The recommended Obsidian vault root is:

```text
/Users/mathewfrazier/Desktop/9889-new-times/workspace
```

Why this root:

- It includes `Experiental Learning Evolution/`.
- It leaves room for adjacent 9889 New Times project notes.
- It avoids forcing Obsidian to see only one narrow subfolder.
- It lets agents and humans link learning notes to other workspace artifacts.

The app should provide an `Open Learning In Obsidian` action that opens:

```text
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
```

Agent instruction: any agent working on swarm-ui product behavior, visual QA,
Majordomo, canvas notes, proof packs, or session learning should read the shared
learning README plus open action items before planning. This rule also belongs
in `Agents.md` so it is not dependent on Majordomo being built.

## Hot UI Movement Without Restart

There are three levels.

### Level 1: Vite HMR

Frontend Svelte/CSS changes can hot reload while `bun run dev` or `bunx tauri
dev` points at the dev server. This already means many visual nudges can show
without a full app restart.

### Level 2: Runtime Dev Tweaks

Add a dev-only tweak store:

```json
{
  "majordomo.button.x": 12,
  "majordomo.button.y": 0,
  "note.surface.width": 420
}
```

The app watches this store and applies CSS variables or inline transform
overrides immediately.

Then a command like:

```text
move majordomo button right 12
```

can update the tweak store and the operator sees the button move live.

Majordomo CLI should expose this directly:

```text
/tweak move majordomo button right 12
/tweak resize note surface wider 40
/tweak reset current
/tweak accept current
```

Flow:

1. Majordomo parses the natural command into a runtime tweak.
2. The app applies the tweak immediately through `ui.tweak.apply`.
3. The capture overlay or visual atlas can show the changed surface without
   restart.
4. The user accepts or resets.
5. Only after acceptance does Codex convert the tweak into a source patch.

### Level 3: Persist To Source

After the tweak looks right, Codex converts the runtime tweak into a source
patch. This still needs code review and build/check.

Rust/Tauri/backend changes still require restart/rebuild.

## New Verification Policy

Do not spend time on native synthetic click loops unless one of these is true:

- Accessibility permission is confirmed.
- The test is explicitly manual/human-visible.
- The workflow has no command-bus or browser-atlas alternative.

Default proof order:

1. Unit tests for data/file/IPC behavior.
2. Visual atlas screenshots for every surface/state.
3. Semantic snapshot for the live app state.
4. Native command-bus workflow for real app behavior.
5. Native screenshot only when supported.
6. Human/manual click proof only for final acceptance gaps.

Every final implementation report must label each feature with this ladder:

```text
stated -> implemented -> visible -> visually acceptable -> flow verified -> regression guarded
```

Meaning:

- `stated`: requirement appears only in docs/plans.
- `implemented`: code exists, but no visual proof yet.
- `visible`: the operator or atlas can see it.
- `visually acceptable`: screenshot review confirms it looks and feels right.
- `flow verified`: click/command path produced the expected artifact or state.
- `regression guarded`: test/atlas/proof pack prevents quiet drift.

Do not call work done when it is only `stated`, only `implemented`, or only
barely `visible`.

## End-To-End Operator Workflow Verification

Every major workflow needs a visible operator verification pass. The pass must
prove the app responds, not merely that a static screen exists.

Current implementation: `swarm-mcp ui operator-verify --out <dir>` writes an
app-owned proof pack with atlas-backed screenshots, semantic before/after
snapshots, session rows, launched-agent classification, Dock bundle status, and
cleanup audit. The current headless proof covers internal
semantic/app-region-dom/native-command evidence and explicitly classifies native
macOS click/screenshot/Automation proof as not attempted.

Minimum workflow proof:

1. Start the correct app version using the `Run This Version` block.
2. Open Home and capture the app identity/runpath strip.
3. Open or create a project.
4. Click a project asset or canvas asset and verify the screen reflects the
   primary action:
   - file/document opens,
   - note/document surface appears,
   - selected state changes,
   - project panel changes,
   - or a clear disabled/error state appears.
5. Enter `Report area` mode.
6. Target the same asset or nearby asset and verify the primary action is not
   accidentally triggered while report mode is active.
7. Press `Next` in the capture/survey flow and screenshot the changed screen.
8. Press `Confirm` and verify:
   - image file exists,
   - markdown sidecar exists,
   - JSON metadata exists,
   - survey shows the captured asset,
   - and the metadata includes clickability/reportability.
9. Launch an agent from the verified project path.
10. Verify the agent is not forgotten:
    - PTY/session row appears,
    - instance id or launch placeholder is visible,
    - status transitions from launching to online/stale/error,
    - project id/scope/channel labels match the active project,
    - timeout/background status is visible,
    - Analyze/Resume Center can see it,
    - and cleanup/kill/deregister controls reference the same id.
11. If the agent launch fails, verify a visible failed launch record exists or
    the launch is rolled back cleanly. Do not leave an invisible ghost session.

Ghost-session prevention rules:

- Every agent launch gets a `launchId` before spawn.
- The UI tracks `launching`, `online`, `failed`, `stale`, `terminated`, and
  `orphaned` states.
- A PTY without a bound instance must show as `orphaned` or `unbound`, not
  disappear.
- An instance without a PTY must show as `headless/background`, not disappear.
- If the user closes a project while agents are running, the app must ask
  whether to stop, leave running, or move them to Resume Center.
- Closeout survey must include launched agents and unresolved ghost/orphan
  warnings.

Verification artifacts:

```text
output/operator-verification/<timestamp>/
  index.md
  01-home-version.png
  02-project-open.png
  03-asset-primary-click.png
  04-report-mode-target.png
  05-report-next.png
  06-report-confirmed.png
  07-agent-launching.png
  08-agent-tracked.png
  semantic-before.json
  semantic-after.json
  session-rows.json
  launched-agent.json
  dock-bundle.json
  cleanup-audit.json
  operator-proof.json
```

The report must say which steps were native Tauri app-shell proof, which were
browser-preview proof, and which remain manual/human-needed.

## First Implementation Slice

Detailed task plan:

```text
docs/superpowers/plans/2026-05-08-majordomo-visual-proof-and-learning.md
```

Build this first:

0. Finish/decide the partially executed Home app identity slice:
   - keep or revise `appIdentity.ts`,
   - keep or revise the Home summary strip,
   - register `home.app-identity-strip` in the feature map,
   - and prove the Tauri-native provenance path before calling it complete.
1. Add a typed feature/control registry in `featureMap.ts` and wire
   `docs/CURRENT_APP_FEATURES.md` into the Home/Majordomo feature index.
2. Add stable `data-surface` and `data-testid` attributes to every registered
   surface/control in the first registry pass.
3. Add clickability/reportability metadata and `data-report-target` coverage for
   visible assets, including clickable, non-clickable, disabled, and decorative
   cases.
4. Add `visualAtlasRegistry.ts` and make coverage fail on `missing-coverage`.
5. Add `VisualAtlas.svelte` and `swarm-mcp ui visual-atlas --out ...` so it
   writes screenshots, semantic snapshots, `feature-map.json`, `coverage.json`,
   and `index.md`.
6. Add `window.__SWARM_UI_PROOF__.snapshot()` and
   `window.__SWARM_UI_PROOF__.captureRegion(draft)`.
7. Add `ui_save_area_capture` to write internal app-region PNGs plus sidecar
   markdown/JSON into dated session folders.
8. Add `Report area` feedback mode for Home/Majordomo, Canvas notes, and at
   least one Project Page surface.
9. Add the dimmed capture confirmation overlay with draggable/resizable red
   LED/RGB crop rectangle and outside-crop `❌` / `✅` controls.
10. Add visible `Back`, `Next`, and `Confirm` wizard states for multi-step
    capture/survey flows and require screenshot proof after `Next`.
11. Add default-on runtime Majordomo binding from the pyramid panel using
   `spawnShell` with `role:majordomo` and `owner:majordomo` label metadata.
12. Add explicit closeout triggers and write closeout survey markdown/JSON into
    the same dated session folder as captured screenshots.
13. Add an `Open Learning In Obsidian` action pointing at the shared learning
    README under the 9889 New Times workspace.
14. Add Majordomo CLI live tweak commands that route through runtime tweak state
    and persist to source only after user acceptance.
15. Add Home first-viewport app identity/version/runpath strip using
    `ui_build_provenance`, and include the same packet in Majordomo/CLI/session
    closeouts.
16. Add PTY/agent-card report gesture handling that preserves terminal-native
    double-click behavior unless feedback mode or an explicit report affordance
    is active.
17. Add the required `Run This Version` block to Codex/Claude/Majordomo/CLI
    final reports after edits.
18. Make browser/atlas tests headless by default and close/cleanup any spawned
    Playwright/Chromium browser so macOS Dock icons do not accumulate.
19. Add the end-to-end operator verification report that clicks a real asset,
    shows the screen update, steps through `Next` and `Confirm`, and verifies a
    launched agent remains tracked or visibly failed.

Acceptance for Slice 1:

- Home first viewport visibly shows LAB/ACTIVE/LOCAL, version, DEV/BUNDLE mode,
  compact runpath, and Dock/bundle status.
- Running the visual atlas command writes screenshots without focusing the
  native app and fails on any `missing-coverage`.
- The screenshot report includes every registered first-pass surface/control, or
  an explicit exemption with reason and owner.
- The registry includes clickability/reportability metadata for every visible
  asset-like surface.
- A clickable asset opens normally outside feedback mode and opens report capture
  in feedback mode.
- A non-clickable visible asset can still be targeted and captured in feedback
  mode.
- The canvas-note screenshot shows the actual document surface, not just a
  hidden asset record.
- Reporting an area captures only the app surface/control region, not the whole
  Mac screen, and stores it under `area-captures/YYYY-MM-DD/session-<id>/`.
- Closeout survey shows the captured area and gives smart choices seeded by the
  feature map.
- Majordomo expands during capture confirmation unless Majordomo is the target.
- The capture overlay darkens unrelated UI, preserves the capture area, shows a
  thick red glowing crop rectangle, and keeps `❌` / `✅` outside the crop.
- Multi-step report/survey flow shows `Next` and `Confirm`, and screenshot proof
  shows the screen changed after `Next`.
- A runtime Majordomo auto-binds or can be started as a real `role:majordomo`
  instance with visible status/timeout metadata.
- Launching an agent from a verified project creates a visible tracked session,
  PTY, instance, or failed launch record. No invisible ghost session is accepted.
- Analyze/Resume Center or equivalent can locate the launched agent by the same
  id used in the proof report.
- The dated session folder contains screenshot image(s), sidecar capture note(s),
  closeout survey markdown, and closeout survey JSON.
- The closeout survey JSON contains app identity, Tauri shell/run kind, source
  root, executable path, bundle path, project root, scope/channel, session id,
  branch, commit, dirty state, and Dock/bundle status.
- A live tweak command changes a visible element without restart and can be
  accepted or reset.
- The final report states which paths are mocked browser atlas and which are
  real native app state.

## What To Stop Doing Immediately

Stop treating these as acceptance proof:

- "I opened the app and saw the home screen."
- "I tried to click it with CGEvent."
- "Playwright clicked a Vite mock, so native is done."
- "The build passed, so the UI works."

Those can be supporting evidence. They are not the proof standard.
