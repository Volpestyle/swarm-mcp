---
description: Inspect swarm-mcp state (instances, tasks, kv, recent messages)
allowed-tools: Bash(swarm-mcp:*), Bash(bun:*), Bash(node:*)
argument-hint: "[status|instances|tasks|kv|messages]"
---

You are answering a `/swarm` slash command. The argument selects which view to
print -- treat it as read-only inspection. Default subcommand is `status`.

Subcommand: `$ARGUMENTS`

Run the matching command below, then reply with a compact summary (no
narration about how you ran it). Show counts first, then the first few rows.

- `status` (default): `!swarm-mcp inspect --json` -- summarize instances,
  tasks, kv keys, and recent messages.
- `instances`: `!swarm-mcp instances --json`
- `tasks`: `!swarm-mcp tasks --json`
- `kv`: `!swarm-mcp kv list --json`
- `messages`: `!swarm-mcp messages`

If `swarm-mcp` is not on `$PATH`, fall back to whichever resolves first:

- `!bun run /Users/james.volpe/volpestyle/swarm-mcp/src/cli.ts <subcommand> ...`
- `!node /Users/james.volpe/volpestyle/swarm-mcp/dist/cli.js <subcommand> ...`

If neither runs, surface a one-line install hint pointing to
`integrations/claude-code/README.md` and stop.
