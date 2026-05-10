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

The plugin auto-registers each session, releases locks on session end, and adds a `/swarm` slash command. If you install it from the marketplace, it bundles the role-doctrine skill too — and if it doesn't, the copy from step 2 picks up the slack, so you won't notice the difference.

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

Open two terminal windows, both `cd`'d into `/path/to/your-project`, and start Claude Code in each. The plugin's `SessionStart` hook registers each session automatically. Inside either session, ask it to call `register` if anything looks off.

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

The `peers` array containing the other session is the signal that everything works.

## 5. Verify from outside the sessions

From any terminal:

```sh
swarm-mcp inspect
```

You should see both instances listed under `instances`, with matching `scope` and recent heartbeats. Run it again a few seconds later and `last_heartbeat_at` should advance — that confirms the live registration is healthy.

```sh
swarm-mcp instances
```

Lists just the live peers, one per line, for a quick sanity check.

(Future: `swarm-mcp doctor` will roll the install check, MCP wiring, plugin presence, and live registration into a single command. For now, `inspect` + `instances` are the manual version.)

## Send a message between them

In session A, ask the agent: "send a hello message to the other peer." It will pick the peer's `instance_id` from `list_instances` and call `send_message`. In session B, ask: "poll messages." It should call `poll_messages` and read the message from A.

That's it. You have two Claude Code sessions coordinating through the shared swarm-mcp database.

## Next steps

- [`identity-boundaries.md`](./identity-boundaries.md) — separating work vs personal accounts on the same machine.
- `/swarm-mcp planner`, `/swarm-mcp implementer`, `/swarm-mcp reviewer`, `/swarm-mcp researcher` — role-specialized doctrine from the bundled skill.
- [`swarm-server.md`](./swarm-server.md) — the Rust daemon behind `swarm-ui`, mobile pairing, and PTY streaming.
- [`getting-started.md`](./getting-started.md) — local-clone development setup and per-host MCP config (Codex, OpenCode, custom Claude Code paths).
- [`agent-routing.md`](./agent-routing.md) — when to delegate to swarm peers vs native subagents.

Other hosts (Codex CLI, OpenCode, Hermes) participate the same way — see [`getting-started.md`](./getting-started.md) for per-host MCP configs and the [integrations](../integrations/) directory for runtime-specific plugins.
