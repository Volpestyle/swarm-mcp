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

Add the server to your coding agent using that host's MCP config format. This server requires Bun because it runs through `bun run` and uses Bun's built-in SQLite support.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.swarm]
command = "bun"
args = ["run", "C:\\path\\to\\swarm-mcp\\src\\index.ts"]
cwd = "C:\\path\\to\\swarm-mcp"
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
- [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) -- copy-paste coordination rules for any agent host
- [`docs/roles-and-teams.md`](./docs/roles-and-teams.md) -- specialist/generalist label conventions and handoff examples
- [`docs/install-skill.md`](./docs/install-skill.md) -- host-specific install paths for the bundled skill
- [`skills/swarm-mcp`](./skills/swarm-mcp) -- installable skill source for hosts with skill ecosystems

---

## How it works

All sessions read and write to `~/.swarm-mcp/swarm.db` by default using WAL mode, auto-vacuum, and a 3s busy timeout. Bun's built-in `bun:sqlite` is used directly -- no external SQLite dependencies.

Set `SWARM_DB_PATH` before launching the server if you want a different database location.

When you call `register`, the server starts a 10s heartbeat and a 5s notification poller.

### Registration fields

The `register` tool accepts these parameters. Only `directory` is required.

| Field | Required | Description |
|-------|----------|-------------|
| `directory` | Yes | The live working directory for the current session. |
| `scope` | No | Shared swarm boundary. Sessions in the same scope can see each other; different scopes are different swarms. Defaults to the detected git root, or to `directory` when no git root exists. |
| `file_root` | No | Canonical base path for resolving relative file paths in `annotate`, `lock_file`, `check_file`, and task `files`. Useful when disposable worktrees should share one logical file tree. |
| `label` | No | Free-form identity text. Recommended convention: machine-readable space-separated tokens like `provider:codex-cli role:planner`. The `role:` token is optional; if missing, the session is treated as a generalist. |

---

## Auto-cleanup

| Data                             | TTL        |
| -------------------------------- | ---------- |
| Stale instances (no heartbeat)   | 30 seconds |
| Messages                         | 1 hour     |
| Completed/failed/cancelled tasks | 24 hours   |
| Non-lock context annotations     | 24 hours   |

When a session expires, stale claimed or in-progress tasks are released back to `open` and that session's file locks are removed.

Non-lock annotations are cleaned up by TTL, while locks stay exclusive and are cleared when the owning instance goes stale or deregisters.

---

## Tools

### Instance registry

| Tool             | Description                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `register`       | Join the swarm. Starts heartbeat + notification poller. See [Registration fields](#registration-fields). |
| `list_instances` | List all live instances.                                                                                             |
| `whoami`         | Get this instance's swarm ID.                                                                                        |

### Messaging

| Tool            | Description                                         |
| --------------- | --------------------------------------------------- |
| `send_message`  | Send a direct message to a specific instance by ID. |
| `broadcast`     | Message all other instances in the swarm.           |
| `poll_messages` | Read unread messages and mark them as read.         |

### Task delegation

| Tool           | Description                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `request_task` | Post a task (types: `review`, `implement`, `fix`, `test`, `research`, `other`). Optionally assign to a specific instance. |
| `claim_task`   | Claim an open task. Prevents double-claiming.                                                                             |
| `update_task`  | Update a claimed task to `in_progress`, `done`, `failed`, or `cancelled`. Attach a result when useful.                    |
| `get_task`     | Get full details of a task.                                                                                               |
| `list_tasks`   | Filter tasks by status, assignee, or requester.                                                                           |

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
| `kv_delete` | Delete a key.                                  |
| `kv_list`   | List keys, optionally filtered by prefix.      |

---

## Resources

The server exposes 4 MCP resources. `swarm://inbox`, `swarm://tasks`, and `swarm://instances` are refreshed by the background poller when the host supports resource update notifications.

| URI                        | Description                                |
| -------------------------- | ------------------------------------------ |
| `swarm://inbox`            | Unread messages for this instance.         |
| `swarm://tasks`            | Open, claimed, and in-progress tasks.      |
| `swarm://instances`        | All active instances.                      |
| `swarm://context?file=...` | Annotations and locks for a specific file. |

---

## Prompts

The server exposes MCP prompts. Some hosts surface them directly, while others only expose tools and resources.

| Prompt | Purpose |
| ------ | ------- |
| `swarm:setup` | Guides the agent through registration: call `register`, `poll_messages`, `list_tasks`, then summarize swarm ID, active sessions, role labels, open tasks, and coordination risks. |
| `swarm:protocol` | Applies the recommended coordination workflow for the session: check before editing, lock while editing, use `annotate` for findings, `broadcast` for updates, inspect `role:` labels when choosing collaborators. |

---

## Set up AGENTS.md

For autonomous collaboration, add directives to your global or project `AGENTS.md`, or to the equivalent host instruction file.

Copy [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) for a ready-made version that works with any MCP-capable host.

For specialist workflows with planners, implementers, reviewers, and team conventions, see [`docs/roles-and-teams.md`](./docs/roles-and-teams.md).

If your host exposes MCP prompts, you can also use the built-in `swarm:protocol` prompt to pull the workflow into a session on demand.

Minimal example:

```markdown
## Swarm

- At the start of every session, call the swarm `register` tool with your working directory.
- Before starting a task, call `poll_messages` and `list_tasks` for pending requests.
- Before editing a file, call `check_file` to see if another session has locked it.
- After completing a significant task, call `broadcast` with a short summary.
```

## Installable Skill

This repo ships a reusable skill at [`skills/swarm-mcp`](./skills/swarm-mcp).

Use it when your host supports installable `SKILL.md` workflows and you want agents to learn the swarm protocol more reliably. For install locations, see [`docs/install-skill.md`](./docs/install-skill.md).

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
