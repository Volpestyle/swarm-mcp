# Backend Configuration

This doc explains where consumer configuration lives for `swarm-mcp`, workspace backends, spawners, and runtime integrations.

The short version: agents should keep using swarm tools (`dispatch`, `prompt_peer`, tasks, messages). Backend selection belongs to launcher/config, not to normal agent reasoning.

## Mental Model

![Control-plane and backend configuration overview](./diagrams/backend-configuration.png)

Source: [`docs/diagrams/backend-configuration.mmd`](./diagrams/backend-configuration.mmd). Render with `bun run diagrams`.

Durable coordination uses swarm `instance_id` and state in `swarm.db`. Workspace handles such as herdr `pane_id` or a future swarm-server `pty_id` are transport-local and live behind workspace identity rows.

Spawner and workspace backends are capability boundaries, not necessarily different products. The spawner creates a new worker; the workspace backend resolves or wakes an already-published handle for an existing worker. Herdr currently implements both capabilities, while `swarm-ui` is only a spawner backend.

Work tracker selection is separate from workspace/backend selection. Runtime hooks publish configured same-identity tracker metadata to swarm KV at `config/work_tracker/<identity>` when present, and `bootstrap` returns the matching row. Agents should then verify the matching MCP is available; they should not choose a tracker from the loaded MCP list alone.

## Configuration Layers

| Layer | Owns | Examples |
|---|---|---|
| MCP host config | Mounts the `swarm` MCP server in an agent host. | `.mcp.json`, `~/.codex/config.toml`, `~/.claude.json`, opencode config |
| Runtime integration config | Hooks/plugin behavior for a host. | Hermes plugin, Claude Code hooks, Codex plugin hooks |
| Launcher/profile config | Account and tool visibility boundary. | `swarm_define_profile` aliases from `env/launchers.zsh.example` |
| Work tracker config | Human-facing tracker selection by repo/scope and identity. | `~/.config/swarm-mcp/<identity>.env`, `SWARM_<runtime>_WORK_TRACKER`, `SWARM_WORK_TRACKER`, `.swarm-work-tracker`, Hermes `swarm.work_tracker` |
| Coordinator config | Shared DB and swarm scope defaults. | `SWARM_DB_PATH`, `SWARM_MCP_SCOPE`, `SWARM_MCP_FILE_ROOT` |
| Spawner config | Which backend creates new workers. | `SWARM_SPAWNER`, `SWARM_DISPATCH_SPAWNER`, `dispatch(... spawner)` |
| Workspace backend config | Which backend resolves/wakes existing published workspace handles. | Current default: `herdr`; future: configurable backend default |

## Current Supported Backends

| Capability | Current support | Selection |
|---|---|---|
| Workspace wake/handle backend | `herdr` only | Published KV row `identity/workspace/herdr/<instance_id>` |
| Default spawner backend | `herdr` | Default when no spawner is specified |
| Alternate spawner backend | `swarm-ui` | `SWARM_SPAWNER=swarm-ui`, `SWARM_DISPATCH_SPAWNER=swarm-ui`, or `dispatch(... spawner: "swarm-ui")` |
| `swarm-server` backend | Not active as a `swarm-mcp` backend yet | Requires new backend implementations before config can select it |

`swarm-server` exists today as the Rust desktop/mobile daemon. It is documented in [`swarm-server.md`](./swarm-server.md), but it is not yet registered as a `swarm-mcp` workspace backend or spawner backend.

The same adapter family may provide both capabilities. Keeping the contracts separate lets a gateway use one backend to request creation, then let workers publish whatever workspace handle they actually receive for later wakeups.

## Current Herdr Setup

Herdr-launched workers publish workspace identity when these env vars are present:

| Env var | Purpose |
|---|---|
| `HERDR_PANE_ID` / `HERDR_PANE` | Transport-local pane handle to publish. |
| `HERDR_SOCKET_PATH` | Herdr socket used by wake/status calls and direct `pane.report_agent` status reporting. |
| `HERDR_WORKSPACE_ID` | Optional workspace metadata. |
| `SWARM_HERDR_BIN` | Optional non-default `herdr` binary path. |

For local development, prefer identity-scoped shared herdr sockets:

```sh
# work
export HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/work/herdr.sock

# personal
export HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock
```

Launch both the visible desktop herdr server and the matching-identity gateway
with the same value. The personal path is visible to sandboxed personal gateways
that can access `/Users/james.volpe/volpestyle`, while keeping it separate from
work identity state. Work identities use their own host-visible socket under
`/Users/james.volpe/.config/herdr/sessions/work`.

The published KV row is:

```text
identity/workspace/herdr/<instance_id>
```

with a value like:

```json
{
  "schema_version": 1,
  "backend": "herdr",
  "handle_kind": "pane",
  "handle": "pane-id",
  "pane_id": "pane-id",
  "socket_path": "/path/to/herdr.sock",
  "workspace_id": "workspace-id"
}
```

Runtime integrations also write the legacy compatibility key `identity/herdr/<instance_id>` for current consumers. New integrations should publish the generic `identity/workspace/<backend>/<instance_id>` shape.

When both `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`/`HERDR_PANE` are present,
runtime hooks also report pane agent status directly to herdr with
`pane.report_agent` after successful swarm registration and call
`pane.release_agent` during cleanup. Missing env vars, socket errors, or herdr
RPC errors are fail-open: the workspace identity KV still publishes when
possible, and herdr falls back to its normal process/output heuristics.

## Current Dispatch/Spawner Setup

Gateway sessions should call the MCP `dispatch` tool. Operator shells and hooks can use `swarm-mcp dispatch`.

Spawner selection order:

1. Explicit `dispatch(... spawner: "...")` or CLI `--spawner`.
2. `SWARM_SPAWNER`.
3. `SWARM_DISPATCH_SPAWNER`.
4. Default: `herdr`.

Herdr dispatch uses:

| Env var | Purpose |
|---|---|
| `HERDR_PANE_ID` / `HERDR_PANE` / `SWARM_HERDR_PARENT_PANE` | Parent pane to split from. |
| `SWARM_HERDR_SPLIT_DIRECTION` | Split direction; default `right`. |
| `SWARM_WORKER_HARNESS` / `SWARM_DISPATCH_HARNESS` | Worker launcher command. |
| `SWARM_HERDR_BIN` | Optional non-default `herdr` binary path. |

Dispatch chooses the worker launcher from the requester identity, not from the
current shell alone. It reads `SWARM_HARNESS_CLAUDE` / `_CODEX` / `_OPENCODE` /
`_HERMES` from the requester's profile env (`~/.config/swarm-mcp/<profile>.env`)
to resolve the launcher alias for each canonical harness. Generic harness
requests (`claude`, `codex`, `opencode`, `hermes`) and cross-profile aliases
both normalize through this mapping. The herdr spawner pre-creates a swarm
instance lease with the requester `identity:` token, injects
`SWARM_MCP_INSTANCE_ID` and `SWARM_MCP_LABEL`, and waits for the worker to
adopt/register. Dispatch releases the spawn mutex only after the worker is
registered and bound to the task.

Dispatch itself still returns immediately after task handoff/spawn unless the
caller opts into task completion monitoring. Use MCP
`completion_wait_seconds` or CLI `--wait-for-completion <seconds>` to wait for
the task state to reach `done`, `failed`, or `cancelled`; the response keeps
the normal dispatch status and adds a `completion` object.

## Switching To Swarm Server Later

Switching to `swarm-server` should be a config flip only after the backend support exists.

Required implementation first:

1. Add a `swarm-server` `WorkspaceBackend` for resolving and waking PTY/session handles.
2. Add a `swarm-server` `SpawnerBackend` for creating worker PTYs through the daemon.
3. Register both backends in the MCP server/CLI startup path.
4. Update launchers/hooks so swarm-server-launched workers publish `identity/workspace/swarm-server/<instance_id>`.

Expected future consumer config shape:

```sh
SWARM_SPAWNER=swarm-server
SWARM_WORKSPACE_BACKEND=swarm-server
SWARM_SERVER_URL=http://127.0.0.1:5444
```

`SWARM_WORKSPACE_BACKEND` is the intended future default selector for handle resolution, but it is not implemented today. Today, workspace wake resolution works from the backend name embedded in the published identity row, and only `herdr` is registered.

Future swarm-server identity rows should look like:

```text
identity/workspace/swarm-server/<instance_id>
```

```json
{
  "schema_version": 1,
  "backend": "swarm-server",
  "handle_kind": "pty",
  "handle": "pty-id",
  "pty_id": "pty-id",
  "server_url": "http://127.0.0.1:5444"
}
```

## What Agents Should Do

Agents should not decide whether the transport is herdr, swarm-ui, or swarm-server.

- Use `dispatch` for gateway spawn/routing.
- Use `send_message`, `request_task`, and `prompt_peer` for coordination.
- Target swarm `instance_id`, never raw pane/PTY IDs.
- Let workspace identity and backend adapters handle transport-specific wakeups.

If a backend is not configured or not available, agents should report that and ask the operator rather than inventing another spawn path.
