# Getting Started

This guide gets you from a fresh clone to two coding-agent sessions that can see each other and exchange messages through `swarm-mcp`.

It assumes:

- You are running sessions on the same machine.
- Your coding agent host supports custom stdio MCP servers.
- You want a simple local setup using the default shared database at `~/.swarm-mcp/swarm.db`.

This guide uses the default local backend setup. For consumer backend/profile configuration, see [`backend-configuration.md`](./backend-configuration.md). For work/personal account separation, see [`identity-boundaries.md`](./identity-boundaries.md).

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

If you are using the packaged CLI instead of a local clone, `swarm-mcp init --dir /absolute/path/to/project` can write a project `.mcp.json` and copy the packaged `swarm-mcp` skill. The manual host-specific config below is still the clearest path when you want to run directly from this checkout.

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
args = ["run", "/absolute/path/to/swarm-mcp/src/index.ts"]
cwd = "/absolute/path/to/swarm-mcp"
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

## 4. Install the packaged skill

The MCP server provides the *tools*; the packaged skill teaches agents how to use them well for coordination. Skip this step only if your host does not support installable skills.

The packaged skill source is at `skills/swarm-mcp` in this repo. Symlink it into your consumer project so `git pull` updates propagate automatically:

```sh
# Run from your consumer project root
mkdir -p .agents/skills .claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp
ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp
```

Or globally for every project:

```sh
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp
```

Per-host paths and a copy-based alternative are in [`docs/install-skill.md`](./install-skill.md).

## 5. Restart your coding agent host

Most hosts only load MCP server changes at startup. Restart the application or start a fresh session after editing the MCP config.

## 6. Open your first session and register

In your first coding-agent session, call the swarm server's `register` tool.

Use:

- `directory`: the project directory you are working in
- `scope`: usually omit it. By default the server uses the repo's git root, or `directory` when no git root exists. Use a different `scope` only when you want a completely separate swarm.
- `label`: optional, but if you use one prefer machine-readable tokens like `identity:work provider:codex-cli role:implementer`

Do not use `scope` to split frontend/backend inside one repo. Keep one shared scope and use `label` tokens like `team:frontend` and `team:backend` if you want soft grouping inside the same swarm.

See the README's [Registration fields](../README.md#registration-fields) section for the full field reference.

The tool returns your swarm instance ID and registration details.

After that, call:

- `whoami`
- `list_instances`
- `poll_messages`

At this point you should see only your own session.

## 7. Open a second session and register again

Open another session in the same host or a different host on the same machine, as long as it is also configured to use `swarm-mcp`.

Call `register` there too, ideally with a different `label`.

Now call `list_instances` in either session. You should see both sessions in the same scope.

If you do not, check:

- Both sessions are using the same project directory, or both explicitly joined the same `scope`
- You did not accidentally put the sessions in different scopes just to represent frontend/backend or other soft teams; use shared scope plus `team:` labels for that
- Both sessions are pointing at the same database path
- Both hosts actually loaded the MCP config change after restart

## 8. Verify cross-agent communication

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
- `get_file_context` for read-only inspection
- `lock_file` while editing (its response also surfaces peer annotations)
- `annotate` to leave shared notes on a file

## 9. Add operating instructions and start collaborating

Once the MCP server is working, install the bundled coordination skill and let it carry the doctrine. The skill's main `SKILL.md` is the generalist guide; `skills/swarm-mcp/references/` holds role-specific workflows (planner, implementer, reviewer, researcher) and the roles-and-teams reference for multi-team setups.

Install with the steps in [`docs/install-skill.md`](./install-skill.md), then invoke role-specialized sessions with `/swarm-mcp planner`, `/swarm-mcp implementer`, `/swarm-mcp reviewer`, or `/swarm-mcp researcher`. Hosts without installable-skill support can point their `AGENTS.md` (or equivalent) directly at [`skills/swarm-mcp/SKILL.md`](../skills/swarm-mcp/SKILL.md) — it doubles as a readable doctrine file.

For runtime-agnostic routing rules that should be always-on (not on-demand), see [`docs/agent-routing.md`](./agent-routing.md).

The minimum collaboration loop is:

- Call `register` at session start
- Call `poll_messages` and `list_tasks` before starting work
- Call `get_file_context` for read-only file inspection
- Call `lock_file` while editing (skip if you're alone in scope; the response includes peer annotations)
- Call `broadcast` or `update_task` when handing work off

For troubleshooting tips, see the [Troubleshooting](../README.md#troubleshooting) section in the README.

## Desktop and mobile access

The setup above is only for the stdio MCP server. The desktop UI, PTY control, mobile-style pairing, and LAN streaming use the separate Rust `swarm-server` daemon. It is not required for basic MCP coordination. See [`docs/swarm-server.md`](./swarm-server.md) when you need `swarm-ui`. The current `apps/swarm-ios` workstream is Herdr-bridge first so Herdr remains the PTY owner.
