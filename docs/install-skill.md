# Install The Packaged Skill

## Installation

The package exposes the coordinator through `swarm-mcp` and
`swarm-coordinator-mcp`. The skill uses `swarm_sync` and `swarm_inbox`;
trusted launchers enroll sessions and supply their credentials.

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

MCP configuration is supplied per session by the trusted runtime adapter,
not by putting a shared capability into a global `.mcp.json`. The Node owner uses
each profile's isolated `coordination.db`. Startup rejects databases belonging
to other applications.

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
  installer.

Use [runtime acceptance](runtime-acceptance.md) for the exact supported versions
and limitations. Runtime-owned credentials are generated automatically and are not
part of skill content. Run `node dist/coordination/client-cli.js doctor` inside the
enrolled environment to inspect owner/client build, API/schema/skill contract and
configured skill status. [Startup diagnostics](startup-compatibility.md) explain
mismatches and recovery without rotating identities.

## Install the skill

Link the entire `skills/swarm-mcp` directory from this checkout into the host's
skill root, preserving its `references/` directory. For example:

```sh
mkdir -p ~/.codex/skills
ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.codex/skills/swarm-mcp
```

Use `.claude/skills/swarm-mcp` for a project-local Claude installation or
`.opencode/skills/swarm-mcp` for OpenCode. Keep one source directory and use
symlinks where supported. The skill teaches the API; the trusted runtime mounts
it and owns enrollment, identity, credentials and host approval settings.

Start a session through that runtime, confirm the nine tools are
available, and call `swarm_sync`. A visible skill without those tools means
runtime integration is missing.
