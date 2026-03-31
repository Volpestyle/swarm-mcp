# Swarm

Portable coordination rules for any MCP-capable coding agent.

Tool names are namespaced by the host. Depending on the client you may see `swarm_register`, `mcp__swarm__register`, or similar variants. Use whichever form your host exposes.

---

## Register early

At the start of every session, call `register` before using any other swarm tool.

- `directory`: your current project directory (required)
- `scope`: omit unless you want multiple directories to share one swarm
- `file_root`: omit unless working in a disposable worktree that should share locks and annotations with a stable checkout
- `label`: optional, but prefer machine-readable tokens like `provider:codex-cli role:planner team:frontend`

No `role:` token means the session is a generalist.

---

## Check for pending work

Immediately after registering, call `poll_messages`, `list_tasks`, and `list_instances`.

- If you have unread messages, read and act on them before starting new work.
- If there are tasks assigned to you (by instance ID or matching your `role:`), claim and prioritize them.
- If you see open `review` tasks and you handle reviews, claim them before starting implementation work.
- If nothing is waiting, proceed with your own task.

Check `poll_messages` and `list_tasks` periodically, not just at startup.

---

## React to what you find

When you receive a task via `request_task`:

- `claim_task` immediately so no other session takes it
- Call `update_task` to `in_progress` when you start
- Call `update_task` to `done` with a short `result` when finished, or `failed` with what went wrong
- If the task requires follow-up, create a new `request_task` (e.g. the implementer sends a `review` task back to the planner)

When you receive a direct message via `send_message`:

- Treat it as coordination, not a formal task. Respond with `send_message` or take action.

When you see a `broadcast`:

- Use it for awareness. No response is required unless the content affects your current work.

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

Include a short title, a useful description, and relevant `files` when possible. Set `assignee` only when you want a specific active session to take it.

When choosing who to delegate to, inspect `list_instances` labels:

- Prefer a session with a matching `role:` token (e.g. `role:reviewer` for review work)
- If the swarm uses `team:` labels, prefer a same-team specialist
- Fall back to any matching specialist, then to a generalist

---

## Share context

Use `annotate` to leave findings, warnings, notes, bugs, or todos on files.

Use `broadcast` for short updates that help everyone stay in sync. Use `send_message` for direct coordination with one session.

---

## Track shared state

Use `kv_set` and `kv_get` for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

---

## Finish cleanly

When you complete assigned work:

1. `unlock_file` any files you locked
2. `update_task` with `done` and a short `result`
3. If follow-up is needed, create a new `request_task` (don't reuse the old one)
4. `broadcast` a short summary if other sessions should know
