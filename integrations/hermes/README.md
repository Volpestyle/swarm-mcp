# swarm — hermes plugin

Lifecycle bridge between [hermes-agent](https://github.com/NousResearch/hermes-agent) sessions and the swarm-mcp coordinator.

This is the *behavioural* layer that complements two other artifacts in this repo:

- **MCP server** (`src/index.ts`) — gives the agent the swarm tools.
- **Skill** (`skills/swarm-mcp/`) — gives the agent the role doctrine.
- **Plugin** (this directory) — eliminates lifecycle boilerplate the agent should not have to remember.

For the full design — architecture, lifecycle contract, role topology (worker vs gateway), and roadmap — see [SPEC.md](SPEC.md). Backend selection and workspace identity conventions are centralized in [`docs/backend-configuration.md`](../../docs/backend-configuration.md). This README covers install + verify only.

## What it does (v0.3.0)

| Responsibility | Mechanism |
|---|---|
| Auto-`register` on session start | `on_session_start` hook → `mcp_swarm_register` |
| Auto-`deregister` on session finalization | `on_session_finalize` hook → `mcp_swarm_deregister` |
| Auto-lock write-like file tools when peers are active | `pre_tool_call` → `mcp_swarm_lock_file`, `post_tool_call` → `mcp_swarm_unlock_file` |
| Publish workspace identity for this swarm instance | `on_session_start` → publish current workspace handle when `HERDR_PANE_ID` is present |
| Publish configured work tracker | `on_session_start` reads tracker config and writes `config/work_tracker/<identity>` KV |
| Express-lane peer prompt | `swarm_prompt_peer` tool → `mcp_swarm_send_message`, then best-effort workspace backend wake-up (`herdr pane run` today) |
| `/swarm` slash command (status/instances/tasks/kv/messages) | shells to `swarm-mcp` CLI, no agent turn |

Failures are logged and swallowed — coordination is opt-in convenience, never critical path.

`swarm_prompt_peer` does not replace `wait_for_activity` for agents that are actively monitoring delegated work. It writes the durable swarm message first, then nudges the target workspace handle only if that instance has published a workspace identity and the handle is not actively working. If the backend is unavailable, the message remains in swarm for the worker's next yield checkpoint.

The tool is safe for ordinary workers, not just planners or gateways: implementers, reviewers, researchers, and generalists may use it to wake a peer for legitimate handoff or coordination. The guardrail is that they target a swarm instance id and leave the actual instruction in swarm; raw backend commands such as `herdr pane run` remain operator/spawner-level capabilities.

## Roadmap

See [SPEC.md §9](SPEC.md#9-roadmap) for the canonical roadmap.

## Install

The plugin lives in this repo. For local use, symlink it into hermes' user plugin dir:

```bash
ln -sfn /path/to/swarm-mcp/integrations/hermes ~/.hermes/plugins/swarm
```

Then enable it in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - swarm
```

The plugin assumes the swarm MCP server is registered with hermes under the name `swarm` (its tools will appear as `mcp_swarm_register`, `mcp_swarm_deregister`, etc.). If you used a different name, set `SWARM_HERMES_MCP_NAME` in your env.

Identity labels are derived from `SWARM_HERMES_IDENTITY`, `AGENT_IDENTITY`, or `SWARM_IDENTITY` when present. For example, launching Hermes with `AGENT_IDENTITY=personal` registers labels like `identity:personal hermes platform:cli session:<id>`. If `SWARM_HERMES_LABEL` is set and does not already include an `identity:` token, the plugin prepends the derived identity token.

Work tracker metadata is read from `SWARM_HERMES_WORK_TRACKER`, `SWARM_WORK_TRACKER`, `.swarm-work-tracker`, or Hermes config `swarm.work_tracker`, then published to `config/work_tracker/<identity>` in swarm KV. This is routing metadata only; credentials still live in the launcher/config-root MCP setup.

The express-lane tool is registered under Hermes toolset `plugin_swarm`. Enable that toolset for sessions that should be allowed to nudge peers; sessions without the toolset still get auto-register, auto-lock, identity publishing, and `/swarm`.

The `/swarm` slash command resolves the CLI in this order:

1. `SWARM_MCP_BIN` as a real command, e.g. `bun run /path/to/swarm-mcp/src/cli.ts`
2. `swarm-mcp` on `$PATH`
3. This checkout's `src/cli.ts` or `dist/cli.js` when `bun`/`node` is available

Do not use a shell alias for `SWARM_MCP_BIN`; plugin subprocesses do not expand aliases.

```bash
export SWARM_MCP_BIN='bun run /path/to/swarm-mcp/src/cli.ts'
```

## Verify

```bash
hermes plugins list           # should show 'swarm' as loaded
```

Inside a hermes session:

```
/swarm status
```

Should print compact instance/task/kv counts. If you see `swarm-mcp CLI not found`, set `SWARM_MCP_BIN`.

## Runtime behavior at a glance

- **Fail-open by default.** Coordination errors (server down, network issue) never block tool calls — the agent just has no swarm presence for that turn.
- **Block on real lock conflicts.** When a peer holds a lock on a file you're trying to write, the tool call returns `swarm lock blocked write_file ... File is already locked` instead of editing through.
- **`on_session_end` is per-turn, not per-session.** The plugin only deregisters on `on_session_finalize` (`/new`, `/reset`, exit, gateway expiry).

Full hook contract, identity rules, and failure semantics: [SPEC.md §5](SPEC.md#5-lifecycle-contracts).
