# Swarm CLI (for scripts)

Use the `swarm-mcp` CLI **only from helper scripts** (shell, node, python, etc.) that need to read or write swarm state. Inside an MCP-enabled agent session, prefer the MCP tools — they are the primary, structured, notification-integrated interface.

The CLI talks to the same SQLite database as the MCP server. It is a non-MCP transport for the same primitives, not a new capability layer.

## When to reach for the CLI

- You are writing a helper script (e.g. a CLI referee, a test harness, a one-shot migration) that is invoked by an agent and needs to atomically update swarm state (KV, messages, locks) as part of its work.
- Without the CLI, the script would have to print coordination instructions for the calling agent to manually execute after the fact — splitting one logical action across two actors.
- With the CLI, the script performs the full operation itself in one invocation.

If the work is happening inside the agent's own loop, call the MCP tool directly. Do not shell out.

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
- **Not for inside-session use**: if your agent has the swarm MCP tools mounted, use them. Shelling out to the CLI from inside the agent loop adds a subprocess, bypasses notifications, and clutters reasoning.
