# swarm.db contracts

`swarm.db` is bootstrapped from the SQL files in `sql/`:

- `sql/swarm_db_bootstrap.sql` creates tables and sets `PRAGMA user_version`.
- `sql/swarm_db_finalize.sql` performs data backfills and creates indexes.
- `crates/swarm-schema` embeds those files, runs the idempotent column migrations needed for older databases, and validates the live `user_version` against the binary's embedded `SWARM_DB_VERSION`.
- `src/db.ts` uses the same SQL files and refuses to open a database stamped with a newer schema version.

`apps/swarm-server/migrations/0001_initial.sql` is not the `swarm.db` schema. It owns the separate `~/.swarm-mcp/server/server.db` auth database used for devices, tokens, pairing codes, rate limits, and audit events.

## Writers

Most `swarm.db` tables have one owner:

- `tasks`: MCP server (`src/tasks.ts`)
- `messages`: MCP server (`src/messages.ts`)
- `context`: MCP server (`src/context.ts`)
- `events`: MCP server (`src/events.ts`) plus Rust event mirrors for Rust-owned actions
- `kv` and `kv_scope_updates`: MCP server (`src/kv.ts`) plus Tauri layout writes
- `ui_commands`: MCP server enqueues pending commands; swarm-ui claims and completes them

`instances` is intentionally dual-writer because the UI needs a visible node before the MCP server inside the PTY exists.

## instances.adopted

The adoption flow is the cross-stack contract for `instances`:

1. swarm-ui or swarm-server creates a pending row with `pid = 0` and `adopted = 0`.
2. The spawned process receives `SWARM_MCP_INSTANCE_ID` and related scope/directory env vars: `SWARM_MCP_DIRECTORY`, `SWARM_MCP_SCOPE`, `SWARM_MCP_FILE_ROOT`, and `SWARM_MCP_LABEL` when available.
3. When the MCP server starts, `src/index.ts` auto-adopts by calling `registry.register(...)` with the preassigned id.
4. `registry.register` updates the same row with the live pid, optional label, current heartbeat, and `adopted = 1`.
5. Heartbeats and normal deregistration are owned by the adopted MCP server.
6. UI/server cleanup may only delete rows where `adopted = 0`; manual UI cleanup can remove stale adopted rows only after checking that no live PTY is bound.

If a pending row is pruned before adoption, the MCP server may insert a fresh adopted row using the same preassigned id so the PTY binding remains stable. `swarm-server` also periodically reclaims unadopted rows that are offline and no longer bound to a live PTY.

## ui_commands

`ui_commands` is a one-way queue:

- MCP/CLI writes new rows as `pending`.
- swarm-ui atomically claims the oldest pending row by transitioning it to `running`, setting `claimed_by` and `started_at`.
- swarm-ui is the only component that transitions `running` rows to `done` or `failed`.
- Completion paths must not update commands that are no longer `running`.

New databases enforce valid queue statuses with a `CHECK` constraint. Existing databases keep their current table shape, so Rust transition checks are still required.
