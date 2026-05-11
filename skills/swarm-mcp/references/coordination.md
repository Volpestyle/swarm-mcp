# Coordination State

Use this reference when reading or writing shared swarm state through messages, tasks, locks, or KV.

## MCP Access

Agents see shared state through MCP tools. The skill teaches conventions; MCP provides access.

- `register` establishes the session identity and scope.
- `bootstrap` is the preferred yield-checkpoint read: it returns instance state, peers, unread messages, tasks, and configured work tracker metadata.
- `list_instances`, `poll_messages`, and `list_tasks` are focused reads when you only need one part of the live coordination surface.
- `get_file_lock`, `lock_file`, and `unlock_file` coordinate file-level work. `get_file_lock` is read-only inspection. `lock_file` is a deliberate critical-section tool — for multi-step Read→Edit, multi-file refactors, or planned reservations — not per-edit ceremony; plugin-supported runtimes enforce peer-held locks at write time (see `SKILL.md` "Locking"). `unlock_file` releases early; terminal `update_task` releases any remaining edit locks automatically.
- `kv_list`, `kv_get`, `kv_set`, `kv_append`, and `kv_delete` read/write small shared state.
- `wait_for_activity` blocks while you are actively responsible for a peer result, dependency, lock, review, or gateway/planner delegation. It wakes on `new_messages`, `task_updates`, `kv_updates`, and `instance_changes`.

## KV Principles

Use KV for small durable state, not logs or large documents.

- Keep values short.
- Prefer JSON strings for structured values.
- Use prefixes so other agents can discover related keys with `kv_list("prefix/")`.
- Do not store secrets in KV.
- Clear or update stale progress keys when work finishes.

## Common Key Prefixes

| Prefix | Purpose |
|--|--|
| `progress/<instance-id>` | Current activity for one agent. |
| `plan/latest` | Pointer to the latest durable plan checkpoint. |
| `plan/v<N>` | Versioned planner checkpoint. |
| `plan/<instance-id>` | Planner-local plan state visible to peers. |
| `owner/planner` | Active planner owner, maintained by the server. |
| `owner/<area>` | Soft ownership of a domain like `owner/server`. |
| `review/<topic>` | Lightweight review coordination state. |
| `queue/<name>` | Small queue or backlog state. |
| `research/<topic>` | Structured research output. |
| `findings/<task-id>` | Structured task-specific findings. |
| `retries/<task-key>` | Retry count for planner escalation. |

## Progress Heartbeats

For long-running tasks (multi-minute), periodically call:

```text
kv_set("progress/<your-instance-id>", "<short status>")
```

Examples:

```json
"implementing auth middleware, tests next"
```

```json
{"task":"abc123","status":"running tests","percent":70}
```

This lets planners and peers check status with `kv_list("progress/")` without interrupting you.

Skip progress heartbeats for short tasks — the call cost outweighs the value.

## Reacting To KV Updates

When `wait_for_activity` returns `kv_updates`:

- Planners should check `owner/planner`, `plan/latest`, peer `plan/<instance-id>`, and implementer `progress/` keys.
- Implementers should check planner plan changes, ownership notes, or handoff keys relevant to their task.
- Reviewers should check review handoffs, progress keys, and plan changes that affect review priority.
- Researchers should check research handoffs and planner notes.

`wait_for_activity` tells you that some KV changed; use `kv_list` or `kv_get` to inspect the keys you care about.

## Messages vs Tasks vs KV

- Use `send_message` for targeted conversation or questions.
- Use `send_message` when the target is busy and the note can wait until their next yield checkpoint.
- Use `prompt_peer` when a peer should get a live-interface nudge. It writes the durable swarm message first, then best-effort wakes the workspace handle with only a short instruction to check messages.
- Use `broadcast` for short updates all active agents need.
- Use `request_task` for tracked work that needs ownership and a final status.
- Use KV for compact shared state that agents should poll or resume from.
- Use `report_progress` for long-running concrete tasks instead of ad hoc task progress KV; `swarm_status`, `get_task`, and `list_tasks` can surface that progress.

If you receive a live wake prompt from another peer, call `bootstrap` or `poll_messages` and act on unread messages. Do not treat the live prompt itself as the full work contract.

## Safety

- Never write secrets, tokens, passwords, API keys, or credentials to KV.
- Do not overwrite another agent's `plan/<instance-id>`, `progress/<instance-id>`, or ownership key without coordinating.
- If ownership is contested, use messages first and prefer explicit acknowledgement.
