# Getting Started

This guide gets you from a fresh clone to two coding-agent sessions that can see each other and exchange messages through `swarm-mcp`.

It assumes:

- You are running sessions on the same machine.
- Your coding agent host supports custom stdio MCP servers.
- You want a simple local setup using the default shared database at `~/.swarm-mcp/swarm.db`.

## 1. Install Bun

`swarm-mcp` runs through `bun run` and uses Bun's built-in SQLite support.

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

You can also copy from [`docs/codex.toml`](./codex.toml).

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

You can also copy from [`docs/opencode.jsonc`](./opencode.jsonc).

### Other hosts

Use the same command, args, and working directory in that host's MCP settings.

Tool names may be rendered differently by each client. For the same `register` tool, one host may show `swarm_register` while another shows `mcp__swarm__register`.

## 4. Restart your coding agent host

Most hosts only load MCP server changes at startup. Restart the application or start a fresh session after editing the MCP config.

## 5. Open your first session and register

In your first coding-agent session, call the swarm server's `register` tool.

Use:

- `directory`: the project directory you are working in
- `label`: optional, but if you use one prefer machine-readable tokens like `provider:codex-cli role:implementer` or `provider:claude-code role:reviewer`
- `scope`: usually omit this unless you intentionally want multiple directories to share one swarm

The `role:` token is optional. If a session omits it, treat that session as a generalist.

The tool returns your swarm instance ID and registration details.

After that, call:

- `whoami`
- `list_instances`
- `poll_messages`

At this point you should see only your own session.

## 6. Open a second session and register again

Open another session in the same host or a different host on the same machine, as long as it is also configured to use `swarm-mcp`.

Call `register` there too, ideally with a different `label`.

If you want specialist sessions, a practical convention is:

- `provider:codex-cli role:planner`
- `provider:codex-cli role:implementer`
- `provider:claude-code role:reviewer`

Now call `list_instances` in either session. You should see both sessions in the same scope.

If you do not, check:

- Both sessions are using the same project directory or compatible `scope`
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

## 8. Add lightweight operating instructions

Once the MCP server is working, add a short coordination protocol to your host instructions or `AGENTS.md`.

For a neutral version, start with [`docs/generic-AGENTS.md`](./generic-AGENTS.md).

For opencode-specific wording, use [`docs/opencode-AGENTS.md`](./opencode-AGENTS.md).

## 9. Understand the default storage model

By default, all sessions use:

```text
~/.swarm-mcp/swarm.db
```

That is what allows separate sessions on the same machine to discover each other.

If you want a different path, set `SWARM_DB_PATH` before launching the MCP server.

## 10. Common mistakes

- Editing the MCP config but not restarting the host
- Using the wrong absolute path in the server command
- Running one session against a different `SWARM_DB_PATH`
- Registering in different scopes by using different project roots
- Expecting prompt support when the host only exposes tools

## 11. What to do next

Once basic messaging works, the most useful next step is to make the behavior habitual:

- Call `register` at session start
- Call `poll_messages` and `list_tasks` before starting work
- Call `check_file` before editing
- Call `lock_file` while editing
- Call `broadcast` or `update_task` when handing work off

That is the minimum loop that turns `swarm-mcp` from "installed" into actually useful.
