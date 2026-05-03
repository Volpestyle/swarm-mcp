# Overhaul Agent Assignments

## Recommended Provider Map

- Orchestrator Planner: Claude Code in terminal. Best fit for product vision, task decomposition, coordination, and drift control.
- Researcher Assistant: Codex in terminal. Best fit for fast file discovery, exact code references, collision checks, command lookup, and architecture answers.
- Builder A Launch/Productization: Codex in terminal. Best fit for Tauri config, launch profile plumbing, icon metadata, TypeScript/Rust verification, and app packaging.
- Builder B Agent Identity UX: Claude Code in terminal. Best fit for agent-card UX, copy, information architecture, and making nodes feel less terminal-oppressive.
- Builder C Project Spaces/Data: Codex in terminal. Best fit for stores, SQLite/Tauri commands, tests, containment semantics, and data model rigor.
- Builder D Visual Systems/Themes: Claude Code in terminal. Best fit for Encom Glass, DarkFolder Silhouette, startup hero, mood, spacing, and high-contrast visual language.
- Reviewer: Codex in terminal first. Best fit for strict verification, runtime-truth checks, file ownership discipline, and catching UI controls that imply behavior without implementing it.

## Orchestrator Planner

- Owns phase sequencing, task decomposition, dependency ordering, and merge order.
- Creates swarm tasks and assigns file ownership.
- Does not perform broad implementation edits unless unblocking.
- Keeps `plan/latest` current after major changes.
- Approves only the next phase or next slice, not the whole roadmap at once.
- Treats failed subtasks as fix-task triggers unless the whole phase truly must be abandoned.
- Sends discovery questions to the researcher instead of pausing builders.

## Researcher Assistant

- Owns repo archaeology and exact-answer support for the orchestrator.
- Finds files, functions, tests, commands, prior decisions, and collision risks.
- Maintains the current collision map for shared files.
- Does not edit code unless the planner explicitly assigns an implementation task.
- Answers with exact file paths, line references when useful, and concise evidence.
- Uses `wait_for_activity` when idle.

## Builder A — Launch/Productization

- Owns `apps/swarm-ui/src-tauri/tauri.conf.json`.
- Owns app icon assets and launch profile plumbing.
- Owns Phase 1 files unless planner reassigns them.
- Preferred provider: Codex.

## Builder B — Agent Identity

- Owns agent profile/domain model and agent card surfaces.
- Owns `apps/swarm-ui/src/nodes/*Agent*`, `apps/swarm-ui/src/lib/agentIdentity.ts`, and related tests.
- Must preserve existing listener-health node fields, header badges, and Inspector details while converting nodes to agent-first cards.
- Preferred provider: Claude Code.

## Builder C — Project Spaces

- Owns project models, boundaries, project page, and project assets.
- Owns `apps/swarm-ui/src/stores/projects.ts`, `apps/swarm-ui/src/canvas/ProjectBoundary.svelte`, and project Tauri commands.
- Preferred provider: Codex.

## Builder D — Visual Systems

- Owns startup hero, theme split, DarkFolder object language, and visual QA.
- Owns theme files and Home/startup visual surfaces after coordination with Builder A.
- Preferred provider: Claude Code.

## Reviewer

- Reviews merged slices for correctness, scope discipline, regressions, and verification evidence.
- Confirms that behavior-facing UI controls map to real runtime behavior.
- Preferred provider: Codex.

## Collision Rules

- Parallelize independent files and new components.
- Serialize shared spine files through the orchestrator or one named integrator.
- Big collision files: `apps/swarm-ui/src/lib/types.ts`, `apps/swarm-ui/src/App.svelte`, `apps/swarm-ui/src/panels/StartupHome.svelte`, `apps/swarm-ui/src/panels/ProjectPage.svelte`, `apps/swarm-ui/src-tauri/src/writes.rs`, `apps/swarm-ui/src-tauri/src/ui_commands.rs`, `apps/swarm-ui/src-tauri/src/main.rs`, `apps/swarm-ui/src/lib/themeProfiles.ts`, and `apps/swarm-ui/src/app.css`.
- Do not let multiple builders edit a big collision file in parallel.
- Do not fail a parent phase task just because one builder hits red tests. Create a fix task and keep downstream phase gates intact.
- Current active work is the May 1st MVP bootstrap with the May 2 project-first UX correction folded in: Slice 0 smoke, Slice 1/2 Home plus Project Cockpit, then Slice 3/4 Task Board plus task-bound launch. The old Phase 4/5/6/7 sequence is archived and should not be resumed unless Mathew explicitly reopens a phase.
- Recommended active team: planner or acting Majordomo, researcher, Builder A for Home/Project Cockpit, Builder B for Task Board/task-bound launch, and reviewer. Keep visual/theme-only Builder D work deferred unless it directly supports the MVP loop.

## Coordination Rules

- Use absolute paths. The startup location must be `/Users/mathewfrazier/Desktop/swarm-mcp-lab`, not `Users/mathewfrazier/Desktop/swarm-mcp-lab`.
- Lock files before editing.
- Do not edit another builder's owned files without planner approval.
- Do not revert another agent's changes.
- Report verification commands and results in task updates.
- Use `wait_for_activity` when idle.
- Treat listener-health badges as operational signals: `Listening`, `Polled`, or `Working` are healthy; `Needs poll`, `Register needed`, `Scope mismatch`, or `Unverified` require investigation before assuming the node is ready.
