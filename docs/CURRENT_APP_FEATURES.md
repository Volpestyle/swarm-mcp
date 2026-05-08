# Current App Feature Matrix

Updated: 2026-05-08 local app session.

This is the working feature contract for `swarm-mcp-lab` / `swarm-ui`.
It lists the capabilities the current app should have, where they appear, what
hidden command/API support exists underneath, and what proof level is currently
available.

## Proof Levels

| Level | Meaning |
| --- | --- |
| Source-confirmed | Current source code contains the feature path. This is not runtime proof. |
| Unit-tested | Focused unit or Rust test covers the behavior. |
| Build-tested | Typecheck/build completed successfully. |
| Browser-visual | Playwright/Vite/browser harness saw and interacted with the UI. |
| Native-shell | Tauri/Rust IPC or native worker path was exercised. |
| Human-needed | Requires a real installed app click-through or macOS permission boundary. |
| Defect | The behavior is incomplete, misleading, or not honestly provable yet. |
| Missing-coverage | Registered feature/control has no screenshot, semantic proof, or explicit exemption. |

## Product Spine

The active product direction is still:

1. Open or create a project.
2. Capture/import a plan.
3. Convert plan items into task rows.
4. Assign providers and roles.
5. Launch task-bound agents.
6. Watch listener/task/session state on the canvas.
7. Review files, results, proof, risks, and cleanup actions.

Normal users should see projects, tasks, agents, conversations, notes, and
review state. Directory/scope/channel/command/provider internals should stay in
Advanced, Debug, or incongruency review unless the user needs them.

## Majordomo Mental Map Inputs

This file is the baseline feature map for Majordomo, external agents, and human
operators. Majordomo should combine it with:

- `docs/VISUAL_TESTABILITY_AND_MAJORDOMO_PLAN.md`
- `/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution/README.md`
- recent surveys,
- area captures,
- visual mismatches,
- feature-learning notes,
- and `action-items/open.md`.

This lets Majordomo ask smart closeout questions like "Did the notes flow create
a real file and visible canvas document this time?" instead of generic survey
questions.

Majordomo's intended runtime is the local Hermes agent, launched visibly through
the app's PTY/harness path instead of hidden in a detached terminal. Local
planning research found:

- `Hermes` is available at `/Users/mathewfrazier/.local/bin/Hermes`.
- It resolves into `/Users/mathewfrazier/.hermes/hermes-agent/venv/bin/hermes`
  and imports `hermes_cli.main:main`.
- It supports `hermes --tui`, `-z/--oneshot`, `--model`, `--provider`,
  `--toolsets`, `--source`, session resume, and `hermes mcp ...`.
- The current app already has a default `hermes --tui` harness alias, recognizes
  `hermes` as a harness-shell role, and has a `role:majordomo` preset.

Therefore the first real Majordomo implementation should be a visible
Hermes-backed `role:majordomo` PTY with app-owned startup, source-tagging,
model/provider metadata, closeout survey handoff, and cleanup proof.

## Coverage Contract

This document is the human-readable contract. The app should also generate a
machine-readable feature/control registry from `data-surface`, `data-testid`,
and explicit feature-map metadata.

Every visible operator-facing control must be one of:

- screenshot-covered,
- semantic-covered,
- native-only-manual,
- hidden-debug-exempt,
- or missing-coverage.

`missing-coverage` is a defect. The visual atlas should fail when any registered
surface/control is missing coverage or exemption.

Macro Phase 1 now has the first machine-readable contract:
`apps/swarm-ui/src/lib/featureMap.ts`, `visualAtlasRegistry.ts`,
`visual-atlas/VisualAtlas.svelte`, and `swarm-mcp ui visual-atlas --out <dir>`.
The current atlas covers 12 registered surfaces and 25 controls with no
`missing-coverage` issues. This is browser/semantic proof through headless
Chrome/CDP, not native Tauri click proof.

## Visible Capabilities

| Feature | Operator surface | Current visible behavior | Hidden support | Proof status |
| --- | --- | --- | --- | --- |
| Home command deck | `StartupHome.svelte` | Start surface with Open Project, Start From Plan, Resume Running Agents, Advanced Launch, Settings, Dictionary/About sections, FrazierCode card. | Startup preferences, recent dirs, theme profile, project creation. | Source-confirmed, Build-tested. Some flows browser-smoked in older slices. |
| Home app identity/version strip | `StartupHome.svelte` first viewport | Shows `LAB` / `ACTIVE` / `LOCAL`, app version, run mode, compact runpath, and Dock/bundle status so the operator can tell whether they are in lab, active, dev, or bundled app. | `ui_build_provenance` returns app version, run kind, source root, cwd, executable path, bundle path, branch/commit/dirty state, and build/modified timestamps; browser preview fallback uses the app package version for atlas/dev proof. | Source-confirmed, Unit-tested, Browser-visual for preview fallback; native Tauri provenance path still needs app-shell visual proof. |
| Workspace Kit | `TopStrip.svelte` | Top strip opens Projects, Notes, Media, Plan Docs, `.md Files`, Browser lane; can create or open project spaces. | `ui_list_projects`, `ui_save_project`, `ui_default_project_root`, browser catalog commands. | Source-confirmed, Build-tested. |
| Canvas graph | `App.svelte`, SvelteFlow | Shows project boundaries, agent/PTY nodes, browser nodes, app/document surface nodes, edges, minimap, controls, selection. | Rust watcher polls DB and emits state updates; `buildGraph` merges instances, PTYs, browser contexts, app surfaces. | Unit-tested for terminal/browser/app-surface graph nodes; Browser-visual for document surface. |
| Project boundaries | `ProjectBoundary.svelte` | Draggable/resizable project box on canvas; project asset bubbles render inside. | Project boundary saved in project record, local layout sync. | Source-confirmed, Build-tested. |
| Canvas app rail | `App.svelte` | Left rail exposes Chrome, Note, Obsidian. | Tauri native app/browser commands plus document surface state. | Browser-visual for Note rail. Chrome/Obsidian source-confirmed; native proof varies by app. |
| Canvas notes | `App.svelte`, `AppSurfaceNode.svelte` | `Note` creates an on-canvas Canvas Document node with editable markdown, Save, Open file, and path footer. | `ui_create_project_note_asset`, `ui_update_project_note_asset_content`, `ui_open_project_asset_path`. | Unit-tested real file creation/update; Browser-visual with mocked Tauri IPC; native click-through still Human-needed. |
| Asset click/report contract | Canvas, Project Page, Workspace Kit, Proof Pack, Media, app surfaces | Visible assets now have registry metadata declaring whether normal click opens/selects/does nothing/disabled/decorative, while report mode can still target both clickable and non-clickable assets for screenshots. | `featureMap.ts` clickability/reportability metadata, `data-report-target`, area capture metadata. | Registry implemented, Unit-tested, and included in visual atlas/operator verification evidence. |
| Canvas quick menu | Canvas right-click / double-click | Right-click menu can launch agent, browser, Workspace Kit, note, plan, inspect; double-click opens provider picker. | Reuses existing launch, browser, note, plan, and inspect handlers. | Source-confirmed. Native gesture proof is weak due macOS automation limits. |
| Provider picker | Canvas double-click / quick menu | Select provider and role from canvas, then spawn agent into project/channel. | Launch preflight, `spawnShell`, role/name/label bootstrap. | Source-confirmed, Build-tested; broader launch tests exist for helpers. |
| Shell surface rail | Right mode rail | Launch, Chat, Inspect, Agents, Analyze, Mobile, Settings, FrazierCode, hide/show shell surface. | Shared panels and Tauri commands. | Source-confirmed, Build-tested. |
| Terminal/agent nodes | Canvas node body | Ghostty terminal panes, node header identity, status, ports, resize/selection, compact/full modes. | PTY daemon, binder, `get_pty_sessions`, PTY write/resize/lease/close. | Source-confirmed; many older smoke paths, but each new terminal change needs native proof. |
| Browser nodes | Canvas browser surface | Managed browser contexts can appear as canvas nodes with tab/snapshot context. | MCP browser engine, Tauri browser catalog, Chrome import/open/capture commands. | Unit-tested graph rendering; browser engine/source confirmed; native UI-managed browser proof is partial. |
| Native app surfaces | Canvas app nodes | Obsidian/native app records can show as operator-visible app surfaces. | `ui_launch_native_app`; app-surface node type. | Unit-tested graph rendering; launch/open proof is app-dependent. |
| Project Page / Cockpit | `ProjectPage.svelte` | Project notes, roots, linked agents, linked tasks, recent activity, editable color/notes/roots. | Project CRUD, memberships, project asset catalog. | Source-confirmed; older browser smoke exists. |
| Task Board | Project Page | Paste plan, create/edit grouped task rows, set provider/role/status/priority, select rows, Launch N, retry/reassign/reset. | MCP task model, `spawnShell`, preflight, task-board runtime resolver. | Older browser smoke and focused tests; current full path should be rerun after major changes. |
| Task-bound launch | Project Task Board | Selected rows launch agents with project/task labels and row-level PTY/instance/listener state. | `spawn_shell`, launch preflight, bootstrap prompt, task row state. | Prior native and browser proof exists; should be reverified before claiming current acceptance. |
| Review/Ship | Project Page | Groups changed/review files, task results, risks, commit-message suggestions, reviewer prompts. | `reviewShip` helper, task/result/file context. | Unit/source-confirmed from previous slices; current UI smoke needed. |
| Proof pack | Project Page and CLI | Captures semantic task-board proof, visual evidence metadata, screenshot status, review signals. | `ui_write_proof_pack`, `swarm-mcp ui proof-pack`, `collectVisualEvidence`. | Unit-tested; native screenshot is explicitly unsupported today. |
| Post-session improvement | Project Page | Captures worked/confusing/broke/improve-next notes, optionally creates improvement rows or bounded background launch. | `postSessionImprovement` helpers, background launch labels/prompts/policy. | Source-confirmed and helper-tested from previous slice; full native proof should be rerun. |
| Background Resume Center | Project Page | Shows project-linked background runs, status/provider/role/timeout/scope, Suspend/Kill controls. | Background launch labels, project/task/session records. | Previously accepted as local dev; installed proof still tracked separately. |
| Conversation panel | Right shell surface | Broadcast/direct operator messages, copy visible conversation. | `ui_broadcast_message`, `ui_send_message`, message DB/events. | Source-confirmed; sidecar tests covered export/bootstrap language. |
| Agent Command Center / Grand Architect | Right rail panel | Agent library, roles, teams, hierarchy, protocols, overhaul/status board. | Agent profiles, team profiles, role presets, May 1st data model. | Source-confirmed; some store tests. |
| Majordomo mental map/runtime assistant | Right rail Majordomo panel | Answers feature/proof/runpath questions through the visible contact surface, structures messy idea dumps, offers Clarify Will choices, and can start/bind a visible Hermes-backed `role:majordomo` PTY in the lab profile. | `majordomoRuntime.ts`, feature map, visual/testability plan, shared learning folder, area captures, action items, `spawnShell`, role preset/launch role support, Hermes CLI at `/Users/mathewfrazier/.local/bin/Hermes`. | Implemented, Unit-tested, Build-tested; live Hermes launch proof still needs native shell run. |
| Hermes Majordomo lifecycle | Majordomo panel, closeout packet | Launch command uses `/Users/mathewfrazier/.local/bin/Hermes --tui --source swarm-ui-majordomo`, optional model/provider, runtime status, timeout metadata, visible PTY binding, and stop through PTY close or kill/deregister fallback. | Existing `spawnShell`, `launch.rs` harness role support, PTY close/kill/deregister paths, `majordomoRuntime.ts`. | Implemented and Unit-tested; no hidden Hermes session claimed until native launch/cleanup proof is run. |
| Omnipresent Majordomo contact | Majordomo panel plus report mode entry | Lets the operator idea-dump messy text, structure it, clarify unclear will through concrete choices, apply live tweaks, and start report-area capture from the Majordomo surface. | Majordomo contact tab, runtime tweak parser/store, feature map, command bus, survey learning folder. | Implemented, Unit-tested, Build-tested; still needs full operator-workflow proof. |
| Area report capture | App-wide feedback mode | Darkens unrelated UI, keeps Majordomo context visible, shows a draggable/resizable red crop box, steps through Next/Confirm, creates app-region DOM proof, and saves PNG/Markdown/JSON sidecars into dated learning session folders through Tauri. | `areaCapture.ts`, `AreaCaptureOverlay.svelte`, `window.__SWARM_UI_PROOF__.captureRegion`, `ui_save_area_capture`. | Implemented, Unit-tested, Rust native-write tested, and operator-verifier covered; native desktop screenshot is not claimed. |
| Exhaustive visual atlas | CLI/proof pack surface | Renders deterministic atlas surfaces, screenshots each registered surface, writes semantic snapshots, exports feature/coverage JSON, and fails when a control has `missing-coverage`. | `featureMap.ts`, `visualAtlasRegistry.ts`, `VisualAtlas.svelte`, `swarm-mcp ui visual-atlas --out <dir>`. | Implemented, Unit-tested, Build-tested, Browser-visual via headless Chrome/CDP; native shell proof not claimed. |
| Live UI tweaks through Majordomo | Majordomo contact tab | Supports `/tweak move majordomo button right 12`, `/tweak resize note surface wider 40`, `/tweak reset current`, and `/tweak accept current`; applies live CSS variables without source writes. | `runtimeTweaks.ts`, Majordomo contact tab, app-root CSS variables. | Implemented and Unit-tested; source-persist after acceptance remains future work. |
| App identity in surveys/proof | Closeout survey, proof pack, visual atlas, operator verifier, Majordomo CLI | Closeout packet records app name, lab/active/local variant, version, Tauri shell/run kind, source root, project root, scope/channel, session id, visual atlas path, captured areas, and Majordomo runtime cleanup state. | `ui_build_provenance`, `sessionCloseout.ts`, `ui_save_session_closeout`, visual atlas `index.md`, operator verification `index.md`. | Implemented for closeout packet and operator verifier; Unit/Rust tested. |
| Run This Version closeout | Codex/Claude/Majordomo/CLI final reports | After any implementation or CLI-driven edit, final output should include exact source root, native dev runpath, browser preview URL when relevant, Dock/bundle freshness status, and evidence run. | Future closeout formatter, Majordomo CLI, proof pack metadata, session survey JSON. | Planned/Defect until wired into agent and app closeouts. |
| Operator workflow verification | CLI/proof pack surface | Produces an evidence directory with home/project/asset/report/agent screenshots, semantic before/after snapshots, session rows, launched-agent tracking proof, Dock bundle status, and cleanup audit. Native launch steps are explicitly classified when not driven by macOS automation. | `operatorWorkflowProof.ts`, `operatorVerifyCli.ts`, `swarm-mcp ui operator-verify`, semantic snapshots, session rows, launched-agent proof. | Implemented, Unit-tested, Browser-visual/internal semantic proof; native macOS click/screenshot/Automation not claimed. |
| Analyze panel | Right rail panel | System load, agent/helper process rows, CPU/memory/token/cost style summaries, kill session/helper/all actions. | `ui_scan_system_load`, `ui_kill_session_tree`, `ui_kill_all_agent_sessions`. | Source-confirmed; some Rust/system-load tests. |
| Settings | Settings modal | Theme, launch defaults, diagnostics/export/screenshot buttons, analyzer settings, aliases. | Startup preferences, appearance, export/screenshot commands, analyzer config. | Source-confirmed; screenshot command honestly returns unsupported. |
| Mobile access | Mobile modal | Device pairing/revoke/control surface for companion/mobile access. | `mobile_access_*` Tauri commands and protocol types. | Source-confirmed; current runtime proof not rerun here. |
| FrazierCode archive | Home card/right rail | FrazierCode [Agentic] art/archive panel remains visible but secondary. | Static assets and panel state. | Source-confirmed, Build-tested. |

## Hidden / Agent-Facing Capabilities

### MCP Server Tools

These are available through the `swarm` MCP server for agent sessions:

- Instance registry: `register`, `list_instances`, `whoami`, `remove_instance`, `deregister`.
- Messaging: `send_message`, `broadcast`, `poll_messages`, `wait_for_activity`.
- Task DAG: `request_task`, `request_task_batch`, `claim_task`, `update_task`, `approve_task`, `get_task`, `list_tasks`.
- Shared context: `annotate`, `lock_file`, `unlock_file`, `check_file`, `search_context`.
- Browser automation: `browser_open`, `browser_contexts`, `browser_tabs`, `browser_read`, `browser_snapshot`, `browser_screenshot`, `browser_snapshots`, `browser_navigate`, `browser_click`, `browser_type`, `browser_close`.
- UI browser intents: `browser_ui_open`, `browser_ui_import_active_tab`, `browser_ui_capture_snapshot`, `browser_ui_close`, `browser_ui_commands`.
- Key-value state: `kv_get`, `kv_set`, `kv_append`, `kv_delete`, `kv_list`.

### CLI Capabilities

The CLI provides:

- `swarm-mcp inspect`: dump instances, tasks, context, KV, and recent messages.
- `swarm-mcp messages`, `tasks`, `kv`: read/write coordination state.
- `swarm-mcp lock` / `unlock`: file lock coordination.
- `swarm-mcp ui spawn`: ask the running UI to spawn an agent/PTY.
- `swarm-mcp ui kill`: ask the UI to kill/deregister an instance.
- `swarm-mcp ui export-layout`: write current UI layout state.
- `swarm-mcp ui screenshot`: request screenshot; current contract may return explicit unsupported status.
- `swarm-mcp ui proof-pack`: ask the UI worker to write a proof pack.
- `swarm-mcp ui visual-atlas --out <dir> [--json]`: write feature-map coverage,
  atlas screenshots, semantic snapshots, and an index through headless
  Chrome/CDP.

### Tauri IPC Commands

The desktop app exposes hidden IPC for:

- Swarm state and PTY lifecycle: `get_swarm_state`, `get_pty_sessions`, `get_binding_state`, `spawn_shell`, `respawn_instance`, `respawn_instance_in_project`, `pty_write`, `pty_resize`, `pty_close`, `pty_request_lease`, `pty_release_lease`, `pty_get_buffer`.
- Launch/preflight: `ui_preflight_launch_command`, `ui_write_codex_launch_script`, `ui_resolve_swarm_mcp_server`, `get_role_presets`.
- Messaging/tasks/cleanup: `ui_broadcast_message`, `ui_send_message`, `ui_send_sigint_scope`, `ui_clear_messages`, `ui_unassign_task`, `ui_remove_dependency`, `ui_kill_instance`, `ui_deregister_instance`, `ui_force_deregister_instance`, `ui_deregister_offline_instances`, `ui_sweep_unadopted_orphans`.
- Layout/proof: `ui_set_layout`, `ui_export_layout`, `ui_capture_screenshot`, `ui_write_proof_pack`.
- Browser/app surfaces: `ui_launch_chrome`, `ui_launch_native_app`, `ui_list_browser_catalog`, `ui_refresh_browser_catalog`, `ui_refresh_browser_context`, `ui_capture_browser_snapshot`, `ui_open_browser_context`, `ui_import_front_chrome_tab`, `ui_list_chrome_tabs`, `ui_import_chrome_tabs`, `ui_close_browser_context`, `ui_delete_browser_context`.
- Projects/assets: `ui_list_projects`, `ui_default_project_root`, `ui_ensure_project_folder`, `ui_save_project`, `ui_delete_project`, `ui_attach_instance_to_project`, `ui_detach_instance_from_project`, `ui_list_project_assets`, `ui_save_project_asset`, `ui_create_project_note_asset`, `ui_update_project_note_asset_content`, `ui_open_project_asset_path`, `ui_analyze_project_asset`, `ui_get_asset_analyzer_settings`, `ui_save_asset_analyzer_settings`, `ui_read_asset_text_file`, `ui_refresh_project_assets`, `ui_delete_project_asset`, `ui_attach_asset`, `ui_detach_asset`.
- System/app: `ui_build_provenance`, `ui_scan_system_load`, `ui_kill_session_tree`, `ui_kill_all_agent_sessions`, `ui_set_window_vibrancy`, `ui_exit_app`.
- Mobile access: `mobile_access_fetch_devices`, `mobile_access_create_pairing_session`, `mobile_access_cancel_pairing_session`, `mobile_access_revoke_device`.

## Tested In The Latest Canvas-Notes Pass

Latest focused verification for canvas notes:

- `cargo test -p swarm-ui project_note_asset -- --nocapture`
  - Passed.
  - Proves `ui_create_project_note_asset` writes markdown under project `workspace/`.
  - Proves `ui_update_project_note_asset_content` rewrites the markdown file and updates the asset record.
- `cd apps/swarm-ui && bun test src/lib/graph.test.ts src/stores/projectAssets.test.ts`
  - Passed, 19 tests.
  - Proves project asset normalization/store helpers and graph support for app surfaces still work.
- `cd apps/swarm-ui && bun run check`
  - Passed, 0 Svelte errors/warnings.
- `cd apps/swarm-ui && bun run build`
  - Passed.
  - Warning only: existing large chunk/dynamic import warning.
- Playwright/Vite visual harness:
  - Entered Canvas.
  - Clicked the Note rail.
  - Saw a visible `Canvas Document` node.
  - Saw editable markdown textarea, `Saved`, `Open file`, and the file path footer.

Important limitation: the Playwright visual harness used mocked Tauri IPC for the
browser run. It proved the frontend operator flow and visible canvas surface,
not the native Tauri app clicking through to the real Rust command in one
end-to-end chain.

## Known Defects And Verification Gaps

### 1. Native Tauri click-through proof is not reliable enough

Observed during the canvas-notes pass:

- The native `swarm-ui` Tauri window launched.
- macOS allowed screenshots of the desktop.
- Synthetic click attempts against the native window did not reliably activate
  the intended UI controls.
- `System Events` assistive-access automation was blocked by macOS permissions.
- I therefore used Playwright/Vite with mocked Tauri IPC to prove the visible
  document surface.

Verdict: this is a verification defect. We cannot honestly say "an agent clicked
the native app, created a note, opened the note, and captured the result" until
the native app has a dependable agent-operable test path.

### 2. App screenshot contract is intentionally unsupported

`ui_capture_screenshot` currently reports that window screenshot capture is
unavailable in this runtime. That is better than pretending screenshots work,
but it means proof packs cannot yet include true native window screenshots by
default.

### 3. Browser-mode proof can lie about native behavior

Plain Vite/browser mode is good for layout, accessibility refs, text fitting,
and interaction with frontend state. It is not proof of:

- Tauri IPC behavior.
- Rust command registration.
- Native file picker behavior.
- Native window/webview behavior.
- PTY behavior.
- macOS app launch/open-file behavior.

### 4. Canvas note proof is split, not single-chain

What is proven:

- Rust file write/update semantics are real.
- The frontend note rail/document node is visible and usable in browser harness.

What still needs proof:

- Native Tauri app click: `Enter Canvas -> Note -> real ui_create_project_note_asset -> visible Canvas Document -> edit -> Save -> actual file contents changed -> Open file`.

## Required Next Testability Fixes

To make this app truly agent-testable the way the product wants, add these:

1. Add a native UI command for `create_canvas_note` that the CLI/MCP can queue
   into the running app and that drives the same frontend handler as the rail.
2. Add a native semantic snapshot command for the current canvas: visible nodes,
   document surfaces, buttons, text fields, selected project, and asset paths.
3. Add stable `data-testid` or accessible labels for note rail, note surface,
   Save, Open file, project bubbles, browser nodes, and terminal nodes.
4. Add a native screenshot path or a documented fallback that crops the active
   Tauri window after macOS permissions are granted.
5. Add a canvas-note e2e smoke command that returns:
   - markdown file path,
   - on-canvas node id,
   - semantic snapshot excerpt,
   - screenshot path if available,
   - file contents after Save.

Until those land, the honest proof vocabulary is:

- "Rust file path tested."
- "Frontend/browser visual tested."
- "Native app launched."
- "Native click-through not proven."

## Acceptance Bar For Canvas Notes

Canvas notes are not fully accepted until this exact workflow passes in native
Tauri:

1. Start `swarm-ui` from a fresh build.
2. Enter Canvas.
3. Click `Note`.
4. See a `Canvas Document` node without opening a hidden project record.
5. Confirm a `.md` file exists under the active project `workspace/`.
6. Type into the document textarea.
7. Click `Save`.
8. Confirm the `.md` file on disk contains the edited content.
9. Click `Open file`.
10. Confirm the OS opens the file or reveals a clear error.
11. Capture semantic proof and, when available, a native screenshot.

This workflow is the bar. Anything less must be reported as partial proof.
