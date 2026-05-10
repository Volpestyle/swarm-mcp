# Swarm-Server Logs

The Rust daemon `swarm-server` writes one log file per UTC day under the server directory next to the swarm DB:

```text
${dirname(SWARM_DB_PATH:-~/.swarm-mcp/swarm.db)}/server/logs/swarm-server.log.YYYY-MM-DD
```

With the default DB path, that is:

```text
~/.swarm-mcp/server/logs/swarm-server.log.YYYY-MM-DD
```

These logs cover daemon-level concerns the SQLite swarm tables do not: PTY lifecycle, local UDS server failures, pairing, TLS/certificate handshakes, HTTP/WSS errors, mobile reconnects, and internal panics.

Reach for them when:

- A `swarm-ui` desktop session is misbehaving, such as PTY spawn, bind, prompt, or adoption failures
- Pairing with the iOS/iPadOS client failed
- The daemon crashed or refused a connection
- An unadopted instance row appeared and you need to know whether the harness ever started
- `ui_commands` rows stay `pending`, `running`, or `failed` and the DB alone does not explain why

The logs do not record normal swarm coordination actions. Messages, tasks, KV changes, locks, and UI command status transitions live in `swarm.db` events.

## Format

`tracing` text output with ISO-8601 UTC timestamps:

```text
2026-04-25T15:25:28.800595Z  WARN swarm_server: uds client connection failed err=...
2026-04-25T19:53:25.123456Z  INFO swarm_server::pty: pty spawned id=... harness=claude bound_instance=...
```

Fields are `key=value` after the module path. JSON output mode is not enabled by default. Verbosity follows `RUST_LOG`; the default filter is `swarm_server=info`.

## Useful Searches

```sh
DB=${SWARM_DB_PATH:-$HOME/.swarm-mcp/swarm.db}
LOG="$(dirname "$DB")/server/logs/swarm-server.log.$(date -u +%F)"

# Errors and panics only
rg '\sERROR\s|panic' "$LOG"

# PTY lifecycle, bind, and prompt forwarding
rg 'pty|bound_instance|send_prompt|PtyExit' "$LOG"

# Pairing and certificate flow
rg 'pairing|/pair|fingerprint|TLS|handshake' "$LOG"

# Local socket / desktop app connection issues
rg 'uds|UDS|local server|client connection failed' "$LOG"

# Specific instance once you know its UUID
rg '<instance-uuid>' "$LOG"

# Specific PTY id
rg '<pty-id>' "$LOG"
```

Use UTC for log windows, or convert your local incident time before searching.

## Cross-Referencing With `swarm.db`

When the daemon launches a swarm-aware harness (`claude`, `codex`, or `opencode`), `swarm-ui` pre-creates an `instances` row with `adopted = 0` and injects `SWARM_MCP_INSTANCE_ID=<uuid>` into the child environment. Match log fields such as `bound_instance=<uuid>` to:

- `instances.id` for live rows
- `events.subject` or `events.actor` for `instance.registered`, `instance.deregistered`, and `instance.stale_reclaimed`
- `ui_commands.result` for completed spawn/prompt/move/organize commands

If the log shows a PTY spawn but no `instance.registered` event ever appears for that UUID, the MCP subprocess probably never came up. Common causes are a missing `bun`/`node`/host binary, a bad `SWARM_DB_PATH`, wrong working directory, or the harness exiting before adoption.

## Server Auth DB

`server/server.db` is separate from `swarm.db`. It stores devices, tokens, pairing sessions, certificates, and server audit events. Inspect it only for pairing/mobile/server-auth incidents, not task/message/KV coordination.

Useful pairing audit query:

```sh
sqlite3 -readonly -header -separator $'\t' ~/.swarm-mcp/server/server.db \
  "SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts, kind, subject, payload FROM audit_events ORDER BY id DESC LIMIT 50;"
```

## Common Patterns

**`swarm-mcp ui spawn` succeeded but no node adopted**

Check `ui_commands` for the command result, then search logs for the `pty_id` or `bound_instance`. If the PTY exited immediately, verify the harness binary on `PATH` and the `cwd`/`SWARM_DB_PATH` environment.

**Mobile client cannot reconnect after certificate rotation**

Look for TLS handshake or fingerprint mismatch entries. Re-pair the device after confirming the expected fingerprint.

**UDS client connection failed spam**

Usually a desktop app retrying while the daemon is restarting or the socket path changed. Benign if it stops; suspicious if paired with `ui_commands` that never leave `pending`.

## Caveats

- Logs are one file per day and old days accumulate until deleted manually.
- The daemon writes only to the log file through tracing in normal runs; foreground development may also show process stderr/stdout around startup failures.
- Field names can change between releases. Prefer stable substrings (`pty`, `bound_instance`, `pairing`, `panic`, `uds`) over exact log fields.
- Logs are UTC. DB report timestamps should usually be converted to localtime for user-facing summaries.
