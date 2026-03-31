# Swarm

Portable coordination rules for opencode.

---

## Register early

At the start of every session, call `swarm_register` before using any other swarm tool.

Use your current project directory as `directory`. Set `scope` only when you want multiple worktrees or folders to share one swarm on purpose.

If you choose a `label`, prefer machine-readable tokens such as `provider:codex-cli role:planner origin:clanky`. Treat `role:` as optional. If an instance has no `role:` token, treat it as a generalist.

---

## Check first

Before starting work, call `swarm_poll_messages` and `swarm_list_tasks` to pick up requests from other instances.

When choosing collaborators, inspect `swarm_list_instances` labels for tokens like `role:planner`, `role:reviewer`, or `role:implementer`. If an instance has no `role:` token, treat it as a generalist.

Before editing a file, call `swarm_check_file` for that path. If another instance has a lock or warning, avoid overlap and coordinate first.

---

## Lock carefully

When you begin editing a file, call `swarm_lock_file` with a short reason.

Unlock it with `swarm_unlock_file` as soon as you are done. Keep locks short and specific.

---

## Delegate clearly

Use `swarm_request_task` for review, implementation, fix, test, or research handoffs.

Include a short title, a useful description, and relevant `files` when possible. Set `assignee` only when you want a specific active instance to take it.

---

## Share context

Use `swarm_annotate` to leave findings, warnings, notes, bugs, or todos on files.

Use `swarm_broadcast` for short updates that help everyone stay in sync. Use `swarm_send_message` for direct coordination with one instance.

---

## Track shared state

Use `swarm_kv_set` and `swarm_kv_get` for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

---

## Finish cleanly

When you complete assigned work, call `swarm_update_task` with `in_progress` when you start and `done`, `failed`, or `cancelled` when you finish.

Include a short `result` so the next instance can continue without re-reading everything.
