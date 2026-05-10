---
name: swarm-mcp
description: Join and coordinate through the swarm MCP server. Use when registering a Claude Code session, coordinating multiple agents, using swarm tasks/messages/KV/locks, or bootstrapping planner, implementer, reviewer, researcher, or generalist roles.
argument-hint: "[planner|implementer|reviewer|researcher|generalist]"
arguments: [role]
metadata:
  short-description: Coordinate work through swarm-mcp
  domain: agent-coordination
  role: workflow
  scope: workflow
---

# Swarm MCP

Use this skill when the `swarm` MCP server is available in the current session and the task benefits from multi-agent coordination.

This skill assumes the swarm tools are already mounted. If they are not present, say so clearly and fall back to local work or direct setup help only for normal worker sessions. Gateway/lead sessions may make trivial, low-risk edits locally, but should restore the swarm tools, use an available launcher/spawner surface, or ask the operator to start workers for medium or large implementation work.

Role argument: `$role`.

If the user invoked this skill with a role argument, follow the matching role reference. If no role was provided, use the generalist flow and load role references only when choosing collaborators or accepting delegated work.

## Start Here

1. Bootstrap into the swarm with `register`
2. Inspect the current swarm with `whoami`, `list_instances`, `poll_messages`, and `list_tasks`
3. For read-only inspection, call `get_file_context`; while editing, call `lock_file` — its response also includes peer annotations, so a separate check call is unnecessary. Skip locking entirely when alone in scope.
4. Delegate or coordinate with `request_task`, gateway-only `dispatch`, `send_message`, or `broadcast`
5. Leave durable context with `annotate` and small shared state with `kv_set`
6. Complete a task with a single `update_task` (terminal status). Normal edit locks release automatically; internal `/__swarm/` mutex locks are managed by their owning flow.

For planner sessions, the server maintains `owner/planner` automatically. Check it with `kv_get` to see whether you currently own planner duties.

## Role Routing

- `planner`: load `references/planner.md` and register with `identity:<work|personal> role:planner`
- `implementer`: load `references/implementer.md` and register with `identity:<work|personal> role:implementer`
- `reviewer`: load `references/reviewer.md` and register with `identity:<work|personal> role:reviewer`
- `researcher`: load `references/researcher.md` and register with `identity:<work|personal> role:researcher`
- `generalist` or no role: register without a `role:` token unless the user specified one, then handle mixed work using the core workflow

When the role is unclear, do not invent one. Ask one short question or proceed as a generalist if the task is already actionable.

## Task Features

- **Priority**: Tasks have an integer `priority` field (higher = more urgent). `list_tasks` returns tasks sorted by priority. Claim the highest-priority open task first.
- **Unread-message guard**: `claim_task` refuses to claim new open work while you have unread direct messages. Call `poll_messages` and handle corrections before retrying. Override only when intentionally ignoring those messages.
- **Dependencies**: Tasks can have a `depends_on` field (array of task IDs). A task with unmet dependencies starts as `blocked` and auto-transitions to `open` when all deps complete. If a dependency fails, downstream tasks are auto-cancelled.
- **Approval gates**: Tasks can be set to `approval_required` status. They remain gated until approved (transitions to `open`) or explicitly cancelled. Use this for true approval checkpoints, not routine code review.
- **Idempotency**: Tasks can have an `idempotency_key` field that prevents duplicate creation on retry.

## Load References As Needed

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Bootstrap and registration fields | `references/bootstrap.md` | You need to decide `directory`, `scope`, `file_root`, or `label` |
| Planner workflow | `references/planner.md` | The session should plan, delegate, monitor, or recover work |
| Implementer workflow | `references/implementer.md` | The session should claim tasks and edit code |
| Reviewer workflow | `references/reviewer.md` | The session should review completed work or inspect risk |
| Researcher workflow | `references/researcher.md` | The session should investigate and publish findings |
| KV and shared coordination state | `references/coordination.md` | You need to read/write `progress/`, `plan/`, `owner/`, queue, or handoff keys |
| Specialists, generalists, and team conventions | `references/roles-and-teams.md` | You need to route work by `role:` or `team:` labels |
| Identity, auth, and design-tool routing | `../../docs/identity-boundaries.md` | You need to route work across personal/work identities, Figma/Linear, or external Codex/OpenCode/Claude design workers |
| `swarm-mcp` CLI reference | `references/cli.md` | You are about to write or invoke a helper script, inspect swarm state from a plain terminal, or control `swarm-ui` through the CLI |

## Constraints

### Must Do

- Call `register` before using other swarm tools
- Use `whoami`, `list_instances`, `poll_messages`, and `list_tasks` early in the session. If `list_instances` returns only you, skip per-edit locking until peers join.
- Use `get_file_context` for read-only inspection, and call `lock_file` while editing when peers are present. Read the returned annotations as your pre-edit check.
- Use `update_task` once at task completion (terminal status). `claim_task` already moved the task to `in_progress`.
- Use explicit `review` tasks for normal review handoff
- Use `identity:work` or `identity:personal` to match the launcher/config root
- Treat `role:` labels as conventions, not hard schema
- Treat sessions without a `role:` label token as generalists
- Prefer the highest-priority open task when claiming work
- Include structured results (JSON with `files_changed`, `test_status`, `summary`) when completing tasks

### Must Not Do

- Assume other sessions share your exact working directory unless `scope` and `file_root` make that true
- Invent role-routing behavior that is not visible from labels, messages, tasks, or instructions
- Hold file locks longer than needed
- Use `assignee` for a stale or unknown instance
- Confuse direct messages with task handoff; use `request_task` for structured delegated work
- Try to claim `blocked` tasks — they will become `open` automatically
- Shell out to the `swarm-mcp` CLI for normal coordination primitives from inside your agent loop — use the MCP tools, including `dispatch` for gateway task/spawn routing. Use the CLI bridge only from operator scripts, hooks, or gateway sessions where the MCP tools are unavailable.

## Default Behavior

When the skill triggers, prefer this sequence unless the task clearly requires something else:

1. Verify the swarm tools exist
2. `register` — skip if a SessionStart hook already registered you (the `bootstrap` response will confirm via the `instance` field)
3. `bootstrap` — single atomic call returning `{instance, peers, unread_messages, tasks}`. Replaces the older `whoami` + `list_instances` + `poll_messages` + `list_tasks` sequence. Pass `mark_read: false` to peek messages without consuming them.
4. Summarize active specialists, open work, and collision risks before taking action
5. Act on any pending work (claim tasks, respond to messages)
6. Enter an autonomous idle loop using `wait_for_activity` when useful, but treat it as an optimization. Direct peer delivery is swarm message/task first, with `prompt_peer` wakeups when a specific peer should notice soon.

## Collaboration Heuristics

- Prefer `request_task` when the work should be tracked and completed
- Prefer explicit `review` tasks over passive review scans
- Prefer `send_message` for durable targeted notes that do not need task state
- Prefer `prompt_peer` when a specific peer should notice the message soon; it records the swarm message first, then best-effort wakes the workspace handle
- Prefer `broadcast` for short status updates that help everyone
- Prefer `annotate` for file-specific findings another agent may need later
- Prefer a matching `role:` token when choosing a specialist
- Prefer a matching `team:` token when the swarm uses soft teams
- Fall back to any matching specialist, then to a generalist, when the ideal collaborator is unavailable
- Use `wait_for_activity` as an idle optimization, not the delivery guarantee — peers may wake you with a short prompt to call `poll_messages` / `bootstrap`
- If you are acting as a planner, watch `owner/planner` on `kv_updates` so you can resume from `plan/latest` after failover
- Update your progress with `kv_set("progress/<your-instance-id>", ...)` while working on tasks so others can check on you without interrupting
- Messages prefixed with `[auto]` are system notifications (task assignments, completions, stale-agent recovery) — treat them like any other actionable message
- When you receive a `[signal:complete]` broadcast, the planner is signaling all work is done — finish current work, deregister, and stop
- In gateway/lead mode, no live worker is a spawn problem, not a native-subagent fallback. Use the MCP `dispatch` tool to create/reuse the swarm task, wake a matching live worker, or spawn through the configured Spawner backend (`herdr` in the current stack). If `dispatch` reports no spawner surface, ask the operator. Worker/generalist sessions do not spawn new workers; they request tracked work, message the planner/gateway, or continue locally when safe.

## CLI Bridge Fallback

Swarm coordination inside an agent loop should use MCP tools. The `dispatch` MCP tool is the first-class gateway path: it creates/reuses a task, wakes a live worker when one exists, or spawns through the configured Spawner backend when no worker is live. It is enforced server-side and restricted to gateway authority.

The CLI bridge remains for hooks, operator shells, and rare gateway fallback cases where the MCP tools are not mounted. When you must use it, resolve the command prefix in this order:

1. Use the exact `SWARM_MCP_BIN` value if set by the launcher.
2. Otherwise use `swarm-mcp` from `PATH`.
3. If neither works, use herdr directly if available, or ask the operator to start the worker.

Do not ask ordinary worker sessions to run `dispatch`, `ui spawn`, or raw workspace-backend pane/node creation. Spawn authority belongs to `mode:gateway` sessions and operator surfaces; non-gateway MCP callers should expect `dispatch` to reject them.

## Spawn Layout Doctrine

Gateway agents own worker layout decisions. Do not move layout selection into plugin code or a deterministic helper: choosing whether to split a pane, create a tab, or create a workspace is part of the same judgment call as choosing the worker role, task contract, and success criterion. The hard rule is human readability — keep density at a level the operator can scan and navigate from the current surface.

### Herdr surfaces available

- `herdr workspace list` — inspect workspaces in the current herdr instance
- `herdr tab list --workspace <id>` — inspect tabs in a workspace
- `herdr pane list` — inspect panes in current focus or by tab/workspace as supported by herdr
- `herdr workspace create`, `herdr tab create`, and `herdr pane split` — create new layout surfaces before spawning a worker

### Rules of thumb, not enforcement

- **Workspace per swarm scope:** default to one workspace per git-root/scope. A second workspace for the same scope should be a deliberate operator-driven choice, not the default spawn path.
- **Aim for ≤3 panes per tab:** four or more panes usually makes individual agents unreadable. If the matching tab is at cap, prefer a new tab.
- **Aim for ≤6–8 tabs per workspace:** beyond that, the herdr sidebar starts hiding useful context. Consider a new workspace only when the operator has asked for that separation.
- **Group by role:** tabs labeled by role group (`implementers`, `reviewers`, `researchers`) are easier to scan than per-ticket sprawl. For one-off bursts, a spawn-batch tab label is also acceptable.
- **Adjust for the operator's surface:** a 4-pane tab may be fine on a large monitor and terrible from a phone. Use judgment and make the decision visible when it matters.

### Labels and identity bridge

- **Pane title:** use the full swarm label when possible, e.g. `implementer-bob role:implementer scope:vuhlp`, so herdr maps onto `swarm list_instances`.
- **Tab label:** use the role group when role-grouped; otherwise use the spawn batch or ticket identifier.
- **Workspace label:** keep herdr's cwd-based default unless the operator explicitly overrides it.

### What not to do

- Don't write a deterministic layout helper in plugin code.
- Don't enforce the soft caps as hard config limits.
- Don't hide layout decisions from the gateway agent; it should reason about them visibly.

## Structured Results Convention

When completing a task, prefer a JSON `result`:

```json
{
  "files_changed": ["src/foo.ts"],
  "test_status": "pass",
  "summary": "What was done and why."
}
```

Fall back to a plain string if you cannot produce structured output.
