# Install The Skills

This repo ships these installable skills:

| Skill | Purpose |
|-------|---------|
| [`skills/swarm-mcp`](../skills/swarm-mcp) | General swarm coordination plus role workflows for planner, implementer, reviewer, researcher, and generalist sessions |
| [`skills/swarm-deepdive`](../skills/swarm-deepdive) | Forensic inspection of a swarm — reconstruct timelines, debug stuck agents, audit task/message/KV history straight from `swarm.db` and the server logs |

Invoke `swarm-mcp` directly with a role argument when you want a session to adopt a role immediately:

```text
/swarm-mcp planner
/swarm-mcp implementer
/swarm-mcp reviewer
/swarm-mcp researcher
/swarm-mcp generalist
```

Invoke `swarm-deepdive` when you want a session to investigate what a swarm did rather than participate in one — postmortems, debugging stuck tasks, auditing message/KV history.

Each skill's main `SKILL.md` stays short and routes to supporting reference files under `skills/<name>/references/` only when needed.

Important boundary:

- the skills teach agents how to use `swarm-mcp` and inspect its history well
- the skills do not install or mount the MCP server for you
- configure the `swarm` MCP server first, then install the skills

## Automated Project Setup

When using the packaged CLI, `swarm-mcp init` can write a project-local MCP config and copy the bundled skills:

```sh
swarm-mcp init --dir /path/to/project
```

This writes:

- `.mcp.json` with a `swarm` server entry that runs `npx -y swarm-mcp`
- `.claude/skills/swarm-mcp` and `.claude/skills/swarm-deepdive` unless `--no-skills` is passed

Useful flags:

- `--force`: overwrite an existing copied skill
- `--no-skills`: write only `.mcp.json`
- `--dir <path>`: install into a project directory other than the current directory

Use the manual sections below for global installs, non-Claude skill directories, or local-clone MCP configs.

## Symlink From A Local Clone (Recommended For Consumers)

If you cloned this repo or vendor it under another project, prefer symlinks over copies. Symlinks keep the skills single-sourced — when you `git pull` swarm-mcp, every consumer picks the update up automatically.

The skill sources live at:

```text
/path/to/swarm-mcp/skills/swarm-mcp
/path/to/swarm-mcp/skills/swarm-deepdive
```

Install into a consumer project (matches the convention this repo itself uses for its bundled skills, where `.claude/skills/<name>` is a symlink to `../../.agents/skills/<name>`):

```sh
# In the consumer project
mkdir -p .agents/skills .claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp
ln -s /absolute/path/to/swarm-mcp/skills/swarm-deepdive .agents/skills/swarm-deepdive
ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp
ln -s ../../.agents/skills/swarm-deepdive .claude/skills/swarm-deepdive
```

Or globally for every project on the machine:

```sh
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp
ln -s /absolute/path/to/swarm-mcp/skills/swarm-deepdive ~/.claude/skills/swarm-deepdive
```

Most agent hosts follow symlinks transparently. If yours does not, fall back to the copy-based instructions below.

## Skill Source

Copy each skill folder as a unit:

```text
skills/swarm-mcp
skills/swarm-deepdive
```

The destination folder must keep the skill name and contain `SKILL.md` plus its `references/` directory. Claude Code treats skills as slash commands, so `/swarm-mcp planner` is the role bootstrap command and `/swarm-deepdive` loads the forensic inspection workflow.

## Claude Code

Install project-locally by copying the folder to:

```text
.claude/skills/swarm-mcp
.claude/skills/swarm-deepdive
```

Or install globally for all projects:

```text
~/.claude/skills/swarm-mcp
~/.claude/skills/swarm-deepdive
```

After installing, invoke `/swarm-mcp` directly or pass a role argument like `/swarm-mcp implementer`; invoke `/swarm-deepdive` for investigations.

## Codex

Install globally by copying the folder to:

```text
~/.codex/skills/swarm-mcp
~/.codex/skills/swarm-deepdive
```

On Windows, that is typically:

```text
C:\Users\<you>\.codex\skills\swarm-mcp
C:\Users\<you>\.codex\skills\swarm-deepdive
```

PowerShell example:

```powershell
New-Item -ItemType Directory -Force "$HOME/.codex/skills" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-mcp" "$HOME/.codex/skills\swarm-mcp"
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-deepdive" "$HOME/.codex/skills\swarm-deepdive"
```

Then restart Codex so it picks up the new skill.

## OpenCode

OpenCode officially discovers skills in these locations:

- project-local: `.opencode/skills/<name>`
- global: `~/.config/opencode/skills/<name>`
- project Claude-compatible: `.claude/skills/<name>`
- global Claude-compatible: `~/.claude/skills/<name>`
- project agent-compatible: `.agents/skills/<name>`
- global agent-compatible: `~/.agents/skills/<name>`

A simple project-local install is:

```text
.opencode/skills/swarm-mcp
.opencode/skills/swarm-deepdive
```

PowerShell example from a repo root:

```powershell
New-Item -ItemType Directory -Force ".opencode/skills" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-mcp" ".opencode/skills\swarm-mcp"
Copy-Item -Recurse -Force "C:\path\to\swarm-mcp\skills\swarm-deepdive" ".opencode/skills\swarm-deepdive"
```

OpenCode loads skills on demand through its native `skill` tool. Restarting the session is still a good idea after adding a new one.

## Claude-Compatible Shared Folder

If you want one project-local location that OpenCode already treats as Claude-compatible, use:

```text
.claude/skills/swarm-mcp
.claude/skills/swarm-deepdive
```

Or globally:

```text
~/.claude/skills/swarm-mcp
~/.claude/skills/swarm-deepdive
```

This is useful when you already organize reusable agent instructions under a Claude-style skill directory and want OpenCode to discover the same skill.

## Verify The Install

After installing the skills and mounting the `swarm` MCP server:

1. Start a fresh session
2. Confirm the host can see the `swarm-mcp` and `swarm-deepdive` skills
3. Ask the agent to join the swarm or invoke `/swarm-mcp planner`
4. Verify it calls `register`, then checks `list_instances`, `poll_messages`, and `list_tasks`
5. Invoke `/swarm-deepdive` when you want an agent to inspect `swarm.db` or server logs

If the skills appear but the swarm tools do not, the skill install worked and the MCP setup did not.

## Recommended Setup

Use all three layers together:

- MCP config: makes the swarm tools available
- `AGENTS.md`: gives ambient always-on rules
- `SKILL.md`: gives the agent reusable playbooks it can load when relevant

That combination is more reliable than any one layer by itself.
