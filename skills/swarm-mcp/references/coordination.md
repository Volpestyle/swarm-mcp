# Coordination State

Use this reference when reading or writing shared swarm state through messages, tasks, annotations, locks, or KV.

## MCP Access

Agents see shared state through MCP tools. The skill teaches conventions; MCP provides access.

- `register` establishes the session identity and scope.
- `list_instances`, `poll_messages`, and `list_tasks` read the live coordination surface.
- `check_file`, `lock_file`, `unlock_file`, and `annotate` coordinate file-level work.
- `kv_list`, `kv_get`, `kv_set`, `kv_append`, and `kv_delete` read/write small shared state.
- `wait_for_activity` wakes on `new_messages`, `task_updates`, `kv_updates`, and `instance_changes`.

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

While working, periodically call:

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

## Reacting To KV Updates

When `wait_for_activity` returns `kv_updates`:

- Planners should check `owner/planner`, `plan/latest`, peer `plan/<instance-id>`, and implementer `progress/` keys.
- Implementers should check planner plan changes, ownership notes, or handoff keys relevant to their task.
- Reviewers should check review handoffs, progress keys, and plan changes that affect review priority.
- Researchers should check research handoffs and planner notes.

`wait_for_activity` tells you that some KV changed; use `kv_list` or `kv_get` to inspect the keys you care about.

## Messages vs Tasks vs KV

- Use `send_message` for targeted conversation or questions.
- Use `broadcast` for short updates all active agents need.
- Use `request_task` for tracked work that needs ownership and a final status.
- Use `annotate` for file-specific durable context.
- Use KV for compact shared state that agents should poll or resume from.

## Safety

- Never write secrets, tokens, passwords, API keys, or credentials to KV.
- Do not overwrite another agent's `plan/<instance-id>`, `progress/<instance-id>`, or ownership key without coordinating.
- If ownership is contested, use messages first and prefer explicit acknowledgement.
