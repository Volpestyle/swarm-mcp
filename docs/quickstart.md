# Quickstart

Get two Claude Code sessions in the same repo seeing each other in about five minutes.

This is the fast path: one developer, one machine, no identity split. If you want to hack on swarm-mcp itself instead of consuming it, follow [`getting-started.md`](./getting-started.md) for the local-clone setup.

## 1. Get the `swarm-mcp` CLI on `PATH`

`swarm-mcp init` is the recommended setup command, so the `swarm-mcp` binary needs to be runnable from your shell. Pick one:

```sh
# From a local clone (fastest if you already cloned the repo)
cd /path/to/swarm-mcp
bun install
bun run build
bun link

# Or, once published to npm
npm i -g swarm-mcp
```

Verify:

```sh
swarm-mcp --help
```

You should see the `swarm-mcp` subcommand list (`init`, `inspect`, `instances`, …).

## 2. Wire the MCP server into your project

From the repo you want to coordinate in:

```sh
cd /path/to/your-project
swarm-mcp init
```

Expected output:

```
Installing swarm-mcp into /path/to/your-project
  wrote /path/to/your-project/.mcp.json
  wrote /path/to/your-project/.claude/skills/swarm-mcp
Done. Restart your coding-agent host to pick up .mcp.json.
```

That writes a `.mcp.json` pointing Claude Code at `npx -y swarm-mcp` and copies the role-doctrine skill into `.claude/skills/swarm-mcp`.

## 3. Install the Claude Code plugin

The plugin auto-registers each session, releases locks on session end, and adds a `/swarm` slash command. A marketplace install also bundles the role-doctrine skill; if it doesn't, the copy from step 2 covers it.

Add the plugin to `~/.claude.json`:

```jsonc
{
  "plugins": {
    "swarm": {
      "path": "/absolute/path/to/swarm-mcp/integrations/claude-code"
    }
  }
}
```

## 4. Open two Claude Code sessions in the same repo

Open two terminal windows, both `cd`'d into `/path/to/your-project`. Before
starting Claude Code, export an identity in each so the plugin's
`SessionStart` hook knows which `identity:` label to register under:

```sh
export AGENT_IDENTITY=work   # any slug — must match across the two sessions
```

Then start Claude Code in each window. The plugin's `SessionStart` hook
registers each session automatically. Inside either session, ask it to
call `register` if anything looks off.

> Sessions launched without `AGENT_IDENTITY` (or `SWARM_IDENTITY`, or a
> per-runtime equivalent) are intentionally **not** registered — raw
> binaries stay out of the swarm so an unlabeled instance can't defeat
> the cross-identity boundary. For multi-identity setups, define profile
> launchers per [`../env/README.md`](../env/README.md) and use those
> aliases instead of exporting `AGENT_IDENTITY` by hand.

Expected `register` response (paraphrased):

```json
{
  "instance_id": "f3a1c8b2-...",
  "scope": "/path/to/your-project",
  "label": "identity:work claude-code platform:cli session:f3a1c8b2"
}
```

Then have one session call `bootstrap`. Expected shape:

```json
{
  "self": { "instance_id": "f3a1c8b2-...", "label": "...", "scope": "..." },
  "peers": [
    { "instance_id": "9d4e0721-...", "label": "identity:work claude-code platform:cli session:9d4e0721" }
  ],
  "unread_messages": [],
  "tasks": { "open": [], "claimed": [], "in_progress": [] }
}
```

If `peers` lists the other session, the two are coordinating through the same database.

## 5. Verify from outside the sessions

From any terminal:

```sh
swarm-mcp inspect
```

You should see both instances listed under `instances`, with matching `scope` and recent heartbeats. Run it again a few seconds later and `last_heartbeat_at` should advance — that confirms the live registration is healthy.

```sh
swarm-mcp instances
```

Lists just the live peers, one per line.

For a one-shot health report covering binary, db, scope, skill/plugin install, and env knobs:

```sh
swarm-mcp doctor
```

## Send a message between them

In session A, ask the agent: "send a hello message to the other peer." It will pick the peer's `instance_id` from `list_instances` and call `send_message`. In session B, ask: "poll messages." It should call `poll_messages` and read the message from A.

That's it. You have two Claude Code sessions coordinating through the shared swarm-mcp database.

## Next steps

- [`identity-boundaries.md`](./identity-boundaries.md) — separating profile/account stacks on the same machine.
- `/swarm-mcp planner`, `/swarm-mcp implementer`, `/swarm-mcp reviewer`, `/swarm-mcp researcher` — role-specialized doctrine from the bundled skill.
- [`swarm-server.md`](./swarm-server.md) — the Rust daemon behind `swarm-ui`, mobile pairing, and PTY streaming.
- [`getting-started.md`](./getting-started.md) — local-clone development setup and per-host MCP config (Codex, OpenCode, custom Claude Code paths).
- [`agent-routing.md`](./agent-routing.md) — when to delegate to swarm peers vs native subagents.

Other hosts (Codex CLI, OpenCode, Hermes) participate the same way — see [`getting-started.md`](./getting-started.md) for per-host MCP configs and the [integrations](../integrations/) directory for runtime-specific plugins.
