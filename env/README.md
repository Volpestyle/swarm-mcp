# Swarm Env Files

Use these examples to create consumer-local launcher env files. Env files are the recommended place for identity, config-root, and work-tracker routing metadata. Shell aliases or functions should source these files instead of repeating long inline env assignments.

Copy the examples to a local config directory:

```sh
mkdir -p ~/.config/swarm-mcp
cp env/work.env.example ~/.config/swarm-mcp/work.env
cp env/personal.env.example ~/.config/swarm-mcp/personal.env
```

Then edit the copies for your actual MCP names, tracker teams, repos, and config roots. These files must not contain credentials. Tokens and OAuth state belong in the runtime config root or the MCP provider's own auth store.

The examples also set per-identity coordinator databases:

```sh
# work.env
export SWARM_DB_PATH="$HOME/.swarm-mcp-work/swarm.db"

# personal.env
export SWARM_DB_PATH="$HOME/.swarm-mcp-personal/swarm.db"
```

`swarm-mcp` creates the parent directory when it opens the database. Use the same `SWARM_DB_PATH` in any host MCP config that launches `swarm-mcp` directly instead of through these shell launchers.

The env examples also set identity-scoped herdr socket paths:

```sh
# work.env
HERDR_SOCKET_PATH=${HERMES_HOST_HOME:-$HOME}/.herdr/work/herdr.sock

# personal.env
HERDR_SOCKET_PATH=${HERMES_HOST_HOME:-$HOME}/volpestyle/.herdr/personal/herdr.sock
```

Use the matching value when launching the visible desktop herdr server and that
identity's gateway sessions. This gives sandboxed personal gateways a socket
they can reach without sharing the host profile socket or the work identity's
herdr state, while work sessions use their own host-visible socket.

For zsh launcher functions, copy `launchers.zsh.example` into your shell config and adjust paths if needed:

```sh
source /absolute/path/to/swarm-mcp/env/launchers.zsh.example
```

The personal launcher set is `clowd` for Claude Code, `cdx` for Codex, `opc`
for OpenCode, and `hermesp` for Hermes. Dispatch uses the same names when a
personal gateway spawns workers.

The visible herdr launcher functions are `herdrw` for the work socket and
`herdrp` for the personal socket. They run `herdr --session work` and
`herdr --session personal` with the matching `HERDR_SOCKET_PATH`.

## Published State

When Claude Code, Codex, or Hermes swarm hooks start a session, they read these env vars and publish the selected tracker metadata into swarm KV:

```text
config/work_tracker/work
config/work_tracker/personal
```

The `bootstrap` tool returns the matching row as `work_tracker` for the current registered identity.
