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
| Enforce peer-declared locks on write-like file tools | `pre_tool_call` → `mcp_swarm_get_file_lock` per target path; blocks the call when a peer (not this session) holds it. Never acquires. |
| Publish workspace identity and pane status for this swarm instance | `on_session_start` → publish current workspace handle when `HERDR_PANE_ID` is present; with `HERDR_SOCKET_PATH`, report `pane.report_agent state=idle` and release it on finalize |
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

If Hermes launches `swarm-mcp` as an MCP server, set identity and database env on the MCP server entry too. Hermes child processes may not inherit the launcher environment:

```yaml
mcp_servers:
  swarm:
    command: bun
    args:
      - run
      - /path/to/swarm-mcp/src/index.ts
    enabled: true
    env:
      AGENT_IDENTITY: personal
      SWARM_DB_PATH: /Users/you/.swarm-mcp-personal/swarm.db
```

Use the matching work values for a work profile: `AGENT_IDENTITY: work` and `/Users/you/.swarm-mcp-work/swarm.db`.

### Daemon-managed gateways (launchd / systemd)

`mcp_servers.swarm.env` only reaches the MCP server child. The hermes daemon itself runs in whatever environment its service manager booted it under, and launchd in particular strips the operator's shell env. A plain `~/Library/LaunchAgents/ai.hermes.gateway-personal.plist` boots hermes with only `HERMES_HOME`, so the in-process swarm plugin's `_resolved_identity()` falls back to `identity:unknown` — and every worker the gateway dispatches inherits that token through the spawn label chain (raw `codex`/`claude` is launched instead of `cdx`/`clowd`, the launch script exports `AGENT_IDENTITY=unknown`, and downstream session_start hooks register with `identity:unknown`).

Hermes' launchd plist generator (`hermes_cli/gateway.py::generate_launchd_plist`) handles this automatically for any named Hermes profile (anything other than the reserved `default`/`custom` placeholders) — it emits `AGENT_IDENTITY=<profile>`, `SWARM_HERMES_IDENTITY=<profile>`, `SWARM_IDENTITY=<profile>`, and `SWARM_DB_PATH=$HOME/.swarm-mcp-<profile>/swarm.db` into the plist's `EnvironmentVariables` block. Site-specific envs (e.g. `SWARM_MCP_<PROFILE>_ROOTS` pointing at your checkout root, `SWARM_MCP_BIN`, `HERDR_SOCKET_PATH`) are read from `$HERMES_HOME/launchd_extra_env.json` if present:

```json
{
  "SWARM_MCP_PERSONAL_ROOTS": "/Users/you/repos:/Users/you/herdr",
  "SWARM_MCP_BIN": "bun run /Users/you/repos/swarm-mcp/src/cli.ts",
  "HERDR_SOCKET_PATH": "/Users/you/.config/herdr/sessions/personal/herdr.sock"
}
```

The extras file is an input to the generator, so it survives `refresh_launchd_plist_if_needed()` and any `hermes gateway` regeneration. After editing the plist or the extras file, you must reload launchd — `launchctl kickstart -k` does not pick up env changes:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway-personal.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway-personal.plist
```

The matching minimum-set for `systemd` is the same env block under `[Service] Environment=` in the unit file (`hermes_cli/gateway.py::generate_systemd_unit`). The systemd template does not yet emit profile-derived identity envs — set them explicitly there for now.

Work tracker metadata is read from `SWARM_HERMES_WORK_TRACKER`, `SWARM_WORK_TRACKER`, `.swarm-work-tracker`, or Hermes config `swarm.work_tracker`, then published to `config/work_tracker/<identity>` in swarm KV. This is routing metadata only; credentials still live in the launcher/config-root MCP setup.

The express-lane tool is registered under Hermes toolset `plugin_swarm`. Enable that toolset for sessions that should be allowed to nudge peers; sessions without the toolset still get auto-register, the peer-lock check on writes, identity publishing, and `/swarm`.

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
- **Block on real lock conflicts.** When a peer holds a swarm lock on a file you're trying to write, the tool call returns `swarm lock blocked write_file for <file>: held by <8-char-prefix> (<note>)` instead of editing through. Same-instance locks pass through (re-entrant), so an agent that declared its own wider critical section keeps editing.
- **`on_session_end` is per-turn, not per-session.** The plugin only deregisters on `on_session_finalize` (`/new`, `/reset`, exit, gateway expiry).

Full hook contract, identity rules, and failure semantics: [SPEC.md §5](SPEC.md#5-lifecycle-contracts).
