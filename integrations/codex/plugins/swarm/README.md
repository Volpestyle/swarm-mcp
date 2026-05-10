# swarm — Codex CLI plugin

Lifecycle bridge between Codex CLI sessions and the swarm-mcp coordinator,
mirroring the [hermes plugin](../../../hermes/) and the
[Claude Code plugin](../../../claude-code/) inside the constraints of the
Codex plugin model.

This is the *behavioural* layer that complements the other artifacts in this
repo:

- **MCP server** (`src/index.ts`) — gives the agent the swarm tools.
- **Skill** (`skills/swarm-mcp/`) — gives the agent the role doctrine.
- **Plugin** (this directory) — eliminates lifecycle boilerplate the agent
  should not have to remember.

For the broader adapter contract, see
[`docs/control-plane.md`](../../../../docs/control-plane.md). For design
parallels, see [`integrations/hermes/SPEC.md`](../../../hermes/SPEC.md) and
[`integrations/claude-code/SPEC.md`](../../../claude-code/SPEC.md).

## What it does (v0.2.0)

| Responsibility | Mechanism |
|---|---|
| Auto-`register` on session start | `SessionStart` hook → `swarm-mcp register`, stores `instance_id` in hook scratch metadata |
| Auto-`deregister` on session end | `Stop` hook → `swarm-mcp deregister` |
| Auto-lock writes when peers exist | `PreToolUse` (matcher: `apply_patch`) → parses the patch envelope, calls `swarm-mcp lock` per path |
| Release auto-acquired locks after the tool runs | `PostToolUse` → `swarm-mcp unlock` |
| Block on real lock conflicts | PreToolUse emits `permissionDecision: deny` with the swarm reason |
| Publish and cleanup `identity/workspace/herdr/<instance_id>` | `SessionStart` / `Stop` hooks → `swarm-mcp kv set/del` when `HERDR_PANE_ID` is present |
| Gateway conductor mode | `SWARM_CODEX_ROLE=gateway` registers as `role:planner`; make easy edits locally, use the MCP `dispatch` tool for medium/large task/spawn routing |
| `/swarm` slash command (status / instances / tasks / kv / messages) | Markdown command shelling to the `swarm-mcp` CLI |

Worker-mode coordination failures are swallowed — coordination is opt-in
convenience for ordinary sessions, never critical path. Gateway mode can handle
trivial, low-risk edits locally, but medium or large implementation work should
create/reuse a swarm task and route it through the MCP `dispatch` tool, not
native subagents. Solo sessions (no peers in scope) skip locking entirely.

### Codex specifics

Codex's only file-write tool is `apply_patch`, whose tool input is a
`*** Begin Patch ... *** End Patch` envelope rather than a JSON `file_path`.
The plugin parses the envelope to recover affected paths from
`*** Update File:`, `*** Add File:`, `*** Delete File:`, and `*** Move File:`
directives, then locks each one. `exec_command` and `write_stdin` are not
locked — shell-mediated writes are out of scope for v0.1.

## Install

`codex plugin marketplace add` accepts a local marketplace root. This repo's
root is the marketplace root via `.agents/plugins/marketplace.json`, which
exposes the `swarm` plugin from `integrations/codex/plugins/swarm/`. That
matches the Claude Code setup: install the repo-level marketplace once, then
let the host load the plugin and its hooks from the repo checkout.

```sh
# personal profile
CODEX_HOME=~/.codex-personal codex plugin marketplace add \
    /Users/james.volpe/volpestyle/swarm-mcp

# or work profile
codex plugin marketplace add \
    /Users/james.volpe/volpestyle/swarm-mcp
```

Plugin hooks must be enabled for the lifecycle bridge to run:

```sh
CODEX_HOME=~/.codex-personal codex features enable hooks
CODEX_HOME=~/.codex-personal codex features enable plugin_hooks
```

Restart codex so it picks up the plugin's `hooks.json` and `commands/`. On
the first launch after installing or changing hooks, review and approve the
new hook entries in `/hooks`; until they are approved, Codex will not run the
SessionStart auto-registration hook.

Codex runs hook commands from the session cwd, not the plugin root, and does
not currently expose a plugin-root environment variable to hook subprocesses.
For that reason, this plugin's hook commands locate the installed plugin under
`CODEX_HOME` / `~/.codex*` before executing the Python hook scripts.

For local plugin development, Codex discovers installed plugin versions from
real cache directories. If you want repo edits to flow into the installed
plugin without reinstalling, keep the version directory real and symlink the
plugin contents inside it, for example:

```sh
mkdir -p ~/.codex-personal/plugins/cache/swarm-mcp/swarm/0.2.0/.codex-plugin
ln -s /Users/james.volpe/volpestyle/swarm-mcp/integrations/codex/plugins/swarm/.codex-plugin/plugin.json \
  ~/.codex-personal/plugins/cache/swarm-mcp/swarm/0.2.0/.codex-plugin/plugin.json
ln -s /Users/james.volpe/volpestyle/swarm-mcp/integrations/codex/plugins/swarm/hooks.json \
  ~/.codex-personal/plugins/cache/swarm-mcp/swarm/0.2.0/hooks.json
ln -s /Users/james.volpe/volpestyle/swarm-mcp/integrations/codex/plugins/swarm/hooks \
  ~/.codex-personal/plugins/cache/swarm-mcp/swarm/0.2.0/hooks
ln -s /Users/james.volpe/volpestyle/swarm-mcp/integrations/codex/plugins/swarm/commands \
  ~/.codex-personal/plugins/cache/swarm-mcp/swarm/0.2.0/commands
```

Do not leave backup version directories such as `0.2.0.cached` under the same
plugin cache path; Codex may select them instead of the intended version.

### Make sure the swarm MCP server is mounted

This plugin expects the `swarm` MCP server to already be available inside the
session — it does not bundle a `.mcp.json`. The simplest path is to add it
once to your codex config:

```toml
# ~/.codex-personal/config.toml
[mcp_servers.swarm]
command = "bun"
args = ["run", "/Users/james.volpe/volpestyle/swarm-mcp/src/index.ts"]
```

For global installs and non-codex hosts, see
[`docs/install-skill.md`](../../../../docs/install-skill.md).

### CLI resolution

The hooks shell to the `swarm-mcp` CLI without relying on shell aliases
(codex hooks run as direct subprocesses):

1. `SWARM_MCP_BIN` as a real command — e.g.
   ```sh
   export SWARM_MCP_BIN='bun run /path/to/swarm-mcp/src/cli.ts'
   ```
2. `swarm-mcp` on `$PATH`.
3. The repo checkout's `src/cli.ts` under `bun`, then `dist/cli.js` under
   `node`.

Do **not** use a shell alias for `SWARM_MCP_BIN`; subprocesses do not expand
aliases.

### Identity, label, scope, role

Hooks pick up the same env knobs as the hermes / Claude Code plugins, with
`SWARM_CODEX_*` taking priority for codex-specific overrides:

| Variable | Purpose |
|---|---|
| `SWARM_CODEX_IDENTITY` / `AGENT_IDENTITY` / `SWARM_IDENTITY` | Auto-derives the `identity:<work\|personal>` label token. |
| `SWARM_CODEX_LABEL` / `SWARM_HERMES_LABEL` | Override the full label. If it omits `identity:`, the derived token is prepended. |
| `SWARM_CODEX_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE` | Override the coordination scope. Default: git root of `cwd`. |
| `SWARM_CODEX_FILE_ROOT` / `SWARM_HERMES_FILE_ROOT` / `SWARM_MCP_FILE_ROOT` | Override the file root passed to `register`. |
| `SWARM_CODEX_AGENT_ROLE` / `SWARM_AGENT_ROLE` | Adds a `role:<name>` token to the derived label. Accepts `planner`, `implementer`, `reviewer`, `researcher`, `generalist`, or `worker` (the default; emits no token). |
| `SWARM_CODEX_ROLE` / `SWARM_ROLE` | `worker` by default. Set `gateway` for planner/conductor behavior. |
| `SWARM_CODEX_LEASE_SECONDS` | CLI registration lease for hook-managed sessions. Defaults to `86400`; `Stop` deregisters normally. |
| `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID` | When present, the SessionStart hook publishes this pane identity for express-lane peer wakes. |

**Repo-wide role default — `.swarm-role` file.**
If `SWARM_CODEX_AGENT_ROLE` is unset, the hook walks up from `cwd` to the
coordination scope looking for a `.swarm-role` file. The first non-blank,
non-comment line is read as the role token. Drop one at the repo root to
make every codex session in that workspace register as e.g. `implementer`
without env-var ceremony:

```sh
echo implementer > .swarm-role
```

Resolution order: `SWARM_CODEX_AGENT_ROLE` → `.swarm-role` file →
`SWARM_AGENT_ROLE` → `role:planner` when `SWARM_CODEX_ROLE=gateway`. The
literal value `worker` explicitly suppresses the role token.

If no source supplies a role, the SessionStart context appends a one-line nudge
to the agent telling it how to set the token before its first peer
interaction. Skill doctrine in `skills/swarm-mcp/SKILL.md` is the source of
truth for which role to pick.

Default label format:
`identity:<id> codex platform:cli [mode:gateway] [role:<name>] origin:codex session:<id-prefix>`.
Gateway mode adds `mode:gateway` and defaults the routing role to
`role:planner`.

## Verify

In a fresh project with the swarm MCP server mounted:

1. Start codex (`cdx` or `codex`). The first turn should include a
   `SessionStart` system block saying the session is already registered with
   an `instance_id`.
2. Confirm registration: `swarm-mcp instances` from another terminal should
   show your codex session.
3. With a second peer registered in the same scope, ask the agent to apply a
   patch on a file the peer has locked
   (`swarm-mcp lock <file>` from peer terminal). The `apply_patch` tool
   should be denied with `swarm lock blocked apply_patch for <file>: ...`.
4. Run `/swarm` inside the session — should print a compact status summary.

If the deny message never appears, the most common causes are:

- The agent never registered (skill not loaded, or `register` was skipped).
  Check `swarm-mcp instances`.
- `swarm-mcp` CLI is not resolvable from the hook subprocess. Set
  `SWARM_MCP_BIN` to a real command.
- No peer holds a lock on the file you're editing. Solo sessions skip
  locking by design.

## Roadmap

### v0.1 — Lifecycle bridge ✓
- SessionStart additionalContext priming registration with derived args
- Lock bridge with deny-on-conflict, fail-open elsewhere
- /swarm slash command
- Best-effort identity KV cleanup on Stop

### v0.2 — Autonomous lifecycle + gateway mode ✓ (this version)
- `swarm-mcp register` / `deregister` / `list-instances`
- SessionStart/Stop hooks call lifecycle commands directly
- Gateway-mode planner labels, local-small/dispatch-large routing, and MCP `dispatch`

### v0.3 — Verify hook payload contract
- Empirically confirm codex's PreToolUse / PostToolUse stdin schema and
  matcher semantics; tighten path extraction once the contract is stable.

### v0.4 — Peer prompt express lane
- Use the adapter-neutral `prompt_peer` MCP tool or `swarm-mcp prompt-peer`
  CLI. No plugin-local tool surface is needed.

### v0.5 — Ambient peer context
- SessionStart additionalContext carries the current peer/lock/annotation
  snapshot so the agent starts a turn already aware of the coordination
  state.

## File layout

```
integrations/_shared/
└── swarm_hook_core.py           -- runtime-agnostic HookCore class (shared with claude-code)

integrations/codex/plugins/swarm/
├── README.md
├── SPEC.md
├── .codex-plugin/
│   └── plugin.json              -- codex plugin manifest
├── hooks.json                   -- hook registration
├── hooks/
│   ├── _common.py               -- codex RuntimeConfig + apply_patch path extractor
│   ├── session_start.py         -- 12-line stub: core.run_session_start_hook
│   ├── session_end.py           -- 12-line stub: core.run_session_end_hook
│   ├── pre_tool_use.py          -- 12-line stub: core.run_pre_tool_use_hook
│   └── post_tool_use.py         -- 12-line stub: core.run_post_tool_use_hook
└── commands/
    └── swarm.md                 -- /swarm slash command
```

The hook lifecycle methods (lock-conflict detection, peer scan, identity
registration, scratch-dir bookkeeping, herdr identity publication, etc.) live in the shared
core. This plugin's `_common.py` only carries codex-specific bits: the
`apply_patch` envelope parser, the `codex` label token, the `SWARM_CODEX_*`
env-var prefix, and the `swarm-codex` scratch namespace.
