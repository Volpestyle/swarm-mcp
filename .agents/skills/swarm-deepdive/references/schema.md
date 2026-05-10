# Swarm DB Schema Cheatsheet

Database file: `${SWARM_DB_PATH:-~/.swarm-mcp/swarm.db}`. The default is `~/.swarm-mcp/swarm.db`; `SWARM_DB_PATH` overrides it for the MCP server, `swarm-ui`, and `swarm-server`.

The database is SQLite with WAL journaling. Ordinary `*_at` timestamps are Unix seconds unless noted. `tasks.changed_at`, `kv_scope_updates.changed_at`, and planner `assigned_at` payloads are Unix milliseconds.

## `instances` - Live And Recently Live Agents

| Column | Notes |
|---|---|
| `id` | UUID primary key. `actor`, `assignee`, `requester`, and `instance_id` columns elsewhere often reference this. |
| `scope` | Shared directory key. Usually a git root. |
| `directory` | Where the agent was launched. |
| `root` | Git root detected at registration time, or the launch directory fallback. |
| `file_root` | Filesystem root used to resolve relative paths for locks/tasks. |
| `pid` | OS PID. `0` is used for UI-precreated, not-yet-adopted rows. |
| `label` | Free-form tokens such as `role:planner provider:claude team:backend`. These are conventions, not schema. |
| `registered_at` | Unix seconds when the row was created. |
| `heartbeat` | Unix seconds for the latest heartbeat. Runtime stale threshold is about 30 seconds. |
| `adopted` | `1` after the child MCP process adopts the row. `0` means a UI-spawned PTY row is pending adoption. |

Rows disappear on clean deregister or offline reclaim. Instances are stale after about 30 seconds without a heartbeat and reclaimable after about 60 seconds. `instance.registered`, `instance.deregistered`, and `instance.stale_reclaimed` events preserve labels for the 24-hour event window.

## `tasks` - Work Items

| Column | Notes |
|---|---|
| `id` | UUID. |
| `scope` | Project scope. |
| `type` | `review`, `implement`, `fix`, `test`, `research`, or `other`. |
| `title` / `description` | Human-readable task text. |
| `requester` | Instance ID that created the task. |
| `assignee` | Instance ID currently assigned, or `NULL`. |
| `status` | `open`, `claimed`, `in_progress`, `done`, `failed`, `cancelled`, `blocked`, or `approval_required`. |
| `files` | JSON array of paths. Paths are resolved through the requester's registration context. |
| `result` | JSON string or plain string set on terminal update. Structured convention is `{files_changed, test_status, summary}`. |
| `priority` | Integer. Higher is more urgent; task listing orders by priority descending. |
| `depends_on` | JSON array of task IDs. Unmet dependencies hold a task in `blocked`; failed/cancelled dependencies cascade-cancel dependents. |
| `parent_task_id` | Optional parent for task trees. |
| `idempotency_key` | Unique per scope when present; prevents duplicate task creation on retry. |
| `created_at` / `updated_at` | Unix seconds. |
| `changed_at` | Unix milliseconds for polling and UI snapshots. |

Active tasks persist. Terminal tasks are deleted after 24 hours when MCP cleanup runs. `swarm-ui` snapshots also hide terminal tasks whose `changed_at` is older than 24 hours.

## `messages` - Direct And Broadcast Communication

| Column | Notes |
|---|---|
| `id` | Auto-increment integer; monotonic message order. |
| `scope` | Project scope. |
| `sender` | Instance ID, or `system` for some automatic notifications. |
| `recipient` | Instance ID. Broadcasts are fanned out as one row per recipient. |
| `content` | Plain text. `[auto]` prefixes system notifications; `[signal:complete]` is the planner completion signal. |
| `created_at` | Unix seconds. |
| `read` | `1` once the recipient consumed it with `poll_messages`. CLI and resource peeks do not flip this. |

Messages are short-lived. Runtime cleanup deletes rows older than one hour and deletes queued rows for recipients that deregister or are reclaimed offline. For message history inside the 24-hour event window, prefer `message.sent` and `message.broadcast` events because their payloads include content.

`message.cleared` events are emitted by `swarm-ui` when a user clears the history between two instances.

## `events` - Append-Only Audit Log

| Column | Notes |
|---|---|
| `id` | Auto-increment integer, monotonic per DB. |
| `scope` | Project scope. |
| `type` | Event type string. See event families below. |
| `actor` | Instance ID, `system`, a UI worker ID, or `NULL` depending on event source. |
| `subject` | Most-relevant entity: task ID, KV key, file path, recipient ID, instance ID, command kind, etc. |
| `payload` | JSON detail. Often contains content. Treat as sensitive evidence. |
| `created_at` | Unix seconds. |

Event families currently emitted into `swarm.db`:

| Family | Event types |
|---|---|
| Instances | `instance.registered`, `instance.deregistered`, `instance.stale_reclaimed` |
| Tasks | `task.created`, `task.claimed`, `task.updated`, `task.approved`, `task.cascade.unblocked`, `task.cascade.cancelled` |
| Messages | `message.sent`, `message.broadcast`, `message.cleared` |
| KV | `kv.set`, `kv.deleted`, `kv.appended` |
| File context | `context.annotated`, `context.lock_acquired`, `context.lock_released` |
| UI commands | `ui.command.started`, `ui.command.completed`, `ui.command.failed` |

Payload facts that matter for investigations:

| Event | Payload notes |
|---|---|
| `message.sent` | Includes `content` and `length`; `subject` is the recipient. |
| `message.broadcast` | Includes `content`, `recipients`, and `length`; `subject` is usually `NULL`. |
| `kv.set` | Includes full `value` and `length` for MCP-side writes. |
| `kv.deleted` | Includes `prior_value` and `prior_length` when the row existed. |
| `kv.appended` | Includes parsed `appended` JSON and resulting array `length`. |
| `task.created` | Includes type, title, status, assignee, files, priority, dependency and parent fields, and idempotency metadata where present. |
| `task.updated` | Includes `status`, `prior_status`, and `result` where present. |
| `context.annotated` | Includes annotation type, annotation ID, and content. |
| `context.lock_acquired` / `context.lock_released` | Includes lock ID/content or release count/reason. |
| `ui.command.*` | Includes `command_id`, result or error, and command metadata. |

Events are deleted after 24 hours when MCP cleanup runs. The CLI has no `events` subcommand; inspect this table with SQL.

## `context` - File Locks And Annotations

| Column | Notes |
|---|---|
| `id` | UUID. |
| `scope` | Project scope. |
| `instance_id` | Lock owner or annotation author. |
| `file` | Absolute path. |
| `type` | `lock`, `finding`, `warning`, `note`, `bug`, or `todo`. |
| `content` | Lock reason or annotation text. |
| `created_at` | Unix seconds. |

A unique partial index enforces one active `lock` per `(scope, file)`. Locks clear on explicit unlock, terminal task update for task files, instance deregister, or offline reclaim. Non-lock annotations are deleted after 24 hours when MCP cleanup runs.

## `kv` - Shared Coordination State

| Column | Notes |
|---|---|
| `scope` | Part of the composite primary key. |
| `key` | Free-form. Common namespaces: `owner/<role>`, `progress/<instance-id>`, `plan/<...>`, `queue/<...>`, `handoff/<...>`, `ui/<...>`. |
| `value` | Text, usually JSON for structured values. |
| `updated_at` | Unix seconds. |

Only the current value lives here. MCP cleanup removes old orphaned `progress/<instance-id>` and `plan/<instance-id>` rows after the owning instance disappears; durable keys such as `plan/latest`, `owner/planner`, and `ui/...` remain until overwritten or explicitly deleted. MCP-side `kv_set`, `kv_delete`, and `kv_append` also emit events with enough content to reconstruct changes inside the event window. Some internal `swarm-ui` KV writes, such as layout and planner-owner refreshes, update `kv` directly and may not emit `kv.*` events. Always compare current `kv` rows against event history before claiming a complete KV timeline.

`kv_scope_updates` stores one row per scope with `changed_at` in Unix milliseconds for polling.

## `ui_commands` - Async Desktop UI Queue

| Column | Notes |
|---|---|
| `id` | Auto-increment integer. |
| `scope` | Project scope. |
| `created_by` | Instance ID of the requester when available. |
| `kind` | `spawn_shell`, `send_prompt`, `move_node`, `organize_nodes`, etc. |
| `payload` | JSON args. |
| `status` | `pending`, `running`, `done`, or `failed`. |
| `claimed_by` | UI worker that picked the command up. |
| `result` / `error` | Set on completion/failure. |
| `created_at` / `started_at` / `completed_at` | Unix seconds. |

If a command stays `pending`, no `swarm-ui` worker is actively claiming commands for that DB. Cross-reference `ui.command.started`, `ui.command.completed`, and `ui.command.failed` events for execution history.
