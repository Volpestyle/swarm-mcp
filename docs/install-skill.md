# Install The Skill

This repo ships three installable skills:

| Skill | Purpose |
|-------|---------|
| [`skills/swarm-mcp`](../skills/swarm-mcp) | General swarm coordination (any role) |
| [`skills/swarm-planner`](../skills/swarm-planner) | Bootstrap as a planner with autonomous monitoring loop |
| [`skills/swarm-implementer`](../skills/swarm-implementer) | Bootstrap as an implementer with autonomous work loop |

Use `swarm-mcp` when the session's role is flexible. Use `swarm-planner` or `swarm-implementer` when you want a session to immediately adopt a specific role and enter an autonomous loop.

Important boundary:

- the skills teach an agent how to use `swarm-mcp` well
- the skills do not install or mount the MCP server for you
- configure the `swarm` MCP server first, then install the skill(s)

## Skill Source

Copy the desired skill folder(s) as a unit:

```text
skills/swarm-mcp
skills/swarm-planner
skills/swarm-implementer
```

Each destination folder must keep its original name and contain `SKILL.md`.

## Claude Code Slash Commands

For Claude Code users, this repo also ships slash commands in [`commands/`](../commands/):

```text
commands/swarm-planner.md
commands/swarm-implementer.md
```

Copy these into your project's `.claude/commands/` directory to enable `/swarm-planner` and `/swarm-implementer` as slash commands.

## Codex

Install globally by copying the folder to:

```text
~/.codex/skills/swarm-mcp
```

On Windows, that is typically:

```text
C:\Users\<you>\.codex\skills\swarm-mcp
```

PowerShell example:

```powershell
New-Item -ItemType Directory -Force "$HOME/.codex/skills" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-mcp" "$HOME/.codex/skills\swarm-mcp"
```

Then restart Codex so it picks up the new skill.

## OpenCode

OpenCode officially discovers skills in these locations:

- project-local: `.opencode/skills/swarm-mcp`
- global: `~/.config/opencode/skills/swarm-mcp`
- project Claude-compatible: `.claude/skills/swarm-mcp`
- global Claude-compatible: `~/.claude/skills/swarm-mcp`
- project agent-compatible: `.agents/skills/swarm-mcp`
- global agent-compatible: `~/.agents/skills/swarm-mcp`

A simple project-local install is:

```text
.opencode/skills/swarm-mcp
```

PowerShell example from a repo root:

```powershell
New-Item -ItemType Directory -Force ".opencode/skills" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-mcp" ".opencode/skills\swarm-mcp"
```

OpenCode loads skills on demand through its native `skill` tool. Restarting the session is still a good idea after adding a new one.

## Claude-Compatible Shared Folder

If you want one project-local location that OpenCode already treats as Claude-compatible, use:

```text
.claude/skills/swarm-mcp
```

Or globally:

```text
~/.claude/skills/swarm-mcp
```

This is useful when you already organize reusable agent instructions under a Claude-style skill directory and want OpenCode to discover the same skill.

## Verify The Install

After installing the skill and mounting the `swarm` MCP server:

1. Start a fresh session
2. Confirm the host can see the `swarm-mcp` skill
3. Ask the agent to join the swarm or coordinate through `swarm-mcp`
4. Verify it calls `register`, then checks `list_instances`, `poll_messages`, and `list_tasks`

If the skill appears but the swarm tools do not, the skill install worked and the MCP setup did not.

## Recommended Setup

Use all three layers together:

- MCP config: makes the swarm tools available
- `AGENTS.md`: gives ambient always-on rules
- `SKILL.md`: gives the agent a reusable swarm playbook it can load when relevant

That combination is more reliable than any one layer by itself.
