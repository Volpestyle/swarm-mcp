# May 1st Execution Bootstrap

Use this before implementing the May 1st overhaul.

## Purpose

This bootstrap converts `docs/MAY_1ST_OVERHAUL_PLAN.md` from a broad product plan into the first concrete build path.

The first release slice is:

**Open Project -> Project Cockpit -> Task Board -> assign selected tasks -> launch task-bound agents -> show listener/task status.**

May 2 UX correction is folded into this bootstrap. Do not create a separate May 2 overhaul. The happy path is project-first and canvas/task-first; directory, scope, channel, command, and launch-profile details are internal or advanced/debug concerns.

Do not start with Viewer, left rail, background agents, Terminal/Ghostty rescue, or Grand Architect / Majordomo automation. Those depend on the core loop.

## Happy-Path Product Model

User-facing:

- Project: where the user's work lives.
- Task: what the user wants done.
- Agent: who is doing it.
- Conversation: where updates and clarification happen.

Advanced/debug:

- Directory/project root.
- Internal channel/scope.
- Harness command, model/provider, trust posture, and launch profile.
- PTY/session/process details.

Saved agents are templates by default. They should launch into the current project/session unless explicitly pinned to a project or internal channel.

## Definitions

### Project Cockpit

A project-first page for any local folder. It replaces boundary-first behavior as the default user path.

Minimum content:

- project name and root
- current project/session health
- task board
- running/reconnectable agents
- recent activity
- quick actions: Start From Plan, Launch Selected, Resume Agents

Project boundaries can still exist on the canvas, but the user should not need to draw a boundary to start work.

Internal channel/scope may be shown as small diagnostic metadata, but it is not a primary user choice in Project Cockpit.

### Task Board

The main implementation surface for Stage 1/2.

Minimum row fields:

- checkbox/selection state
- title
- section
- status
- provider
- role
- assignee/agent binding
- listener state
- elapsed time
- last activity
- result summary

Minimum actions:

- add task
- import/paste plan into tasks
- multi-select
- set provider/role per selected task
- launch selected
- retry/reassign failed task

### Task-Bound Agent

An agent session launched for a specific task. The task id and agent id must be visible in app state.

Minimum contract:

- agent starts in the project cwd
- agent receives task title/description and current project context
- agent registers in the correct internal channel/scope automatically
- agent enters the normal `poll_messages` / `list_tasks` / `wait_for_activity` behavior
- task row shows project, listening/working/done/failed/stale state from real swarm data

### Grand Architect / Majordomo

This is not a feature to implement first.

For now, it is a named coordinator role and future protocol. It can later be backed by Codex in Terminal, Claude Code in Terminal, OpenClaw, Hermes Agent AI, or another configured harness.

Minimum definition for docs and prompts:

- **Grand Architect:** strategic planner for project architecture, task decomposition, and review routing.
- **Majordomo:** operational coordinator for live team state, stuck agents, role changes, handoffs, and session hygiene.

In early implementation, these can be the same saved-agent role preset. Do not build autonomous Majordomo automation until the Task Board loop works.

### Dynamic Role Evolution

This already exists as a behavior the user has observed, but it needs protocol and UI before being treated as a product feature.

Minimum protocol:

- role changes are proposed, not hidden
- proposals include source agent, target agent, old role, new role, reason, and approval state
- accepted changes update label/profile metadata
- changes are logged in activity
- agents receive the updated role context

Do not let agents silently change another agent's role in the MVP.

### Optional Team Worktrees

Worktrees are an isolation strategy, not the default.

Use shared swarm tasks, locks, notes, and annotations by default. Use worktrees only when:

- two teams must make conflicting file changes
- risky work should be isolated
- the user or approved coordinator chooses the strategy

MVP does not need team worktrees.

## Implementation Order

### Completion State - 2026-05-02

Slice 0 through Slice 8C are complete for the local dev surface. Slice 7D is complete for the native restart survivor/rebind/kill backbone. Slice 8D native background-control proof is accepted, with human-visible installed click/reopen and notifications tracked as follow-up.

Slice 0 smoke/reuse result:

- Home is reusable as the first operational entry surface after simplifying the primary actions.
- Project/Workspace Kit is reusable for project creation/opening and saved project space selection.
- Launch is reusable as the Advanced Launch secondary surface; it should not be the normal happy-path entry.
- Agents is reusable as the May 1st status and plan surface.
- Agents -> Live Tasks now includes a May 1st Kanban above the runtime SQLite task board.
- Media/Assets entry points are reusable as project-context lanes, but deeper Phase 5 visual-analysis acceptance remains separate QA debt.
- Browser-mode smoke reports expected Tauri API warnings outside the Tauri shell. Native picker, PTY, launcher, and installed-app behavior still need Tauri proof when those paths become the active implementation target.

Slice 1 product result:

- Home first viewport shows `Open Project`, `Start From Plan`, and `Resume Running Agents`.
- `Open Project` uses the native directory picker when Tauri is available, then creates/opens a project and routes to Project Cockpit.
- Browser/dev fallback opens the existing project creation flow instead of failing silently.
- `Start From Plan` routes to the May 1st plan/status surface.
- `Resume Running Agents` enters the canvas when sessions exist and routes to recovery when there are none.
- `Advanced Launch` remains reachable, but raw directory/scope/channel/launch-profile details are no longer the happy-path first decision.

Slice 2 product result:

- Opening a saved project now lands in a `Project Cockpit` band at the top of the project page.
- The cockpit shows project root, task source, and internal channel only as diagnostic metadata.
- The cockpit has project-linked `Task Board` lanes for Ready, Claimed, Active, and Closed rows.
- The cockpit summarizes attached/running/reconnectable agents and saved browser references.
- The cockpit summarizes recent activity from project tasks, attached agents, and audit events.
- Boundary sync remains optional; the useful workspace exists as soon as the folder is opened.

Slice 3 product result:

- The project page has an interactive `Task Board` surface below the cockpit.
- A pasted plan with headings and bullets becomes grouped, editable task rows.
- Rows expose title, description, section, status, provider, role, assignee/listener metadata, and result summary fields.
- Multi-select works across rows, with bulk provider/role assignment.
- A selected-task action bar shows the selected count and a clear `Launch N` action without overlapping task rows.

Slice 4 product result:

- `Launch N` now routes selected task rows through the existing `spawnShell` contract.
- Rows launch through Codex, Claude, or opencode provider paths; `Local shell` is blocked for task-bound launch because it cannot adopt a swarm identity.
- Task-bound launch labels include project id, task id, task title, source, and Slice 4 tokens.
- The task-bound bootstrap includes project root, internal channel, row title, section, status, provider/role, description, and files.
- Launched rows show agent id, PTY id, listener state, last activity, status, and result summary.

Verification:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui
bun run check
bun run build
bunx tauri build --debug --no-bundle
```

`bun run check`, `bun run build`, and `bunx tauri build --debug --no-bundle` passed again after Slice 4 on 2026-05-02. `bun run build` emitted only the existing Vite chunk-size warning. Browser smoke verified the task-board launch path with mocked Tauri `spawn_shell`; real native click-through with actual agent processes remains the first Slice 5 smoke item.

### Slice 0: Baseline And Existing UI Smoke

Goal:

Know which old surfaces are usable before editing.

Do:

1. Run focused installed-app smoke on Home, Project, Launch, Terminal, and Asset surfaces.
2. Record what is reusable for the May 1st loop.
3. Record what is broken enough to ignore or replace.

Commands:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
git status --short
cd apps/swarm-ui && bun run check
```

Visual path:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui
bun run dev -- --host 127.0.0.1
```

Use Tauri/dev app only when verifying native IPC, PTY, launcher, or installed-app behavior.

### Slice 1: Authority And Home Simplification

Goal:

The app starts with a clear choice instead of old phase clutter.

Build:

- Home primary actions:
  - Open Project
  - Start From Plan
  - Resume Running Agents
- Move advanced launch/profile/config controls behind a secondary path.
- Hide raw directory/scope/channel decisions from the first-run path.
- Route selected/opened project into Project Cockpit.

Proof:

- New user can find Open Project and Start From Plan immediately.
- Existing launch/profile behavior still works from the secondary path.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Installed-app/native proof for picker, PTY, launcher, and Dock bundle behavior is deferred until those native paths are touched by Slice 3/4 or a dedicated native smoke pass.

### Slice 2: Project Cockpit MVP

Goal:

Opening any folder lands in a useful project workspace.

Build:

- Project summary card/section.
- Task Board placeholder connected to project.
- Running/reconnectable agents summary.
- Recent activity summary.
- "Project context, not sandbox" copy only where needed.

Proof:

- Open a repo and see project root, tasks, agents, and activity without drawing a boundary. Internal channel/scope is available only as diagnostic metadata.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Browser smoke with a fixture project confirmed `Project Cockpit`, `Task Board`, `Agents`, and `Recent Activity` render on the project page.

### Slice 3: Task Board MVP

Goal:

Tasks become the main launch surface.

Build:

- Add/edit tasks.
- Paste plan into task rows.
- Section grouping.
- Multi-select.
- Provider/role assignment fields.
- Sticky selected-task action bar.

Proof:

- Paste the north-star plan text and turn it into editable tasks.
- Select three tasks and see a clear "Launch 3" action.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Browser smoke with a fixture project pasted three task bullets, imported three editable rows, selected them, and confirmed `Launch 3` was visible.

### Slice 4: Launch Selected Task-Bound Agents

Goal:

Launch selected tasks into real task-bound agent sessions.

Build:

- Use the existing `spawnShell` path with Codex, Claude, or opencode providers.
- Bind task id, agent id, project id/root, internal channel/scope, provider, role, and launch command.
- Show task-bound tile placement on canvas.
- Show basic listener/task status in rows.

Proof:

- Launch three selected tasks.
- Each task row shows assigned provider/role, live listener state, elapsed time, last activity, task result, agent id, and PTY id.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Browser smoke with a fixture project verified three mocked Tauri `spawn_shell` launches, three unique `task:` label tokens, Codex/implementer provider-role payloads, shared project scope, and row-level agent/PTY ids.
- Tauri debug build passed. Real native click-through with actual agent processes moves to Slice 5.

### Slice 5: Review And Regression Pass

Goal:

Make the first loop safe before adding new surfaces.

Build/fix:

- Task Board `Capture proof pack` button that writes a `swarm-ui-proof-pack` JSON artifact with review note, row state, agent state, recent activity, semantic UI evidence, scroll containers, theme variables, and explicit screenshot status.
- `swarm-mcp ui proof-pack` CLI sidecar for the same artifact family when driving the UI command worker from shell.
- broken text fit
- confusing launch copy
- stale task/agent state
- missing retry/reassign affordance
- any path where an agent launches without clear project/task identity
- any happy-path surface that asks the user to reason about scope/channel before they can start work
- seed the AI Visual QA Pack as a sidecar if visual proof is slowing review:
  - semantic snapshot: DOM/accessibility tree, bounds, text, theme variables, and scroll containers
  - targeted element screenshots for menus, modals, panels, task rows, and agent tiles
  - scroll-container top/middle/bottom passes for lower-page and nested-panel visibility
  - simple motion frame sampling for hover, glow, edge-pulse, and menu-transition states

Proof:

- Run focused tests.
- Run installed-app or Tauri smoke for the full MVP path.
- Capture at least one structured visual evidence pack for the task-board-to-agent loop. If native screenshot capture is unavailable, the artifact must say so and still include semantic UI evidence.
- Queue `swarm-mcp ui proof-pack --wait 0 --json` and confirm the UI worker recognizes the command family.
- Update manual QA with pass/fail cues.

Status:

- Proof-pack v1 is complete on the local dev surface as of 2026-05-02.
- The Project Task Board now has `Capture proof pack`; it writes a `swarm-ui-proof-pack` artifact through the new `ui_write_proof_pack` Tauri command.
- The CLI sidecar `swarm-mcp ui proof-pack` queues `ui.proof-pack` for the UI worker and writes an artifact that warns when DOM evidence is unavailable from shell-only capture.
- Browser smoke with a fixture project verified normal clicks from Home -> saved project -> Task Board -> import three rows -> `Launch 3` -> `Capture proof pack`.
- The smoke also caught and fixed a Home overlay regression: opening a saved project now exits Home before the Project Page needs clicks.
- Slice 5B native smoke passed on 2026-05-02: native `swarm-ui` claimed queued commands, spawned Codex PTY `241bb99d-66fe-404d-b24c-c8200ca5434a`, adopted instance `10c6efab-88a0-4a6b-b3a2-a229d5ef0402` with pid `52276`, broadcast `[standby] slice5b-native-script-1`, entered `wait_for_activity`, and wrote proof artifact `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777718803198.json`.
- Slice 5C native click-through was attempted on 2026-05-02. Native screenshot capture works, but automated clicks were blocked by macOS Accessibility: System Events returned `-25211`, and the Clawd Cursor fallback opened Accessibility settings with `Codex` disabled. Full human-visible Project Task Board native click-through is an end-of-overhaul revisit after enabling Accessibility for the active desktop controller or running the checklist manually.
- Slice 5C was retried later on 2026-05-02 and still failed at the same Assistive Access click step. Slice 5D is complete for the local dev surface: Task Board rows now derive stale launch state from live instance data, expose row-level `Retry`, `Reassign`, and `Reset`, and write computed stale/failed listener truth into proof-pack rows.
- Slice 5E acceptance sweep is complete on 2026-05-02. The native bundle rebuild and screenshot path passed; the 5C click path was retried and sidelined after the same macOS Assistive Access/TCC blocker (`-1719` on the latest attempt). Browser visual proof covered Home -> Workspace Kit -> saved project -> Task Board -> import three rows -> Launch 3 -> Retry -> Capture proof pack -> Reassign, with screenshots under `output/playwright/may-1st-slice-5e/`.
- Slice 5E proof evidence: 3 Task Board rows, 3 `Retry` / 3 `Reassign` / 3 `Reset` buttons, stale missing-agent row copy, 4 mocked `spawn_shell` calls, proof-pack `rowCount: 3`, `launchedRows: 3`, `taskBoundRows: 3`, `screenshot-unavailable`, semantic snapshot count 80, and scroll-container count 2. The visual sweep also caught and fixed the Task Board action-bar overlap.
- Slice 5C is no longer blocking the next product slice. Circle back near the end of the overhaul to rethink native click automation after macOS Accessibility for the active desktop controller is enabled or replaced with a different trusted driver.

### Slice 6: Review/Ship Surface

Goal:

Turn parallel agent output into understandable engineering output before commit/push.

Build:

- Project Page `Review / Ship` section.
- Changed/review files grouped by task, agent, and lock evidence when available.
- Commit-message suggestions generated from task titles, result summaries, reported files, tests, and unresolved risks.
- Copyable reviewer task prompt and direct reviewer-agent handoff for online reviewer/opencode agents attached to the project.
- Task result summaries, unresolved risks, and explicit no-auto-commit posture.

Proof:

- Open a saved project with completed or failed task rows.
- See `Review / Ship`, changed files, task result summaries, unresolved risks, and suggested commit text.
- Copy the commit message or review prompt.
- Send the review handoff to an online reviewer/opencode project agent when present.

Status:

- Complete on the local dev surface as of 2026-05-02.
- `apps/swarm-ui/src/lib/reviewShip.ts` builds the Review/Ship summary from project tasks, attached agents, and locks.
- Focused helper tests, Svelte check, and production UI build passed.
- Browser visual smoke covers desktop and narrow Review/Ship layouts; native commit/push remains explicit and manual.

### Slice 7A: Stale Row Reconciliation

Goal:

Make cleanup truth immediate when instance rows disappear outside the normal UI path or were already removed by the backend.

Build:

- Tested local reconciliation helper for removed instance rows.
- Drop removed instances from the Svelte store immediately after deregister, force-remove, kill, kill-all, and stale sweep paths.
- Mirror backend deregister cleanup locally for lock rows, queued recipient messages, and claimed/in-progress task assignments.
- Treat `instance not found` cleanup races as success for the visible UI row.
- Status-bar `kill all` passes visible instance ids so phantom active rows can be reconciled when the backend reports no protected skipped targets.

Proof:

- Remove or kill a visible row that the backend has already deleted.
- Active/stale/offline counts update immediately without Cmd+R.
- Claimed/in-progress tasks assigned to the removed instance return to `open` locally while waiting for the next DB snapshot.
- Locks and queued recipient messages for that instance vanish from the UI.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Focused reconciliation tests, PTY-catalog tests, Svelte check, and production UI build passed.
- This does not revisit Slice 5C native click automation; that remains an end-of-overhaul Accessibility/TCC item.

### Slice 7B: Launch Preflight Diagnostics

Goal:

Block obvious launch failures before the app opens a terminal and leaves the user staring at an unhelpful shell.

Build:

- Add a shared launch-command preflight helper for parsing the real executable from saved commands, aliases, env prefixes, and wrapper commands.
- Add a Tauri `ui_preflight_launch_command` IPC command that checks the command through the user's login shell and reports shell, PATH preview, executable resolution, diagnostics, warnings, and hard blocker text.
- Run preflight before Advanced Launch, saved Agent Profile launch, Team Launch, Task Board row launch, and the shared `spawnShell` contract.
- Surface Task Board row preflight state as `preflighting`, `preflight ok`, `preflight full access`, or `preflight blocked` before spawning.

Proof:

- Try a saved command like `definitely-not-swarm-ui-command-xyz`; launch is blocked before a PTY is spawned.
- Try `codex`, `claude`, `opencode`, `flux`, or `flux9`; preflight reports the login-shell resolution when available.
- Task Board row launch failures show row-level launch details instead of only a global failure count.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Focused TypeScript launch-preflight tests, focused Tauri launch-preflight tests, Svelte check, production UI build, and Tauri debug no-bundle build passed.

### Slice 7C: Command Trust Posture Visibility

Goal:

Make dangerous/full-access launch posture visible at the launch decision point instead of hiding it inside a friendly alias.

Build:

- Classify `flux`, `flux9`, dangerous bypass flags, skip-permission flags, and no-sandbox style commands as full-access posture.
- Add `Preflight` and `Trust posture` lines to the Advanced Launch review.
- Add full-access warnings to Advanced Launch and Team Launch reviews.
- Keep Project Task Board launch modal-free on the happy path while still recording `preflight full access` or a hard blocker on each row.

Proof:

- A `flux9`/Codex launch shows full-access posture in preflight review.
- A Task Board row using a full-access alias shows `preflight full access` before it spawns.
- A mismatched command/provider pair warns before Advanced Launch proceeds.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Native installed-app click-through remains tied to the existing Slice 5C Accessibility/TCC revisit, not to launch-preflight plumbing.

### Slice 7D: App-Restart Survivor And Rescue Loop

Goal:

If `swarm-ui` is killed or crashes while agents are still running, the agents should survive only when they have an explicit owner/purpose/policy, and the next app launch should surface them again without making the user hunt through terminals or process lists.

Build:

- Launch one bounded task/background agent from `swarm-ui`, then kill or quit `swarm-ui` while the agent is idle in `wait_for_activity`.
- Verify the agent process and swarm identity survive the UI exit without creating duplicate agents or losing project/task/scope labels.
- Relaunch `swarm-ui` and show the survivor prominently in Resume Center / running agents with status, project, purpose, timeout/idle policy, and cleanup controls.
- Provide a visible rescue path when direct PTY attach is unavailable: open in Terminal, open in Ghostty, copy attach/resume command, suspend, or kill.
- Confirm workspace switching, stale cleanup, and orphan cleanup do not hide or incorrectly delete the survivor.

Proof:

- After killing `swarm-ui`, SQLite and process evidence show the agent still alive with the same instance id, scope, cwd, label, and pid.
- After relaunch, the app surfaces the survivor without manual DB/process hunting and offers resume/rescue/suspend/kill actions.
- Kill cleanup removes the survivor row and process without leaving orphan PTYs or phantom active counts.
- Any TCC-blocked click proof remains called out honestly instead of marked complete.

Status:

- Complete for the native app-restart survivor/rebind/kill backbone as of 2026-05-02.
- Command `#28` spawned survivor instance `f912ba8f-53ee-4fd9-8dbc-743d8b2b1436` with PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`; command `#29` launched the guarded standby Codex prompt.
- Event `#966` adopted MCP pid `7158`, and event `#967` shows the survivor waiting.
- Killing only `swarm-ui` pid `6685` left the same instance row and pid `7158` alive; relaunching `swarm-ui` as pid `8202` rehydrated the binding.
- Command `#31` addressed the survivor by instance id after relaunch, closed PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`, deregistered the instance, and terminated pid `7158`.
- Human-visible installed-app screenshot/click proof remains tied to the Slice 5C Accessibility/TCC revisit.

### Slice 8A: Post-Session Improvement Review

Goal:

Capture user feedback at the moment of friction and turn it into project context.

Build:

- Add a Project Page `Post-Session Improvement` section with Worked, Confusing, Broke/Unreliable, Improve Next, and follow-up prompt fields.
- Save the review as a project-local note asset with current task and agent state.
- Optionally create an editable Task Board improvement row from the review.

Proof:

- Survey-only save works without launching any agent.
- Created notes include current project, root, internal channel, task counts, agent counts, follow-up prompt, and safety posture.
- Optional task creation adds a `Post-session improvements` row in the Project Task Board.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Focused `postSessionImprovement` tests, Svelte check, production UI build, and browser visual smoke passed.

### Slice 8B: Bounded Background Improvement Launch

Goal:

Allow opt-in background improvement work without creating mystery autonomous work.

Build:

- Require explicit background-work opt-in plus prompt, cwd, internal channel/scope, provider, role, trust posture, timeout, and idle policy.
- Launch through the existing `spawnShell` path with `owner:background-work`, project, run id, timeout, trust, and Slice 8 label tokens.
- Use in-app confirmation before launching; full-access posture makes the confirmation dangerous/red.
- Bootstrap the agent with hard guardrails against commit, push, deletion, history rewrite, destructive cleanup, and unbounded work.

Proof:

- Launch validation blocks empty prompt, missing cwd/scope, missing idle policy, or timeout outside 15-480 minutes.
- Background run prompt includes the project, policy, feedback, and reporting/stop rules.
- The launched task row records the background run id, instance/PTY id when available, and review note id.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Focused `postSessionImprovement` tests, Svelte check, production UI build, and browser visual smoke passed.

### Slice 8C: Background Resume Center

Goal:

Make background work visible and controllable from the project surface that launched it.

Build:

- Derive project-linked background runs from live agent labels, scope, and directory.
- Show status, provider, role, timeout, and scope in a Project Page Resume Center.
- Add `Suspend` and `Kill` controls.
- `Suspend` sends a direct operator message asking the agent to report status and enter `wait_for_activity`.
- `Kill` uses the destructive kill/deregister path behind an in-app confirmation.

Proof:

- Background runs with `owner:background-work` and matching project/scope/directory appear in Resume Center.
- `Suspend` sends a direct control message without killing the process.
- `Kill` calls the real kill/deregister store path, not a stale-row-only remove.

Status:

- Complete on the local dev surface as of 2026-05-02.
- Focused `postSessionImprovement` tests, Svelte check, production UI build, and browser visual smoke passed.

### Slice 8D: Background Work Acceptance And Notifier Follow-Up

Goal:

Prove the whole post-session/background-work loop in the installed app and decide what needs enforcement beyond prompt policy.

Build:

- Run installed-app manual QA: save review, create task, launch bounded background agent, suspend it, kill it, close/reopen, and verify Resume Center state.
- Decide whether timeout/idle policy remains prompt-level for MVP or becomes an app-enforced timer/notification path.
- If native notifications land, keep them scoped to explicit background run status: completed, failed, approval needed, stale, or timed out.

Proof:

- Installed-app screenshots and DB/process evidence agree with Resume Center state.
- No hidden commit/push/delete behavior and no unbounded background work.
- Any notifier/timer enforcement gap is either implemented or documented as post-MVP follow-up.

Status:

- Native background-control loop accepted on 2026-05-02.
- Native worker commands proved bounded launch, adoption, suspend-message delivery through `wait_for_activity`, and corrected kill/deregister cleanup.
- Timeout and idle policy stay prompt-level for MVP. Native timers/notifications are post-MVP follow-up and must only cover explicit background statuses: completed, failed, approval needed, stale, or timed out.
- Follow-up remains for human-visible installed click-through: save review, create task, close/reopen, and Resume Center screenshot truth.

## Swarm Usage During Implementation

Use a small swarm only.

Recommended first team:

- Planner / acting Majordomo: one terminal agent, preferably the most reliable planning agent.
- Builder A: Home + Project Cockpit UI.
- Builder B: Task Board + launch binding.
- Reviewer: checks diffs, tests, and UI proof.

Do not use a large swarm until the Task Board can prove task ownership and listener status. More agents before that creates coordination noise.

Rules:

- Every builder owns a file set before editing.
- Every builder locks files before editing.
- Builder A and Builder B must not both edit the same Svelte store or root component without planner sync.
- Reviewer should run focused tests and inspect UI behavior, not rewrite architecture.
- Use `wait_for_activity` when idle.

## Testing Policy

Fast local checks during slices:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui
bun run check
```

Focused tests when touching stores/helpers:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/stores/<test-file>.test.ts apps/swarm-ui/src/lib/<test-file>.test.ts
```

Root check before calling a slice complete:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun run check
```

Visual proof:

- Use Vite/browser for layout, text fit, navigation, and basic click paths.
- Use `bunx tauri dev` or debug build for PTY, launch, IPC, app quit, notifications, file dialogs, and daemon/session behavior.
- Prefer structured visual evidence over a single broad screenshot: pair screenshots with DOM/semantic snapshots, capture scroll containers explicitly, and use targeted element captures for theme-sensitive surfaces.

No slice is done from compile alone.

## Explicit Deferrals

Do not implement these before the Slice 5 safety pass proves the first loop:

- autonomous Grand Architect / Majordomo behavior
- background improvement agents
- Terminal/Ghostty rescue
- full Viewer
- professional left rail/friends presence
- optional team worktrees
- protocol views
- theme overhauls

They can be designed as follow-ups, but the first shipped value is task-board-to-agent execution.
