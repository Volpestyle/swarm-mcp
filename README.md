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

Add the server to your coding agent using that host's MCP config format.

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

Any host session that launches with this MCP server configured will now have swarm tools available.

This server requires Bun because it runs through `bun run` and uses Bun's built-in SQLite support.

Tool names are usually namespaced by the client using the server name, but the exact format varies by host. Depending on the client, you may see names like `swarm_register`, `mcp__swarm__register`, or other host-specific variants.

Call the swarm `register` tool first to join the swarm.

For host-specific and host-neutral onboarding, this repo also ships copy-paste docs:

- [`docs/getting-started.md`](./docs/getting-started.md) with a beginner-friendly setup and verification walkthrough
- [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) with host-neutral coordination guidance
- [`docs/codex.toml`](./docs/codex.toml) with a Codex MCP config example
- [`docs/opencode-AGENTS.md`](./docs/opencode-AGENTS.md) with a recommended global coordination protocol
- [`docs/opencode.jsonc`](./docs/opencode.jsonc) with a local MCP config example

The server also exposes MCP prompts. Some hosts surface them directly, while others only expose tools and resources:

- `swarm:setup` to register and inspect the current swarm state
- `swarm:protocol` to apply the recommended coordination workflow for the session

---

## How it works

All sessions read and write to `~/.swarm-mcp/swarm.db` by default using WAL mode, auto-vacuum, and a 3s busy timeout. Bun's built-in `bun:sqlite` is used directly — no external SQLite dependencies.

Set `SWARM_DB_PATH` before launching the server if you want a different database location.

When you call `register`, the server starts a 10s heartbeat and a 5s notification poller.

`register` also accepts an optional `scope`. If you omit it, the scope defaults to the detected git root, or to the provided directory when no git root exists.

`register` also accepts an optional `file_root`. When set, relative file paths in `annotate`, `lock_file`, `check_file`, and task `files` are resolved against that canonical path instead of the live working directory. This is useful when multiple disposable worktrees should share one logical file tree.

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
| `register`       | Join the swarm with a working directory, optional label, optional scope, and optional canonical `file_root`. Starts heartbeat + notification poller. |
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

## Set up AGENTS.md

For autonomous collaboration, add directives to your global or project `AGENTS.md`, or to the equivalent host instruction file.

If you want a ready-made version, copy [`docs/generic-AGENTS.md`](./docs/generic-AGENTS.md) for host-neutral guidance or [`docs/opencode-AGENTS.md`](./docs/opencode-AGENTS.md) for opencode-specific wording.

If your host exposes MCP prompts, you can also use the built-in `swarm:protocol` prompt to pull the workflow into a session on demand.

Minimal example:

```markdown
## Swarm

- At the start of every session, call the swarm `register` tool with your working directory.
- Before starting a task, call the swarm `poll_messages` tool and check the swarm `list_tasks` tool for requests.
- After completing a significant task, call the swarm `broadcast` tool with a short summary.
- Before editing a file, call the swarm `check_file` tool to see if another session has locked it.
- If you receive a review request, prioritize it.
```

This gives each agent a consistent collaboration protocol without any host-specific wiring.
