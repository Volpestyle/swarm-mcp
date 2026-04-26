# Swarm DB schema cheatsheet

Database file: `~/.swarm-mcp/swarm.db` (SQLite, WAL journal). Ordinary `*_at` timestamps are **unix seconds**. `tasks.changed_at` and `kv_scope_updates.changed_at` are **unix milliseconds**.

## `instances` — live and recently-live agents

| Column | Notes |
|---|---|
| `id` | UUID primary key. `actor` and `assignee` columns elsewhere reference this. |
| `scope` | The directory key everything else filters by. Usually a git root. |
| `directory` | Where the agent was launched. |
| `root` | Same as directory unless explicitly overridden during register. |
| `file_root` | Filesystem root the agent claims responsibility for; `lock_file` is rooted here. |
| `pid` | OS PID. Useful for matching a row to a still-running process. |
| `label` | Free-form tokens like `role:planner provider:claude team:backend`. Soft convention. |
| `registered_at` | When the agent first joined. |
| `heartbeat` | Last time the agent pinged. Stale agents are pruned ~30s after heartbeat lapses. |
| `adopted` | `1` if a swarm-aware harness adopted the row; `0` for a pending PTY-bound row that has not yet started its MCP subprocess. |

A row disappears on clean deregister or stale prune — but the `instance.registered` and `instance.deregistered`/`instance.stale_reclaimed` events stick around (24h) and preserve the label.

## `tasks` — work items

| Column | Notes |
|---|---|
| `id` | UUID. |
| `scope` | Project scope. |
| `type` | One of `review`, `implement`, `fix`, `test`, `research`, `other`. |
| `title` / `description` | Human-readable. |
| `requester` | Instance id that created the task. |
| `assignee` | Instance id currently working it (set by `claim_task`). |
| `status` | `open`, `claimed`, `in_progress`, `done`, `failed`, `cancelled`, `blocked`, `approval_required`. |
| `files` | JSON array of paths the task touches. |
| `result` | JSON or string set on completion (`{files_changed, test_status, summary}` by convention). |
| `priority` | Integer; higher = more urgent. `list_tasks` orders by this. |
| `depends_on` | JSON array of task IDs. Status auto-flips `blocked` → `open` when all deps complete; cascade-cancels on dep failure. |
| `parent_task_id` | Optional parent for subtask trees. |
| `idempotency_key` | Prevents duplicate creation on retry. Unique per scope. |
| `created_at` / `updated_at` | unix seconds. |
| `changed_at` | unix **milliseconds** — used by clients for change polling. |

## `messages` — direct + broadcast comms

| Column | Notes |
|---|---|
| `id` | Auto-increment integer; ordering across the swarm. |
| `scope` | Project scope (broadcasts also carry scope). |
| `sender` | Instance id, or another identifier for `[auto]` system messages. |
| `recipient` | Instance id. Broadcasts are fanned out as one row per recipient; use `message.broadcast` events to identify broadcast sends. |
| `content` | Plain text. `[auto] ...` prefix marks system notifications (task assignments, completions, stale-agent recovery). `[signal:complete]` is the planner's "we're done" broadcast. |
| `created_at` | unix seconds. |
| `read` | `1` once the recipient called `poll_messages` and consumed it. Peek queries do NOT flip this. |

## `events` — append-only audit log (24h TTL)

| Column | Notes |
|---|---|
| `id` | Auto-increment, monotonic per DB. |
| `scope` | Project scope. |
| `type` | One of: `instance.registered`, `instance.deregistered`, `instance.stale_reclaimed`, `task.created`, `task.claimed`, `task.updated`, `task.approved`, `task.cascade.unblocked`, `task.cascade.cancelled`, `message.sent`, `message.broadcast`, `kv.set`, `kv.deleted`, `kv.appended`, `context.annotated`, `context.lock_acquired`, `context.lock_released`. |
| `actor` | Instance id of the cause, or `'system'` for daemon-driven events (prune, cascade). |
| `subject` | Most-relevant entity: task id for `task.*`, kv key for `kv.*`, file path for `context.*`, recipient id for `message.sent`, instance id for `instance.*`. |
| `payload` | JSON detail. Examples: `{"label": "...", "adopted": true, "pid": 12345}` for register, `{"length": 121}` for kv.set (content not stored), `{"id": "<lock-uuid>"}` for lock_acquired. |
| `created_at` | unix seconds. |

**TTL-pruned by MCP cleanup** — anything older than 24h may be gone after a server process exits cleanly. The CLI does not have an `events` subcommand; query directly with sqlite3.

## `context` — file locks and annotations

| Column | Notes |
|---|---|
| `id` | UUID. |
| `scope` | Project scope. |
| `instance_id` | Owner of the lock or author of the annotation. |
| `file` | Absolute path. |
| `type` | `lock`, `finding`, `warning`, `note`, `bug`, or `todo`. |
| `content` | For locks: optional note. For non-lock annotations: the message. |
| `created_at` | unix seconds. |

A unique partial index enforces one active `lock` per `(scope, file)`. Locks auto-clear when the owner deregisters.

## `kv` — shared coordination state

| Column | Notes |
|---|---|
| `scope` | Part of the composite primary key. |
| `key` | Free-form; conventional namespaces: `owner/<role>`, `progress/<instance-id>`, `plan/<...>`, `queue/<...>`, `handoff/<...>`. |
| `value` | TEXT. Typically JSON. |
| `updated_at` | unix seconds. |

Note: only the **current value** lives here. To see history, query `events` for `kv.set` / `kv.deleted` / `kv.appended` rows with `subject = '<key>'` (24h window only — payload stores `{"length": N}`, not the prior value, so reconstruction is partial).

`kv_scope_updates` is a per-scope `changed_at` (unix milliseconds) used by clients to poll cheaply.

## `ui_commands` — async desktop UI queue

| Column | Notes |
|---|---|
| `id` | Auto-increment. |
| `scope` | Project scope. |
| `created_by` | Instance id of the requester. |
| `kind` | `spawn_shell`, `send_prompt`, `move_node`, `organize_nodes`, etc. |
| `payload` | JSON args. |
| `status` | `pending`, `running`, `done`, `failed`. |
| `claimed_by` | UI app instance that picked the command up. |
| `result` / `error` | Set on completion. |
| `created_at` / `started_at` / `completed_at` | unix seconds. |

If a command sits `pending` forever, no `swarm-ui` desktop app is running.
