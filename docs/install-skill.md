# Install The Packaged Skill

## Compact candidate installation

The candidate skill starts by discovering the mounted interface. `swarm_sync`
and `swarm_inbox` select the compact workflow; legacy `register`/`poll_messages`
select the retained legacy reference. Role arguments describe offered work; they
do not enroll a compact session or grant authority.

Build one pinned candidate and keep its owner, adapters and skill together:

```powershell
bun install --frozen-lockfile
bun run build
npm run verify:package
```

For an isolated packed install, pack the built checkout locally with
`npm pack --ignore-scripts`, extract the tarball into a new directory, then run
`bun install --production --frozen-lockfile` inside its `package` directory.
The tarball carries `bun.lock`; it needs neither source nor development tools to
run. The repository build scripts are not shipped, so build from the checkout,
not from the extracted runtime package. This prepares an artifact; it does not
publish it or switch an installed MCP configuration.

Copy/link the entire `skills/swarm-mcp` directory into the intended host's skill
location, keeping its references. Set `SWARM_SKILL_PATH` to the absolute path of
that actual installed copy's `SKILL.md` in the trusted launcher environment, or
pass `skillPath` to its runtime-launcher options. Startup checks the
`swarm-coordination/1` frontmatter stamp. A checked file is not proof the host
loaded it; restart/reload the host according to its native skill discovery.

Compact MCP configuration is supplied per session by the trusted runtime adapter,
not by putting a shared capability into a global `.mcp.json`. The Node owner uses
a separate profile's `coordination.db`. Do not point it at a legacy `swarm.db`;
follow [migration/canary guidance](migration-cutover.md) before activating old data.

The built modules expose the tested launcher/plugin compositions:

- Claude: `dist/coordination/claude-launcher.js` exports `prepareClaudeLaunch`.
  Supply the absolute Node, owner and hook paths, private state directory, validated
  identity/worktree roots, native session UUID and incarnation. Launch Claude with
  the returned arguments and environment; retain native approval/sandbox settings.
- OpenCode: `dist/coordination/opencode-plugin.js` exports `opencodeLifecycle`.
  Use the trusted options and native plugin wiring in the
  [OpenCode integration specification](../integrations/opencode/SPEC.md).
- Codex: `dist/coordination/codex-launcher.js` composes the verified existing-thread
  resume path. It is not an automatic initial-enrollment or autonomous-delivery
  installer. Hermes actual-host rollout remains unverified.

Use [runtime acceptance](runtime-acceptance.md) for the exact supported versions
and limitations. Runtime-owned credentials are generated automatically and are not
part of skill content. Run `node dist/coordination/client-cli.js doctor` inside the
enrolled environment to inspect owner/client build, API/schema/skill contract and
configured skill status. [Startup diagnostics](startup-compatibility.md) explain
mismatches and recovery without rotating identities.

## Legacy setup and host skill locations

The `swarm-mcp init` instructions below configure the legacy entrypoint. They do
not install the compact owner or its automatic session lifecycle. Host skill-copy
locations apply to either workflow; select the actual MCP surface first.

This repo ships one consumer installable skill:

| Skill | Purpose |
|-------|---------|
| [`skills/swarm-mcp`](../skills/swarm-mcp) | General swarm coordination plus role workflows for planner, implementer, reviewer, researcher, and generalist sessions |

Invoke `swarm-mcp` directly with a role argument when you want a session to adopt a role immediately:

```text
/swarm-mcp planner
/swarm-mcp implementer
/swarm-mcp reviewer
/swarm-mcp researcher
/swarm-mcp generalist
```

The skill's main `SKILL.md` stays short and routes to supporting reference files under `skills/swarm-mcp/references/` only when needed.

Repo-internal skills such as `swarm-deepdive` and `tauri` live under [`.agents/skills`](../.agents/skills). They are for working on this repository and are not copied by `swarm-mcp init` or shipped as consumer skills by default.

Important boundary:

- the skill teaches agents how to use `swarm-mcp` well
- the skill does not install or mount the MCP server for you
- configure the `swarm` MCP server first, then install the skill

## Automated Legacy Project Setup

When using the packaged CLI, `swarm-mcp init` can write a project-local MCP config and copy the packaged skill:

```sh
swarm-mcp init --dir /path/to/project
```

This writes:

- `.mcp.json` with a `swarm` server entry that runs `npx -y swarm-mcp`
- `.claude/skills/swarm-mcp` unless `--no-skills` is passed

Useful flags:

- `--force`: overwrite an existing copied skill
- `--no-skills`: write only `.mcp.json`
- `--dir <path>`: install into a project directory other than the current directory

Use the manual sections below for global installs, non-Claude skill directories, or local-clone MCP configs.

## Symlink From A Local Clone (Recommended For Consumers)

If you cloned this repo or vendor it under another project, prefer symlinks over copies. Symlinks keep the skills single-sourced — when you `git pull` swarm-mcp, every consumer picks the update up automatically.

The skill source lives at:

```text
/path/to/swarm-mcp/skills/swarm-mcp
```

Install into a consumer project:

```sh
# In the consumer project
mkdir -p .agents/skills .claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp
ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp
```

Or globally for every project on the machine:

```sh
mkdir -p ~/.claude/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp
```

Most agent hosts follow symlinks transparently. If yours does not, fall back to the copy-based instructions below.

## Skill Source

Copy the skill folder as a unit:

```text
skills/swarm-mcp
```

The destination folder must keep the skill name and contain `SKILL.md` plus its `references/` directory. Claude Code treats skills as slash commands, so `/swarm-mcp planner` is the role bootstrap command.

## Claude Code

Install project-locally by copying the folder to:

```text
.claude/skills/swarm-mcp
```

Or install globally for all projects:

```text
~/.claude/skills/swarm-mcp
```

After installing, invoke `/swarm-mcp` directly or pass a role argument like `/swarm-mcp implementer`.

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

- project-local: `.opencode/skills/<name>`
- global: `~/.config/opencode/skills/<name>`
- project Claude-compatible: `.claude/skills/<name>`
- global Claude-compatible: `~/.claude/skills/<name>`
- project agent-compatible: `.agents/skills/<name>`
- global agent-compatible: `~/.agents/skills/<name>`

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

After installing the skills and mounting the `swarm` MCP server:

1. Start a fresh session
2. Confirm the host can see the `swarm-mcp` skill
3. Ask the agent to join the swarm or invoke `/swarm-mcp planner`
4. Verify it calls `register`, then `bootstrap`

If the skill appears but the swarm tools do not, the skill install worked and the MCP setup did not.

## Recommended Setup

Use all three layers together:

- MCP config: makes the swarm tools available
- `AGENTS.md`: gives ambient always-on rules
- `SKILL.md`: gives the agent the reusable playbook it can load when relevant

That combination is more reliable than any one layer by itself.
