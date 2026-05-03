# Overhaul Handoff Prompt

Use this for any agent joining the overhaul swarm.

## Registration

Use the swarm register tool with:

- `directory="/Users/mathewfrazier/Desktop/swarm-mcp-lab"`
- `scope="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul"`
- `label="provider:<provider> role:<planner|researcher|implementer|reviewer> name:<short-name>"`

Important: the directory must be an absolute path. Use `/Users/mathewfrazier/Desktop/swarm-mcp-lab`, not `Users/mathewfrazier/Desktop/swarm-mcp-lab`.

Then call:

1. `whoami`
2. `list_instances`
3. `poll_messages`
4. `list_tasks`
5. `kv_get("owner/planner")` if you are a planner
6. `kv_get("plan/latest")`

## Required Reading

Read these files before work:

- `docs/OVERHAUL_EXECUTION_STATUS.md`
- `docs/MAY_1ST_OVERHAUL_PLAN.md`
- `docs/MAY_1ST_EXECUTION_BOOTSTRAP.md`
- `docs/MAY_1ST_PLAN_ARCHIVE.md`
- `docs/OVERHAUL_AGENT_ASSIGNMENTS.md`
- `docs/OVERHAUL_ORCHESTRATOR_PROMPT.md` if you are the orchestrator planner
- `docs/superpowers/specs/2026-04-22-agentic-orchestration-os-master-spec.md`
- `docs/manual-qa/listener-health-reliability-sync.md`

Read the old phase plans only when you need implementation details from an archived phase. Do not resume old Phase 4/5/6/7 work as the active execution lane unless Mathew explicitly reopens it.

Archive status: the old phase-sequenced overhaul was closed on 2026-05-02. New agents should treat those phase docs as reference material only and execute the May 1st MVP bootstrap with the May 2 project-first UX correction folded in.

## Recommended First Team

- Planner / acting Majordomo: one terminal agent, preferably the most reliable planning agent for the current run.
- Builder A: Home and Project Cockpit UI.
- Builder B: Task Board and task-bound launch binding.
- Reviewer: Codex or another terminal agent focused on diffs, tests, and UI proof.

Do not create a large swarm until the Task Board can prove task ownership and listener status. More agents before that adds coordination noise.

## Operating Rules

- Claim only tasks matching your role and assigned files.
- Lock files before editing.
- Do not edit another builder's owned files without planner approval.
- Do not revert changes made by other agents.
- Report verification commands and results in task updates.
- Use `wait_for_activity` when idle.
- After launch, a healthy idle agent should eventually show `Listening` or `Polled` in swarm-ui. `Needs poll`, `Register needed`, or `Unverified` means the workflow may need a nudge before assigning more work to that node.
- If a subtask fails, create or request a fix task. Do not fail a parent phase unless the phase truly must stop.
- Do not approve every gated phase at once.

## Recommended First Planner Action

1. Confirm the May 1st authority docs: `docs/MAY_1ST_OVERHAUL_PLAN.md`, `docs/MAY_1ST_EXECUTION_BOOTSTRAP.md`, and `docs/MAY_1ST_PLAN_ARCHIVE.md`.
2. Run Slice 0 from the bootstrap: short installed-app or dev-surface smoke for existing Home, Project, Launch, Terminal, and Asset behavior.
3. Record which archived Phase 4/5/6 behavior is reusable for the May 1st MVP.
4. Execute Slice 1/2 next: Home simplification and Project Cockpit MVP.
5. Then execute Task Board MVP and task-bound launch binding.
6. Create review tasks after each slice and require visual proof before calling a slice complete.
