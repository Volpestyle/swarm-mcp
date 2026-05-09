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
[`docs/control-plane.md`](../../docs/control-plane.md). For the design parallel
in the hermes case, see [`integrations/hermes/SPEC.md`](../hermes/SPEC.md).

## What it does (v0.2.0)

| Responsibility | Mechanism |
|---|---|
| Auto-`register` on session start | `SessionStart` hook → `swarm-mcp register`, stores `instance_id` in hook scratch metadata |
| Auto-`deregister` on session end | `SessionEnd` hook → `swarm-mcp deregister` |
| Auto-lock write-class file tools when peers exist | `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) → `swarm-mcp lock` |
| Release auto-acquired locks after the tool runs | `PostToolUse` → `swarm-mcp unlock` |
| Block on real lock conflicts | PreToolUse emits `permissionDecision: deny` with the swarm reason |
| Publish and cleanup `identity/herdr/<instance_id>` | `SessionStart` / `SessionEnd` hooks → `swarm-mcp kv set/del` when `HERDR_PANE_ID` is present |
| Gateway conductor mode | `SWARM_CC_ROLE=gateway` registers as `role:planner`, blocks inline writes unless explicitly opted in |
| Peer prompt express lane | `prompt_peer` MCP tool or `swarm-mcp prompt-peer` CLI sends durable swarm message, then best-effort herdr wake |
| `/swarm` slash command (status / instances / tasks / kv / messages) | Markdown command shelling to the `swarm-mcp` CLI |

Worker-mode coordination failures are swallowed — coordination is opt-in
convenience for ordinary sessions, never critical path. Gateway mode still
blocks inline writes by default: no live peer means create/reuse a swarm task
and drive the herdr / `swarm-ui` spawn path, not native subagents or local
implementation. Solo worker sessions (no peers in scope) skip locking entirely.

### Remaining gaps vs. the hermes plugin

The Claude Code plugin now has lifecycle parity for registration, locking,
identity publication, and peer prompting. The remaining gap is the higher-level
gateway dispatch/spawn path:

- **In-agent fast dispatch.** Gateway mode blocks direct writes and gives the
  agent planner identity. The CLI now has `swarm-mcp dispatch` for idempotent
  task creation, live-worker wakeups, and spawn requests through `swarm-ui`,
  but Claude Code still does not have a plugin-local `swarm_fast_dispatch`
  tool. The CLI helper is the bridge for hooks, launcher scripts, and gateway
  wrappers that cannot call MCP tools directly.

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

That writes a project-local `.mcp.json` and copies the bundled skills. See
[`docs/install-skill.md`](../../docs/install-skill.md) for global installs and
non-Claude hosts.

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
| `SWARM_CC_GATEWAY_INLINE_WRITES` + `SWARM_CC_GATEWAY_WORKSPACE_MIRROR` | Both must be set to allow gateway inline writes; otherwise write tools are denied and should be delegated. |
| `SWARM_CC_LEASE_SECONDS` | CLI registration lease for hook-managed sessions. Defaults to `86400`; `SessionEnd` deregisters normally. |
| `SWARM_CC_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE` | Override the coordination scope. Default: git root of `cwd`. |
| `SWARM_CC_FILE_ROOT` / `SWARM_HERMES_FILE_ROOT` / `SWARM_MCP_FILE_ROOT` | Override the file root passed to `register`. |
| `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID` | When present, the SessionStart hook publishes this pane identity for express-lane peer wakes. |

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
   file the peer has locked (`swarm-mcp lock <file>` from peer terminal). The
   tool should be denied with `swarm lock blocked Edit for <file>: ...`.
4. Run `/swarm` inside the session — should print a compact status summary.

If the deny message never appears, the most common causes are:

- The SessionStart hook did not register. Check `swarm-mcp instances` — you
  should see your session there.
- `swarm-mcp` CLI is not resolvable from the hook subprocess. Set
  `SWARM_MCP_BIN` to a real command.
- No peer holds a lock on the file you're editing. Solo sessions skip
  locking by design.

## Roadmap

### v0.1 — Lifecycle bridge ✓
- SessionStart additionalContext priming registration with derived args
- Lock bridge with deny-on-conflict, fail-open elsewhere
- /swarm slash command
- Best-effort identity KV cleanup on SessionEnd

### v0.2 — Autonomous lifecycle + gateway mode ✓ (this version)
- `swarm-mcp register` / `deregister` / `list-instances`
- SessionStart/SessionEnd hooks call lifecycle commands directly
- `prompt_peer` MCP tool and `swarm-mcp prompt-peer`
- `SWARM_CC_ROLE=gateway` planner/conductor labels and inline-write blocking

### v0.3 — Dispatch/spawn orchestration
- `swarm-mcp request-task` and `swarm-mcp dispatch` for idempotent task
  creation, worker selection, no-double-spawn locking, `swarm-ui` spawn queue,
  and peer wake.
- Later: expose a synchronous-feeling in-agent helper if Claude Code gains a
  suitable plugin tool surface.

### v0.4 — Ambient peer context
- SessionStart additionalContext carries the current peer/lock/annotation
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
│   ├── pre_tool_use.py          -- 12-line stub: core.run_pre_tool_use_hook
│   └── post_tool_use.py         -- 12-line stub: core.run_post_tool_use_hook
└── commands/
    └── swarm.md                 -- /swarm slash command
```

Lifecycle methods (registration, lock-conflict detection, peer scan, identity publication,
scratch-dir bookkeeping, herdr identity hint) live in the shared core.
This plugin's `_common.py` only carries claude-code-specific bits: the
`file_path` / `notebook_path` extractors, the `claude-code` label token,
the `SWARM_CC_*` env-var prefix, and the `swarm-cc` scratch namespace.
