# Majordomo Visual Proof And Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first durable slice of exhaustive visual proof, default-on runtime Majordomo, app-region issue capture, and adaptive session learning.

**Architecture:** Add a generated feature/control registry as the authority for atlas coverage and Majordomo's mental map. Add internal app-region capture through frontend DOM/region capture plus a Tauri file-write bridge, then store screenshots and closeout survey documents together in dated session folders. Bind the pyramid Majordomo panel to a real `role:majordomo` runtime agent by default in the lab profile, while keeping deterministic local fallback survey logic.

**Tech Stack:** Svelte 5, TypeScript, Tauri 2/Rust, Bun tests, `svelte-check`, existing `spawnShell`, existing project/asset/proof helpers.

---

## Execution Status Ledger

Current policy as of 2026-05-08: broad execution is authorized. Execute the
remaining overhaul as three macro phases, not as seven stop-and-wait gates.
Mathew is not manually testing between phases; agents must build the app-owned
proof capability and run the final evidence pass themselves.

| Area | Status | Evidence | Remaining |
| --- | --- | --- | --- |
| Task 0 app identity helper | Done for Macro Phase 1. | `apps/swarm-ui/src/lib/appIdentity.ts` exists; `apps/swarm-ui/src/lib/appIdentity.test.ts` passed. | Native Tauri app-shell proof still needed before release. |
| Task 0 Home identity strip | Done for browser/semantic proof. | `StartupHome.svelte` renders `data-testid="home-app-identity-strip"`; `output/visual-atlas/macro-phase-1/home.png` and `home.semantic.json` exist. | Dock/bundle freshness check not implemented. |
| Task 0 test/check | Done for Macro Phase 1 proof engine. | `bun test apps/swarm-ui/src/lib/appIdentity.test.ts apps/swarm-ui/src/lib/featureMap.test.ts apps/swarm-ui/src/lib/visualAtlasRegistry.test.ts test/visual-atlas-cli.test.ts`, `bun run typecheck`, and `cd apps/swarm-ui && bun run check` passed. | Not end-to-end operator proof. |
| Task 0 feature-map registration | Done. | `apps/swarm-ui/src/lib/featureMap.ts` registers `home.app-identity-strip` and 19 total controls across 11 surfaces. | Expand registry as new Macro Phase 2/3 controls land. |
| Macro Phase 1 proof engine | Done for browser/semantic atlas proof. | `bun run src/cli.ts ui visual-atlas --out output/visual-atlas/macro-phase-1 --json` exited 0; `coverage.json` reports 11 surfaces, 19 controls, 0 issues; no leftover Vite listener on port 1420. | Native command-bus/app-region proof moves to Macro Phase 2/3. |
| Macro Phase 2 product loop | Done for model, browser/semantic atlas, and native write-bridge proof. | `bun test ...` passed 30 focused tests; `bun run typecheck`; `cd apps/swarm-ui && bun run check`; `cargo test -p swarm-ui area_capture -- --nocapture`; `bun run src/cli.ts ui visual-atlas --out output/visual-atlas/macro-phase-2 --json` exited 0 with 12 surfaces, 24 controls, 0 issues. | Full operator workflow and live Hermes launch/cleanup proof move to Macro Phase 3. |
| Macro Phase 3 operator proof | Done for internal semantic/app-region/native-command proof and explicit native-launch classification. | `bun test ...` passed 35 focused tests; `bun run typecheck`; `cd apps/swarm-ui && bun run check`; `cargo test -p swarm-ui area_capture -- --nocapture`; `bun run src/cli.ts ui visual-atlas --out output/visual-atlas/macro-phase-3 --json` exited 0 with 12 surfaces, 25 controls, 0 issues; `bun run src/cli.ts ui operator-verify --out output/operator-verification/macro-phase-3 --json` wrote 8 classified steps and `ghostAgent=false`. | Native macOS click/screenshot/Automation and live Hermes launch proof were not attempted in this headless run. |
| Runpath closeout block | Documented requirement. | Added to this plan and visual/Majordomo plan. | Implement in Codex/Claude/Majordomo/CLI closeout output. |
| Chrome/Dock test hygiene | Documented requirement. | Added to visual/Majordomo plan and action items. | Make browser tests headless by default and clean up spawned browser processes/icons. |
| Asset click/reportability | Documented requirement. | Added to visual/Majordomo plan and this implementation plan. | Add metadata to feature registry and prove clickable/non-clickable assets remain reportable. |
| Operator workflow verification | Implemented for app-owned internal proof. | `operatorWorkflowProof.ts`, `test/operator-verify-cli.test.ts`, and `swarm-mcp ui operator-verify --out <dir>` write screenshots, semantic snapshots, session rows, launched-agent proof, Dock bundle status, and cleanup audit. | Escalate to native macOS click/screenshot/Automation only after permissions are intentionally granted. |
| Hermes runtime research | Done for planning. | `Hermes` resolves to `/Users/mathewfrazier/.local/bin/Hermes`; local help confirms `--tui`, `-z/--oneshot`, `--model`, `--provider`, `--toolsets`, `--source`, sessions, and MCP commands; current app already recognizes the `hermes` harness and `majordomo` role. | Implement visible Hermes PTY lifecycle, swarm MCP context, cleanup proof, and survey fallback. |
| Review finding: proof-pack stale diagnostics | Done in Phase 0. | `taskRowsForProofPack()` now uses `resolveTaskBoardRowRuntime()` and focused task-board tests passed. | None. Keep this behavior guarded while proof-pack code evolves. |
| Review finding: Escape closes shell behind overlay | Done in Phase 0. | `handleWindowKeydown()` now checks `!overlayOpen` before closing the shell surface on Escape; `bun run check` passed. | None. Add UI-command/browser proof when the proof engine lands. |
| Review finding: untracked generated/binary artifacts | Cleaned/quarantined in Phase 0. | Removed `.playwright-cli`, duplicate `* 2.png` / `* 3.png` icon files, and `desktop-schema 2.json`; moved unlinked screenshots/icon backups outside the repo. | Keep intentional proof screenshots explicit at commit time. |
| Majordomo chief-contact surface | Added to plan. | Operator wants one omnipresent Majordomo surface for idea dumps, will clarification, workflow launch, swarm management, and slippage checks. | Implement in Macro Phase 2 after the feature map and proof command bus exist. |
| Tasks 0-8 | Authorized under three macro phases. | Phase 0 stabilization is complete; the remaining registry, atlas, capture, Majordomo, closeout, tweak, CLI, and verification tasks are mapped below. | Roll through Macro Phases 1-3 and reserve manual operator testing for final evidence review. |

Do not report the whole overhaul as done because Macro Phase 1 is implemented.
Use the completion ladder from `docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md`:

```text
stated -> implemented -> visible -> visually acceptable -> flow verified -> regression guarded
```

Current Macro Phase 1 state is `flow verified` for browser/semantic atlas proof,
and not yet `flow verified` in the native Tauri shell.

## Required Closeout Runpath Block

After any code edit by Codex, Claude, Majordomo, the CLI, or another agent, the
final report must include a `Run This Version` block.

Minimum format:

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

If the Dock/app bundle is updated and verified, replace `not confirmed updated`
with the exact app bundle path and timestamp. If only Vite/browser preview was
used, say so plainly.

## File Structure

- Create `apps/swarm-ui/src/lib/featureMap.ts`: typed feature/control registry for surfaces, buttons, commands, expected behavior, and proof requirements.
- Create `apps/swarm-ui/src/lib/featureMap.test.ts`: validates unique ids and required metadata.
- Create `apps/swarm-ui/src/lib/operatorWorkflowProof.ts`: proof model for asset click, report Next/Confirm, and launched-agent tracking.
- Create `apps/swarm-ui/src/lib/operatorWorkflowProof.test.ts`: verifies required proof steps and ghost-session failure detection.
- Create `apps/swarm-ui/src/lib/visualAtlasRegistry.ts`: maps feature/control ids to atlas states and coverage status.
- Create `apps/swarm-ui/src/lib/visualAtlasRegistry.test.ts`: fails when a visible control has no atlas/semantic/manual coverage.
- Create `apps/swarm-ui/src/lib/appIdentity.ts`: normalizes `ui_build_provenance` into app variant, version, runpath, and Dock/bundle status.
- Create `apps/swarm-ui/src/lib/appIdentity.test.ts`: validates lab/active detection, compact runpath labels, and Dock/dev status.
- Modify `apps/swarm-ui/src/panels/StartupHome.svelte`: show app identity/version/runpath in the first Home viewport.
- Create `apps/swarm-ui/src/visual-atlas/VisualAtlas.svelte`: deterministic atlas surface renderer.
- Modify `apps/swarm-ui/src/App.svelte`: add visual-atlas route, report-area mode, closeout triggers, and tweak command bridge.
- Create `apps/swarm-ui/src/panels/AreaCaptureOverlay.svelte`: dimmed confirmation overlay with draggable/resizable red crop rectangle and outside-crop cancel/confirm buttons.
- Create `apps/swarm-ui/src/lib/areaCapture.ts`: capture draft types, folder naming, data URL validation, markdown/JSON payload builders.
- Create `apps/swarm-ui/src/lib/areaCapture.test.ts`: validates dated paths, metadata, and closeout document payloads.
- Modify `apps/swarm-ui/src-tauri/src/ui_commands.rs`: add `ui_save_area_capture` and expose explicit proof-level result.
- Modify `apps/swarm-ui/src-tauri/src/main.rs`: register `ui_save_area_capture`.
- Modify `apps/swarm-ui/src/panels/MajordomoArchitect.svelte`: add default runtime state, Start Majordomo, bind existing `role:majordomo`, and status/timeout display.
- Create `apps/swarm-ui/src/lib/majordomoRuntime.ts`: labels, Hermes runtime prompt, matching existing instance, launch option helpers, model/provider/source-tag metadata, cleanup policy, and no-ghost lifecycle state.
- Create `apps/swarm-ui/src/lib/majordomoRuntime.test.ts`: validates labels, prompt inputs, duplicate prevention, Hermes command defaults, timeout metadata, closeout cleanup states, and no orphan/ghost detection.
- Create `apps/swarm-ui/src/lib/sessionCloseout.ts`: trigger model, adaptive survey selection, and storage packet builders.
- Create `apps/swarm-ui/src/lib/sessionCloseout.test.ts`: validates closeout triggers, forced-quit recovery behavior, skip/good-area logic, Majordomo loading timeout fallback, and captured-image inclusion.
- Modify `src/cli.ts`: add `swarm-mcp ui visual-atlas --out <path>` and `swarm-mcp ui operator-verify --out <path>` proof commands.
- Keep docs in sync: `docs/CURRENT_APP_FEATURES.md`, `docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md`, and the 9889 New Times learning folder templates.

---

## Macro Phase Sequence

The old seven-phase ladder is retired as an execution gate. Keep the detailed
task blocks below for traceability, but drive the overhaul through three macro
phases so agents can roll forward and generate proof without waiting on manual
operator testing between slices.

### Completed Preflight: Phase 0 Stabilization

Goal: protect evidence quality, keyboard behavior, and commit cleanliness before
the larger overhaul.

Status: complete. Proof-pack stale diagnostics, Escape overlay priority, and
generated-artifact cleanup were handled before the macro-phase run.

### Macro Phase 1: Build The Proof Engine

Goal: create the source of truth and app-owned proof surfaces the rest of the
overhaul can trust.

Owns:

- Task 0: app identity, version, runpath, and Home identity strip.
- Task 1: feature/control registry, clickability/reportability metadata, and
  feature-matrix sync.
- Task 2: exhaustive visual atlas coverage gate.
- Task 7: visual atlas CLI command.
- The semantic snapshot and command-bus parts needed to prove surfaces without
  macOS click automation.

Exit bar: agents can run an app-owned proof command that produces identity,
feature-map coverage, semantic state, console status, and atlas artifacts.

Status: complete for headless browser/CDP proof. The proof command writes
`output/visual-atlas/macro-phase-1/feature-map.json`, `coverage.json`,
surface screenshots, semantic snapshots, and `index.md`.

### Macro Phase 2: Build The Product Loop

Goal: wire the operator-facing learning loop and visible Majordomo runtime on
top of the proof engine.

Owns:

- Task 3: app-internal area capture.
- Task 4: default-on runtime Majordomo through visible Hermes-backed PTY.
- Task 5: session closeout and survey packet.
- Task 6: Majordomo CLI live tweaks.
- Omnipresent Ask Majordomo / Clarify Will, idea-dump cleanup, workflow
  proposals, slippage checks, and deterministic fallback behavior.

Exit bar: the app can capture a reported area, save learning artifacts, launch
or bind Majordomo visibly, ask/adapt closeout questions, and record cleanup
state without depending on hidden sessions.

Status: complete for model, browser/semantic atlas, and native write-bridge
proof. Evidence lives under `output/visual-atlas/macro-phase-2/`.

### Macro Phase 3: End-To-End Proof And Release

Goal: prove the operator workflow, harden cleanup, and produce final evidence
from the app itself.

Owns:

- Task 8: operator workflow verification and ghost-session guard.
- Full visual atlas run and proof-pack index.
- Launch tracking proof across Canvas, Analyze, Resume Center, or visible
  failed-launch records.
- Dock/bundle freshness proof, runpath closeout, and final cleanup audit.

Exit bar: the final generated evidence packet proves asset click/report flow,
Next/Confirm behavior, persisted capture files, launched-agent tracking,
Majordomo runtime cleanup, and honest native/browser/internal proof levels.

Status: complete for internal semantic/app-region/native-command proof and
explicit native-launch classification. Evidence lives under
`output/visual-atlas/macro-phase-3/` and
`output/operator-verification/macro-phase-3/`. Native macOS click/screenshot
and Automation proof were not attempted in this headless run.

The remaining task blocks are now implementation checklists inside these macro
phases. Do not re-expand them into seven approval gates unless Mathew explicitly
asks to slow the run down.

---

### Task -1: Completed Preflight - Phase 0 Stabilization

**Files:**
- Modify: `apps/swarm-ui/src/lib/taskBoardModel.ts`
- Test: `apps/swarm-ui/src/lib/taskBoardModel.test.ts`
- Modify: `apps/swarm-ui/src/App.svelte`
- Review cleanup: `.playwright-cli/`, `output/playwright/`,
  `apps/swarm-ui/src-tauri/icons/* 2.png`, `apps/swarm-ui/src-tauri/icons/* 3.png`,
  `apps/swarm-ui/src-tauri/gen/schemas/desktop-schema 2.json`

Completed evidence:

- `cd apps/swarm-ui && bun test src/lib/taskBoardModel.test.ts src/lib/taskBoardState.test.ts`
  passed 10 tests.
- `cd apps/swarm-ui && bun run check` passed with 0 Svelte errors/warnings.
- Scratch artifacts were removed or quarantined outside the repo.

- [x] **Step 1: Add failing proof-pack stale diagnostics test**

Add a test that proves a launched row with a missing instance exports the same
stale runtime state the UI shows:

```ts
import { describe, expect, test } from 'bun:test';
import { taskRowsForProofPack, type TaskBoardRow } from './taskBoardModel';

function row(input: Partial<TaskBoardRow>): TaskBoardRow {
  return {
    id: 'task-row-1',
    projectId: 'project-1',
    sourceTaskId: 'task-1',
    section: 'Build',
    title: 'Launch missing agent',
    description: '',
    status: 'claimed',
    provider: 'codex',
    role: 'implementer',
    assignee: '',
    listenerState: 'launched and bound',
    elapsed: '1m',
    lastActivity: 'just now',
    result: '',
    files: [],
    priority: 2,
    selected: true,
    draft: false,
    launchStatus: 'launched',
    launchPtyId: '',
    launchInstanceId: 'agent-missing-123',
    launchError: '',
    ...input,
  };
}

describe('taskRowsForProofPack', () => {
  test('exports stale missing instance diagnostics used by the visible task board', () => {
    const [proofRow] = taskRowsForProofPack([row({})], []);

    expect(proofRow.listenerState).toBe('stale - missing agent-mi');
    expect(proofRow.launchError).toContain('missing from live swarm state');
  });
});
```

- [x] **Step 2: Fix proof-pack row mapping**

Update `taskRowsForProofPack()` in `taskBoardModel.ts` to call
`resolveTaskBoardRowRuntime(row, instances)` and export:

```ts
const runtime = resolveTaskBoardRowRuntime(row, instances);

listenerState: runtime.listenerState,
launchError: runtime.launchError,
```

Expected result: proof packs now preserve stale/offline/missing launch evidence.

- [x] **Step 3: Run focused proof-pack tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/taskBoardModel.test.ts src/lib/taskBoardState.test.ts
```

Expected: both pass.

- [x] **Step 4: Fix Escape overlay priority**

In `App.svelte`, change the Escape branch from:

```ts
if (event.key === 'Escape' && shellSurfaceOpen && !shellSurfaceHasInternalModal()) {
```

to:

```ts
if (
  event.key === 'Escape'
  && shellSurfaceOpen
  && !overlayOpen
  && !shellSurfaceHasInternalModal()
) {
```

Expected result: Escape does not close the shell surface behind Settings, Home,
Mobile Access, Analyze, FrazierCode, Inspect Workspace, or Agent Command Center.

- [x] **Step 5: Run app check**

Run:

```bash
cd apps/swarm-ui && bun run check
```

Expected: Svelte check passes.

- [x] **Step 6: Clean or quarantine generated artifacts**

Before committing, classify untracked artifacts:

```bash
git status --short --untracked-files=all
```

Rules:

- Keep intentional new source/docs/assets.
- Do not commit `.playwright-cli/` scratch logs.
- Do not commit duplicate generated files like `desktop-schema 2.json` or icon
  files named `* 2.png` / `* 3.png` unless Mathew explicitly says they are
  deliverables.
- Preserve proof screenshots only when they are intentionally linked from docs
  or a proof pack.
- Add ignore rules only for repeatable scratch output, not for source files.

- [x] **Step 7: Phase 0 closeout**

Report:

- proof-pack stale diagnostics fixed or still blocked,
- Escape overlay priority fixed or still blocked,
- artifact cleanup status,
- exact tests run,
- and the required `Run This Version` block.

---

### Task 0 (Macro Phase 1): App Identity, Version, And Runpath

**Files:**
- Create: `apps/swarm-ui/src/lib/appIdentity.ts`
- Create: `apps/swarm-ui/src/lib/appIdentity.test.ts`
- Modify: `apps/swarm-ui/src/panels/StartupHome.svelte`
- Modify: `apps/swarm-ui/src/lib/featureMap.ts`

- [x] **Step 1: Add app identity model**

Create `apps/swarm-ui/src/lib/appIdentity.ts`:

```ts
export type BuildProvenance = {
  appVersion: string;
  buildProfile: string;
  runKind: string;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  buildUnix?: number | null;
  executableModifiedUnix?: number | null;
  executablePath: string;
  appBundlePath?: string | null;
  currentWorkingDirectory: string;
  sourceRoot: string;
  manifestDir: string;
};

export type AppVariant = 'lab' | 'active' | 'local' | 'unknown';
export type DockStatus = 'not-this-run' | 'this-bundle-run' | 'unknown';

export type AppIdentity = {
  appName: 'swarm-ui';
  appVariant: AppVariant;
  appVersion: string;
  shell: 'tauri';
  tauriMajor: 2;
  runKind: string;
  buildProfile: string;
  sourceRoot: string;
  currentWorkingDirectory: string;
  executablePath: string;
  appBundlePath: string | null;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  buildUnix: number | null;
  executableModifiedUnix: number | null;
  dockStatus: DockStatus;
};

export function appVariantFromProvenance(provenance: BuildProvenance): AppVariant {
  const source = provenance.sourceRoot.toLowerCase();
  const runPath = `${provenance.appBundlePath ?? ''} ${provenance.executablePath}`.toLowerCase();
  if (source.includes('swarm-mcp-lab') || runPath.includes('swarm ui lab')) return 'lab';
  if (source.includes('swarm-mcp-active') || runPath.includes('swarm ui active')) return 'active';
  if (source || runPath) return 'local';
  return 'unknown';
}

export function dockStatusFromProvenance(provenance: BuildProvenance): DockStatus {
  if (provenance.runKind === 'app-bundle') return 'this-bundle-run';
  if (provenance.runKind === 'tauri-dev') return 'not-this-run';
  return 'unknown';
}

export function appIdentityFromProvenance(provenance: BuildProvenance): AppIdentity {
  return {
    appName: 'swarm-ui',
    appVariant: appVariantFromProvenance(provenance),
    appVersion: provenance.appVersion,
    shell: 'tauri',
    tauriMajor: 2,
    runKind: provenance.runKind,
    buildProfile: provenance.buildProfile,
    sourceRoot: provenance.sourceRoot,
    currentWorkingDirectory: provenance.currentWorkingDirectory,
    executablePath: provenance.executablePath,
    appBundlePath: provenance.appBundlePath ?? null,
    gitBranch: provenance.gitBranch,
    gitCommit: provenance.gitCommit,
    gitDirty: provenance.gitDirty,
    buildUnix: provenance.buildUnix ?? null,
    executableModifiedUnix: provenance.executableModifiedUnix ?? null,
    dockStatus: dockStatusFromProvenance(provenance),
  };
}

export function compactRunPath(identity: AppIdentity): string {
  const path = identity.appBundlePath || identity.executablePath;
  return path
    .replace('/Users/mathewfrazier/Desktop/', '~/Desktop/')
    .replace('/Users/mathewfrazier/', '~/');
}

export function browserPreviewIdentity(appVersion: string, sourceRoot = ''): AppIdentity {
  return {
    appName: 'swarm-ui',
    appVariant: sourceRoot.includes('swarm-mcp-lab') ? 'lab' : 'local',
    appVersion,
    shell: 'tauri',
    tauriMajor: 2,
    runKind: 'browser-preview',
    buildProfile: 'preview',
    sourceRoot,
    currentWorkingDirectory: sourceRoot,
    executablePath: 'Vite/browser preview',
    appBundlePath: null,
    gitBranch: 'unknown',
    gitCommit: 'unknown',
    gitDirty: false,
    buildUnix: null,
    executableModifiedUnix: null,
    dockStatus: 'unknown',
  };
}
```

- [x] **Step 2: Add app identity tests**

Create `apps/swarm-ui/src/lib/appIdentity.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  appIdentityFromProvenance,
  appVariantFromProvenance,
  browserPreviewIdentity,
  compactRunPath,
  dockStatusFromProvenance,
  type BuildProvenance,
} from './appIdentity';

const base: BuildProvenance = {
  appVersion: '0.1.0',
  buildProfile: 'debug',
  runKind: 'tauri-dev',
  gitBranch: 'main',
  gitCommit: 'abcdef123456',
  gitDirty: true,
  buildUnix: 1710000000,
  executableModifiedUnix: 1710000100,
  executablePath: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri/target/debug/swarm-ui',
  appBundlePath: null,
  currentWorkingDirectory: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui',
  sourceRoot: '/Users/mathewfrazier/Desktop/swarm-mcp-lab',
  manifestDir: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri',
};

describe('app identity', () => {
  test('detects lab dev runs and dock status', () => {
    expect(appVariantFromProvenance(base)).toBe('lab');
    expect(dockStatusFromProvenance(base)).toBe('not-this-run');
    const identity = appIdentityFromProvenance(base);
    expect(identity.appVariant).toBe('lab');
    expect(identity.appVersion).toBe('0.1.0');
    expect(identity.tauriMajor).toBe(2);
  });

  test('detects app bundle runs', () => {
    const identity = appIdentityFromProvenance({
      ...base,
      runKind: 'app-bundle',
      appBundlePath: '/Users/mathewfrazier/Applications/Swarm UI Lab.app',
      executablePath: '/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui',
    });
    expect(identity.dockStatus).toBe('this-bundle-run');
    expect(compactRunPath(identity)).toBe('~/Applications/Swarm UI Lab.app');
  });

  test('provides browser preview identity for visual atlas fallback', () => {
    const identity = browserPreviewIdentity('0.1.0', '/Users/mathewfrazier/Desktop/swarm-mcp-lab');
    expect(identity.appVariant).toBe('lab');
    expect(identity.runKind).toBe('browser-preview');
    expect(compactRunPath(identity)).toBe('Vite/browser preview');
  });
});
```

- [x] **Step 3: Show identity on Home**

In `StartupHome.svelte`, call `invoke<BuildProvenance>('ui_build_provenance')`
on mount, normalize it with `appIdentityFromProvenance`, and render a first
viewport strip with:

```text
LAB v0.1.0 · DEV · run ~/Desktop/swarm-mcp-lab/... · dock not-this-run
```

The strip should have `data-testid="home-app-identity-strip"` and a tooltip or
details affordance containing full source root, executable path, bundle path,
branch, commit, dirty state, build stamp, and modified stamp.

- [x] **Step 4: Add feature map control**

Register `home.app-identity-strip` under the Home surface with expected behavior:
`shows app variant, version, run kind, runpath, and Dock/bundle status in the
first Home viewport`.

- [x] **Step 5: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/appIdentity.test.ts
cd apps/swarm-ui && bun run check
```

Expected: app identity tests pass and Home typecheck passes.

---

### Task 1 (Macro Phase 1): Feature And Control Registry

**Files:**
- Create: `apps/swarm-ui/src/lib/featureMap.ts`
- Create: `apps/swarm-ui/src/lib/featureMap.test.ts`
- Modify: `docs/CURRENT_APP_FEATURES.md`

- [x] **Step 1: Add the registry types**

Create `apps/swarm-ui/src/lib/featureMap.ts` with:

```ts
export type ProofLevel =
  | 'source-confirmed'
  | 'unit-tested'
  | 'build-tested'
  | 'browser-visual'
  | 'native-shell'
  | 'human-needed'
  | 'defect'
  | 'missing-coverage';

export type CoverageKind =
  | 'screenshot-covered'
  | 'semantic-covered'
  | 'native-only-manual'
  | 'hidden-debug-exempt'
  | 'missing-coverage';

export type Clickability =
  | 'primary-clickable'
  | 'selectable-only'
  | 'noninteractive'
  | 'disabled'
  | 'decorative';

export type Reportability =
  | 'reportable'
  | 'reportable-in-feedback-mode'
  | 'context-menu-only'
  | 'native-only-manual'
  | 'exempt';

export type FeatureControl = {
  id: string;
  surfaceId: string;
  label: string;
  kind: 'button' | 'input' | 'toggle' | 'tab' | 'menuitem' | 'icon-button' | 'canvas-affordance' | 'panel' | 'document';
  testId: string;
  reportTargetId: string;
  expectedBehavior: string;
  proofLevel: ProofLevel;
  coverage: CoverageKind;
  assetLike: boolean;
  clickability: Clickability;
  reportability: Reportability;
  primaryAction: string | null;
  reportAction: string;
  exemptionReason?: string;
};

export type FeatureSurface = {
  id: string;
  label: string;
  route: 'home' | 'canvas' | 'project' | 'settings' | 'modal' | 'right-rail' | 'visual-atlas';
  expectedBehavior: string;
  proofLevel: ProofLevel;
  controls: FeatureControl[];
};
```

- [x] **Step 2: Seed the minimum registry**

Add `SWARM_UI_FEATURE_SURFACES` covering Home, Workspace Kit, Canvas, Canvas Notes, Majordomo, Project Page, Task Board, Settings, Proof Pack, Area Report Capture, and Visual Atlas. Each visible control in the first slice must include `id`, `surfaceId`, `label`, `kind`, `testId`, `reportTargetId`, `expectedBehavior`, `proofLevel`, `coverage`, `assetLike`, `clickability`, `reportability`, `primaryAction`, and `reportAction`.

Seed at least these asset cases:

```ts
{
  id: 'canvas.note-document-surface',
  surfaceId: 'canvas-notes',
  label: 'Canvas Document note surface',
  kind: 'document',
  testId: 'canvas-note-document-surface',
  reportTargetId: 'canvas-note-document-surface',
  expectedBehavior: 'opens as an editable canvas document surface and saves to a markdown file',
  proofLevel: 'browser-visual',
  coverage: 'screenshot-covered',
  assetLike: true,
  clickability: 'primary-clickable',
  reportability: 'reportable-in-feedback-mode',
  primaryAction: 'open-or-focus-note-document',
  reportAction: 'capture-note-document-region',
}
{
  id: 'project.disabled-skill-lane',
  surfaceId: 'workspace-kit',
  label: '/skills disabled resource lane',
  kind: 'button',
  testId: 'workspace-skill-lane-disabled',
  reportTargetId: 'workspace-skill-lane-disabled',
  expectedBehavior: 'shows unavailable state without navigating',
  proofLevel: 'source-confirmed',
  coverage: 'semantic-covered',
  assetLike: true,
  clickability: 'disabled',
  reportability: 'reportable-in-feedback-mode',
  primaryAction: null,
  reportAction: 'capture-disabled-resource-lane',
}
```

- [x] **Step 3: Add uniqueness tests**

Create `apps/swarm-ui/src/lib/featureMap.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { SWARM_UI_FEATURE_SURFACES } from './featureMap';

describe('feature map', () => {
  test('surface and control ids are unique', () => {
    const ids = new Set<string>();
    for (const surface of SWARM_UI_FEATURE_SURFACES) {
      expect(ids.has(surface.id)).toBe(false);
      ids.add(surface.id);
      for (const control of surface.controls) {
        expect(ids.has(control.id)).toBe(false);
        ids.add(control.id);
      }
    }
  });

  test('visible controls carry test ids and expected behavior', () => {
    for (const surface of SWARM_UI_FEATURE_SURFACES) {
      expect(surface.expectedBehavior.trim().length).toBeGreaterThan(0);
      for (const control of surface.controls) {
        expect(control.testId.trim().length).toBeGreaterThan(0);
        expect(control.reportTargetId.trim().length).toBeGreaterThan(0);
        expect(control.expectedBehavior.trim().length).toBeGreaterThan(0);
        expect(control.reportAction.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('asset-like controls declare clickability and reportability', () => {
    const assetControls = SWARM_UI_FEATURE_SURFACES.flatMap((surface) =>
      surface.controls.filter((control) => control.assetLike),
    );
    expect(assetControls.some((control) => control.clickability === 'primary-clickable')).toBe(true);
    expect(assetControls.some((control) => control.clickability === 'disabled')).toBe(true);
    for (const control of assetControls) {
      expect(control.reportability).not.toBe('exempt');
      if (control.clickability === 'disabled') {
        expect(control.primaryAction).toBeNull();
      }
    }
  });
});
```

- [x] **Step 4: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/featureMap.test.ts
```

Expected: both tests pass.

---

### Task 2 (Macro Phase 1): Exhaustive Visual Atlas Coverage Gate

**Files:**
- Create: `apps/swarm-ui/src/lib/visualAtlasRegistry.ts`
- Create: `apps/swarm-ui/src/lib/visualAtlasRegistry.test.ts`
- Create: `apps/swarm-ui/src/visual-atlas/VisualAtlas.svelte`
- Modify: `apps/swarm-ui/src/App.svelte`

- [x] **Step 1: Add coverage validator**

Create `apps/swarm-ui/src/lib/visualAtlasRegistry.ts`:

```ts
import { SWARM_UI_FEATURE_SURFACES, type FeatureControl } from './featureMap';

export type AtlasCoverageStatus = FeatureControl['coverage'];

export type AtlasCoverageIssue = {
  controlId: string;
  surfaceId: string;
  label: string;
  status: AtlasCoverageStatus;
};

export function atlasCoverageIssues(): AtlasCoverageIssue[] {
  return SWARM_UI_FEATURE_SURFACES.flatMap((surface) =>
    surface.controls
      .filter((control) => control.coverage === 'missing-coverage')
      .map((control) => ({
        controlId: control.id,
        surfaceId: surface.id,
        label: control.label,
        status: control.coverage,
      })),
  );
}

export function atlasCoverageOk(): boolean {
  return atlasCoverageIssues().length === 0;
}
```

- [x] **Step 2: Add coverage test**

Create `apps/swarm-ui/src/lib/visualAtlasRegistry.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { atlasCoverageIssues, atlasCoverageOk } from './visualAtlasRegistry';

describe('visual atlas coverage', () => {
  test('no registered control is missing coverage', () => {
    expect(atlasCoverageIssues()).toEqual([]);
    expect(atlasCoverageOk()).toBe(true);
  });
});
```

- [x] **Step 3: Add VisualAtlas shell**

Create `apps/swarm-ui/src/visual-atlas/VisualAtlas.svelte` rendering one section per registered surface with `data-surface` and `data-testid` markers. It may start with fixture cards, but every registered control must render a visible representative control or an explicit exemption card.

- [x] **Step 4: Route atlas mode in App**

In `apps/swarm-ui/src/App.svelte`, detect `?visual-atlas=1` during startup and render `VisualAtlas` instead of the normal app shell.

- [x] **Step 5: Run tests and check**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/featureMap.test.ts src/lib/visualAtlasRegistry.test.ts
cd apps/swarm-ui && bun run check
```

Expected: registry tests pass and Svelte check passes.

---

### Task 3 (Macro Phase 2): App-Internal Area Capture

**Files:**
- Create: `apps/swarm-ui/src/lib/areaCapture.ts`
- Create: `apps/swarm-ui/src/lib/areaCapture.test.ts`
- Create: `apps/swarm-ui/src/panels/AreaCaptureOverlay.svelte`
- Modify: `apps/swarm-ui/src/App.svelte`
- Modify: `apps/swarm-ui/src-tauri/src/ui_commands.rs`
- Modify: `apps/swarm-ui/src-tauri/src/main.rs`

- [x] **Step 1: Add capture model**

Create `apps/swarm-ui/src/lib/areaCapture.ts` with:

```ts
export type AreaCaptureDraft = {
  id: string;
  sessionId: string;
  dateKey: string;
  surfaceId: string | null;
  testId: string | null;
  featureId: string | null;
  targetKind: 'control' | 'surface' | 'agent-card' | 'pty' | 'majordomo' | 'canvas-region';
  instanceId: string | null;
  ptyId: string | null;
  captureLimitations: string[];
  bounds: { x: number; y: number; width: number; height: number };
  majordomoExpandedBeforeCapture: boolean;
  targetIsMajordomo: boolean;
  overlayIncludedInFinalCrop: false;
  note: string;
};

export function areaCaptureSessionDir(dateKey: string, sessionId: string): string {
  return `area-captures/${dateKey}/session-${sessionId}`;
}

export function areaCaptureBaseName(index: number, label: string): string {
  const number = String(index).padStart(3, '0');
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'capture';
  return `${number}-${slug}`;
}
```

- [x] **Step 2: Add model tests**

Create `apps/swarm-ui/src/lib/areaCapture.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { areaCaptureBaseName, areaCaptureSessionDir } from './areaCapture';

describe('area capture paths', () => {
  test('uses dated session folders', () => {
    expect(areaCaptureSessionDir('2026-05-08', 'abc')).toBe('area-captures/2026-05-08/session-abc');
  });

  test('creates stable numbered capture names', () => {
    expect(areaCaptureBaseName(1, 'Majordomo Button')).toBe('001-majordomo-button');
  });
});
```

- [x] **Step 3: Add overlay component**

Create `AreaCaptureOverlay.svelte` with props `draft`, `onCancel`, `onConfirm`, and `onChange`. It renders a full-screen dim layer, a bright crop area, a red glowing rectangle, corner/edge handles, and outside-crop cancel/confirm buttons.

For PTY and agent cards, preserve normal double-click inside the terminal body.
Report capture is entered only by feedback mode, context menu `Report this
terminal area`, or explicit report affordance on the node chrome/header.

- [x] **Step 4: Add frontend capture hook**

In `App.svelte`, add `window.__SWARM_UI_PROOF__.captureRegion(draft)` that returns `{ dataUrl, proofLevel, warnings }`. MVP proof level is `app-region-dom`; if content cannot serialize cleanly, return `app-region-partial`.

- [x] **Step 5: Add Tauri file bridge**

Add `ui_save_area_capture` in `ui_commands.rs` accepting `date_key`, `session_id`, `base_name`, `png_data_url`, and metadata JSON. It writes:

```text
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/area-captures/<date>/session-<id>/<base>.png
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/area-captures/<date>/session-<id>/<base>.md
```

Register it in `main.rs`.

- [x] **Step 6: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/areaCapture.test.ts
cd apps/swarm-ui && bun run check
cargo test -p swarm-ui area_capture -- --nocapture
```

Expected: Bun tests pass, Svelte check passes, and Rust area capture tests pass after adding the Rust test module.

---

### Task 4 (Macro Phase 2): Default-On Runtime Majordomo

**Files:**
- Create: `apps/swarm-ui/src/lib/majordomoRuntime.ts`
- Create: `apps/swarm-ui/src/lib/majordomoRuntime.test.ts`
- Modify: `apps/swarm-ui/src/panels/MajordomoArchitect.svelte`
- Modify: `apps/swarm-ui/src/stores/harnessAliases.ts`

- [x] **Step 1: Add runtime helpers**

Create `majordomoRuntime.ts`:

```ts
import type { Instance, ProjectSpace } from './types';

export function isRuntimeMajordomo(instance: Instance, project: ProjectSpace | null): boolean {
  const label = instance.label ?? '';
  const roleMatch = /\brole:majordomo\b/.test(label);
  const ownerMatch = /\bowner:majordomo\b/.test(label);
  const projectMatch = project ? label.includes(`project:${project.id}`) || instance.directory === project.root : true;
  return roleMatch && ownerMatch && projectMatch;
}

export function buildMajordomoRuntimeLabel(project: ProjectSpace, timeoutMinutes: number): string {
  return [
    'owner:majordomo',
    'runtime_ai_assistant:true',
    `project:${project.id}`,
    `timeout_m:${Math.round(timeoutMinutes)}`,
    'source:majordomo_runtime',
  ].join(' ');
}

export type MajordomoHarnessRuntime = {
  harness: 'hermes';
  command: string;
  model: string | null;
  provider: string | null;
  sourceTag: 'swarm-ui-majordomo';
  cleanupPolicy: 'stop-on-app-close' | 'leave-running-visible';
};

export function defaultHermesMajordomoRuntime(): MajordomoHarnessRuntime {
  return {
    harness: 'hermes',
    command: 'hermes --tui --source swarm-ui-majordomo',
    model: null,
    provider: null,
    sourceTag: 'swarm-ui-majordomo',
    cleanupPolicy: 'stop-on-app-close',
  };
}
```

- [x] **Step 2: Add Hermes runtime context builder**

Add a `buildMajordomoBootstrapInstructions(...)` helper that names the exact
files Hermes should read:

```text
docs/CURRENT_APP_FEATURES.md
docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md
docs/superpowers/plans/2026-05-08-majordomo-visual-proof-and-learning.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/action-items/open.md
apps/swarm-ui/src/stores/pty.ts
apps/swarm-ui/src-tauri/src/launch.rs
apps/swarm-ui/src/panels/MajordomoArchitect.svelte
```

The instructions must define responsibilities:

- answer feature/version/runpath questions,
- guide the operator to app surfaces,
- interpret issue captures,
- generate adaptive closeout questions,
- use swarm MCP or CLI channels when available,
- stay visible and killable,
- and never claim proof without visual or semantic evidence.

- [x] **Step 3: Add model/provider launch metadata**

Allow the Majordomo panel/settings to pass optional Hermes `--model` and
`--provider` values. The current local default discovered during planning is
`grok-4.3` via `xAI`, but the app should store these as configurable values,
not hard-coded assumptions.

If a model/provider is selected, the command builder appends:

```text
--model <model> --provider <provider>
```

Always add:

```text
--source swarm-ui-majordomo
```

so Hermes sessions can be filtered and cleanup can prove which session was
started by swarm-ui.

Add a validation-only substep for swarm MCP access:

```bash
Hermes mcp add swarm-ui-lab \
  --command bun \
  --args run /Users/mathewfrazier/Desktop/swarm-mcp-lab/src/index.ts
Hermes mcp test swarm-ui-lab
```

Only document or enable this in-app after the test passes. If it fails, keep the
first slice on visible PTY bootstrap plus app-owned command/survey fallback.

- [x] **Step 4: Add tests**

Create `majordomoRuntime.test.ts` with cases for matching by role/owner/project, rejecting duplicates from other projects, and preserving timeout metadata.
Also validate:

- default harness is `hermes`,
- default command includes `--tui` and `--source swarm-ui-majordomo`,
- optional model/provider flags are included when set,
- bootstrap instructions mention the feature map, visual plan, learning folder,
  and launch/PTY seams,
- cleanup policy defaults to `stop-on-app-close`,
- and a launched Majordomo without any visible instance/PTY/resume record is
  flagged as a ghost.

- [x] **Step 5: Patch panel**

In `MajordomoArchitect.svelte`, show runtime state and a `Start Majordomo` button. Use existing `spawnShell` with `role: 'majordomo'`, `label: buildMajordomoRuntimeLabel(project, timeout)`, and bootstrap instructions from the plan.

Runtime state must include:

```text
offline
launching
online
blocked
stale
timeout-soon
stopping
stopped
failed
```

The panel must bind to an existing matching `role:majordomo` before spawning a
new one. It must show model/provider/source tag when known.

- [x] **Step 6: Add cleanup path**

Add app-owned stop behavior:

1. Try graceful Hermes stop if the UI knows a safe sequence.
2. Close the bound PTY.
3. If the process remains, use the existing kill/deregister path.
4. Refresh PTY/instance state.
5. Record the cleanup result in the closeout packet.

If the operator chooses `leave-running-visible`, the app must keep Majordomo
visible in Analyze/Resume Center with a timeout and stop action.

- [x] **Step 7: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/majordomoRuntime.test.ts
cd apps/swarm-ui && bun run check
```

Expected: tests and check pass.

---

### Task 5 (Macro Phase 2): Session Closeout And Survey Packet

**Files:**
- Create: `apps/swarm-ui/src/lib/sessionCloseout.ts`
- Create: `apps/swarm-ui/src/lib/sessionCloseout.test.ts`
- Modify: `apps/swarm-ui/src/App.svelte`
- Modify: `apps/swarm-ui/src/lib/appIdentity.ts`
- Modify: `/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/surveys/SESSION_SURVEY_TEMPLATE.md`

- [x] **Step 1: Add trigger model**

Create `sessionCloseout.ts`:

```ts
export type CloseoutTrigger =
  | 'end-session'
  | 'project-close'
  | 'app-ui-quit'
  | 'stop-all-agents'
  | 'leave-running-agent'
  | 'last-project-window-closed'
  | 'idle-end-confirmed'
  | 'forced-quit-recovery';

export function shouldRunCloseout(trigger: CloseoutTrigger): boolean {
  return trigger !== 'forced-quit-recovery';
}
```

Add the closeout packet shape:

```ts
import type { AppIdentity } from './appIdentity';

export type SessionCloseoutPacket = {
  sessionId: string;
  endedAt: string;
  endKind: CloseoutTrigger;
  appIdentity: AppIdentity;
  projectRoot: string;
  scopeOrChannel: string;
  surfaceIds: string[];
  areaCaptures: string[];
  visualAtlasPath: string | null;
  majordomoRuntime: {
    harness: 'hermes' | 'fallback';
    model: string | null;
    provider: string | null;
    instanceId: string | null;
    ptyId: string | null;
    questionStatus: 'not-started' | 'loading' | 'ready' | 'timeout' | 'failed' | 'fallback-only';
    cleanupStatus: 'not-needed' | 'stopped' | 'left-running-visible' | 'failed';
  };
};
```

- [x] **Step 2: Add adaptive area logic**

Add a function that returns no follow-up for `good`, one follow-up for `okay`, energy/hierarchy wording choices for `boring`, and visual/interaction/proof follow-ups for `bad`.

- [x] **Step 3: Add nonblocking survey loading model**

The closeout surface appears immediately and must not freeze while Hermes thinks.
The app owns persistence and fallback questions.

Add survey loading state:

```ts
export type SurveyQuestionStatus =
  | 'fallback-visible'
  | 'majordomo-loading'
  | 'majordomo-ready'
  | 'majordomo-timeout'
  | 'majordomo-failed';
```

Rules:

- At 0 seconds, show captured images and 4-8 fallback questions.
- While Hermes prepares tailored questions, show loading animation and allow
  skip/save partial answers.
- At 10-20 seconds, accept Hermes questions if ready.
- After timeout, continue with fallback questions and record the timeout in
  `closeout-survey.json`.
- If Hermes is offline, blocked, or stopped, use deterministic feature-map logic.
- Explicitly reported/captured areas appear before generic questions.

- [x] **Step 4: Add tests**

Validate trigger behavior, emoji chip branching, and app identity persistence
with Bun tests. Also validate:

- the fallback question set appears before Majordomo completes,
- timeout records `majordomoQuestionStatus`,
- captured images are included in the survey packet,
- and forced-quit recovery asks once without blocking launch.

- [x] **Step 5: Wire App triggers**

In `App.svelte`, call closeout on End Session, project close, app UI quit, stop-all-agents, leave-running-agent, last project window closed, and idle-end confirmation. Do not block force quit or hard process kill.

Closeout must call `ui_build_provenance`, normalize it through
`appIdentityFromProvenance`, and write the identity packet into
`closeout-survey.md` and `closeout-survey.json`.

- [x] **Step 6: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/sessionCloseout.test.ts
cd apps/swarm-ui && bun run check
```

Expected: tests and check pass.

---

### Task 6 (Macro Phase 2): Majordomo CLI Live Tweaks

**Files:**
- Create: `apps/swarm-ui/src/lib/runtimeTweaks.ts`
- Create: `apps/swarm-ui/src/lib/runtimeTweaks.test.ts`
- Modify: `apps/swarm-ui/src/panels/MajordomoArchitect.svelte`
- Modify: `apps/swarm-ui/src/App.svelte`

- [x] **Step 1: Add tweak model**

Create `runtimeTweaks.ts` with commands for moving/resizing controls by feature id. Supported commands for slice 1:

```text
/tweak move majordomo button right 12
/tweak resize note surface wider 40
/tweak reset current
/tweak accept current
```

- [x] **Step 2: Add parser tests**

Validate the two move/resize commands and reset/accept commands.

- [x] **Step 3: Apply CSS variable tweaks**

In `App.svelte`, apply accepted runtime tweak state through CSS variables or data attributes. Do not write source until the user selects accept.

- [x] **Step 4: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/runtimeTweaks.test.ts
cd apps/swarm-ui && bun run check
```

Expected: tests and check pass.

---

### Task 7 (Macro Phase 1): Visual Atlas CLI Command

**Files:**
- Modify: `src/cli.ts`
- Create: `test/visual-atlas-cli.test.ts`

- [x] **Step 1: Add command parser coverage**

Create a CLI test that invokes the parser with:

```text
swarm-mcp ui visual-atlas --out output/visual-atlas/latest
```

Expected parsed intent:

```json
{
  "group": "ui",
  "command": "visual-atlas",
  "out": "output/visual-atlas/latest"
}
```

- [x] **Step 2: Add CLI command**

In `src/cli.ts`, add a `ui visual-atlas` branch that requires `--out`, starts or reuses the Vite dev server, opens `http://127.0.0.1:1420/?visual-atlas=1` in the local browser automation runner, captures registered surfaces, writes `feature-map.json`, `coverage.json`, screenshots, console logs, and `index.md`.

- [x] **Step 3: Add failure behavior**

If `coverage.json` contains any `missing-coverage`, exit nonzero and print:

```text
visual atlas failed: missing coverage
```

- [x] **Step 4: Run CLI tests**

Run:

```bash
bun test test/visual-atlas-cli.test.ts
```

Expected: CLI parser and missing-coverage failure tests pass.

---

### Task 8 (Macro Phase 3): Operator Workflow Verification And Ghost Session Guard

**Files:**
- Create: `apps/swarm-ui/src/lib/operatorWorkflowProof.ts`
- Create: `apps/swarm-ui/src/lib/operatorWorkflowProof.test.ts`
- Modify: `src/cli.ts`
- Test: `test/operator-verify-cli.test.ts`

- [ ] **Step 1: Add proof model**

Create `apps/swarm-ui/src/lib/operatorWorkflowProof.ts`:

```ts
export type OperatorProofStepStatus = 'pending' | 'passed' | 'failed' | 'manual-needed';

export type OperatorWorkflowProofStep = {
  id:
    | 'home-version-visible'
    | 'project-opened'
    | 'asset-primary-click-reflected'
    | 'report-mode-targeted'
    | 'report-next-reflected'
    | 'report-confirm-persisted'
    | 'agent-launch-visible'
    | 'agent-tracked-or-failed-visibly';
  label: string;
  status: OperatorProofStepStatus;
  screenshotPath: string | null;
  semanticBeforePath: string | null;
  semanticAfterPath: string | null;
  notes: string;
};

export type LaunchedAgentTrackingProof = {
  launchId: string;
  instanceId: string | null;
  ptyId: string | null;
  projectId: string;
  scope: string;
  status: 'launching' | 'online' | 'stale' | 'failed' | 'terminated' | 'orphaned' | 'headless-background';
  visibleInCanvas: boolean;
  visibleInAnalyze: boolean;
  visibleInResumeCenter: boolean;
  cleanupActionVisible: boolean;
};

export function missingOperatorProofSteps(steps: OperatorWorkflowProofStep[]): string[] {
  return steps.filter((step) => step.status !== 'passed').map((step) => step.id);
}

export function hasGhostAgent(proof: LaunchedAgentTrackingProof): boolean {
  if (proof.status === 'failed') return !proof.cleanupActionVisible;
  if (proof.status === 'orphaned') return !proof.visibleInAnalyze;
  if (proof.status === 'headless-background') return !proof.visibleInResumeCenter;
  return !proof.visibleInCanvas && !proof.visibleInAnalyze && !proof.visibleInResumeCenter;
}
```

- [ ] **Step 2: Add proof model tests**

Create `apps/swarm-ui/src/lib/operatorWorkflowProof.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { hasGhostAgent, missingOperatorProofSteps, type LaunchedAgentTrackingProof } from './operatorWorkflowProof';

describe('operator workflow proof', () => {
  test('reports missing workflow steps', () => {
    expect(missingOperatorProofSteps([
      { id: 'home-version-visible', label: 'Home version', status: 'passed', screenshotPath: '01.png', semanticBeforePath: null, semanticAfterPath: null, notes: '' },
      { id: 'report-next-reflected', label: 'Next changed screen', status: 'failed', screenshotPath: null, semanticBeforePath: null, semanticAfterPath: null, notes: 'No visual change' },
    ])).toEqual(['report-next-reflected']);
  });

  test('flags invisible launched agents as ghosts', () => {
    const proof: LaunchedAgentTrackingProof = {
      launchId: 'launch-1',
      instanceId: null,
      ptyId: null,
      projectId: 'project-1',
      scope: '/tmp/project',
      status: 'launching',
      visibleInCanvas: false,
      visibleInAnalyze: false,
      visibleInResumeCenter: false,
      cleanupActionVisible: false,
    };
    expect(hasGhostAgent(proof)).toBe(true);
  });

  test('accepts headless background agents when Resume Center tracks them', () => {
    const proof: LaunchedAgentTrackingProof = {
      launchId: 'launch-2',
      instanceId: 'instance-1',
      ptyId: null,
      projectId: 'project-1',
      scope: '/tmp/project',
      status: 'headless-background',
      visibleInCanvas: false,
      visibleInAnalyze: true,
      visibleInResumeCenter: true,
      cleanupActionVisible: true,
    };
    expect(hasGhostAgent(proof)).toBe(false);
  });
});
```

- [ ] **Step 3: Add CLI parser test**

Create `test/operator-verify-cli.test.ts` with a parser assertion for:

```text
swarm-mcp ui operator-verify --out output/operator-verification/latest
```

Expected parsed intent:

```json
{
  "group": "ui",
  "command": "operator-verify",
  "out": "output/operator-verification/latest"
}
```

- [ ] **Step 4: Add operator verification command**

In `src/cli.ts`, add `ui operator-verify --out <path>`. The command writes:

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
```

The MVP may label native app-shell steps `manual-needed` until the command bus
can drive them, but it must fail if it cannot prove or explicitly classify every
required step.

- [ ] **Step 5: Run tests**

Run:

```bash
cd apps/swarm-ui && bun test src/lib/operatorWorkflowProof.test.ts
bun test test/operator-verify-cli.test.ts
```

Expected: proof model tests and CLI parser tests pass.

---

## Recommended Execution Lanes

Use one lead coordinator unless Mathew explicitly asks for parallel subagents.
When execution is authorized, subagents are useful only if their file ownership
is cleanly separated:

- Registry/atlas worker: `featureMap.ts`, `visualAtlasRegistry.ts`,
  `VisualAtlas.svelte`, atlas tests.
- Capture/survey worker: `areaCapture.ts`, `AreaCaptureOverlay.svelte`,
  `sessionCloseout.ts`, 9889 learning templates.
- Majordomo/Hermes worker: `majordomoRuntime.ts`,
  `MajordomoArchitect.svelte`, `harnessAliases.ts`, lifecycle tests.
- Operator proof worker: `operatorWorkflowProof.ts`, CLI proof commands,
  ghost-session guard tests.
- Docs/proof worker: feature matrix, plan ledger, manual QA, runpath closeout.

Recommended skills:

- `superpowers:subagent-driven-development` for multi-agent execution.
- `superpowers:executing-plans` for single-agent execution.
- `superpowers:verification-before-completion` before claiming done.
- repo `tauri` skill for IPC/capability/security boundaries.
- browser/frontend testing skills for visual atlas screenshots and cleanup.

## Zero-Context Bootstrap For A New Conversation

Paste this into a new agent session:

```text
You are working in /Users/mathewfrazier/Desktop/swarm-mcp-lab.
Do not broadly execute unless Mathew authorizes a slice.
Read:
- AGENTS.md
- docs/CURRENT_APP_FEATURES.md
- docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md
- docs/superpowers/plans/2026-05-08-majordomo-visual-proof-and-learning.md
- /Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md
- /Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/action-items/open.md

For Majordomo/Hermes work, inspect:
- apps/swarm-ui/src/stores/harnessAliases.ts
- apps/swarm-ui/src/stores/pty.ts
- apps/swarm-ui/src-tauri/src/launch.rs
- apps/swarm-ui/src/panels/MajordomoArchitect.svelte
- apps/swarm-ui/src/lib/agentRolePresets.ts
- apps/swarm-ui/src/panels/Launcher.svelte
- /Users/mathewfrazier/.local/bin/Hermes
- /Users/mathewfrazier/.hermes/hermes-agent

Current recommendation: implement Majordomo first as a visible Hermes PTY
launched through spawnShell with role:majordomo, source tag
swarm-ui-majordomo, app-owned cleanup, and deterministic survey fallback.
```

## Apple Permission Notes For Verification

Target operator machine for this overhaul:

```text
Device: MacBook Air
OS: macOS Tahoe 26.4.1 (25E253)
```

- Run a permission preflight before claiming native clicking, native keyboard
  input, native screenshots, AppleScript automation, or packaged-app file access
  works.
- Prefer internal app command bus, semantic snapshots, DOM-region capture, and
  Tauri file writes. These avoid Accessibility and Screen Recording.
- OS synthetic clicks/keyboard into the Tauri app need Accessibility permission.
- Whole-window or desktop screenshots need Screen Recording permission.
- AppleScript control of Chrome, Ghostty, Terminal, or Finder can trigger
  Automation permission.
- Packaged app file access may trigger Files and Folders or Full Disk Access
  prompts for protected paths.
- Playwright/Chromium tests can create temporary Dock icons unless the runner is
  headless and cleaned up.
- After changing macOS privacy permissions, quit and relaunch the affected app
  or test runner before retesting.

Required proof labels:

```text
Native click proof: confirmed | blocked by Accessibility | not attempted
Native screenshot proof: confirmed | blocked by Screen Recording | not attempted
Automation proof: confirmed | blocked by Automation | not attempted
Internal app proof: semantic/app-region-dom/native-command
```

---

## Verification Closeout

Run the full doc and implementation proof set before calling the slice done:

```bash
cd apps/swarm-ui && bun test src/lib/appIdentity.test.ts src/lib/featureMap.test.ts src/lib/visualAtlasRegistry.test.ts src/lib/areaCapture.test.ts src/lib/majordomoRuntime.test.ts src/lib/sessionCloseout.test.ts src/lib/runtimeTweaks.test.ts src/lib/operatorWorkflowProof.test.ts
bun test test/visual-atlas-cli.test.ts test/operator-verify-cli.test.ts
cd apps/swarm-ui && bun run check
cargo test -p swarm-ui area_capture -- --nocapture
```

Expected:

- all Bun tests pass,
- Svelte check passes,
- Rust area capture tests pass,
- Home first viewport shows app variant, app version, run mode, runpath, and
  Dock/bundle status,
- `swarm-mcp ui visual-atlas --out output/visual-atlas/latest` writes screenshots, `coverage.json`, and `index.md`,
- coverage has no `missing-coverage`,
- asset-like controls include clickability/reportability metadata and report
  targets,
- operator verification report proves asset primary click, report mode target,
  `Next`, `Confirm`, and launched-agent tracking or visible failure,
- a dated learning folder contains at least one `.png`, one capture `.md`, `closeout-survey.md`, and `closeout-survey.json`,
- the closeout JSON contains the app identity packet from `ui_build_provenance`,
- Majordomo can launch/bind as a visible Hermes-backed `role:majordomo` PTY,
- Majordomo/Hermes cleanup is proven with no invisible orphan session or hidden
  process left behind unless the operator chose `leave-running-visible`,
- survey closeout shows fallback questions immediately, then records whether
  Hermes generated tailored questions, timed out, or failed,
- and the final proof report states which evidence is DOM/atlas/native/manual.
