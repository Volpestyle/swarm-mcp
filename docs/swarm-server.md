# Swarm Server

`swarm-server` is the Rust daemon for the desktop and mobile control plane. It is separate from the TypeScript `swarm-mcp` stdio MCP server.

Use `swarm-mcp` when coding-agent hosts need MCP tools. Use `swarm-server` when `swarm-ui` or a paired iOS/iPadOS client needs snapshots, PTY streaming, pairing, leases, or LAN access.

`swarm-server` is not currently registered as a `swarm-mcp` workspace or spawner backend. For the current backend matrix and the intended future config switch to `swarm-server`, see [`backend-configuration.md`](./backend-configuration.md).

## Responsibilities

- Reads the shared `swarm.db` through `crates/swarm-state`.
- Ensures the `swarm.db` schema through `crates/swarm-schema` before writing server-owned rows.
- Serves local `swarm-ui` over a Unix domain socket at `~/.swarm-mcp/server/swarm-server.sock`.
- Serves paired remote clients over HTTPS and WSS on port `5444` by default.
- Owns PTY lifecycle, PTY leases, stream replay, and mobile takeover behavior.
- Owns a separate auth database at `~/.swarm-mcp/server/server.db`.

The auth database is not the swarm coordination schema. It stores devices, bearer tokens, pairing codes/sessions, rate limits, and audit events.

## Run and Test

From the repo root:

```sh
bun run dev:server
cargo test --manifest-path apps/swarm-server/Cargo.toml
```

For desktop UI development, run the daemon and UI separately:

```sh
# Terminal 1
bun run dev:server

# Terminal 2
bun run dev:ui
```

`bun run dev:ui` sets `SWARM_UI_MANAGE_DAEMON=0`, so stale or incompatible daemon processes are surfaced instead of being silently replaced by the UI. Managed startup remains available through `bun run dev:ui:managed`. In debug builds, managed startup prefers:

1. `SWARM_SERVER_BIN` when set to an existing binary
2. `cargo run --manifest-path apps/swarm-server/Cargo.toml`

Packaged builds look for a sibling `swarm-server` binary first, then fall back to workspace binaries when available.

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| `SWARM_DB_PATH` | `~/.swarm-mcp/swarm.db` | Shared with the MCP server. The server directory is based on this file's parent. |
| `SWARM_SERVER_PORT` | `5444` | HTTPS/WSS bind port on `0.0.0.0`. |
| `SWARM_ENABLE_BONJOUR` | unset | Enables `_swarm._tcp` advertisement in debug builds. Release builds advertise by default. |
| `SWARM_SERVER_BIN` | unset | Used by `swarm-ui` to launch a specific server binary. |
| `SWARM_UI_MANAGE_DAEMON` | enabled | Set to `0`, `false`, `no`, or `off` to make `swarm-ui` require a separately-started daemon. |

Server-owned files live under `~/.swarm-mcp/server/` by default:

- `server.db`
- `pinned.pem`
- `pinned-key.pem`
- `swarm-server.sock`
- `logs/swarm-server.log.*`

The dev launchd plist at `apps/swarm-server/install/dev.swarm.server.plist` contains machine-specific absolute paths. Treat it as a local template and update paths before loading it.

## Local vs Remote Transports

The same router is exposed in two modes:

- Local Unix socket: used by `swarm-ui`; bypasses bearer auth and rate limiting.
- Remote HTTPS/WSS: used by paired mobile clients; requires a bearer token from pairing and is rate limited.

Remote clients pin the server certificate fingerprint returned during pairing. If the certificate files are replaced, clients must pair again.

## API Surface

Common local and remote endpoints:

| Route | Purpose |
|-------|---------|
| `GET /health` | Health check with protocol version. |
| `POST /pair` | Redeem a pairing code/session secret and mint a bearer token. |
| `POST /auth/revoke` | Revoke a paired device and release its PTY leases. |
| `GET /state` | Return a `SwarmSnapshot`; accepts cursor filtering. |
| `GET /stream` | WebSocket stream for table deltas, events, PTY frames, ping/pong, and replay. |
| `POST /reveal` | Reveal redacted KV/message/annotation content and audit the reveal. |
| `POST /pty` | Spawn a PTY. |
| `GET /pty/:id/replay` | Return retained PTY output as text for diagnostics. |
| `POST /pty/:id/input` | Write bytes to a PTY. |
| `POST /pty/:id/resize` | Resize a PTY. |
| `DELETE /pty/:id` | Close a PTY. |
| `POST /pty/:id/lease` | Request or take over interactive control. |
| `DELETE /pty/:id/lease` | Release interactive control. |

Local-only endpoints:

| Route | Purpose |
|-------|---------|
| `GET /auth/devices` | List paired devices. |
| `POST /auth/pairing-session` | Create a short-lived pairing session for `swarm-ui` Mobile Access. |
| `DELETE /auth/pairing-session/:id` | Cancel a pairing session. |

JSON RPC request/response bodies defined in `crates/swarm-protocol/src/rpc.rs` carry protocol field `v`. `GET /state` returns a `SwarmSnapshot` with cursors and `server_time`. WebSocket frames use the protocol types in `crates/swarm-protocol` and the Swift mirror in `apps/swarm-ios/Packages/SwarmProtocol`.

## Pairing Model

`swarm-ui` creates pairing sessions through the local socket. A session includes:

- a 6-digit code
- a one-shot `pairing_secret`
- server host and port
- the server certificate fingerprint
- an expiration timestamp

Pairing sessions expire after 120 seconds. A successful `POST /pair` returns a bearer token, device id, certificate fingerprint, and the visible swarm scopes for that device.

## PTY and Adoption Model

`POST /pty` supports these harnesses:

- `shell`
- `claude`
- `codex`
- `opencode`

Plain shell PTYs are unbound. For swarm-aware harnesses, the server creates a pending `instances` row with `adopted = 0`, binds that instance id to the PTY, and injects environment variables so the MCP subprocess can adopt the row. Orchestrators may also pass `instance_id` to bind the PTY to an existing unadopted pending row that they created before launch; the server rejects reattaching an already-adopted online row.

- `SWARM_MCP_INSTANCE_ID`
- `SWARM_MCP_DIRECTORY`
- `SWARM_MCP_SCOPE`
- `SWARM_MCP_FILE_ROOT`
- `SWARM_MCP_LABEL`
- `SWARM_SERVER_HARNESS`
- `SWARM_UI_ROLE`

When `src/index.ts` starts inside the harness, it auto-adopts the pending row and flips `adopted = 1`. If a harness exits before adoption, the server deletes the unadopted row. Long-running servers also reclaim offline unadopted rows that are no longer bound to a live PTY.

`POST /pty` publishes the PTY catalog row before deferred `initial_input` delivery so UI clients can render and attach immediately. Exited PTYs are retained briefly, including their replay buffer, so callers can fetch `/pty/:id/replay` after early exits or adoption failures.

Default role presets are `planner`, `implementer`, `reviewer`, and `researcher`. Direct `swarm-server` launches read extra roles from `$XDG_CONFIG_HOME/swarm-server/role-presets.json`, with `$XDG_CONFIG_HOME/swarm-ui/role-presets.json` as a legacy fallback. The desktop UI reads `$XDG_CONFIG_HOME/swarm-ui/role-presets.json`.

## Security Notes

This is a local development control plane. Local socket access is trusted. Remote access relies on pairing, bearer tokens, TLS certificate pinning, and per-token rate limiting, but it is still intended for trusted LAN use rather than exposure across trust boundaries.
