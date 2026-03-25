# swarm-mcp

MCP server that lets multiple opencode/Claude Code instances on the same machine discover each other and collaborate through a shared SQLite database.

Each instance spawns its own swarm-mcp server process via stdio. They all share one SQLite file at `~/.opencode/swarm.db`. No daemon needed.

[GitHub](https://github.com/Volpestyle/swarm-mcp)

---

## Quick start

Install dependencies:

```sh
cd /path/to/swarm-mcp
bun install
```

Add to your global opencode config at `~/.config/opencode/opencode.json`:

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

Every opencode instance that launches will now have swarm tools available.

This server requires Bun because it runs through `bun run` and uses Bun's built-in SQLite support.

In opencode, MCP tool names are prefixed by the server name, so you'll call tools like `swarm_register`, `swarm_list_instances`, and `swarm_request_task`.

Call `swarm_register` first to join the swarm.

---

## How it works

All instances read and write to `~/.opencode/swarm.db` using WAL mode, auto-vacuum, and a 3s busy timeout. Bun's built-in `bun:sqlite` is used directly — no external SQLite dependencies.

When you call `register`, the server starts a 10s heartbeat and a 5s notification poller.

`register` also accepts an optional `scope`. If you omit it, the scope defaults to the detected git root, or to the provided directory when no git root exists.

---

## Auto-cleanup

| Data                             | TTL        |
| -------------------------------- | ---------- |
| Stale instances (no heartbeat)   | 30 seconds |
| Messages                         | 1 hour     |
| Completed/failed/cancelled tasks | 24 hours   |
| Non-lock context annotations     | 24 hours   |

When an instance expires, stale claimed or in-progress tasks are released back to `open` and that instance's file locks are removed.

Non-lock annotations are cleaned up by TTL, while locks stay exclusive and are cleared when the owning instance goes stale or deregisters.

---

## Tools

### Instance registry

| Tool             | Description                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `register`       | Join the swarm with a working directory, optional label, and optional scope. Starts heartbeat + notification poller. |
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

The server exposes 4 MCP resources. `swarm://inbox`, `swarm://tasks`, and `swarm://instances` are refreshed by the background poller.

| URI                        | Description                                |
| -------------------------- | ------------------------------------------ |
| `swarm://inbox`            | Unread messages for this instance.         |
| `swarm://tasks`            | Open, claimed, and in-progress tasks.      |
| `swarm://instances`        | All active instances.                      |
| `swarm://context?file=...` | Annotations and locks for a specific file. |

---

## Set up AGENTS.md

For autonomous collaboration, add directives to your project's `AGENTS.md`:

```markdown
## Swarm

- At the start of every session, call `swarm_register` with your working directory.
- Before starting a task, call `swarm_poll_messages` and check `swarm_list_tasks` for requests.
- After completing a significant task, `swarm_broadcast` a summary of what you did.
- Before editing a file, call `swarm_check_file` to see if another instance has locked it.
- If you receive a review request, prioritize it.
```

This gives each agent a consistent collaboration protocol without any extra wiring.
