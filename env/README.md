# Swarm Profile Env Files

A swarm-mcp "profile" is a named isolation boundary you pick (e.g. `personal`,
`work`, `client-x`, `main`). Each profile gets its own env file declaring the
identity token it uses on the wire, its coordinator DB, its herdr socket, and
the launcher aliases that map canonical agents (claude/codex/opencode/hermes)
to per-profile binaries. Profile names are user-defined — swarm-mcp has no
reserved "personal"/"work" specialness; those are just the most common pattern.

## Single-profile, two-profile, N-profile

There is no minimum or maximum. Common shapes:

- **Single profile** — one identity, one DB, one set of MCP roots. Pick any
  name (`main`, `default`, your username, …) and stop.
- **Two profiles** — `personal` and `work` are a common split, but the
  binding is to whatever isolation boundary you want (per account, per client,
  per environment).
- **N profiles** — declare one env file per boundary. Each gets its own DB
  path, herdr socket, MCP config roots, and launcher aliases.

## Setting up a profile

```sh
mkdir -p ~/.config/swarm-mcp

# Single-profile starter (recommended if you don't need multiple profiles):
cp env/default.env.example ~/.config/swarm-mcp/default.env

# Or use the pre-filled personal/work example split:
cp env/personal.env.example ~/.config/swarm-mcp/personal.env
cp env/work.env.example     ~/.config/swarm-mcp/work.env

# Or a fully generic template you copy once per profile name:
cp env/profile.env.example ~/.config/swarm-mcp/<profile>.env
```

Edit each copy for your actual MCP names, tracker teams, repos, and config
roots. These files must not contain credentials — tokens and OAuth state
belong in the runtime config root or the MCP provider's own auth store.

For the single-profile `default.env` starter, `HERMES_HOME` points at
`~/.hermes`, because Hermes' root home is where most single-profile installs
keep `config.yaml`, plugins, and MCP servers. Use `~/.hermes/profiles/<name>`
only for named Hermes profiles that actually have their own config/plugin/MCP
state.

Each profile env file declares (at minimum):

```sh
# Identity token used on the wire. Matches the file name (without .env).
export AGENT_IDENTITY=<profile>
export SWARM_IDENTITY=<profile>

# Per-profile coordinator DB.
export SWARM_DB_PATH="$HOME/.swarm-mcp-<profile>/swarm.db"

# Per-profile herdr control socket.
export HERDR_SOCKET_PATH="${HERMES_HOST_HOME:-$HOME}/.config/herdr/sessions/<profile>/herdr.sock"

# Launcher aliases. Names are your choice; swarm-mcp dispatches to whatever
# alias you set. These four are the canonical harnesses swarm-mcp knows about.
export SWARM_HARNESS_CLAUDE=<your-claude-alias>
export SWARM_HARNESS_CODEX=<your-codex-alias>
export SWARM_HARNESS_OPENCODE=<your-opencode-alias>
export SWARM_HARNESS_HERMES=<your-hermes-alias>
```

`swarm-mcp` creates the DB's parent directory on first open. Use the same
`SWARM_DB_PATH` in any host MCP config that launches `swarm-mcp` directly
instead of through these shell launchers.

## Shell launcher functions

Source `launchers.zsh.example` from your shell config. As of v0.4 it
auto-discovers profiles from `$SWARM_ENV_DIR/*.env` and materializes the
launcher functions declared by each file's `SWARM_HARNESS_*` values —
no manual `swarm_define_profile` call required.

```sh
source /absolute/path/to/swarm-mcp/env/launchers.zsh.example
```

After sourcing, the alias names declared in each profile env file become
real shell functions. With `personal.env` setting `SWARM_HARNESS_CLAUDE=clowd`,
the `clowd` function launches Claude Code with `personal.env` sourced and
`AGENT_IDENTITY=personal` exported. `SWARM_HARNESS_HERDR=herdrp` gives you
`herdrp` for a visible herdr server pinned to the personal socket. Drop a
new `<name>.env` and the matching aliases appear on the next shell.

`*_LEAD` aliases set the session as a gateway/planner so it routes
non-trivial work through the swarm `dispatch` tool instead of doing it
in-pane. Use the plain alias for workers, the lead alias for gateways.

### Three ways to launch each agent, per profile

For any profile, every canonical agent (claude/codex/opencode/hermes) has
three launch shapes. Pick whichever matches what you want that session to
do:

| Launch shape | How | What it does |
|---|---|---|
| **Worker**  | profile worker alias (`SWARM_HARNESS_CLAUDE`, e.g. `clowd`) | Registers as `identity:<profile>` worker. Sees its identity's peers, can be dispatched work, enforces file locks. |
| **Gateway** | profile lead alias (`SWARM_HARNESS_CLAUDE_LEAD`, e.g. `clowdg`) | Same registration as worker but marked `mode:gateway role:planner`. Routes medium/large work through `dispatch`, owns Linear tracker updates. |
| **Raw / vanilla** | the canonical binary directly (`claude`, `codex`, …) | **Does not register at all.** Skips swarm hooks, no DB footprint, no peer visibility. The right choice when you want an uncoordinated solo session. |

The vanilla case is the absence of a launcher — you don't define an alias
for it. If a session has no `AGENT_IDENTITY` / `SWARM_<RUNTIME>_IDENTITY` /
`SWARM_IDENTITY` env exported, the SessionStart hook detects there's no
identity to register under and exits early with a one-line stderr note.
This is intentional: an unlabeled instance would be discoverable from any
identity and defeat the cross-identity boundary, so we don't register one
at all rather than minting a synthetic `identity:unknown`.

The escape hatch is `SWARM_MCP_ALLOW_UNLABELED=1` — set it from a trusted
shell to restore the old behavior of registering without an identity. Use
this only when you know what you're doing.

### Manual overrides (optional)

Auto-discovery covers the common case. If you want to override the aliases
a profile env file declares — or skip auto-discovery entirely — call
`swarm_define_profile` yourself after sourcing the example, and it wins:

```sh
swarm_define_profile personal \
    claude=clowd codex=cdx opencode=opc hermes=hermesp-worker \
    claude_lead=clowdg codex_lead=cdxg opencode_lead=opcg hermes_lead=hermesp \
    herdr=herdrp
```

To disable auto-discovery, set `SWARM_MCP_DISABLE_AUTODEFINE=1` before
sourcing the example file.

## How dispatch picks a launcher

When a worker calls `dispatch`, swarm-mcp resolves the target launcher in
three steps:

1. Canonicalize the requested harness (`claude` / `codex` / `opencode` /
   `hermes`). Non-canonical aliases (like `clawd` or `hermesw`) reverse-map
   to the canonical name by scanning `SWARM_HARNESS_*` in the requester's
   env and across all profile env files in `$SWARM_MCP_PROFILE_DIR`
   (defaults to `~/.config/swarm-mcp`).
2. Load the target identity's profile env (process env first, then
   `<identity>.env`).
3. Return `SWARM_HARNESS_<CANONICAL>` from that env — that's the alias the
   spawned shell will exec.

If a profile doesn't declare an alias for a canonical harness, dispatch
falls back to the canonical name itself (so `claude` always works as a last
resort even without a launcher function).

## Published state

When Claude Code, Codex, or Hermes swarm hooks start a session, they read
the profile env vars and publish the selected work-tracker metadata into
swarm KV:

```text
config/work_tracker/<profile>
```

The `bootstrap` tool returns the matching row as `work_tracker` for the
current registered identity.
