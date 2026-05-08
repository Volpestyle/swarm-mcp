# Swarm CLI

The `swarm-mcp` CLI has two uses:

1. Read/write shared swarm state from contexts that cannot speak MCP
2. Control a running `swarm-ui` app through the `swarm-mcp ui ...` command family

Inside an MCP-enabled agent session, prefer the MCP tools for swarm coordination primitives — they are the primary, structured, notification-integrated interface. Reach for the CLI when you are writing a helper script, operating from a plain terminal, or the user explicitly wants to drive `swarm-ui` from the CLI.

The CLI talks to the same SQLite database as the MCP server. For state/coordination commands it is a non-MCP transport for the same primitives. The `ui` subcommands add a small queue-based control surface for `swarm-ui`.

## When to reach for the CLI

- You are writing a helper script (e.g. a CLI referee, a test harness, a one-shot migration) that is invoked by an agent and needs to atomically update swarm state (KV, messages, locks) as part of its work.
- Without the CLI, the script would have to print coordination instructions for the calling agent to manually execute after the fact — splitting one logical action across two actors.
- With the CLI, the script performs the full operation itself in one invocation.
- You are in a plain terminal and want to inspect swarm state quickly without going through an MCP host.
- You want to control a running `swarm-ui` app: spawn nodes, forward prompts into PTYs, move nodes, or organize the canvas.

If the work is happening inside the agent's own loop and there is an MCP equivalent, call the MCP tool directly. Do not shell out just to read or mutate swarm state.

## Subcommands

Read-only (no identity required):

| Command | Purpose |
|--|--|
| `swarm-mcp inspect [--scope P] [--json]` | Unified dump: instances, tasks, context, kv, recent messages. |
| `swarm-mcp instances [--scope P]` | List live instances. |
| `swarm-mcp messages [--to W] [--from W] [--limit N]` | Peek messages. Does not mark them read. |
| `swarm-mcp tasks [--status S] [--scope P]` | List tasks. |
| `swarm-mcp context [--scope P]` | List locks + annotations. |
| `swarm-mcp kv list [--prefix P] [--scope P]` | List KV keys. |
| `swarm-mcp kv get <key> [--scope P]` | Print a KV value. Exits 1 if missing. |

Writes (require an identity):

| Command | Purpose |
|--|--|
| `swarm-mcp send --to <who> <content...>` | Send a direct message. |
| `swarm-mcp broadcast <content...>` | Fan out to every other instance in scope. |
| `swarm-mcp kv set <key> <value>` | Set a KV entry. |
| `swarm-mcp kv append <key> <json>` | Append to a KV array value. |
| `swarm-mcp kv del <key>` | Delete a KV entry. |
| `swarm-mcp lock <file> [--note "..."]` | Acquire an exclusive file lock. |
| `swarm-mcp unlock <file>` | Release your file lock. |

Every command accepts `--json` for machine-readable output.

Swarm UI control:

| Command | Purpose |
|--|--|
| `swarm-mcp ui list [--scope P] [--status S] [--limit N]` | List queued/running/completed UI commands. |
| `swarm-mcp ui get <id>` | Inspect one UI command, including result/error. |
| `swarm-mcp ui spawn <cwd> [--harness H] [--role R] [--label L] [--scope P] [--wait N]` | Ask a running `swarm-ui` app to spawn a new PTY/node. |
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

const scope = process.env.SWARM_SCOPE;   // or compute it
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
- **Impersonation**: `--as` trusts the caller. The CLI will happily write as any live instance. This is fine for scripts the agent spawns locally; don't expose the binary to untrusted callers.
- **Message peek vs poll**: `swarm-mcp messages` does not consume messages. Use it for observation; use MCP `poll_messages` inside an agent to consume.
- **Stale agents**: the CLI calls `prune()` at startup (same as every MCP call), so stale instances disappear before the command runs.
- **UI commands need the desktop app**: `swarm-mcp ui ...` only executes if a `swarm-ui` app is running and watching the shared DB.
- **UI organize is intentionally small**: today `ui organize` supports only `grid`.
- **Not for inside-session state access**: if your agent has the swarm MCP tools mounted, use them for swarm state. Shelling out to the CLI from inside the agent loop adds a subprocess, bypasses notifications, and clutters reasoning.
