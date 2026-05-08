# Swarm

Portable coordination rules for any MCP-capable coding agent.

Tool names are namespaced by the host. Depending on the client you may see `swarm_register`, `mcp__swarm__register`, or similar variants. Use whichever form your host exposes.

---

## Register early

At the start of every session, call `register` before using any other swarm tool.

- `directory`: your current project directory (required)
- `scope`: omit unless you want multiple directories or worktrees to share one swarm; do not use it to split frontend/backend inside one repo
- `file_root`: omit unless working in a disposable worktree that should share locks and annotations with a stable checkout
- `label`: optional, but prefer machine-readable tokens like `provider:codex-cli role:planner team:frontend`

No `role:` token means the session is a generalist.

If your host resets context or you start a fresh window, call `register` again and rehydrate from `poll_messages`, `list_tasks`, `list_instances`, and any role-specific KV keys you rely on. The shared database is the durable source of truth.

---

## Check for pending work

Immediately after registering, call `poll_messages`, `list_tasks`, and `list_instances`.

- If you have unread messages, read and act on them before starting new work.
- If there are tasks assigned to you (by instance ID or matching your `role:`), claim and prioritize them. **Prefer the highest-priority task**.
- Skip tasks with `blocked` status — they are waiting on dependencies and will become `open` automatically.
- If you see open `review` tasks and you handle reviews, claim them before starting implementation work.
- If nothing is waiting, proceed with your own task.

Check `poll_messages` and `list_tasks` periodically, not just at startup.

---

## React to what you find

When you receive a task via `request_task`:

- `claim_task` immediately so no other session takes it
- Call `update_task` to `in_progress` when you start
- Call `update_task` to `done` with a structured result when finished (see below), or `failed` with what went wrong
- If the task requires follow-up, create a new `request_task` (e.g. the implementer sends a `review` task back to the planner)

When you receive a direct message via `send_message`:

- Treat it as coordination, not a formal task. Respond with `send_message` or take action.

When you see a `broadcast`:

- Use it for awareness. No response is required unless the content affects your current work.
- If the broadcast contains `[signal:complete]`, the planner is signaling all work is done — finish current work and deregister.

---

## Structured results

When completing a task, prefer a JSON `result`:

```json
{
  "files_changed": ["src/foo.ts"],
  "test_status": "pass",
  "summary": "What was done and why."
}
```

Fields:
- `files_changed`: array of file paths you modified
- `test_status`: `"pass"`, `"fail"`, or `"skipped"`
- `summary`: short description of what you did

Fall back to a plain string if you cannot produce structured output.

---

## Check before editing

Before editing a file, call `check_file` for that path. If another session has a lock or warning, avoid overlap and coordinate first.

---

## Lock while editing

When you begin editing a file, call `lock_file` with a short reason.

Unlock it with `unlock_file` as soon as you are done. Keep locks short and specific.

---

## Delegate clearly

Use `request_task` for review, implementation, fix, test, or research handoffs.

Include a short title, a useful description, and relevant `files` when possible. Set `assignee` only when you want a specific active session to take it. Set `priority` to control execution order (higher = more urgent).

Use `depends_on` to express task ordering — a dependent task stays `blocked` until all its dependencies reach `done`. If a dependency fails, downstream tasks are auto-cancelled.

Use explicit `review` tasks for normal code review handoff. Reserve `approval_required` for true approval gates such as production deploys or human sign-off checkpoints.

When choosing who to delegate to, inspect `list_instances` labels:

- Prefer a session with a matching `role:` token (e.g. `role:reviewer` for review work)
- If the swarm uses `team:` labels, prefer a same-team specialist
- Fall back to any matching specialist, then to a generalist
- If multiple planners are active, coordinate ownership before creating tasks in shared areas — use `send_message` and `kv_set` to divide domains
- For planner sessions, check `kv_get("owner/planner")` to see which planner currently owns the swarm-wide planner role

---

## Share context

Use `annotate` to leave findings, warnings, notes, bugs, or todos on files.

Use `broadcast` for short updates that help everyone stay in sync. Use `send_message` for direct coordination with one session.

---

## Track shared state

Use `kv_set` and `kv_get` for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

### Progress heartbeats

While working on a task, periodically update your status:

- Key: `progress/<your-instance-id>`
- Value: short summary of current activity and progress (e.g. `"implementing auth middleware, ~50% done"`)

This lets planners and other agents check on you with `kv_list("progress/")` without interrupting your work. Clear your progress key when you finish a task or go idle.

---

## Stay autonomous

After your initial registration and inspection, **do not wait for user prompting between tasks**. Use `wait_for_activity` to stay in an active loop:

1. After completing a task or when you have nothing to do, call `wait_for_activity`.
2. When it returns with changes, act on them immediately:
   - **new_messages**: Read and respond. Messages prefixed with `[auto]` are system notifications about task assignments or completions.
   - **task_updates**: Claim open tasks (highest priority first) or review completed ones, depending on your role. Skip `blocked` tasks.
   - **kv_updates**: Check for plan changes or progress updates from other agents.
   - **instance_changes**: Adapt to agents joining or leaving.
3. If it returns with `timeout: true`, call `wait_for_activity` again — or check `list_tasks` for anything you may have missed.
4. Repeat until the work is done.

Task creation and completion automatically notify the relevant parties via message. You don't need to manually `send_message` to inform someone about a task you created for them or completed — but you can add extra context if helpful.

---

## Finish cleanly

When you complete assigned work:

1. `unlock_file` any files you locked
2. `update_task` with `done` and a structured result
3. If follow-up is needed, create a new `request_task` (don't reuse the old one)
4. `broadcast` a short summary if other sessions should know
5. If you are leaving the swarm entirely, call `deregister` to release your tasks and locks

If another instance appears stuck or stale, use `remove_instance` to force-remove it. This releases its tasks and locks and notifies the rest of the swarm.
