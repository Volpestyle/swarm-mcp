# Getting Started

This guide gets you from a fresh clone to two coding-agent sessions that can see each other and exchange messages through `swarm-mcp`.

It assumes:

- You are running sessions on the same machine.
- Your coding agent host supports custom stdio MCP servers.
- You want a simple local setup using the default shared database at `~/.swarm-mcp/swarm.db`.

## 1. Install Bun

`swarm-mcp` is easiest to run in development through `bun run`. The built `dist/*.js` entrypoints also run under Node 20+ with `better-sqlite3`, but this guide uses Bun for the shortest setup path.

Verify Bun is installed:

```sh
bun --version
```

If that fails, install Bun first:

<https://bun.sh>

## 2. Clone and install dependencies

```sh
git clone https://github.com/Volpestyle/swarm-mcp.git
cd swarm-mcp
bun install
```

## 3. Add the MCP server to your coding agent

Each host has its own MCP config format, but they should all point at the same server:

- Command: `bun`
- Args: `run /absolute/path/to/swarm-mcp/src/index.ts`
- Working directory: `/absolute/path/to/swarm-mcp`

Examples:

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.swarm]
command = "bun"
args = ["run", "C:\\absolute\\path\\to\\swarm-mcp\\src\\index.ts"]
cwd = "C:\\absolute\\path\\to\\swarm-mcp"
```

### opencode

Add this to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "swarm": {
      "type": "local",
      "enabled": true,
      "command": ["bun", "run", "/absolute/path/to/swarm-mcp/src/index.ts"]
    }
  }
}
```

### Claude Code

Add this to `~/.claude.json`:

```json
{
  "mcpServers": {
    "swarm": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/swarm-mcp/src/index.ts"]
    }
  }
}
```

### Other hosts

Use the same command, args, and working directory in that host's MCP settings.

Tool names may be rendered differently by each client. For the same `register` tool, one host may show `swarm_register` while another shows `mcp__swarm__register`.

## 4. Restart your coding agent host

Most hosts only load MCP server changes at startup. Restart the application or start a fresh session after editing the MCP config.

## 5. Open your first session and register

In your first coding-agent session, call the swarm server's `register` tool.

Use:

- `directory`: the project directory you are working in
- `scope`: usually omit it. By default the server uses the repo's git root, or `directory` when no git root exists. Use a different `scope` only when you want a completely separate swarm.
- `label`: optional, but if you use one prefer machine-readable tokens like `provider:codex-cli role:implementer`

Do not use `scope` to split frontend/backend inside one repo. Keep one shared scope and use `label` tokens like `team:frontend` and `team:backend` if you want soft grouping inside the same swarm.

See the README's [Registration fields](../README.md#registration-fields) section for the full field reference.

The tool returns your swarm instance ID and registration details.

After that, call:

- `whoami`
- `list_instances`
- `poll_messages`

At this point you should see only your own session.

## 6. Open a second session and register again

Open another session in the same host or a different host on the same machine, as long as it is also configured to use `swarm-mcp`.

Call `register` there too, ideally with a different `label`.

Now call `list_instances` in either session. You should see both sessions in the same scope.

If you do not, check:

- Both sessions are using the same project directory, or both explicitly joined the same `scope`
- You did not accidentally put the sessions in different scopes just to represent frontend/backend or other soft teams; use shared scope plus `team:` labels for that
- Both sessions are pointing at the same database path
- Both hosts actually loaded the MCP config change after restart

## 7. Verify cross-agent communication

From session A:

- Call `list_instances`
- Pick the instance ID for session B
- Call `send_message` with that ID and a short message

From session B:

- Call `poll_messages`

You should see the message from session A.

You can also test shared coordination tools:

- `broadcast` to announce progress to all other sessions
- `request_task` to hand work to another session
- `check_file` before editing
- `lock_file` while editing
- `annotate` to leave shared notes on a file

## 8. Add operating instructions and start collaborating

Once the MCP server is working, add a short coordination protocol to your host instructions or `AGENTS.md`:

- [`docs/generic-AGENTS.md`](./generic-AGENTS.md) -- for generalist sessions (no role specialization)
- [`docs/agents-planner.md`](./agents-planner.md) -- for planner sessions (plans work, reviews results)
- [`docs/agents-implementer.md`](./agents-implementer.md) -- for implementer sessions (claims tasks, edits code)

For role/team conventions and multi-team workflows, see [`docs/roles-and-teams.md`](./roles-and-teams.md).

If your host supports installable skills, see [`docs/install-skill.md`](./install-skill.md) to install the bundled swarm skill for stronger per-session guidance.

The minimum collaboration loop is:

- Call `register` at session start
- Call `poll_messages` and `list_tasks` before starting work
- Call `check_file` before editing and `lock_file` while editing
- Call `broadcast` or `update_task` when handing work off

For troubleshooting tips, see the [Troubleshooting](../README.md#troubleshooting) section in the README.

If you are using `swarm-ui`, the operator surface for machine-wide process inspection and real agent cleanup lives in [`docs/system-load-analyzer.md`](./system-load-analyzer.md).
