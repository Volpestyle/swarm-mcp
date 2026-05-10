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

Use this skill when the `swarm` MCP server is available and coordination with other agents is useful.

If swarm tools are not mounted, say so clearly. Normal workers should fall back to local work only when safe. Gateway/lead sessions should restore swarm tools, use a spawner surface, or ask the operator before doing medium/large implementation locally.

Role argument: `$role`.

If the user invoked this skill with a role argument, follow the matching role reference. If no role was provided, use the generalist flow and load role references only when choosing collaborators or accepting delegated work.

## Default Flow

1. Call `register`, unless a hook already did it.
2. Call `bootstrap` for `{instance, peers, unread_messages, tasks}`.
3. Handle unread messages before claiming work.
4. Claim the highest-priority open task that matches your role.
5. If editing and peers exist, call `lock_file`; skip locks when alone.
6. Coordinate through `request_task`, `dispatch` (gateway only), `send_message`, `prompt_peer`, `broadcast`, `annotate`, and KV.
7. Finish with one `update_task` using terminal status and a structured result.

For planner sessions, the server maintains `owner/planner` automatically. Check it with `kv_get` to see whether you currently own planner duties.

## Role Routing

- `planner`: load `references/planner.md` and register with `identity:<work|personal> role:planner`
- `implementer`: load `references/implementer.md` and register with `identity:<work|personal> role:implementer`
- `reviewer`: load `references/reviewer.md` and register with `identity:<work|personal> role:reviewer`
- `researcher`: load `references/researcher.md` and register with `identity:<work|personal> role:researcher`
- `generalist` or no role: register without a `role:` token unless the user specified one, then handle mixed work using the core workflow

When the role is unclear, do not invent one. Ask one short question or proceed as a generalist if the task is already actionable.

## Core Rules

- **Priority**: Tasks have an integer `priority` field (higher = more urgent). `list_tasks` returns tasks sorted by priority. Claim the highest-priority open task first.
- **Unread-message guard**: `claim_task` refuses to claim new open work while you have unread direct messages. Call `poll_messages` and handle corrections before retrying. Override only when intentionally ignoring those messages.
- **Dependencies**: Tasks can have a `depends_on` field (array of task IDs). A task with unmet dependencies starts as `blocked` and auto-transitions to `open` when all deps complete. If a dependency fails, downstream tasks are auto-cancelled.
- **Approval gates**: Tasks can be set to `approval_required` status. They remain gated until approved (transitions to `open`) or explicitly cancelled. Use this for true approval checkpoints, not routine code review.
- **Idempotency**: Tasks can have an `idempotency_key` field that prevents duplicate creation on retry.

## Wait Or Stop

Use `wait_for_activity` only when you are still responsible for swarm activity:

- You claimed work and are waiting on a dependency, review, lock release, or peer response.
- You are a planner/gateway monitoring delegated work.
- You are an idle specialist explicitly expected to stay available in this session.

Use a 30-60 second timeout. On timeout, re-check messages/tasks/KV once. Wait again only if you still own monitoring responsibility.

Do not wait forever just because the swarm exists. If you have no active task, no delegated work to monitor, and no instruction to stay warm, publish/complete your result, deregister, and stop. Peers can wake a live worker with `prompt_peer`, but durable delivery is always swarm messages/tasks.

## References

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

## Do Not

- Assume other sessions share your exact working directory unless `scope` and `file_root` make that true
- Invent role-routing behavior that is not visible from labels, messages, tasks, or instructions
- Hold file locks longer than needed
- Use `assignee` for a stale or unknown instance
- Confuse direct messages with task handoff; use `request_task` for structured delegated work
- Try to claim `blocked` tasks — they will become `open` automatically
- Shell out to the `swarm-mcp` CLI for normal coordination primitives from inside your agent loop — use the MCP tools, including `dispatch` for gateway task/spawn routing. Use the CLI bridge only from operator scripts, hooks, or gateway sessions where the MCP tools are unavailable.

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
- Use `wait_for_activity` as an idle optimization, not the delivery guarantee. Peers may wake you with a short prompt to call `poll_messages` or `bootstrap`.
- If you are acting as a planner, watch `owner/planner` on `kv_updates` so you can resume from `plan/latest` after failover
- Update your progress with `kv_set("progress/<your-instance-id>", ...)` while working on tasks so others can check on you without interrupting
- Messages prefixed with `[auto]` are system notifications (task assignments, completions, stale-agent recovery) — treat them like any other actionable message
- When you receive a `[signal:complete]` broadcast, the planner is signaling all work is done — finish current work, deregister, and stop
- In gateway/lead mode, no live worker is a spawn problem, not a native-subagent fallback. Use the MCP `dispatch` tool to create/reuse the swarm task, wake a matching live worker, or spawn through the configured Spawner backend (`herdr` in the current stack). If `dispatch` reports no spawner surface, ask the operator. Worker/generalist sessions do not spawn new workers; they request tracked work, message the planner/gateway, or continue locally when safe.

## CLI Fallback

Swarm coordination inside an agent loop should use MCP tools. The `dispatch` MCP tool is the first-class gateway path: it creates/reuses a task, wakes a live worker when one exists, or spawns through the configured Spawner backend when no worker is live. It is enforced server-side and restricted to gateway authority.

The CLI bridge remains for hooks, operator shells, and rare gateway fallback cases where the MCP tools are not mounted. When you must use it, resolve the command prefix in this order:

1. Use the exact `SWARM_MCP_BIN` value if set by the launcher.
2. Otherwise use `swarm-mcp` from `PATH`.
3. If neither works, use herdr directly if available, or ask the operator to start the worker.

Do not ask ordinary worker sessions to run `dispatch`, `ui spawn`, or raw workspace-backend pane/node creation. Spawn authority belongs to `mode:gateway` sessions and operator surfaces; non-gateway MCP callers should expect `dispatch` to reject them.

## Spawn Layout Doctrine

Gateway agents own worker layout decisions. Keep spawned agents readable for the operator; do not hide layout decisions in plugin code.

- **Workspace per swarm scope:** default to one workspace per git-root/scope. A second workspace for the same scope should be a deliberate operator-driven choice, not the default spawn path.
- **Aim for ≤3 panes per tab:** four or more panes usually makes individual agents unreadable. If the matching tab is at cap, prefer a new tab.
- **Aim for ≤6–8 tabs per workspace:** beyond that, the herdr sidebar starts hiding useful context. Consider a new workspace only when the operator has asked for that separation.
- **Group by role:** tabs labeled by role group (`implementers`, `reviewers`, `researchers`) are easier to scan than per-ticket sprawl. For one-off bursts, a spawn-batch tab label is also acceptable.
- **Adjust for the operator's surface:** a 4-pane tab may be fine on a large monitor and terrible from a phone.

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
