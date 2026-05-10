# Swarm Env Files

Use these examples to create consumer-local launcher env files. Env files are the recommended place for identity, config-root, and work-tracker routing metadata. Shell aliases or functions should source these files instead of repeating long inline env assignments.

Copy the examples to a local config directory:

```sh
mkdir -p ~/.config/swarm-mcp
cp env/work.env.example ~/.config/swarm-mcp/work.env
cp env/personal.env.example ~/.config/swarm-mcp/personal.env
```

Then edit the copies for your actual MCP names, tracker teams, repos, and config roots. These files must not contain credentials. Tokens and OAuth state belong in the runtime config root or the MCP provider's own auth store.

For zsh launcher functions, copy `launchers.zsh.example` into your shell config and adjust paths if needed:

```sh
source /absolute/path/to/swarm-mcp/env/launchers.zsh.example
```

## Published State

When Claude Code, Codex, or Hermes swarm hooks start a session, they read these env vars and publish the selected tracker metadata into swarm KV:

```text
config/work_tracker/work
config/work_tracker/personal
```

The `bootstrap` tool returns the matching row as `work_tracker` for the current registered identity.
