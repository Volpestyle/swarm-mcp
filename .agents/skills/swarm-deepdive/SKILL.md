---
name: swarm-deepdive
description: Forensic inspection of swarm activity - reconstruct timelines, debug stuck or failed agents, audit task/message/KV/file-lock/UI command history, and correlate daemon logs. Use when the user asks "what happened in the swarm", "why did agent X stop", "trace this task", "show message history", "why is swarm-ui stuck", or otherwise wants to investigate swarm state beyond normal MCP coordination tools.
metadata:
  short-description: Investigate swarm history and live state
  domain: agent-coordination
  role: investigation
  scope: workflow
---

# Swarm Deep Dive

Use this skill to investigate what a swarm actually did, either live or after the fact. Normal swarm MCP tools (`list_instances`, `list_tasks`, `poll_messages`, `kv_get`) are for participation from one registered session. This skill is for inspection: read the SQLite database, event audit log, and server logs to reconstruct timelines and explain coordination failures.

If the user only wants to coordinate current work, use `swarm-mcp` instead. If they want evidence, timelines, root cause, or a postmortem, use this skill.

## When To Use

- "What happened in the swarm overnight / while I was away?"
- "Why is task X blocked / why did agent Y stop?"
- "Reconstruct the conversation between planner and implementer"
- "Audit who edited, locked, or annotated a file"
- "Did this KV value get clobbered?"
- "Why did this UI command stay pending?"
- "Why didn't my agent register / why was it pruned?"
- Any postmortem on swarm behavior.

## Where The Data Lives

| Source | Path | What it has |
|---|---|---|
| Shared SQLite DB | `${SWARM_DB_PATH:-~/.swarm-mcp/swarm.db}` | Instances, tasks, messages, KV, file locks/annotations, events audit log, UI command queue |
| Server auth DB | directory of swarm DB + `/server/server.db` | Devices, bearer tokens, pairing sessions, server audit events - not swarm coordination state |
| Server logs | directory of swarm DB + `/server/logs/swarm-server.log.YYYY-MM-DD` | PTY lifecycle, pairing, HTTP/WSS/UDS errors, daemon startup/crashes |

The Bun MCP server, `swarm-ui`, and `swarm-server` share the same swarm DB path. The default is `~/.swarm-mcp/swarm.db`, but `SWARM_DB_PATH` overrides it.

## Preserve Evidence First

For strict postmortems, start with `sqlite3 -readonly` before using `swarm-mcp inspect`. The CLI is convenient, but every state subcommand imports the runtime and runs cleanup before it reads. That can release tasks, delete offline instance rows, clear locks/messages for those instances, delete old TTL rows, and remove orphaned instance-scoped KV.

Use the CLI when you want the live view after normal runtime cleanup. Use read-only SQL when you need the least-mutated snapshot.

```sh
sqlite3 -readonly -header -separator $'\t' "${SWARM_DB_PATH:-$HOME/.swarm-mcp/swarm.db}" "SELECT COUNT(*) FROM events;"
```

## Events Are The Primary Timeline

`events` is the append-only audit log for swarm-altering actions. It is the fastest way to reconstruct causality.

Current event families include:

- `instance.registered`, `instance.deregistered`, `instance.stale_reclaimed`
- `task.created`, `task.claimed`, `task.updated`, `task.approved`, `task.cascade.unblocked`, `task.cascade.cancelled`
- `message.sent`, `message.broadcast`, `message.cleared`
- `kv.set`, `kv.deleted`, `kv.appended`
- `context.annotated`, `context.lock_acquired`, `context.lock_released`
- `ui.command.started`, `ui.command.completed`, `ui.command.failed`

Each row has `scope`, `actor`, `subject`, `payload`, and `created_at`. Payloads can include sensitive content: message text, KV values, deleted prior values, appended JSON, annotation text, and UI command results. Treat raw payloads as evidence, not as automatically safe user-facing output.

## Retention Model

| Data | Retention behavior |
|---|---|
| `events` | Deleted after 24 hours when MCP cleanup runs. |
| `messages` | Deleted after one hour by cleanup. Messages for deregistered/offline recipients are deleted immediately during release. Use `message.*` events for 24-hour reconstruction. |
| `tasks` | Active tasks persist. Terminal `done`/`failed`/`cancelled` tasks are deleted after 24 hours when MCP cleanup runs. |
| `context` | Locks persist until released, task completion, deregister, or offline reclaim. Non-lock annotations are deleted after 24 hours when MCP cleanup runs. |
| `kv` | Only current values persist. Old orphaned `progress/<instance-id>` and `plan/<instance-id>` rows are removed by cleanup; durable keys such as `plan/latest` remain until overwritten or deleted. |
| `ui_commands` | Command rows persist unless manually cleaned; status is `pending`, `running`, `done`, or `failed`. |

Never assume older incidents are fully reconstructable from the DB. For older windows, combine surviving task/KV/UI rows with server logs and whatever event rows remain.

## Start Here

1. Identify the scope under investigation. It is usually the project git root. Almost every useful query filters by `scope`.
2. Identify the time window and whether evidence preservation matters. If yes, query with `sqlite3 -readonly` first. If no, use `swarm-mcp inspect --scope <path> --json` for a live snapshot.
3. Establish data freshness: oldest/newest `events`, recent `messages`, terminal tasks, and whether `SWARM_DB_PATH` points somewhere non-default.
4. Resolve instance UUIDs to labels using live `instances` rows and `instance.registered` events.
5. Use the reference that matches the question.

| Goal | Reference |
|---|---|
| Reconstruct a timeline, find when something happened | `references/queries.md` -> "Timeline" |
| Trace one task end-to-end | `references/queries.md` -> "Task lifecycle" |
| Replay messages or broadcasts | `references/queries.md` -> "Messages" |
| Audit locks, annotations, or file contention | `references/queries.md` -> "File contention" |
| Track a KV key | `references/queries.md` -> "KV history" |
| Investigate stale, pruned, or unadopted agents | `references/queries.md` -> "Stale agents" |
| Inspect `swarm-ui` command execution | `references/queries.md` -> "UI command queue" |
| Need column names, payload facts, or retention rules | `references/schema.md` |
| Daemon-level errors: PTY, pairing, HTTP/WSS/UDS, crashes | `references/server-logs.md` |

## Core Conventions

- Most timestamps are Unix seconds. Convert with `datetime(created_at, 'unixepoch', 'localtime')`.
- `tasks.changed_at`, `kv_scope_updates.changed_at`, and planner `assigned_at` values are Unix milliseconds.
- Scope filtering matters. The DB can hold many projects. Use `WHERE scope = :scope` unless you are intentionally investigating cross-project behavior.
- Instance IDs are UUIDs. User-facing summaries should resolve them to `instances.label` or the `instance.registered` event payload label.
- The DB is live. Agents, `swarm-ui`, and CLI calls can write while you inspect. Prefer `sqlite3 -readonly` for investigations.
- Payload content may be sensitive. Quote only the minimum needed in the final report.

## Two Ways In

Use direct SQL for forensic work:

```sh
sqlite3 -readonly -header -separator $'\t' "${SWARM_DB_PATH:-$HOME/.swarm-mcp/swarm.db}"
```

Use the CLI for live state or structured snapshots after accepting prune side effects:

```sh
swarm-mcp inspect --scope "$SCOPE" --json
swarm-mcp instances --scope "$SCOPE" --json
swarm-mcp tasks --scope "$SCOPE" --json
swarm-mcp messages --scope "$SCOPE" --limit 100 --json
swarm-mcp context --scope "$SCOPE" --json
swarm-mcp kv list --scope "$SCOPE" --json
```

The CLI has no `events` subcommand. Query `events` directly.

## Constraints

### Must Do

- Filter by scope unless the user explicitly asks for cross-project history.
- State the DB path, scope, and time window you inspected.
- Convert timestamps to localtime for user-facing timelines.
- Explain retention limits when evidence is missing or old.
- Resolve UUIDs to labels where possible.
- Use `sqlite3 -readonly` for inspection unless the user asks for repair.

### Must Not Do

- Mutate swarm state (`UPDATE`, `DELETE`, `swarm-mcp send`, `kv set`, locks) unless the user explicitly requests a repair.
- Treat `swarm-mcp inspect` as a no-side-effect forensic read.
- Assume `events` covers incidents older than 24 hours.
- Assume `messages` rows are complete; they are short-lived and per-recipient.
- Confuse `server/server.db` with `swarm.db`.
- Paste raw sensitive payloads into the final report unless needed.

## Default Report Shape

When the user asks for an investigation, summarize in this order:

1. Scope, DB path, and time window searched.
2. Data freshness and caveats: oldest/newest events, known TTL gaps, whether CLI prune was used.
3. Cast: instance labels, roles, join/exit/stale times.
4. Timeline: ordered events with localtime, actor label, and one-line descriptions.
5. Findings: root cause or direct answer to the question.
6. Evidence: concise supporting rows or log snippets, with sensitive values redacted when appropriate.
7. Follow-ups: only concrete repair or prevention steps.

Keep raw SQL output out of the summary unless the user asks for it.
