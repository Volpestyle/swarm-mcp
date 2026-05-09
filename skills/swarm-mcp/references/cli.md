# Swarm CLI

The `swarm-mcp` CLI has three uses:

1. Read/write shared swarm state from contexts that cannot speak MCP
2. Control a running `swarm-ui` app through the `swarm-mcp ui ...` command family
3. Install project-local MCP config and the bundled skills with `swarm-mcp init`

Inside an MCP-enabled agent session, prefer the MCP tools for swarm coordination primitives — they are the primary, structured, notification-integrated interface. Reach for the CLI when you are writing a helper script, operating from a plain terminal, or the user explicitly wants to drive `swarm-ui` from the CLI.

When launcher aliases set `SWARM_MCP_BIN`, use that value as the command prefix
instead of assuming a literal `swarm-mcp` binary exists on `PATH`. For example,
if `SWARM_MCP_BIN='bun run /path/to/swarm-mcp/src/cli.ts'`, run:

```sh
bun run /path/to/swarm-mcp/src/cli.ts dispatch ...
```

Use `swarm-mcp ...` only when no launcher-provided prefix exists and the binary
is actually resolvable.

The CLI talks to the same SQLite database as the MCP server. For state/coordination commands it is a non-MCP transport for the same primitives. The `ui` subcommands add a small queue-based control surface for `swarm-ui`.

Two higher-level helpers exist for non-MCP callers: `request-task` creates an
idempotent swarm task, and `dispatch` creates/reuses a task, wakes a matching
live worker when one exists, or queues a guarded `swarm-ui` spawn. Inside an
MCP-enabled agent session, prefer `request_task`, `prompt_peer`, and related
MCP tools directly.

## When to reach for the CLI

- You are writing a helper script (e.g. a CLI referee, a test harness, a one-shot migration) that is invoked by an agent and needs to atomically update swarm state (KV, messages, locks) as part of its work.
- Without the CLI, the script would have to print coordination instructions for the calling agent to manually execute after the fact — splitting one logical action across two actors.
- With the CLI, the script performs the full operation itself in one invocation.
- You are in a plain terminal and want to inspect swarm state quickly without going through an MCP host.
- You want to control a running `swarm-ui` app: spawn nodes, forward prompts into PTYs, move nodes, or organize the canvas.

If the work is happening inside the agent's own loop and there is an MCP equivalent, call the MCP tool directly. Do not shell out just to read or mutate swarm state.

## Subcommands

Setup:

| Command | Purpose |
|--|--|
| `swarm-mcp init [--dir P] [--force] [--no-skills]` | Write `.mcp.json` and copy `skills/swarm-mcp` plus `skills/swarm-deepdive` into `.claude/skills/` unless `--no-skills` is passed. |

Read-only (no identity required):

| Command | Purpose |
|--|--|
| `swarm-mcp inspect [--scope P] [--json]` | Unified dump: instances, tasks, context, kv, recent messages. |
| `swarm-mcp cleanup [--scope P] [--dry-run] [--json]` | Run retention cleanup for offline instances, TTL rows, and orphaned instance-scoped KV. |
| `swarm-mcp instances [--scope P] [--json]` | List live instances. |
| `swarm-mcp list-instances [--scope P] [--json]` | Alias for `instances`, useful for scripts that mirror the MCP tool name. |
| `swarm-mcp messages [--to W] [--from W] [--limit N]` | Peek messages. Does not mark them read. |
| `swarm-mcp tasks [--status S] [--scope P]` | List tasks. |
| `swarm-mcp context [--scope P]` | List locks + annotations. |
| `swarm-mcp kv list [--prefix P] [--scope P]` | List KV keys. |
| `swarm-mcp kv get <key> [--scope P]` | Print a KV value. Exits 1 if missing. |

Lifecycle and identity:

| Command | Purpose |
|--|--|
| `swarm-mcp register [directory] [--label L] [--scope P] [--file-root P] [--lease-seconds N] [--json]` | Register an instance from a hook or non-MCP host. `--lease-seconds` is for hook-managed sessions that do not have an MCP heartbeat timer. |
| `swarm-mcp deregister [--as W] [--scope P] [--json]` | Deregister an instance and release its tasks/locks. |
| `swarm-mcp whoami [--as W] [--scope P] [--json]` | Resolve an identity reference and print the registered instance. |

Writes (require an identity):

| Command | Purpose |
|--|--|
| `swarm-mcp request-task <type> <title...> [--description D] [--file P] [--priority N] [--idempotency-key K]` | Create a task as the current identity. |
| `swarm-mcp dispatch <title...> [--message M] [--type T] [--role R] [--harness H] [--idempotency-key K] [--no-spawn] [--wait N]` | Create/reuse a task, wake a live `role:R` worker, or enqueue a guarded `swarm-ui` spawn. |
| `swarm-mcp send --to <who> <content...>` | Send a direct message. |
| `swarm-mcp prompt-peer --to <who> --message <text> [--task ID] [--force] [--no-nudge]` | Send a durable direct message, then best-effort wake the target's published herdr pane. |
| `swarm-mcp broadcast <content...>` | Fan out to every other instance in scope. |
| `swarm-mcp kv set <key> <value>` | Set a KV entry. |
| `swarm-mcp kv append <key> <json>` | Append to a KV array value. |
| `swarm-mcp kv del <key>` | Delete a KV entry. |
| `swarm-mcp lock <file> [--note "..."]` | Acquire an exclusive file lock. |
| `swarm-mcp unlock <file>` | Release your file lock. |

State, write, and UI commands accept `--json` for machine-readable output where supported by `swarm-mcp help`.

Swarm UI control:

| Command | Purpose |
|--|--|
| `swarm-mcp ui list [--scope P] [--status S] [--limit N]` | List queued/running/completed UI commands. |
| `swarm-mcp ui get <id>` | Inspect one UI command, including result/error. |
| `swarm-mcp ui spawn <cwd> [--harness H] [--role R] [--label L] [--scope P] [--wait N]` | Ask a running `swarm-ui` app to spawn a new PTY/node. Supported harness values are the work-identity launchers `claude`, `codex`, `opencode`, `hermesw` (and `clawd` for Claude with `--enable-auto-mode`) and the personal-identity launchers `clowd`, `cdx`, `opc`, `hermesp` — pick the launcher that matches the spawned worker's identity per [`identity-boundaries`](../../../docs/identity-boundaries.md). Omit `--harness` for a plain shell. |
| `swarm-mcp ui prompt --target T <content...> [--no-enter] [--scope P] [--wait N]` | Forward input to a node's PTY. |
| `swarm-mcp ui move --target T --x X --y Y [--scope P] [--wait N]` | Move a node and persist layout. |
| `swarm-mcp ui organize [--kind grid] [--scope P] [--wait N]` | Auto-organize the scope's canvas layout. |

## Identity resolution (for writes)

Identity is resolved in this order:

1. `--as <value>` flag
2. `SWARM_MCP_INSTANCE_ID` environment variable
3. The sole live instance in scope (if exactly one)
4. Error

`<value>` and `--to <who>` accept any of:

- A full UUID
- An unambiguous UUID prefix
- An unambiguous substring of an instance label

Ambiguous matches error with the list of candidates.

## Scope resolution

`--scope <path>` overrides. Otherwise the CLI resolves scope the same way `register` does: git root of the current working directory, falling back to the directory itself. Always pass `--scope` from scripts that may be invoked from anywhere.

## Peer wakeups

`prompt-peer` is the CLI equivalent of the MCP `prompt_peer` tool. It always sends the real instruction through swarm messages first. If the target has published `identity/herdr/<instance_id>` in KV, the command then asks herdr for the pane status and injects only a short wake prompt telling the worker to call `poll_messages`.

The work contract should live in the swarm message or task, not in raw pane input. If no herdr identity exists, the message is still delivered and the nudge is skipped. If the target pane is `working`, the nudge is skipped unless `--force` is passed.

## Dispatch Helper

`swarm-mcp dispatch` is the CLI bridge for gateway-style flows that cannot call
MCP tools directly or need to cross into herdr/`swarm-ui` process control. In
launcher-managed sessions, replace `swarm-mcp` with `SWARM_MCP_BIN` when that
environment variable is set. The helper does four things:

1. Creates or reuses a task using `--idempotency-key` when provided, otherwise
   an auto-derived key from scope, type, title, message, and role.
2. Looks for a live peer whose label contains `role:<role>` (default:
   `role:implementer`). If found, it sends the task instruction through
   `prompt-peer`.
3. If no worker is live and spawning is allowed, it enqueues `ui spawn` for a
   running `swarm-ui` app.
4. While the spawn command is pending/running, it holds a synthetic lock at
   `/__swarm/spawn/<role>/<intent_hash>` so retries return `spawn_in_flight`
   instead of queueing duplicate workers.

If no `swarm-ui` app is running, the UI command remains pending and the spawn
lock remains in place. A later retry with the same idempotency key sees the
in-flight lock instead of creating another pane.

Spawn/dispatch authority is intentionally narrow: gateway/lead sessions and
operator surfaces may use this helper; ordinary worker/generalist sessions
should create or claim tasks, message the planner/gateway, or continue locally
when safe. The CLI enforces this for identified callers by requiring the
requester label to include `mode:gateway`; trusted operator shells can override
the guard with `SWARM_MCP_ALLOW_SPAWN=1`.

## UI command model

`swarm-mcp ui ...` is asynchronous.

- The CLI enqueues a command row into the shared DB.
- A running `swarm-ui` desktop app claims and executes it.
- If no desktop app is running, the command stays `pending`.
- `ui spawn`, `ui prompt`, `ui move`, and `ui organize` wait up to 5 seconds by default for completion. Pass `--wait 0` to return immediately after enqueue.
- Use `ui list` or `ui get` to inspect progress later.

## UI target resolution

`--target` accepts:

- `bound:<instance-id>`
- `instance:<instance-id>`
- `pty:<pty-id>`
- A bare instance reference
- A bare PTY reference

Bare instance references resolve by:

- Full instance UUID
- Unique UUID prefix
- Unique substring of an instance label

Bare PTY references resolve by:

- Full PTY id
- Unique PTY id prefix
- Unique substring of the PTY command

If a bare target could match multiple rows, the command fails as ambiguous.

## Canonical pattern: helper script invoked by an agent

When you write a helper script that needs to participate in swarm coordination, pass the invoking agent's instance id in through the environment so the script can attribute its writes correctly:

```js
// harness.mjs — invoked by an agent with SWARM_MCP_INSTANCE_ID set
import { execFileSync } from "node:child_process";

const scope = process.env.SWARM_MCP_SCOPE; // or compute it
const me = process.env.SWARM_MCP_INSTANCE_ID;
const partner = process.argv[2];

// ... validate input, write files ...

execFileSync("swarm-mcp", [
  "kv", "set", "pixel:turn", JSON.stringify(nextTurn),
  "--scope", scope, "--as", me,
]);
execFileSync("swarm-mcp", [
  "send", "--to", partner, `your turn (${nextTurn.n})`,
  "--scope", scope, "--as", me,
]);
```

The agent calls `node harness.mjs <partner-id>` once. The script does validation, file writes, KV update, and message handoff in one atomic-from-the-agent's-POV invocation. The agent then returns to its `wait_for_activity` loop and receives the response when the partner acts.

## Caveats

- **Exit codes**: 0 on success, 1 on any error (unknown ref, lock conflict, missing key on `kv get`). Check in scripts.
- **Impersonation**: `--as` trusts the caller. The CLI will write as any live instance, though spawn/dispatch helpers require `mode:gateway` unless `SWARM_MCP_ALLOW_SPAWN=1` is set. This is fine for scripts the agent spawns locally; don't expose the binary to untrusted callers.
- **Message peek vs poll**: `swarm-mcp messages` does not consume messages. Use it for observation; use MCP `poll_messages` inside an agent to consume.
- **Stale agents**: the CLI calls `prune()` at startup (same as every MCP call). Instances are marked stale after about 30s without a heartbeat and reclaimed after about 60s, which releases their work and clears locks/messages.
- **UI commands need the desktop app**: `swarm-mcp ui ...` only executes if a `swarm-ui` app is running and watching the shared DB.
- **UI organize is intentionally small**: today `ui organize` supports only `grid`.
- **Not for inside-session state access**: if your agent has the swarm MCP tools mounted, use them for swarm state. Shelling out to the CLI from inside the agent loop adds a subprocess, bypasses notifications, and clutters reasoning.
