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

## What it does (v0.1.0)

| Responsibility | Mechanism |
|---|---|
| Compute label/scope/identity, prime registration | `SessionStart` hook → `additionalContext` instructing the agent to call `register` with the canonical args |
| Auto-lock write-class file tools when peers exist | `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) → `swarm-mcp lock` |
| Release auto-acquired locks after the tool runs | `PostToolUse` → `swarm-mcp unlock` |
| Block on real lock conflicts | PreToolUse emits `permissionDecision: deny` with the swarm reason |
| Cleanup `identity/herdr/<instance_id>` on session exit | `SessionEnd` hook → `swarm-mcp kv del` (best effort) |
| `/swarm` slash command (status / instances / tasks / kv / messages) | Markdown command shelling to the `swarm-mcp` CLI |

Failures are swallowed — coordination is opt-in convenience, never critical
path. Solo sessions (no peers in scope) skip locking entirely.

### Gaps vs. the hermes plugin

The Claude Code plugin model and the swarm-mcp CLI surface have a few seams
the hermes plugin can paper over but this one cannot, yet:

- **Auto-`register`/`deregister`.** The `swarm-mcp` CLI exposes `lock`,
  `unlock`, `kv`, `send`, `broadcast`, and inspection commands, but not
  `register`, `deregister`, or `list_instances`. Claude Code hooks cannot
  reach the agent's MCP tool surface, so this plugin primes the agent to
  register itself (via `additionalContext`) instead. Adding those
  subcommands upstream would let the hooks be fully autonomous; tracked as
  a follow-up below.
- **`swarm_prompt_peer` express-lane tool.** The hermes plugin registers a
  custom tool through hermes' plugin API. Claude Code plugins can ship MCP
  servers but cannot inject single tools into a hosted session. The right
  home for this is the swarm-mcp server itself — adding a `prompt_peer`
  tool there benefits every adapter (Claude, Codex, OpenCode, hermes) at
  once.

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
| `SWARM_CC_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE` | Override the coordination scope. Default: git root of `cwd`. |
| `SWARM_CC_FILE_ROOT` / `SWARM_HERMES_FILE_ROOT` / `SWARM_MCP_FILE_ROOT` | Override the file root passed to `register`. |
| `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID` | When present, the SessionStart context tells the agent to publish its herdr identity for express-lane peer wakes. |

Default label format mirrors hermes: `identity:<id> claude-code platform:cli session:<id-prefix>`.

## Verify

In a fresh project with the swarm MCP server mounted:

1. Start Claude Code. The first turn should see a system block from
   `SessionStart` instructing it to call `register` with a concrete label and
   scope.
2. Confirm registration: `swarm-mcp instances` from another terminal should
   show your session.
3. With a second peer registered in the same scope, ask the agent to edit a
   file the peer has locked (`swarm-mcp lock <file>` from peer terminal). The
   tool should be denied with `swarm lock blocked Edit for <file>: ...`.
4. Run `/swarm` inside the session — should print a compact status summary.

If the deny message never appears, the most common causes are:

- The agent never registered (skill not loaded, or `register` was skipped).
  Check `swarm-mcp instances` — you should see your session there.
- `swarm-mcp` CLI is not resolvable from the hook subprocess. Set
  `SWARM_MCP_BIN` to a real command.
- No peer holds a lock on the file you're editing. Solo sessions skip
  locking by design.

## Roadmap

### v0.1 — Lifecycle bridge ✓ (this version)
- SessionStart additionalContext priming registration with derived args
- Lock bridge with deny-on-conflict, fail-open elsewhere
- /swarm slash command
- Best-effort identity KV cleanup on SessionEnd

### v0.2 — Upstream CLI extensions
- Add `swarm-mcp register` / `deregister` / `list_instances` subcommands so
  hooks can be fully autonomous (no agent priming required)
- Update SessionStart/SessionEnd hooks to call them directly

### v0.3 — Peer prompt express lane
- Add `prompt_peer` to the swarm MCP server itself (benefits every adapter,
  not just one runtime)
- This plugin gains nothing new — the tool flows in via the existing MCP
  mount

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
integrations/claude-code/
├── README.md                    -- this file
├── SPEC.md                      -- design notes (gaps, hook contract)
├── .claude-plugin/
│   └── plugin.json              -- Claude Code plugin manifest
├── hooks/
│   ├── hooks.json               -- hook registration
│   ├── _common.py               -- shared CLI/identity helpers
│   ├── session_start.py
│   ├── session_end.py
│   ├── pre_tool_use.py
│   └── post_tool_use.py
└── commands/
    └── swarm.md                 -- /swarm slash command
```
