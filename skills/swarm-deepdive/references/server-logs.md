# Swarm-server logs

The Rust daemon `swarm-server` writes one log file per UTC day to:

```
~/.swarm-mcp/server/logs/swarm-server.log.YYYY-MM-DD
```

These logs cover daemon-level concerns the SQLite tables do not — PTY lifecycle, pairing, certificate handshakes, HTTP/WSS errors, internal panics. Reach for them when:

- A `swarm-ui` desktop session is misbehaving (PTY won't spawn, won't bind, won't adopt)
- Pairing with the iOS/iPadOS client failed
- The daemon crashed or refused a connection
- An unadopted instance row appeared and you need to know whether the harness ever started

The logs do **not** record swarm coordination actions (those live in `events`). If you only want messages/tasks/KV history, query `swarm.db` instead.

## Format

`tracing` text output with ISO-8601 UTC timestamps:

```
2026-04-25T15:25:28.800595Z  WARN swarm_server: uds client connection failed err=...
2026-04-25T19:53:25.123456Z  INFO swarm_server::pty: pty spawned id=... harness=claude bound_instance=...
```

Fields are `key=value` after the module path. JSON output mode is not enabled by default.

## Useful greps

```sh
LOG=~/.swarm-mcp/server/logs/swarm-server.log.$(date +%F)

# Errors and panics only
grep -E '\sERROR\s|panic' "$LOG"

# PTY lifecycle (spawn / exit / lease)
grep -E 'pty (spawned|exited|lease)' "$LOG"

# Pairing flow
grep -E 'pairing|/pair' "$LOG"

# Specific instance — once you know its UUID
grep '<instance-uuid>' "$LOG"

# Specific PTY id
grep '<pty-id>' "$LOG"

# Time window (after 22:00 local on a given day)
awk '$1 >= "2026-04-25T22:00:00Z"' "$LOG"
```

## Cross-referencing with `swarm.db`

When the daemon binds a swarm-aware harness (`claude`, `codex`, `opencode`), it creates a pending `instances` row with `adopted = 0` and injects the UUID into the harness env (`SWARM_MCP_INSTANCE_ID`). Match the log's `bound_instance=<uuid>` to:

- `instances.id` (live), or
- the `subject` of an `instance.registered` event in `swarm.db`

If the log shows a spawn but no `instance.registered` event ever fires for that UUID, the MCP subprocess never came up — common causes are missing `bun`/`node`, a bad `SWARM_DB_PATH`, or the harness exiting before adoption.

## Common patterns

**"`swarm-mcp ui spawn` succeeded but no node appeared"** — `ui_commands` row is `done`, but the daemon log shows the PTY exited immediately. Check the harness binary on `$PATH` and the `cwd` argument.

**"Mobile client can't reconnect after a cert rotate"** — log entries about TLS handshake failures with the device's pinned fingerprint. Re-pair the device.

**"UDS client connection failed" spam** — usually a `swarm-ui` instance retrying after the daemon was restarted. Benign if it stops on its own.

## Caveats

- Logs are **not** rotated past one file per day; old days accumulate. Safe to delete files older than the time window you care about.
- The daemon writes to stderr in addition to the file when run in the foreground (`cargo run --manifest-path apps/swarm-server/Cargo.toml`).
- Releases may change log fields — treat field names as advisory, grep on stable substrings (`pty spawned`, `pairing`, `panic`).
