# Overhaul Execution Status

Repo: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`
Scope: `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`

Current product-overhaul authority:

- `docs/MAY_1ST_OVERHAUL_PLAN.md`
- `docs/MAY_1ST_EXECUTION_BOOTSTRAP.md`
- `docs/MAY_1ST_PLAN_ARCHIVE.md`

May 2 UX correction is integrated into the May 1st authority docs. It is not a competing overhaul. The active product direction is project-first: Project -> Task Board -> task-bound agents -> conversation/status. Directory, scope/channel, command, launch profile, model/provider details, PTY, and process truth are internal or Advanced/Debug surfaces unless an incongruency needs review.

Sidecar status for May 2 launch/conversation/listening reliability lives in `docs/MAY_1ST_OVERHAUL_PLAN.md` under "May 2 Sidecar Status." It records what has landed, what has only been browser/focused-test verified, and what still needs installed-app/fresh-agent proof.

## Old Overhaul Archive Closeout

Closed on 2026-05-02: the pre-May-1 phase-sequenced overhaul is archived. Do not continue the old Phase 4/5/6/7 roadmap as active work unless Mathew explicitly reopens a specific archived phase.

The archived phase docs remain in place as source material for implementation details, tests, and reusable UI/data patterns. They are not task authority. The only active execution path is the May 1st MVP bootstrap with the May 2 project-first UX correction folded in.

## Current Phase

May 1st MVP bootstrap, with the May 2 project-first UX correction folded in, is the active execution path. Slice 0 through Slice 8C from `docs/MAY_1ST_EXECUTION_BOOTSTRAP.md` are complete on the local dev surface. Slice 7D is complete for the native app-restart survivor/rebind/kill backbone. Slice 8D is complete for the native background-work control loop, with installed click/reopen and notification enforcement tracked as follow-up. The current implementation front is acceptance/reliability proof:

1. Slice 8D follow-up: human-visible installed click/reopen proof and any app-enforced timeout/notification layer.
2. Slice 5C end-of-overhaul revisit: human-visible native click automation once Accessibility/TCC is available.

Old Phase 4/5/6/7 work remains useful source material, but it is closed and archived as an execution lane.

Historical state to preserve:

- Phase 6 Startup Branding and Credit was active under the old phase plan. The experimental Home hero/credit-only containment pass was reverted by user preference; the prior FrazierCode Agentic start page and FrazierCode [Agentic] artwork surfaces are restored. The opacity override maps from fully clear to fully black surfaces.
- Phase 5 Assets and Multimodal Context is implemented through Slice 1, Slice 2, the multimodal-analysis follow-up, and installed-app QA hardening, but final acceptance still needs one more click-through for File Bubble formatting/navigation, local media preview, analyzer configuration, fullscreen image expansion, saved `Visual analysis:`, and `[asset-context]` injection.

Completed:

- Phase 0: Lab baseline and team execution setup.
- Phase 1: Launch productization.
- Phase 2: Acceleration tooling.
- Post-Phase-2 reliability sync: listener-health telemetry and UI badges.
- Phase 3: Agent Identity Overhaul, fully complete and closed.
- May 1st Slice 0: local dev-surface smoke of Home, Project/Workspace Kit, Launch, Agents/Live Tasks, and Asset/Media entry points.
- May 1st Slice 1: Home simplification around `Open Project`, `Start From Plan`, and `Resume Running Agents`, with Advanced Launch demoted to a secondary path.
- May 1st Slice 2: Project Cockpit MVP with project root diagnostics, linked task lanes, running/reconnectable agents, and recent project activity visible after opening a saved folder.
- May 1st Slice 3: Task Board MVP with paste-plan import, grouped editable rows, multi-select, provider/role assignment fields, and a clear selected-row `Launch N` action bar.
- May 1st Slice 4: Task-bound launch binding through the existing `spawnShell` contract, with project/task/scope labels, row-level agent ids, PTY ids, listener state, and result summaries.
- May 1st Slice 5 proof-pack v1: Project Task Board `Capture proof pack`, CLI `swarm-mcp ui proof-pack`, UI-worker artifact writing, manual QA checklist, and the Home -> saved project overlay regression fix.
- May 1st Slice 5B native smoke: native `swarm-ui` worker spawned an app-owned Codex PTY, the wrapper-script launch adopted the pre-created row, the agent broadcast a standby marker, entered `wait_for_activity`, and the CLI proof-pack sidecar wrote a native-worker artifact.
- May 1st Slice 5D retry/reassign state polish: Task Board rows now derive stale launch state from live instance data, expose row-level `Retry`, `Reassign`, and `Reset`, and include computed stale/failed listener truth in proof-pack rows.
- May 1st Slice 5E acceptance sweep: native bundle rebuild plus screenshot proof, Accessibility-blocked click evidence, browser Task Board visual proof, retry/reassign proof-pack evidence, and the Task Board action-bar overlap fix.
- May 1st Slice 6 Review/Ship surface: Project Page now groups changed/review files by task/agent evidence, generates commit-message suggestions, exposes task result summaries and unresolved risks, and supports copyable reviewer prompts plus direct reviewer-agent handoff without auto-commit/push.
- May 1st Slice 7A stale row reconciliation: cleanup paths now locally reconcile removed/vanished instance rows, lock rows, queued recipient messages, and active task assignments so phantom active/stale counts disappear without Cmd+R.
- May 1st Slice 7B launch preflight diagnostics: saved commands, provider aliases, Advanced Launch, Team Launch, Task Board rows, and the shared spawn path now run command preflight before opening a PTY.
- May 1st Slice 7C trust posture visibility: full-access aliases/flags are classified and shown in launch review or Task Board row state before spawn.
- May 1st Slice 8A post-session improvement review: Project Page captures Worked/Confusing/Broke/Improve Next feedback, saves project-local review notes, and optionally creates editable improvement rows.
- May 1st Slice 8B bounded background launch: background work now requires explicit opt-in, prompt, cwd, internal channel/scope, provider, role, trust posture, timeout, and idle policy before launching through `spawnShell`.
- May 1st Slice 8C background Resume Center: project-linked background runs are visible with status/provider/role/timeout/scope plus Suspend and Kill controls.
- May 1st Slice 7D native app-restart survivor proof: native `swarm-ui` worker spawned a bounded survivor Codex PTY, the agent adopted and waited, killing only `swarm-ui` left the same instance/process alive, relaunching `swarm-ui` rehydrated the PTY binding, and the app-worker kill path closed the PTY, deregistered the row, and terminated the smoke MCP pid.
- May 1st Slice 8D native background-work control acceptance: native `swarm-ui` worker spawned a bounded background-labeled Codex PTY, the agent adopted the row, an operator suspend control message was read through `wait_for_activity`, and the corrected native kill path closed the PTY, deregistered the row, and terminated the smoke MCP pid.

Next:

- Slice 8D follow-up: human-visible installed click-through for save review/create task/close-reopen Resume Center truth, plus any app-enforced timeout/notification layer after the MVP prompt-level policy proves stable.
- Slice 5C is sidelined until the end-of-overhaul revisit. The remaining gap is full human-visible native Task Board click automation, blocked by macOS Accessibility/TCC for the active desktop controller, not by launch plumbing.
- Fuller motion frame sampling remains Stage 5 visual polish unless a new Slice 5 bug needs it sooner.

Still needs human-visible confirmation:

- Project boundary movement: moving a project boundary should translate enclosed agent nodes with it; resizing should not drag agents. Automated tests cover the geometry helper, but the installed app still needs a canvas drag check.
- Project context boundary: attaching/syncing agents should send `[project-context]` without silently changing cwd, channel/scope, or OS-level file permissions.
- App/icon polish: source and bundled icons use the restored black-on-cream Agentic logo; Dock/Launchpad may need macOS cache confirmation if an old icon still displays.
- Launch emoji tweak: the saved-agent launch emoji should use the green inner square with no extra circular wrapper on the Launch surface.
- Terminal launch/black page: Codex/Claude launch should show terminal readiness or an explicit overlay/error instead of a silent black pane.
- Phase 5 visual UX: project page, Encom File Bubble folder navigation, image/video preview, fullscreen image expansion, `Analyze image`, saved `Visual analysis:`, and agent `[asset-context]` injection need re-test in the installed app.
- Slice 7D human-visible app window proof: native restart/rebind/kill backbone passed through the app worker, but a visible installed-app screenshot/click proof still depends on the Slice 5C Accessibility/TCC revisit.
- Slice 8D visual installed-app path: direct native worker proof passed, but `bunx tauri build --debug` packaging still hit the known `tauri` rlib artifact issue and `ui.screenshot` reported window screenshot capture unavailable. The save-review/create-task click path still needs a human-visible installed-app run.

Deferred endgame cleanup:

- Keep `scope` as the internal DB/protocol field for now, but use `Channel` in operator-facing UI. At the very end, evaluate an internal rename or compatibility-layer migration so code, docs, and UI language converge without destabilizing current task/message/KV/layout filtering.

## Verification

- May 1st Slice 0/1 completion on 2026-05-02:
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed; built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
  - Browser smoke at `http://127.0.0.1:1420/` confirmed the Home first viewport shows `Open Project`, `Start From Plan`, and `Resume Running Agents`; `Start From Plan` routes to the May 1st plan surface; Agents -> Live Tasks shows the May 1st Kanban and runtime task board.
  - Browser smoke also confirmed Launch remains reachable as the Advanced Launch surface and Project/Workspace Kit plus Media/Assets entry points are still reachable.
  - Browser-mode Tauri API warnings are expected outside the Tauri shell; native picker click-through, PTY launch, launcher execution, and installed-app behavior remain separate proof points for later native-touching slices.

- May 1st Slice 2 completion on 2026-05-02:
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
  - Browser smoke at `http://127.0.0.1:1420/` used a fixture project to confirm the project page now shows `Project Cockpit`, project root diagnostics, `Task Board`, `Agents`, and `Recent Activity` without requiring boundary drawing.
  - Slice 2 was frontend-only. No new Tauri/native relaunch proof is claimed beyond the prior Slice 0/1 debug build.

- May 1st Slice 3 completion on 2026-05-02:
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
  - Browser smoke at `http://127.0.0.1:1420/` used a fixture project, pasted three plan bullets, imported three editable rows, and confirmed the Task Board showed the imported row section, `3 selected`, and `Launch 3`.
  - Slice 3 was frontend-only. Task-bound process spawning moved into Slice 4.

- May 1st Slice 4 completion on 2026-05-02:
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed; built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
  - Browser smoke at `http://127.0.0.1:1420/` used a fixture project, pasted three task bullets, confirmed `Launch 3`, mocked Tauri `spawn_shell`, and verified three Codex/implementer launches with unique `task:` label tokens, shared project scope, three bound rows, and row-level agent/PTY ids.
  - Native code compilation is proven by the Tauri debug build. Real Tauri click-through with actual agent processes remains the first Slice 5 smoke item.

- May 1st Slice 5 proof-pack v1 on 2026-05-02:
  - `bun test apps/swarm-ui/src/lib/proofPack.test.ts`: passed, 1 test and 12 assertions.
  - `swarm-mcp ui proof-pack --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --surface project-task-board --note "slice 5 cli smoke" --wait 0 --json`: queued `ui.proof-pack` successfully.
  - Browser smoke at `http://127.0.0.1:1420/` used normal clicks with a fixture project: Home -> Workspace Kit -> saved project -> Task Board -> import three rows -> `Launch 3` -> `Capture proof pack`.
  - Browser smoke verified three mocked Codex/implementer launches, project/task/scope label tokens, proof-pack `rowCount: 3`, `taskBoundRows: 3`, semantic snapshot count 80, scroll-container count 2, and `screenshotOk: false` with the review signal `screenshot-unavailable`.
  - The smoke initially exposed a Home overlay intercepting Project Page controls after saved-project open; `StartupHome.openProject()` now exits Home before dispatching the project open event.
  - `bun run check`: passed, including TypeScript, 223 Bun tests, root build, Svelte check/build, 18 swarm-server Rust tests, and 93 swarm-ui Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed after the Slice 5 fixes; built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.

- May 1st Slice 5B native smoke on 2026-05-02:
  - Native debug app `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui` claimed queued UI commands through worker `swarm-ui:de363abe2e824c7c83a6f530c81f1d26`.
  - `swarm-mcp ui spawn /Users/mathewfrazier/Desktop/swarm-mcp-lab --harness codex --role implementer --label "project:workspace-kit task:slice5b_native_script_1 task_title:native_script_smoke_agent source:project_task_board slice:may_1_s5b" --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --wait 15 --json`: command `#12` completed with instance `10c6efab-88a0-4a6b-b3a2-a229d5ef0402` and PTY `241bb99d-66fe-404d-b24c-c8200ca5434a`.
  - A frontend-equivalent Codex wrapper script launched through `swarm-mcp ui prompt --target 241bb99d-66fe-404d-b24c-c8200ca5434a --wait 10 --json`: command `#13` completed and wrote 138 bytes to the bound PTY.
  - SQLite and event proof: `instance.registered` event `#893` shows adopted `true` with pid `52276`; message `#307` contains `[standby] slice5b-native-script-1`; event `#896` shows the agent entered `wait_for_activity`.
  - Daemon state proof: `/state` over `~/.swarm-mcp/server/swarm-server.sock` showed PTY `241bb99d-66fe-404d-b24c-c8200ca5434a` bound to instance `10c6efab-88a0-4a6b-b3a2-a229d5ef0402`, `exit_code: null`, and lease holder `local:swarm-ui`.
  - OS process proof: zsh pid `51464` under `swarm-server`, Codex node pid `51863`, Codex binary pid `52230`, and MCP helper pid `52276` were running on `ttys006` with `SWARM_MCP_INSTANCE_ID=10c6efab-88a0-4a6b-b3a2-a229d5ef0402`.
  - `swarm-mcp ui proof-pack --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --surface project-task-board --note "slice 5B native smoke: adopted 10c6efab, pty 241bb99d, broadcast [standby] slice5b-native-script-1" --wait 10 --json`: command `#14` completed and wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777718803198.json`.
  - The first direct long-command prompt attempt left a test shell unadopted, confirming why the frontend wrapper-script path matters for Codex launches. This was a smoke-only attempt, not a product-path regression.

- May 1st Slice 5C native click-through attempt on 2026-05-02:
  - Native bundle launched from `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`; screenshot capture produced `/tmp/swarm-5c-proof/native-home.png` and showed the Home surface with `Workspace Kit`.
  - Direct click automation failed with macOS Assistive Access error `System Events got an error: osascript is not allowed assistive access. (-25211)`.
  - Clawd Cursor fallback was started and then stopped after it failed to focus/click `swarm-ui`; it opened System Settings -> Privacy & Security -> Accessibility instead. Screenshot `/tmp/swarm-5c-proof/clawd-workspace-click-test.png` showed `Codex` disabled for Accessibility while `node` and `openclaw.mjs` were enabled.
  - No Slice 5C UI command was queued or claimed: SQLite still showed `max(id) = 14` in `ui_commands` and `0` instances in `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`.
  - Result: native visual proof is available, but human-visible Task Board click-through remains blocked until Accessibility is enabled for the active desktop controller or Mathew performs the checklist manually.
  - Retry attempt later on 2026-05-02 produced `/tmp/swarm-5c-retry/native-home.png`, then failed at the same click step with `System Events got an error: osascript is not allowed assistive access. (-25211)`. SQLite still showed `max(id) = 14` and `0` overhaul instances after cleanup.

- May 1st Slice 5D retry/reassign polish on 2026-05-02:
  - Added `apps/swarm-ui/src/lib/taskBoardState.ts` with tested row runtime-state derivation for online, missing, stale/offline, failed, launching, and PTY-only adoption states.
  - Project Task Board rows now show computed stale listener copy, missing/offline instance status, and stale launch errors without mutating task status behind the user's back.
  - Added row-level `Retry`, `Reassign`, and `Reset` actions. Retry relaunches a failed/stale row; Reassign applies the current bulk provider/role and clears stale launch identity; Reset clears launch identity and selects the row for a new launch.
  - Proof-pack task rows now use computed listener state and launch error, so stale/missing-agent evidence is captured instead of only the last raw row string.
  - Focused tests: `bun test apps/swarm-ui/src/lib/taskBoardState.test.ts apps/swarm-ui/src/lib/proofPack.test.ts` passed with 6 tests and 26 assertions.
  - Browser smoke at `http://127.0.0.1:1420/` with a narrow Tauri invoke mock opened a fixture project, imported three Slice 5D rows, confirmed `Retry` / `Reassign` / `Reset` render per row, retried a failed row into `stale - missing agent-re`, then reassigned it back to `reassigned, ready`.

- May 1st Slice 5E acceptance sweep on 2026-05-02:
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed; rebuilt `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui` and bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Native bundle launched and screenshot capture produced `/tmp/swarm-5e-proof/native-home.png`, showing the current Home surface with `Workspace Kit`.
  - Native click automation still failed before Task Board with Assistive Access error `System Events got an error: osascript is not allowed assistive access. (-1719)`. Immediately after that failed click, SQLite still showed `max(id) = 14` for `ui_commands` and `0` instances in `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`.
  - Browser visual proof at `http://127.0.0.1:1420/` opened Home -> Workspace Kit -> saved `swarm-mcp-lab` project -> Task Board, imported three rows, launched three mocked Codex/implementer task-bound agents, retried one stale row, captured the proof pack, reassigned one row, and captured desktop plus narrow Task Board screenshots under `output/playwright/may-1st-slice-5e/`.
  - Browser proof evidence: `rowCount: 3`, `Retry` / `Reassign` / `Reset` buttons each rendered 3 times, stale missing-agent copy was visible, proof-pack message was visible, and `spawn_shell` was invoked 4 times (three launches plus one retry).
  - Proof-pack evidence: `rowCount: 3`, `launchedRows: 3`, `taskBoundRows: 3`, `screenshotOk: false`, review signal `screenshot-unavailable`, semantic snapshot count 80, and scroll-container count 2.
  - Fixed the visual overlap caught by Slice 5E screenshots: the Task Board action bar now hides when inactive and renders in normal flow when visible, so it no longer sits over task rows during proof capture.
  - `bun run src/cli.ts ui proof-pack --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --surface project-task-board --note "slice 5E acceptance sweep: native click sidelined by Accessibility, browser proof captured" --wait 0 --json`: queued `ui.proof-pack` command `#15`; after launching the rebuilt native app, worker `swarm-ui:1deac238ea624a3abbd991d0c6904ee3` completed it and wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777722814428.json`.
  - Focused tests: `bun test apps/swarm-ui/src/lib/taskBoardState.test.ts apps/swarm-ui/src/lib/proofPack.test.ts` passed with 6 tests and 26 assertions.
  - `cd apps/swarm-ui && bun run check`: passed with 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed with the existing dynamic-import/chunk-size warnings only.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed after the action-bar fix and rebuilt `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - `bun run check`: passed with 228 Bun tests, root TypeScript/build, UI Svelte check/build, 18 swarm-server Rust tests, and 93 swarm-ui Tauri Rust tests.
  - `git diff --check` on the Slice 5E touched files passed.

- May 1st Slice 6 Review/Ship surface on 2026-05-02:
  - Added `apps/swarm-ui/src/lib/reviewShip.ts` and `apps/swarm-ui/src/lib/reviewShip.test.ts` for structured Review/Ship summaries, changed-file grouping, risk extraction, commit-message suggestions, review prompts, and reviewer-agent candidates.
  - Project Page now renders `Review / Ship` with commit suggestion copy, review task copy, `Ask reviewer`, unresolved risks, changed/review files, and task result summaries.
  - `bun test apps/swarm-ui/src/lib/reviewShip.test.ts`: passed, 2 tests and 13 assertions.
  - `cd apps/swarm-ui && bun run check`: passed with 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed with the existing dynamic-import/chunk-size warnings only.
  - Browser visual smoke covers the Review/Ship desktop and narrow layouts under `output/playwright/may-1st-slice-6-review-ship/`.

- May 1st Slice 7A stale row reconciliation on 2026-05-02:
  - Added `apps/swarm-ui/src/lib/swarmReconcile.ts` and `apps/swarm-ui/src/lib/swarmReconcile.test.ts` for tested local cleanup of removed instance rows.
  - `stores/swarm.ts` now exposes `removeInstancesFromLocalState`, mirroring backend deregister cleanup for instances, claimed/in-progress task assignments, blocked/approval task assignees, lock rows, lock annotations, and queued recipient messages.
  - PTY cleanup paths now use local reconciliation after deregister, force-deregister, kill, kill-all, and stale sweep. `instance not found` races are treated as local cleanup success.
  - Status-bar `kill all` passes visible instance ids so phantom rows can disappear when the backend has no protected skipped targets.
  - `bun test apps/swarm-ui/src/lib/swarmReconcile.test.ts apps/swarm-ui/src/lib/ptyCatalog.test.ts`: passed, 4 tests and 19 assertions.
  - `cd apps/swarm-ui && bun run check`: passed with 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed with the existing dynamic-import/chunk-size warnings only.

- May 1st Slice 7B/7C launch preflight and trust posture on 2026-05-02:
  - Added `apps/swarm-ui/src/lib/launchPreflight.ts` and `apps/swarm-ui/src/lib/launchPreflight.test.ts` for command parsing, fallback preflight, command/provider mismatch warnings, and full-access posture classification.
  - Added Tauri `ui_preflight_launch_command`, registered it in `main.rs`, and verified it resolves executables through the login shell with PATH preview, diagnostics, warnings, and hard blocker text.
  - `spawnShell` now preflights the exact command it will type, reusing caller-provided preflight results when available.
  - Advanced Launch, saved Agent Profile launch, and Team Launch now include preflight/trust posture in the review flow and block missing commands before spawn.
  - Project Task Board rows now move through `preflighting`, `preflight ok`, or `preflight full access`; hard blockers show row-level launch errors without opening a PTY.
  - `bun test apps/swarm-ui/src/lib/launchPreflight.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/lib/codexLaunchCommand.test.ts`: passed with 21 tests and 76 assertions.
  - `cargo test -p swarm-ui launch_preflight_`: passed with 4 focused tests.
  - `cd apps/swarm-ui && bun run check`: passed with 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed with the existing dynamic-import/chunk-size warnings only.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed and built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.

- May 1st Slice 8A/8B/8C post-session improvement and background work on 2026-05-02:
  - Added `apps/swarm-ui/src/lib/postSessionImprovement.ts` and `apps/swarm-ui/src/lib/postSessionImprovement.test.ts` for post-session review notes, improvement task seeds, background-work validation, guarded labels/prompts, and Resume Center row derivation.
  - Project Page now renders `Post-Session Improvement` with Worked/Confusing/Broke review fields, follow-up prompt, optional improvement task creation, explicit background-work policy, `Save + launch bounded agent`, and `Resume Center · Background Work` with Suspend/Kill.
  - Docs now define Slice 7D as the app-restart survivor/rescue loop and Slice 8D as the installed-app background-work acceptance/notifier/timeout decision.
  - Focused tests: `bun test apps/swarm-ui/src/lib/postSessionImprovement.test.ts apps/swarm-ui/src/lib/launchPreflight.test.ts` passed with 11 tests and 33 assertions.
  - `cd apps/swarm-ui && bun run check`: passed with 0 Svelte errors and 0 warnings.
  - `cd apps/swarm-ui && bun run build`: passed with the existing dynamic-import/chunk-size warnings only.
  - Browser visual smoke at `http://127.0.0.1:1420/` used a mocked Tauri surface and fixture background agent; it verified Project Page Post-Session rendering, survey-only save success, created improvement task row, and Resume Center row with Suspend/Kill controls.
  - Visual artifacts: `output/playwright/may-1st-slice-8a-8c/post-session-desktop.png`, `output/playwright/may-1st-slice-8a-8c/post-session-narrow.png`, and `output/playwright/may-1st-slice-8a-8c/resume-center.png`.
  - `git diff --check` on Slice 8A/8B/8C touched files passed.

- May 1st Slice 8D native background-work acceptance on 2026-05-02:
  - Added CLI/native worker support for `swarm-mcp ui kill --target <instance>` so acceptance can exercise the same bound-instance kill/deregister backend used by the app.
  - Fixed `system_load::kill_target_internal` so bound PTYs close before process cleanup, target protection checks only inspect the target process group, and clean deregistration races after PTY close are treated as success.
  - Native worker proof packs completed: command `#16` wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777768335607.json`; command `#17` wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777768343310.json`.
  - Background launch/suspend proof: command `#19` spawned instance `6b7ea64b` with `owner:background-work ... background_run:bg-8d-native`; command `#20` launched the guarded Codex prompt; event `#920` adopted pid `88210`; message `#308` delivered the suspend control; events `#924`-`#926` show the agent polled one unread message, returned from `wait_for_activity` on `new_messages`, then re-entered waiting.
  - Kill regression proof: command `#21` exposed the old false `Protected swarm-server process` result; the fix was verified by command `#27`, which closed PTY `7fe78ef1-8ae2-45dd-9048-a6ea2baa63c4`, deregistered instance `f8956e86-f834-4104-b131-ae8f012bd98f`, and terminated pid `96058`.
  - Cleanup proof: after command `#27`, `swarm-mcp instances --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --json` returned `[]`, and process search found no `bg-8d-native`, `bg-8d-killfix`, or `bg-8d-killdone` smoke process.
  - Decision: timeout/idle enforcement remains prompt-level for MVP. Native app timers/notifications are post-MVP follow-up, scoped only to explicit background statuses: completed, failed, approval needed, stale, or timed out.
  - Limitation: `bunx tauri build --debug` still failed on the packaging-specific `tauri` rlib artifact issue after direct `cargo build --bin swarm-ui` passed; `ui.screenshot` also reported screenshot capture unavailable. Human-visible installed click-through remains a follow-up, not claimed as complete.

- May 1st Slice 7D native app-restart survivor proof on 2026-05-02:
  - `cargo build --bin swarm-ui`: passed for the native debug binary.
  - Native debug app `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui` first ran as pid `6685`.
  - Command `#28` spawned bounded survivor instance `f912ba8f-53ee-4fd9-8dbc-743d8b2b1436` with PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`; command `#29` launched the guarded standby Codex prompt.
  - Event `#966` adopted the row with MCP pid `7158`; event `#967` shows the agent in `wait_for_activity`.
  - After killing only `swarm-ui` pid `6685`, SQLite still contained the same instance row and `ps -p 7158` still showed `node /Users/mathewfrazier/Desktop/swarm-mcp-lab/dist/index.js`.
  - Relaunched native `swarm-ui` as pid `8202`; command `#30` wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777770110589.json`.
  - Command `#31` addressed the survivor by instance id after relaunch, closed PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`, deregistered instance `f912ba8f-53ee-4fd9-8dbc-743d8b2b1436`, and terminated pid `7158`.
  - Cleanup proof: the survivor instance row count returned `0`, and process search found no `f912ba8f`, `bg-7d-survivor`, or `84629a59` survivor process.
  - Limitation: this is native worker/backbone proof, not a human-visible installed-app screenshot; that visual click path remains tied to the Slice 5C Accessibility/TCC revisit.

- Baseline `bun run check`: passed on 2026-04-22 after installing root and `apps/swarm-ui` package dependencies.
- UI `bun run check`: passed as part of baseline check, 0 Svelte errors and 0 warnings.
- UI `bun run build`: passed as part of baseline check; Vite emitted only the existing chunk-size warning.
- Bun tests: 111 passed, 0 failed.
- `apps/swarm-server` Rust tests: 18 passed, 0 failed.
- `apps/swarm-ui/src-tauri` Rust tests: 60 passed, 0 failed.
- Post-Phase-2 listener-health sync verification on 2026-04-25:
  - `bun test test/events.test.ts`: passed, 20 tests.
  - `cd apps/swarm-ui && bun test src/lib/agentListenerHealth.test.ts src/lib/graph.test.ts`: passed, 9 tests.
  - `bun run check`: passed, 124 tests plus TypeScript, Svelte build/check, and Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed, built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
  - Existing Vite chunk-size warning remains non-blocking.
- Phase 3 automated verification on 2026-04-25:
  - `bun test apps/swarm-ui/src/lib/agentIdentity.test.ts`: passed, 6 tests.
  - `cd apps/swarm-ui && bun test src/lib/agentListenerHealth.test.ts src/lib/graph.test.ts src/lib/agentIdentity.test.ts`: passed, 15 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 130 tests plus TypeScript, Svelte build/check, and Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug --no-bundle`: passed, built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
  - Existing Vite chunk-size warning remains non-blocking.
- Phase 3 active-parity regression recovery on 2026-04-25:
  - Restored saved agent profile launch-command precedence over selected launch profiles.
  - Restored scope-aware swarm bootstrap prompt and active's message/task action contract.
  - Restored active terminal-first node body, identity plate, direct Conversation recipient picker, stale/orphan PTY clear paths, Analyze Tron styling, Home Tron art, and FrazierCode [Agentic] rail surface.
  - Integrated the later active Home menu pass into lab: white-LED Encom chrome, FrazierCode art card, stable Home scrollbar/path wrapping, and Team Loadouts in the launcher while preserving lab Launch Profile command precedence.
  - Replaced the app icon and rebuilt a Dockable debug bundle at `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`, then copied a stable launcher to `/Users/mathewfrazier/Applications/Swarm UI Lab.app`.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun test apps/swarm-ui/src/stores/teamProfiles.test.ts apps/swarm-ui/src/stores/startup.test.ts`: passed, 12 tests.
  - `cargo test -p swarm-ui operator_`: passed, 2 tests.
  - `bun run check`: passed, 134 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
- Phase 3 second regression cleanup on 2026-04-25:
  - Fixed the remaining Claude/Codex launch resolver bug: saved agent profiles now own command, harness, role, and bypass posture, so a stale Codex Launch Profile selection cannot make a Claude profile launch Codex.
  - Ported active's shell-overlay folder/header surface into lab and restored active's Tron terminal-node chrome: white square connection ports, resize handles, border glow, and animated message-edge glow.
  - Added provider-aware skill suggestion chips to Launch profile editing and Inspector Agent Identity editing. These are safe static shortcuts; exact live slash-skill catalogs remain terminal-source-of-truth until a backend skill-discovery path is designed.
  - Kept the terminal-first node body as the manual-QA baseline and applied only a light polish pass to the identity plate. The larger "sexy" card redesign remains the next focused Phase 3 slice, not a risky replacement during regression recovery.
  - `bun test apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/lib/skillSuggestions.test.ts`: passed, 5 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 139 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
- Phase 3 Agent Card v2 and launch-preset cleanup on 2026-04-25:
  - Refined launch resolution so saved Agent Profiles keep identity/harness protection while matching Launch Profile command presets can still provide bypass/full-access commands when the Agent Profile's own launch command is blank.
  - Added visible Launcher command-source copy and a mismatch warning when a selected Launch Profile is for a different provider than the active saved Agent Profile.
  - Integrated Agent Card v2 as an in-node Agent Deck: terminal nodes open on the live `Term` tab, with a redesigned `Deck` tab for persona/provider, runtime, listener, task, lock, unread, skills, permissions, and scope signals.
  - Reworked Agent Deck styling for the Tron Encom OS theme with sharp white LED frames while keeping the restored terminal-first baseline.
  - `bun test apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/lib/skillSuggestions.test.ts apps/swarm-ui/src/lib/agentIdentity.test.ts`: passed, 12 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 140 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
- Phase 3 Agent Deck readability/current-work polish on 2026-04-25:
  - Brightened Agent Deck internals so the content reads against the intense Tron LED node frame, and added distinct tone channels for runtime/task/lock/message/status panels.
  - Added a `Current Work` panel with pulsing dark-folder art. It derives the live target from assigned task files first, then lock files, instance directory, or PTY cwd.
  - Added best-effort formal-step display from task metadata when the title or description includes `Step N`, `Part N`, or `Phase N`; richer project/note-backed step tracking remains a later Phase 4+ data-model item.
  - Reworked the node header into a compact identity chip with emoji, agent name, provider, and role; clicking it collapses/expands the node.
  - `bun test apps/swarm-ui/src/lib/agentIdentity.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts`: passed, 10 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 140 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
- Phase 3 node-header wrap-up polish on 2026-04-25:
  - Reworked the top node header into a cleaner Tron control strip: role-derived emoji fallback, larger identity chip, shortened path rail, toned vertical traffic controls, hidden duplicate role pill in Tron, and square command buttons.
  - Preserved the floating identity plate as the main visual identity surface while making the actual node header read as operational chrome rather than a generic desktop title bar.
  - `bun test apps/swarm-ui/src/lib/agentIdentity.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts`: passed, 10 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `CARGO_PROFILE_TEST_DEBUG=0 bun run check`: passed, 140 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests. The explicit test debug setting avoids a local zero-CPU rustc stall seen with the default test debuginfo path.
  - `cd apps/swarm-ui && CARGO_PROFILE_DEV_DEBUG=0 bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
- Phase 3 Dock app launch-profile storage recovery on 2026-04-25:
  - Root cause: the Dockable app bundle reads WebKit storage under `~/Library/WebKit/com.swarm.ui`, while the previously working profile state lived under legacy `~/Library/WebKit/swarm-ui`.
  - The current storage had empty `swarm-ui.agent-profiles`, plain `claude`/`codex` harness aliases, and `trusted-local` selected, so launches fell back to plain commands instead of `flux` / `flux9`.
  - Restored the working legacy localStorage records into the current bundle storage: `Claude_Beast` selected with `launchCommand: flux`, `Codex_Beast` with `launchCommand: flux9`, recent directories, harness aliases, and startup preferences.
  - Quick `open -n /Users/mathewfrazier/Applications/Swarm UI Lab.app` smoke test started the Dock app after recovery, then the app was quit cleanly.
- Phase 4 Project Spaces first implementation slice on 2026-04-25:
  - Added project domain types, frontend project store normalization, SQLite-backed project persistence, Tauri project CRUD/attachment commands, canvas project boundaries, Home create/open actions, and a Project Page surface.
  - Project attachment is context membership only; the confirmation copy explicitly states it does not change OS-level file permissions.
  - `cd apps/swarm-ui && bun test src/stores/projects.test.ts`: passed, 3 tests.
  - `CARGO_PROFILE_TEST_DEBUG=0 cargo test -p swarm-ui project_`: passed, 2 focused Rust tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `CARGO_PROFILE_TEST_DEBUG=0 bun run check`: passed, 143 Bun tests plus TypeScript, Svelte build/check, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && CARGO_PROFILE_DEV_DEBUG=0 bunx tauri build --debug --no-bundle`: passed, built `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
  - Existing Vite chunk-size warning remains non-blocking.
  - Manual click-through QA remains pending.
  - Manual QA: `docs/manual-qa/phase-4-project-spaces.md`
- Phase 4 Project Spaces product-behavior finish on 2026-04-25:
  - Default project root resolves through Tauri to Desktop first, then home.
  - Home now has a first-class Projects section with New Project from Desktop and Open Project paths.
  - Project spaces now persist notes and show roots/assets/files, linked agents, linked tasks, and the context-not-sandbox distinction on the Project Page.
  - Boundaries can be moved/resized and have a sync affordance; dragging an agent into a boundary or syncing enclosed agents attaches membership and sends a project-context bootstrap with root, extra roots, notes, current tasks, and standby/listen instructions.
  - Runtime relocation remains explicit through Respawn in project for stale/offline agents; attachment does not silently change cwd or scope.
  - `bun test apps/swarm-ui/src/stores/projects.test.ts apps/swarm-ui/src/stores/startup.test.ts`: passed, 13 tests.
  - `cargo test -p swarm-ui project_`: passed, 2 focused Rust tests.
  - `cargo test -p swarm-ui retarget_instance_runtime_context_updates_scope_and_directory`: passed, 1 focused Rust test.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 155 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app` and launched the refreshed app process successfully.
  - Manual click-through from Codex was blocked: `System Events` returned assistive access error `-25211`, and `screencapture` failed with `could not create image from display`.
- Dev launch reliability note on 2026-04-25:
  - Root cause for `cd apps/swarm-ui && bunx tauri dev` not opening the app: Vite starts, then Rust can stall at zero CPU while compiling the Tauri binary with full dev debug info.
  - Added workspace Cargo `profile.dev` and `profile.test` debug settings so the plain local commands inherit the working no-debug-info path without requiring `CARGO_PROFILE_DEV_DEBUG=0` / `CARGO_PROFILE_TEST_DEBUG=0` every time.
  - Verified `cd apps/swarm-ui && bunx tauri dev` now launches `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`; verified `cargo test -p swarm-ui project_` passes without a debug-profile env override.
- Agent Profile permission posture cleanup on 2026-04-25:
  - Replaced the freeform permissions textarea in Launcher Agent Profiles with clickable posture options. Claude full access now seeds `flux`; Codex full access seeds `flux9`; Standard clears the profile command override.
  - Legacy saved profiles with `permissions` text like `full permission`, `full access`, `dangerously`, or `bypass` and no launch command now migrate to the matching bypass alias during profile normalization.
  - Verified `bun test apps/swarm-ui/src/stores/agentProfiles.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts` and `cd apps/swarm-ui && bun run check`.
- Launch Profile ownership cleanup on 2026-04-25:
  - Saved Agent Profiles now own harness, role, command, and permission posture completely. Launch Profile presets apply only to manual/current-form launches, so they cannot constrain or override a saved Claude/Codex profile.
  - Launcher hides the Launch Profile selector while an Agent Profile is selected and shows the active Launch Owner plus the exact command that will be typed into the node terminal.
  - Verified `bun test apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/stores/agentProfiles.test.ts` and `cd apps/swarm-ui && bun run check`.
- Launcher UX simplification on 2026-04-25:
  - Rebuilt the launcher presentation around a default Quick Launch surface: one working directory field, saved-agent cards, direct Claude/Codex full-access starters, Shell, and one primary launch button.
  - Moved profile editing, persona/mission/skills/memory, permission posture, manual harness/role/scope/label fields, Launch Profile presets, and Team Loadouts under a collapsed Advanced setup drawer.
  - Added quick-launch helper tests so saved-agent cards display the actual command that will be typed, including `flux`/`flux9` full-access aliases.
  - Verified `bun test apps/swarm-ui/src/lib/quickLaunch.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/stores/agentProfiles.test.ts` and `cd apps/swarm-ui && bun run check`.
- Launcher saved-agent management cleanup on 2026-04-25:
  - Replaced the Claude/Codex full-access quick buttons with `Add Agent` and `Saved Agents` popup pages plus the existing `Shell` starter.
  - Added saved-agent tier ordering, so favorite agents can be moved into the #1/#2 quick-launch card slots.
  - Added per-agent role/emoji look fields and an emoji button on saved-agent cards that opens a role picker with standard presets, including planner/owl. Custom-role creation is intentionally a disabled placeholder for a later slice.
  - Custom non-swarm terminal agents can now save and auto-type arbitrary launch commands like OpenClaw/Hermes-style commands; only known harnesses (`claude`, `codex`, `opencode`) get the pre-created swarm identity row.
  - Verified `bun test apps/swarm-ui/src/lib/*.test.ts apps/swarm-ui/src/stores/*.test.ts` and `cd apps/swarm-ui && bun run check`.
- Phase 3 closeout on 2026-04-25:
  - Mathew accepted the current Phase 3 manual UI pass and directed closeout.
  - Phase 3 is fully closed with the active-style terminal baseline, Agent Deck v2, current-work panel, node-header polish, launch/profile ownership cleanup, saved-agent management popups, role/emoji customization, and restored active parity surfaces.
  - Remaining non-blocking follow-ups move out of Phase 3: richer project/note-backed step tracking belongs to Phase 4+, and first-class custom harness swarm bootstrap belongs to a later runtime-adapter slice.
- Phase 5 Assets and Multimodal Context first implementation slice on 2026-04-26:
  - Added `ProjectAsset`, `AssetKind`, and `AssetAttachment` frontend types plus `projectAssets` store normalization and Tauri command wrappers.
  - Added `buildAssetContextBlock` for structured agent context injection that preserves asset kind, title, path, description, and note/protocol content.
  - Added SQLite-backed asset and attachment persistence through `ui_project_assets` and `ui_asset_attachments`, plus Tauri commands for list/save/delete/attach/detach.
  - Added Project Page asset creation controls for image, screenshot, note, folder, protocol, and reference assets; asset grid grouping; preview rendering; agent attachment buttons; and Inspector Attached Assets context visibility.
  - `cd apps/swarm-ui && bun test src/stores/projectAssets.test.ts src/lib/assetContext.test.ts`: passed, 5 tests.
  - `cargo test -p swarm-ui project_assets_round_trip_and_delete_with_attachments`: passed, 1 focused Rust test.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 161 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
  - Manual click-through remains pending.
- Phase 5 installed-app QA hardening on 2026-04-26:
  - Enabled Tauri `assetProtocol` with `$HOME/**` scope and media CSP so local image/video previews can render through `convertFileSrc`.
  - Reworked File Bubble navigation into a one-layer-at-a-time folder stack and replaced the drawn folder block with the Encom dark-folder image asset.
  - Added video/media preview support for mp4/mov/m4v/webm inventory entries.
  - Added Settings `Multimodal Analyzer` controls backed by macOS Keychain for OpenAI API key storage plus a saved custom analyzer command fallback.
  - Follow-up: image previews are now direct expansion targets, not only the separate `Expand image` button.
  - Follow-up: visual analysis now creates `PROJECT_ROOT/workspace/README.md` when needed and writes a dated markdown artifact under `PROJECT_ROOT/workspace/YYYY-MM-DD/`.
  - Follow-up: project bootstraps now tell attached agents to use/create `PROJECT_ROOT/workspace`, put daily scratch notes/plans in the dated folder, and keep durable project notes directly under `workspace`.
  - Verification:
    - `cd apps/swarm-ui && bun test src/stores/projectAssets.test.ts`: passed, 12 tests.
    - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
    - `cargo test -p swarm-ui analyze_project_asset`: passed, 2 tests; now verifies the filesystem markdown artifact and workspace README.
    - `cargo test -p swarm-ui project_asset_catalog`: passed, 2 tests.
    - `cd apps/swarm-ui && bunx tauri build --debug`: passed and produced `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
    - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app` from the debug bundle.
  - Manual click-through remains pending.
- Phase 5 Slice 2 real asset intake on 2026-04-26:
  - Reviewed Slice 1 and fixed two issues: frontend asset deletion now preserves unrelated attachments, and backend asset persistence now rejects nonexistent project IDs.
  - Added Tauri dialog-backed intake through `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog`, registered the plugin, and granted only `dialog:allow-open`.
  - Added native Project Page `Choose file` / `Choose folder` actions for image, screenshot, note, protocol, and folder assets; filenames/folder names seed titles when empty.
  - Added `asset:` / `http://asset.localhost` CSP support so dialog-selected local image previews can render through Tauri asset URLs.
  - Added frontend and backend validation for visual/folder/note/protocol/reference asset payloads, including real local text-file validation for note/protocol paths.
  - QA follow-up: Project Page is now a wide dedicated overlay instead of a narrow side panel; Assets has a `Refresh assets` action that scans the project root and extra roots for image/text files, imports new files, and hydrates note/protocol content.
  - QA follow-up after manual refresh miss: `Refresh assets` now saves the current Roots & Assets field before scanning and reports imported asset count plus scanned root count, so empty scans are visible instead of silent.
  - QA follow-up after manual file/render test: Project asset catalogs now include Folder Inventory for saved roots, `.rtf` files import as stripped readable note/protocol text, image preview failures show a visible fallback path, and `[project-context]` bootstraps include a `Project assets:` summary when saved assets exist.
  - Asset attachment now sends a direct `[asset-context]` message to the selected agent when the agent is reachable, so the agent can pick it up through the normal swarm message loop.
  - Added manual QA fixtures under `/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/manual-qa/phase-5-fixtures`.
  - QA follow-up verification:
    - `cd apps/swarm-ui && bun test src/lib/assetContext.test.ts src/lib/assetIntake.test.ts src/stores/projectAssets.test.ts`: 20 tests.
    - `cargo test -p swarm-ui asset`: 13 tests.
    - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
    - `bun run check`: passed, 176 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and 81 Tauri Rust tests.
    - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
    - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
  - Focused verification passed:
    - `cd apps/swarm-ui && bun test src/lib/assetIntake.test.ts src/stores/projectAssets.test.ts`: 11 tests.
    - `cargo test -p swarm-ui asset_payload`: 6 tests.
    - `cargo test -p swarm-ui project_asset`: 2 tests.
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 169 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
  - Manual click-through remains pending.
- Phase 5 multimodal-analysis follow-up on 2026-04-26:
  - Added `ui_analyze_project_asset` for image/screenshot assets, with `SWARM_ASSET_ANALYZER_CMD` for local/custom analyzers and `OPENAI_API_KEY` for OpenAI Responses image analysis.
  - The OpenAI analyzer sends base64 image data through stdin-fed `curl --data-binary @-` to avoid command-line payload limits, caps local analysis input at 20 MB, and rejects unsupported OpenAI image extensions with a clear validation message.
  - Saved analysis is persisted into `ProjectAsset.content`; image/screenshot context now labels that content as `Visual analysis:` instead of `Notes:`.
  - Project Page asset cards and the File Bubble image preview now expose `Analyze image` / `Re-analyze image` actions and show saved analysis below visual previews.
  - Manual QA docs now include analyzer setup, missing-config behavior, visual-analysis context injection, and File Bubble image/lightbox checks.
  - Verification:
    - `cd apps/swarm-ui && bun test src/lib/assetContext.test.ts src/stores/projectAssets.test.ts`: passed, 16 tests.
    - `cargo test -p swarm-ui analyze_project_asset`: passed, 2 tests.
    - `cargo test -p swarm-ui extract_response_text`: passed, 1 test.
    - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
    - `bun run check`: passed, 182 Bun tests plus TypeScript, Vite build, swarm-server Rust tests, and 84 Tauri Rust tests.
    - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
    - Refreshed and launched `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; smoke process `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui` started successfully.
  - Manual click-through remains pending.
- Phase 6 Startup Branding and Credit initial slice on 2026-04-26:
  - Added a brand metadata helper with visible artwork credit formatting.
  - Moved the startup artwork into a dedicated brand asset path and created a Home-only `StartupHero` surface.
  - Mounted the hero on Home with FrazierCode branding, the primary Start action, target path, and visible `Artwork by MJ` credit.
  - Fixed narrow viewport Home scrolling in Tron mode and reduced mobile hero title sizing so text does not clip.
  - Follow-up slice: added a full attribution/placement line, added About/Home credit visibility, removed the FrazierCode raster art from Inspect and FrazierCode [Agentic] canvas surfaces, and left those surfaces with credit/placement text only.
  - Verification:
    - `bun test apps/swarm-ui/src/lib/brand.test.ts`: passed, 2 tests.
    - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
    - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
    - Browser/Vite visual pass verified desktop hero, narrow scrolled hero, Start-to-canvas path, Inspect Art Preview credit-only containment, FrazierCode [Agentic] credit-only containment, and About/Home credit visibility; Tauri API warnings are expected in plain browser mode.
    - `cd apps/swarm-ui && CARGO_PROFILE_DEV_DEBUG=0 bunx tauri build --debug`: passed after a targeted stale `objc2-foundation` target-cache cleanup; bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
    - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.
  - Human-visible click-through in `/Users/mathewfrazier/Applications/Swarm UI Lab.app` remains pending.
- Phase 6 user-preference revert and opacity correction on 2026-04-26:
  - Restored the prior full-screen FrazierCode Agentic start portal with the centered play button.
  - Restored raster artwork in FrazierCode [Agentic] and Inspect Art Preview instead of the credit-only containment panels.
  - Removed the unused `StartupHero`, brand metadata helper, duplicate brand asset, and related brand test.
  - Updated the background opacity mapping so `0%` is fully clear and `100%` is full black for canvas, panel, sidebar, node, and header surfaces.
  - Verification:
    - `bun test apps/swarm-ui/src/stores/startup.test.ts`: passed, 10 tests.
    - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
    - `cd apps/swarm-ui && bun run build`: passed; existing Vite chunk-size warning remains non-blocking.
    - `cd apps/swarm-ui && CARGO_PROFILE_DEV_DEBUG=0 bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
    - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started `/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui`, then the app was quit cleanly.

## Setup Notes

- This repo is intentionally a fresh lab copy of `/Users/mathewfrazier/Desktop/swarm-mcp-active`.
- Run `bun install` at the repo root and in `apps/swarm-ui` after a fresh copy. The root package is not a workspace, and root `bun test` imports UI files that resolve Svelte from `apps/swarm-ui/node_modules`.
- The old lab checkout was moved aside before replacement at `/Users/mathewfrazier/Desktop/swarm-mcp-lab-backup-20260422-194857`.
- Standard dev launch: `cd apps/swarm-ui && bunx tauri dev`. The workspace Cargo profiles intentionally disable Rust debug info for dev/test to avoid the local zero-CPU rustc stall; temporarily override with `CARGO_PROFILE_DEV_DEBUG=2` only when Rust symbol debugging is needed.

## Active Decisions

- `swarm-mcp-active` remains the reference lane.
- `swarm-mcp-lab` is the execution lane for the overhaul.
- Use a dedicated swarm scope ending in `#overhaul`.
- File locks and task assignments are required before multi-agent implementation.
- The May 1st plan and bootstrap replace the old phase sequence as the active execution path.
- Phase 1, Phase 2, and Phase 3 are complete. Phase 4 product behavior is implemented with manual click-through pending. Phase 5 is implemented with final installed-app click-through pending. Phase 6 is historical/source material unless reopened. Phase 7+ remain gated until Mathew explicitly approves them.
- Old phase plans should be read through `docs/MAY_1ST_PLAN_ARCHIVE.md`; they are not current task lists.
- Startup paths must be absolute. Use `/Users/mathewfrazier/Desktop/swarm-mcp-lab`, not `Users/mathewfrazier/Desktop/swarm-mcp-lab`.
- Add a researcher assistant beside the orchestrator. The researcher handles discovery and collision checks so the orchestrator can focus on sequencing and coordination.

## Swarm Team Prep

- Planner registered: `9bb8b9a5-aba5-4fd1-a763-1e71f8a2404a` (`provider:codex role:planner name:overhaul-planner`)
- Scope: `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`
- `plan/latest` points agents at the lab repo, authority docs, baseline commit, and pause gate.
- Orchestrator prompt: `docs/OVERHAUL_ORCHESTRATOR_PROMPT.md`
- Recommended first live team: Claude Code orchestrator planner, Codex researcher assistant, Codex Builder A, Codex reviewer.
- Open smoke task: `c026dd8a-a97f-4289-809f-8d0d6cc10dc7` (`Smoke check lab baseline`)
- Gated Phase 1 task: `e3a651f7-ec09-49c7-adff-a295c62510dd`
- Gated Phase 2 task: `6d1aad8a-d237-48fa-b75d-1f661ac9e717`
- Gated Phase 3 task: `9329a76f-1434-4fc6-816b-9904ed9021ee`
- Gated Phase 4 task: `a5c20eda-f8b1-4478-803b-c6f65b91da7c`
- Gated Phase 5 task: `f8cc401a-1fce-4484-8b9d-ab6c5de77ecf`
- Gated Phase 6 task: `c0334d3c-adbb-48b7-b40e-458476544f98`
- Gated Phase 7 task: `00a247e6-ae92-46f8-9375-1bac1956ebba`
- Gated final review task: `27b131f2-c05c-4bb9-afb0-c010baba8133`

## Reliability Sync Baseline

The listener-health reliability sync is now part of the lab baseline for Phase 3.

Do not remove or reimplement this during the agent identity work:

- `src/events.ts`, `src/messages.ts`, and `src/index.ts` emit `agent.polled`, `agent.waiting`, and `agent.wait_returned`.
- `apps/swarm-ui/src/lib/agentListenerHealth.ts` derives listener state.
- `apps/swarm-ui/src/lib/graph.ts` passes unread-message count and listener state to nodes.
- `apps/swarm-ui/src/nodes/NodeHeader.svelte` shows listener and unread badges.
- `apps/swarm-ui/src/panels/Inspector.svelte` shows Listener Health details.

Manual QA: `docs/manual-qa/listener-health-reliability-sync.md`

## Phase 3 Agent Identity Baseline

Phase 3 is closed on top of listener-health. After the active-parity recovery, the terminal remains the default node body, and Agent Deck v2 carries the agent-first identity surface without blocking core launch, terminal, direct-message, and stale-cleanup workflows. The overview-card files remain in the tree as experimental Phase 3 work but are not the default node body.

Do not remove or bypass these in later phases:

- `apps/swarm-ui/src/lib/agentIdentity.ts` parses and rewrites label-backed identity tokens.
- `apps/swarm-ui/src/stores/agentProfiles.ts` persists per-instance runtime profile metadata locally until DB-backed metadata lands.
- `apps/swarm-ui/src/lib/graph.ts` adds `agentDisplay` alongside existing listener-health node data.
- `apps/swarm-ui/src/nodes/NodePersonaTab.svelte` renders the active-style identity plate with provider/model/name/role.
- `apps/swarm-ui/src/nodes/TerminalNode.svelte` keeps active's terminal-first body, compact cards, and fullscreen PTY suspension.
- `apps/swarm-ui/src/panels/Inspector.svelte` edits label-backed name/role/persona and local mission/skills/permissions metadata.
- `apps/swarm-ui/src/nodes/AgentCard.svelte`, `AgentOverview.svelte`, and `AgentModeTabs.svelte` are not the default node body until the card design is rebuilt against active's UI baseline.

Manual QA: `docs/manual-qa/phase-3-agent-identity-overhaul.md`

## Phase Plan Index

- Phase 0: `docs/superpowers/plans/2026-04-22-phase-0-lab-baseline-and-team-execution.md`
- Phase 1: `docs/superpowers/plans/2026-04-22-phase-1-launch-productization.md`
- Phase 2: `docs/superpowers/plans/2026-04-22-phase-2-acceleration-tooling.md`
- Post-Phase-2 reliability sync: `docs/manual-qa/listener-health-reliability-sync.md`
- Phase 3: `docs/superpowers/plans/2026-04-22-phase-3-agent-identity-overhaul.md`
- Phase 4: `docs/superpowers/plans/2026-04-22-phase-4-project-spaces.md`
- Phase 5: `docs/superpowers/plans/2026-04-22-phase-5-assets-and-multimodal-context.md`
- Phase 6: `docs/superpowers/plans/2026-04-22-phase-6-startup-branding-and-credit.md`
- Phase 7: `docs/superpowers/plans/2026-04-22-phase-7-themes-and-protocol-views.md`
