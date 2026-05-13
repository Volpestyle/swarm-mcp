# swarm — Claude Code plugin

Lifecycle bridge between Claude Code sessions and the swarm-mcp coordinator,
mirroring the [hermes plugin](../hermes/) inside the constraints of the Claude
Code plugin model.

This is the *behavioural* layer that complements the other artifacts in this
repo:

- **MCP server** (`src/index.ts`) — gives the agent the swarm tools.
- **Skill** (`skills/swarm-mcp/`) — gives the agent the role doctrine.
- **Plugin** (this directory) — eliminates lifecycle boilerplate the agent
  should not have to remember.

For the broader adapter contract, see
[`docs/control-plane.md`](../../docs/control-plane.md). Backend selection and workspace identity conventions are centralized in [`docs/backend-configuration.md`](../../docs/backend-configuration.md). For the design parallel in the hermes case, see [`integrations/hermes/SPEC.md`](../hermes/SPEC.md).

## What it does (v0.3.0)

| Responsibility | Mechanism |
|---|---|
| Auto-`register` on session start | `SessionStart` hook → `swarm-mcp register`, stores `instance_id` in hook scratch metadata |
| Auto-`deregister` on session end | `SessionEnd` hook → `swarm-mcp deregister` |
| Enforce peer-declared locks on write-class tools | `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) → read-only `swarm-mcp locks --json` inspection; emits `permissionDecision: deny` when a peer (not this session) holds the target file. Never acquires. |
| Publish and cleanup workspace identity | `SessionStart` / `SessionEnd` hooks → publish/delete current workspace handle when `HERDR_PANE_ID` is present |
| Publish configured work tracker | `SessionStart` hook reads tracker config and writes `config/work_tracker/<identity>` KV |
| Gateway conductor mode | `SWARM_CC_ROLE=gateway` registers as `role:planner`; make easy edits locally, use the MCP `dispatch` tool for medium/large task/spawn routing |
| Gateway SOUL priming | `SessionStart` appends this repo's [`SOUL.md`](./SOUL.md) for gateway/lead sessions |
| Peer prompt express lane | `prompt_peer` MCP tool or `swarm-mcp prompt-peer` CLI sends durable swarm message, then best-effort herdr wake |
| `/swarm` slash command (status / instances / tasks / kv / messages) | Markdown command shelling to the `swarm-mcp` CLI |
| Bundled role-doctrine skill | `skills/swarm-mcp/` ships with the plugin (relative symlink to the canonical `skills/swarm-mcp/` source); installs alongside hooks so agents pick up the planner/implementer/reviewer/researcher/generalist role doctrine automatically — no separate skill symlink needed |

Worker-mode coordination failures are swallowed — coordination is opt-in
convenience for ordinary sessions, never critical path. Gateway mode can handle
trivial, low-risk edits locally, but medium or large implementation work should
create/reuse a swarm task and drive the configured Spawner backend, not native
subagents. The pre-tool hook is **check-only**: it inspects existing locks and
denies on peer-held conflicts, but never acquires on the agent's behalf. Agents
declare wider critical sections themselves via `lock_file` when they want peers
to wait (see the `swarm-mcp` skill's "Locking" section).

### Gateway dispatch

Claude Code should use the swarm MCP `dispatch` tool for in-agent gateway
routing. It creates or reuses the task, wakes a matching live worker, or runs a
guarded spawn through the configured backend (`herdr` by default for this
stack). The CLI `swarm-mcp dispatch` helper remains for hooks, launcher
scripts, operator shells, and fallback sessions where MCP tools are unavailable.

## Install

The plugin lives in this repo. To use it inside Claude Code, point Claude
Code at this directory as a plugin source.

### Local install (recommended for this repo)

Add the plugin to your Claude Code config (`~/.claude.json` for work,
`~/.claude-personal/.claude.json` for personal under
[`identity-boundaries`](../../docs/identity-boundaries.md)):

```jsonc
{
  "plugins": {
    "swarm": {
      "path": "/absolute/path/to/swarm-mcp/integrations/claude-code"
    }
  }
}
```

Or symlink into your user plugin dir if Claude Code is configured to scan
one:

```sh
mkdir -p ~/.claude/plugins
ln -sfn /absolute/path/to/swarm-mcp/integrations/claude-code ~/.claude/plugins/swarm
```

Restart Claude Code so it picks up the new plugin.

### Make sure the swarm MCP server is mounted

This plugin expects the `swarm` MCP server to already be available inside the
session — it does not install it for you. The simplest way is:

```sh
# from a project root
swarm-mcp init --dir .
```

That writes a project-local `.mcp.json` so the session can reach the swarm
MCP server. As of v0.3 the role-doctrine skill ships inside the plugin
(`skills/swarm-mcp/`), so a successful plugin install brings doctrine
alongside lifecycle automation — no separate skill symlink is required for
Claude Code users. See [`docs/install-skill.md`](../../docs/install-skill.md)
for global installs and non-Claude hosts.

### CLI resolution

The hooks shell to the `swarm-mcp` CLI. They resolve it without relying on
shell aliases (Claude Code hooks run as direct subprocesses):

1. `SWARM_MCP_BIN` as a real command — e.g.
   ```sh
   export SWARM_MCP_BIN='bun run /path/to/swarm-mcp/src/cli.ts'
   ```
2. `swarm-mcp` on `$PATH`.
3. The repo checkout's `src/cli.ts` under `bun`, then `dist/cli.js` under
   `node`.

Do **not** use a shell alias for `SWARM_MCP_BIN`; subprocesses do not expand
aliases.

### Identity, label, scope

Hooks pick up the same env knobs as the hermes plugin, with `SWARM_CC_*` taking
priority for Claude Code-specific overrides:

| Variable | Purpose |
|---|---|
| `SWARM_CC_IDENTITY` / `AGENT_IDENTITY` / `SWARM_IDENTITY` | Auto-derives the `identity:<work\|personal>` label token. |
| `SWARM_CC_LABEL` / `SWARM_HERMES_LABEL` | Override the full label. If it omits `identity:`, the derived token is prepended. |
| `SWARM_CC_ROLE` / `SWARM_ROLE` | `worker` by default. Set `gateway` for planner/conductor behavior. |
| `SWARM_CC_AGENT_ROLE` / `SWARM_AGENT_ROLE` | Optional swarm role label. Gateway defaults this to `role:planner`. Falls back to a `.swarm-role` file walking up from `cwd` to the coordination scope (first non-blank, non-comment line is the role token) — drop `echo implementer > .swarm-role` at the repo root for a per-project default. |
| `SWARM_CC_LEASE_SECONDS` | CLI registration lease for hook-managed sessions. Defaults to `86400`; `SessionEnd` deregisters normally. |
| `SWARM_CC_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE` | Override the coordination scope. Default: git root of `cwd`. |
| `SWARM_CC_FILE_ROOT` / `SWARM_HERMES_FILE_ROOT` / `SWARM_MCP_FILE_ROOT` | Override the file root passed to `register`. |
| `SWARM_CC_WORK_TRACKER` / `SWARM_WORK_TRACKER` | JSON tracker config to publish at `config/work_tracker/<identity>`; use this for Linear/Jira/GitHub policy, not credentials. |
| `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID` | When present, SessionStart publishes workspace identity for peer wakes and reports `pane.report_agent state=idle`; SessionEnd releases that herdr agent authority. Missing env/socket failures fall back to herdr heuristics. See [`backend-configuration.md`](../../docs/backend-configuration.md). |

Default label format mirrors hermes:
`identity:<id> claude-code platform:cli [mode:gateway] [role:<name>] origin:claude-code session:<id-prefix>`.
Gateway mode adds `mode:gateway` and defaults the routing role to
`role:planner`.

## Verify

In a fresh project with the swarm MCP server mounted:

1. Start Claude Code. The first turn should see a system block from
   `SessionStart` saying the session is already registered with an
   `instance_id`.
2. Confirm registration: `swarm-mcp instances` from another terminal should
   show your session.
3. With a second peer registered in the same scope, ask the agent to edit a
   file the peer has locked (`swarm-mcp lock <file> --note "..."` from peer
   terminal). The tool should be denied with `swarm lock blocked Edit for
   <file>: held by <8-char-prefix> (...)`.
4. Run `/swarm` inside the session — should print a compact status summary.

If the deny message never appears, the most common causes are:

- The SessionStart hook did not register. Check `swarm-mcp instances` — you
  should see your session there.
- `swarm-mcp` CLI is not resolvable from the hook subprocess. Set
  `SWARM_MCP_BIN` to a real command.
- The peer is not actually holding a lock, or held it on a different path
  than the agent is editing. `swarm-mcp locks` should list it.
- The hook's session has no cached `instance_id` (registration failed
  earlier in the session), so it fails open and can't tell own vs peer.

## Roadmap

### v0.1 — Lifecycle bridge ✓
- SessionStart additionalContext priming registration with derived args
- Pre-tool peer-lock check with deny-on-conflict, fail-open elsewhere
- /swarm slash command
- Best-effort identity KV cleanup on SessionEnd

### v0.2 — Autonomous lifecycle + gateway mode ✓
- `swarm-mcp register` / `deregister` / `list-instances`
- SessionStart/SessionEnd hooks call lifecycle commands directly
- `prompt_peer` MCP tool and `swarm-mcp prompt-peer`
- `SWARM_CC_ROLE=gateway` planner/conductor labels and local-small/dispatch-large routing

### v0.3 — Bundle role-doctrine skill ✓ (this version)
- `skills/swarm-mcp/` ships inside the plugin (relative symlink to the
  canonical `skills/swarm-mcp/` source), so a single plugin install brings
  doctrine + lifecycle. No separate skill symlink step on the user side.
- MCP `dispatch` plus CLI `swarm-mcp dispatch` fallback for idempotent task
  creation, worker selection, no-double-spawn locking, configured spawner
  backend selection, and peer wake.

### v0.4 — Ambient peer context
- SessionStart additionalContext carries the current peer/lock/message
  snapshot so the agent starts a turn already aware of the coordination
  state

### v0.5+ — open territory
- Subagent stop bridge analogous to hermes' `subagent_stop` plan
- Gateway-mode awareness if Claude Code ever grows a Telegram-style
  always-on path

## File layout

```
integrations/_shared/
└── swarm_hook_core.py           -- runtime-agnostic HookCore class (shared with codex)

integrations/claude-code/
├── README.md                    -- this file
├── SPEC.md                      -- design notes (gaps, hook contract)
├── .claude-plugin/
│   └── plugin.json              -- Claude Code plugin manifest
├── hooks/
│   ├── hooks.json               -- hook registration
│   ├── _common.py               -- claude-code RuntimeConfig + file_path/notebook_path extractor
│   ├── session_start.py         -- 12-line stub: core.run_session_start_hook
│   ├── session_end.py           -- 12-line stub: core.run_session_end_hook
│   ├── pre_tool_use.py          -- check-only peer-lock inspection (denies on peer-held conflict)
│   └── post_tool_use.py         -- no-op back-compat shim for installs that still wire PostToolUse
├── commands/
│   └── swarm.md                 -- /swarm slash command
└── skills/
    └── swarm-mcp -> ../../../skills/swarm-mcp  -- bundled role doctrine (canonical source lives at repo-root skills/swarm-mcp/)
```

Lifecycle methods (registration, lock-conflict detection, peer scan, identity publication,
scratch-dir bookkeeping, herdr identity hint) live in the shared core.
This plugin's `_common.py` only carries claude-code-specific bits: the
`file_path` / `notebook_path` extractors, the `claude-code` label token,
the `SWARM_CC_*` env-var prefix, and the `swarm-cc` scratch namespace.
