# Swarm

Portable coordination rules for any MCP-capable coding agent.

Tool names are namespaced by the host. Depending on the client you may see `swarm_register`, `mcp__swarm__register`, or similar variants. Use whichever form your host exposes.

---

## Register early

At the start of every session, call `register` before using any other swarm tool.

Use your current project directory as `directory`. Set `scope` only when you want multiple directories to share one swarm on purpose. See the README "How it works" section for full field reference.

If you choose a `label`, prefer machine-readable tokens such as `provider:codex-cli role:planner`. Treat `role:` as optional; no `role:` token means the session is a generalist.

---

## Check first

Before starting work, call the swarm `poll_messages` and `list_tasks` tools to pick up requests from other sessions.

When choosing collaborators, inspect `list_instances` labels for tokens like `role:planner`, `role:reviewer`, or `role:implementer`. If a session has no `role:` token, treat it as a generalist.

Before editing a file, call the swarm `check_file` tool for that path. If another session has a lock or warning, avoid overlap and coordinate first.

---

## Lock carefully

When you begin editing a file, call the swarm `lock_file` tool with a short reason.

Unlock it with the swarm `unlock_file` tool as soon as you are done. Keep locks short and specific.

---

## Delegate clearly

Use the swarm `request_task` tool for review, implementation, fix, test, or research handoffs.

Include a short title, a useful description, and relevant `files` when possible. Set `assignee` only when you want a specific active session to take it.

---

## Share context

Use the swarm `annotate` tool to leave findings, warnings, notes, bugs, or todos on files.

Use the swarm `broadcast` tool for short updates that help everyone stay in sync. Use the swarm `send_message` tool for direct coordination with one session.

---

## Track shared state

Use the swarm `kv_set` and `kv_get` tools for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

---

## Finish cleanly

When you complete assigned work, call the swarm `update_task` tool with `in_progress` when you start and `done`, `failed`, or `cancelled` when you finish.

Include a short `result` so the next session can continue without re-reading everything.
