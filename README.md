# swarm-mcp

MCP server that lets multiple coding-agent sessions on the same machine discover each other and collaborate through a shared SQLite database.

Each session spawns its own swarm-mcp server process via stdio. They all share one SQLite file at `~/.swarm-mcp/swarm.db` by default. No daemon needed.

[GitHub](https://github.com/Volpestyle/swarm-mcp)

---

## Quick start

If you want a first-run walkthrough, start with [`docs/getting-started.md`](./docs/getting-started.md).

Install dependencies:

```sh
cd /path/to/swarm-mcp
bun install
```

Add the server to your coding agent using that host's MCP config format. Bun is the simplest dev/runtime path because the examples use `bun run`, but the built `dist/*.js` entrypoints also run under Node 20+ with `better-sqlite3`.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.swarm]
command = "bun"
args = ["run", "/path/to/swarm-mcp/src/index.ts"]
cwd = "/path/to/swarm-mcp"
```

### opencode (`~/.config/opencode/opencode.json`)

```json
{
  "mcp": {
    "swarm": {
      "type": "local",
      "command": ["bun", "run", "/path/to/swarm-mcp/src/index.ts"],
      "enabled": true
    }
  }
}
```

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "swarm": {
      "command": "bun",
      "args": ["run", "/path/to/swarm-mcp/src/index.ts"]
    }
  }
}
```

Tool names are usually namespaced by the client using the server name. Depending on the host you may see `swarm_register`, `mcp__swarm__register`, or other variants. Use whichever form your host exposes.

Call the swarm `register` tool first to join the swarm.

### Further reading

- [`docs/getting-started.md`](./docs/getting-started.md) -- beginner-friendly setup and verification walkthrough
- [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) -- copy-paste coordination rules for any agent host (generalist)
- [`docs/agents-planner.md`](./docs/agents-planner.md) -- drop-in AGENTS.md for planner sessions (plans work, reviews results)
- [`docs/agents-implementer.md`](./docs/agents-implementer.md) -- drop-in AGENTS.md for implementer sessions (claims tasks, edits code)
- [`docs/roles-and-teams.md`](./docs/roles-and-teams.md) -- role/team conventions, multi-team workflows, and handoff examples
- [`docs/install-skill.md`](./docs/install-skill.md) -- host-specific install paths for the bundled single-skill workflow
- [`docs/swarm-server.md`](./docs/swarm-server.md) -- Rust daemon for desktop UI, mobile pairing, PTY streaming, and LAN access
- [`skills/swarm-mcp`](./skills/swarm-mcp) -- installable skill source with role references for hosts with skill ecosystems

---

## MCP server vs swarm-server

The TypeScript `swarm-mcp` process is the stdio MCP server used by coding-agent hosts. It is enough for local multi-agent coordination through tools, resources, prompts, and the shared SQLite database.

The Rust `apps/swarm-server` daemon is a separate desktop/mobile control plane. It serves `swarm-ui` over a local Unix socket, exposes HTTPS/WSS on port 5444 for paired iOS/iPadOS clients, manages PTYs, and reads the same `swarm.db`. It is not required for the basic MCP setup above. See [`docs/swarm-server.md`](./docs/swarm-server.md).

---

## How it works

All sessions read and write to `~/.swarm-mcp/swarm.db` by default using WAL mode, auto-vacuum, and a 3s busy timeout. Bun uses `bun:sqlite`; Node uses `better-sqlite3`.

Set `SWARM_DB_PATH` before launching the server if you want a different database location.

When you call `register`, the server starts a 10s heartbeat and a 5s notification poller.

### Registration fields

The `register` tool accepts these parameters. Only `directory` is required.

| Field | Required | Description |
|-------|----------|-------------|
| `directory` | Yes | The live working directory for the current session. |
| `scope` | No | Shared swarm boundary. Sessions in the same scope can see each other; different scopes are different swarms. Defaults to the detected git root, or to `directory` when no git root exists. Use a new scope only for a separate swarm; do not split frontend/backend inside one repo with scope. Use `team:` label tokens for that. |
| `file_root` | No | Canonical base path for resolving relative file paths in `annotate`, `lock_file`, `check_file`, and task `files`. Useful when disposable worktrees should share one logical file tree. |
| `label` | No | Free-form identity text. Recommended convention: machine-readable space-separated tokens like `provider:codex-cli role:planner`. The `role:` token is optional; if missing, the session is treated as a generalist. |

### Task features

Tasks support several features for building autonomous DAG-based workflows:

| Feature | Description |
|---------|-------------|
| `priority` | Integer (default 0). Higher = more urgent. `list_tasks` returns tasks sorted by priority descending. Implementers claim the highest-priority open task first. |
| `depends_on` | Array of task IDs. A task with unmet dependencies starts as `blocked` and auto-transitions to `open` when all deps reach `done`. If any dependency fails, downstream tasks are auto-cancelled. |
| `idempotency_key` | Unique string. If a task with this key already exists, `request_task` returns the existing task instead of creating a duplicate. Essential for crash-safe plan retries. |
| `parent_task_id` | Optional parent task ID for tree-structured work tracking. |
| `approval_required` | If true, task starts in `approval_required` status and must be approved via `approve_task` before work begins. Use this for true approval gates, not routine code review. |

Task statuses: `open`, `claimed`, `in_progress`, `done`, `failed`, `cancelled`, `blocked`, `approval_required`.

### Session resets and prompt compaction

If a host compacts context, starts a fresh window, or loses the previous bootstrap, rejoin the swarm the same way:

1. Call `register` again.
2. Rehydrate from `poll_messages`, `list_tasks`, and `list_instances`.
3. For planners, also check `kv_get("owner/planner")` and `kv_get("plan/latest")`.

The durable coordination state lives in the shared database, not in repeated per-tool prompt text.

---

## Auto-cleanup

| Data                             | TTL        |
| -------------------------------- | ---------- |
| Stale instances (no heartbeat)   | 30 seconds |
| Messages                         | 1 hour     |
| Completed/failed/cancelled tasks | 24 hours   |
| Non-lock context annotations     | 24 hours   |
| Events                           | 24 hours   |

When a session expires, stale claimed or in-progress tasks are released back to `open` and that session's file locks are removed.

Non-lock annotations are cleaned up by TTL, while locks stay exclusive and are cleared when the owning instance goes stale or deregisters.

---

## Tools

### Instance registry

| Tool              | Description                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `register`        | Join the swarm. Starts heartbeat + notification poller. See [Registration fields](#registration-fields). |
| `deregister`      | Leave the swarm gracefully. Releases tasks and locks.                                                                |
| `list_instances`  | List all live instances.                                                                                             |
| `remove_instance` | Forcefully remove another instance. Releases its tasks and locks.                                                    |
| `whoami`          | Get this instance's swarm ID.                                                                                        |

### Messaging

| Tool                | Description                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `send_message`      | Send a direct message to a specific instance by ID.                                                            |
| `broadcast`         | Message all other instances in the swarm.                                                                      |
| `poll_messages`     | Read unread messages and mark them as read.                                                            |
| `wait_for_activity` | Block until new messages, task changes, KV changes, or instance changes arrive. Use as an idle loop for autonomous agents. |

### Task delegation

| Tool                 | Description                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `request_task`       | Post a task (types: `review`, `implement`, `fix`, `test`, `research`, `other`). Use `review` for routine code review handoff. Supports `priority`, `depends_on`, `idempotency_key`, `parent_task_id`, and `approval_required`. |
| `request_task_batch` | Create multiple tasks atomically in a single transaction. Supports `$N` references (1-indexed) for intra-batch dependencies. |
| `claim_task`         | Claim an open task. Prevents double-claiming.                                                                             |
| `update_task`        | Update a claimed task to `in_progress`, `done`, `failed`, or `cancelled`. Attach a result when useful.                    |
| `approve_task`       | Approve a task in `approval_required` status. Transitions to `open`/`claimed` (or `blocked` if deps unmet).               |
| `get_task`           | Get full details of a task.                                                                                               |
| `list_tasks`         | Filter tasks by status, assignee, or requester. Sorted by priority (highest first).                                       |

### Shared context and file locking

| Tool             | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `annotate`       | Share findings, warnings, bugs, notes, or todos about a file. |
| `lock_file`      | Acquire an exclusive file lock so others avoid editing it.    |
| `unlock_file`    | Release a file lock.                                          |
| `check_file`     | See annotations and locks before editing a file.              |
| `search_context` | Search annotations by file path or content.                   |

### Key-value store

| Tool        | Description                                    |
| ----------- | ---------------------------------------------- |
| `kv_get`    | Get a value by key.                            |
| `kv_set`    | Set a key-value pair visible to all instances. |
| `kv_append` | Atomically append a JSON value to a KV array.  |
| `kv_delete` | Delete a key.                                  |
| `kv_list`   | List keys, optionally filtered by prefix.      |

---

## CLI

The same `swarm-mcp` binary exposes a non-MCP CLI that talks directly to `~/.swarm-mcp/swarm.db`. Use it from contexts that cannot speak MCP: shell scripts, helper scripts an agent invokes (e.g. a test harness or CLI referee), cron jobs, CI, an ad-hoc terminal for inspection/debugging, or to control a running `swarm-ui` app.

Inside an MCP-enabled agent session, prefer the MCP tools for swarm coordination primitives (`register`, messages, tasks, locks, KV). The CLI is primarily for scripts, operator terminals, and the `swarm-ui` control surface.

Setup helper:

```sh
swarm-mcp init --dir /path/to/project   # write .mcp.json and copy the bundled skill
swarm-mcp init --no-skills              # write only the MCP config
```

`init` writes a project `.mcp.json` entry that runs `npx -y swarm-mcp` and, unless `--no-skills` is passed, copies `skills/swarm-mcp` into `.claude/skills/swarm-mcp`. Manual host-specific MCP configs are still useful when your host does not read `.mcp.json` or you want to run from a local clone.

Inspection:

```sh
swarm-mcp inspect                    # unified dump of instances, tasks, kv, locks, recent messages
swarm-mcp inspect --scope /path      # pin to an explicit scope
swarm-mcp messages --from <who>      # peek (does not mark read)
swarm-mcp kv list --prefix pixel:
swarm-mcp kv get pixel:turn
```

Writes (require identity — pass `--as <uuid | prefix | unique-label-substring>` or set `SWARM_MCP_INSTANCE_ID`; falls back to the sole live instance in scope):

```sh
swarm-mcp send --to <who> "message text"
swarm-mcp broadcast "status update"
swarm-mcp kv set  <key> <value>
swarm-mcp kv append <key> <json-value>
swarm-mcp kv del  <key>
swarm-mcp lock    <file> --note "why"
swarm-mcp unlock  <file>
```

Swarm UI control:

```sh
swarm-mcp ui spawn /path/to/repo --harness codex --role planner
swarm-mcp ui prompt --target role:planner "check the failing tests"
swarm-mcp ui move --target bound:<instance-id> --x 120 --y 80
swarm-mcp ui organize --kind grid
swarm-mcp ui list
```

These commands enqueue work for a running `swarm-ui` app to claim and execute. If no desktop app is running, commands remain `pending` until one starts.

Notes:

- `swarm-mcp ui spawn`, `ui prompt`, `ui move`, and `ui organize` wait up to 5 seconds by default for the desktop app to claim + complete the command. Pass `--wait 0` to return immediately after enqueue.
- `ui spawn` accepts `--harness claude`, `--harness codex`, or `--harness opencode`; omit `--harness` for a plain shell.
- Use `swarm-mcp ui list` and `swarm-mcp ui get <id>` to inspect queued, running, completed, or failed UI commands.
- `--target` accepts `bound:<instance-id>`, `instance:<instance-id>`, `pty:<pty-id>`, or a bare instance / PTY reference. Bare instance refs resolve by full UUID, unique UUID prefix, or unique label substring in scope. Bare PTY refs resolve by full PTY id, unique PTY id prefix, or a unique substring of the PTY command.
- `ui move` persists layout into the shared `ui/layout` KV entry for the target scope, so changes survive refreshes and can be driven from either the desktop UI or the CLI.
- `ui organize` currently supports only `--kind grid`.

State, write, and UI subcommands accept `--json` for machine-readable output where shown by `swarm-mcp help`.

Canonical helper-script pattern — a harness the agent invokes to do validation + state update + handoff in one shot:

```js
// harness.mjs — run as `node harness.mjs <partner-id>` by an agent
import { execFileSync } from "node:child_process";
const me = process.env.SWARM_MCP_INSTANCE_ID;
const scope = process.env.SWARM_SCOPE;
// ... validate and write artifacts ...
execFileSync("swarm-mcp", ["kv", "set", "turn", JSON.stringify(next), "--scope", scope, "--as", me]);
execFileSync("swarm-mcp", ["send", "--to", partner, "your turn", "--scope", scope, "--as", me]);
```

Security note: `--as` trusts the caller. The CLI will write as any live instance. Do not expose this binary to untrusted callers — the security model is the same as the underlying shared SQLite file.

---

## Resources

The server exposes 4 MCP resources. `swarm://inbox`, `swarm://tasks`, and `swarm://instances` are refreshed by the background poller when the host supports resource update notifications.

| URI                        | Description                                |
| -------------------------- | ------------------------------------------ |
| `swarm://inbox`            | Unread messages for this instance.         |
| `swarm://tasks`            | Tasks grouped by status, including open, claimed, in-progress, blocked, approval-required, done, failed, and cancelled. |
| `swarm://instances`        | All active instances.                      |
| `swarm://context?file=...` | Annotations and locks for a specific file. |

---

## Prompts

The server exposes MCP prompts. Some hosts surface them directly, while others only expose tools and resources.

| Prompt | Purpose |
| ------ | ------- |
| `setup` (often shown as `swarm:setup`) | Guides the agent through registration: call `register`, `poll_messages`, `list_tasks`, then summarize swarm ID, active sessions, role labels, open tasks, and coordination risks. |
| `protocol` (often shown as `swarm:protocol`) | Applies the recommended coordination workflow for the session: check before editing, lock while editing, use `annotate` for findings, `broadcast` for updates, inspect `role:` labels when choosing collaborators. |

---

## Set up AGENTS.md

For autonomous collaboration, add directives to your global or project `AGENTS.md`, or to the equivalent host instruction file.

Pick the version that matches your workflow:

| Workflow | File | Use when |
|----------|------|----------|
| Generalist | [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) | Every session does the same thing, no role specialization |
| Planner | [`docs/agents-planner.md`](./docs/agents-planner.md) | This session plans work, delegates to implementers, and reviews results |
| Implementer | [`docs/agents-implementer.md`](./docs/agents-implementer.md) | This session claims tasks, edits code, and sends work back for review |

For role/team conventions and multi-team workflows, see [`docs/roles-and-teams.md`](./docs/roles-and-teams.md).

If your host exposes MCP prompts, you can also use the built-in `protocol` prompt, often shown as `swarm:protocol`, to pull the workflow into a session on demand.

## Installable Skill

This repo ships one reusable skill at [`skills/swarm-mcp`](./skills/swarm-mcp).

Use it when your host supports installable `SKILL.md` workflows and you want agents to learn the swarm protocol more reliably. Invoke role-specific workflows with `/swarm-mcp planner`, `/swarm-mcp implementer`, `/swarm-mcp reviewer`, or `/swarm-mcp researcher`. For install locations, see [`docs/install-skill.md`](./docs/install-skill.md).

Use it in addition to minimal always-on instructions, not instead of them. The skill is a playbook; `AGENTS.md` is still the best place for ambient rules like "register early" and "check locks before editing."

The skill does not mount the MCP server for you. It assumes the `swarm` MCP tools are already available in the session and teaches the agent how to use them well.

---

## Troubleshooting

**Sessions can't see each other.** Check that both sessions registered with the same `scope` (or both defaulted to the same git root). Verify they are using the same database path (`~/.swarm-mcp/swarm.db` by default). Run `list_instances` in both sessions.

**Tools aren't available after config change.** Most hosts only load MCP server changes at startup. Restart the application or start a fresh session after editing the MCP config.

**File locks are stuck.** Stale locks are cleared automatically when the owning instance's heartbeat expires (30s). If you need to clear them manually, delete the row from the `context` table in the SQLite database, or restart the stuck session.

**Inspecting the database directly.** The database is a standard SQLite file at `~/.swarm-mcp/swarm.db`. You can open it with any SQLite client (`bun` itself, `sqlite3`, DB Browser for SQLite, etc.) to inspect instances, tasks, messages, and context.

**Wrong absolute path in server command.** The `bun run` command needs an absolute path to `src/index.ts`. Relative paths may resolve differently depending on how the host launches the process.

---

## Security

All sessions on the same machine share one SQLite file. Any process running as the same OS user can read and write to it. There is no authentication or authorization between sessions.

This is intentional for a local development tool. Do not use swarm-mcp across trust boundaries or expose the database to untrusted users.

---

## License

[MIT](./LICENSE)
