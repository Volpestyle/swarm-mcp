---
name: swarm-deepdive
description: Forensic inspection of a swarm's activity — reconstruct timelines, debug stuck or failed agents, audit task/message/KV history. Use when the user asks "what happened in the swarm", "why did agent X stop", "trace this task", "show me message history", or otherwise wants to dig into swarm state past what `list_*` MCP tools surface.
metadata:
  short-description: Investigate swarm history and live state
  domain: agent-coordination
  role: investigation
  scope: workflow
---

# Swarm Deep Dive

Use this skill to investigate what a swarm actually did — postmortem or live. The MCP tools (`list_instances`, `list_tasks`, `poll_messages`) show current state from one session's perspective. This skill reads the underlying SQLite database and server logs directly so you can reconstruct full timelines, audit decisions, and debug coordination failures across all sessions.

## When to use

- "What happened in the swarm overnight / while I was away?"
- "Why is task X blocked / why did agent Y stop?"
- "Reconstruct the conversation between planner and implementer"
- "Audit who edited which file and when"
- "Did this KV value get clobbered?"
- "Why didn't my agent register / why was it pruned?"
- Any postmortem on swarm behavior.

If the user just wants current state from inside an active session, use the swarm MCP tools (`list_instances`, `list_tasks`, `poll_messages`) instead — this skill is for forensics, not coordination.

## Where the data lives

| Source | Path | What it has |
|---|---|---|
| Shared SQLite DB | `~/.swarm-mcp/swarm.db` | All instances, tasks, messages, KV, file locks/annotations, **events audit log**, UI command queue |
| Server auth DB | `~/.swarm-mcp/server/server.db` | Devices, bearer tokens, pairing — NOT swarm state |
| Server logs | `~/.swarm-mcp/server/logs/swarm-server.log.YYYY-MM-DD` | PTY lifecycle, pairing, HTTP/WS errors, daemon-level issues |

The DB is shared between the MCP server (`swarm-mcp`) and the Rust daemon (`swarm-server`). Both write to it, so it is the single source of truth for swarm activity.

## The events table is your primary tool

`events` is an append-only audit log of every swarm-altering action. It is the fastest way to reconstruct a timeline. Event types:

- `instance.registered`, `instance.deregistered`, `instance.stale_reclaimed`
- `task.created`, `task.claimed`, `task.updated`, `task.approved`, `task.cascade.unblocked`, `task.cascade.cancelled`
- `message.sent`, `message.broadcast`
- `kv.set`, `kv.deleted`, `kv.appended`
- `context.annotated`, `context.lock_acquired`, `context.lock_released`

Each row has `scope`, `actor` (instance id or `system`), `subject` (task id, kv key, file, recipient...), and a JSON `payload` with type-specific detail.

**Critical caveat: events have a 24-hour TTL.** Cleanup drops events older than 24h when an MCP server process exits cleanly, so do not rely on `events` for older incidents. Fall back to inspecting the surviving rows in `tasks`, `messages`, `kv`, `context`, plus `swarm-server.log.*`.

## Start here

1. Identify the **scope** under investigation (usually the project's git root, e.g. `/Users/.../my-project`). Almost every query filters by scope.
2. Get the high-level snapshot first: `swarm-mcp inspect --scope <path>`. This gives instances + tasks + locks + KV + recent messages in one shot.
3. Pick the right reference for the kind of dive you need:

| Goal | Reference |
|---|---|
| Reconstruct a timeline, find when something happened | `references/queries.md` → "Timeline" |
| Trace one task end-to-end (created → claimed → done/failed) | `references/queries.md` → "Task lifecycle" |
| Replay messages between two agents | `references/queries.md` → "Message threads" |
| Audit who edited / locked a file | `references/queries.md` → "File contention" |
| Track a KV key's history | `references/queries.md` → "KV history" |
| Investigate a pruned / stale agent | `references/queries.md` → "Stale agents" |
| Need column names / types | `references/schema.md` |
| Daemon-level errors (PTY, pairing, server panics) | `references/server-logs.md` |

## Core conventions

- **Most timestamps are unix seconds**. Convert ordinary `*_at` fields with `datetime(created_at, 'unixepoch', 'localtime')` in SQLite. `tasks.changed_at` and `kv_scope_updates.changed_at` are unix milliseconds for polling.
- **Instance IDs are UUIDs**; correlate to a human-readable role/label by joining against `instances.label`, or by checking the `instance.registered` event payload (`{"label": "role:planner provider:claude", ...}`). Labels persist in events even after the instance row is deleted.
- **Scope filtering matters**: the DB holds every project on the machine. Always pass `--scope` (CLI) or `WHERE scope = ?` (SQL) unless you specifically want a global view.
- **Read-only first**: query, don't mutate. Only use `swarm-mcp send/kv set/...` or direct `UPDATE` if the user explicitly asks you to repair state.
- **The DB is live**: agents may be writing concurrently. Use `sqlite3 -readonly` for safety, or accept that snapshots can change between queries.

## Two ways in

**`swarm-mcp` CLI** for structured reads (`inspect`, `instances`, `tasks`, `messages`, `context`, `kv list`, `kv get`). It prunes stale instances on startup and respects scope resolution. Use `--json` for machine-readable output. See `skills/swarm-mcp/references/cli.md` for full flag reference.

**`sqlite3`** for anything the CLI does not surface — most importantly the `events` audit log, free-form joins, and time-windowed queries. The CLI has no `events` subcommand; SQL is the only way to read that table.

```sh
# Read-only, tab-separated, with headers — good default for ad-hoc queries
sqlite3 -readonly -header -separator $'\t' ~/.swarm-mcp/swarm.db "SELECT ..."
```

## Constraints

### Must do

- Pass `--scope <path>` or `WHERE scope = ?` on every query unless investigating cross-project behavior
- Convert unix-seconds to localtime before showing timestamps to the user
- Note the 24h event TTL when an investigation needs older data — fall back to surviving table state and server logs
- Resolve instance UUIDs to labels for the user-facing summary (raw UUIDs are unreadable)
- Use `sqlite3 -readonly` for inspection

### Must not do

- Mutate swarm state (`UPDATE`, `DELETE`, `swarm-mcp send/kv set/lock`) unless the user explicitly asks for a repair
- Assume `events` covers older-than-24h incidents
- Confuse `~/.swarm-mcp/server/server.db` (auth) with `~/.swarm-mcp/swarm.db` (swarm state)
- Treat `swarm-mcp messages` output as authoritative consumption — it peeks; messages remain unread for the recipient agent
- Run heavy queries against `swarm.db` while a critical agent is mid-task without `-readonly`

## Default report shape

When the user asks for an investigation, summarize in this order:

1. **Scope and time window** you searched (`scope`, earliest/latest event timestamps)
2. **Cast**: who was online, role labels, when they joined/left
3. **Timeline**: ordered events with localtime + actor label + one-line description
4. **Findings**: the specific question answered (root cause, message thread, who clobbered the key, etc.)
5. **Caveats**: anything outside the 24h window, anything you could not recover

Keep raw SQL output out of the summary unless the user asks for it — show resolved labels and human times.
