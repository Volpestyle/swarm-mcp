# Installation

This guide installs the v2 coordinator: one Node-owned coordinator process per
profile, thin stdio MCP adapters and trusted runtime launchers for Claude Code,
OpenCode and Codex. The legacy stdio interface is installed separately through
`swarm-mcp init`; see the [legacy installation guide](legacy/install.md).

The packaged skill starts by discovering the mounted interface. `swarm_sync` and
`swarm_inbox` select the compact workflow; legacy `register`/`poll_messages`
select the retained legacy reference. Role arguments describe offered work; they
do not enroll a compact session or grant authority.

## Build and package

Build one pinned checkout and keep its owner, adapters and skill together:

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
not from the extracted runtime package. Packing produces a local artifact; it
does not switch an installed MCP configuration. The package is built from `main`
and is not yet published to npm; see the [package boundary](packaging.md).

## Install the packaged skill

Copy/link the entire `skills/swarm-mcp` directory into the intended host's skill
location, keeping its references. Set `SWARM_SKILL_PATH` to the absolute path of
that actual installed copy's `SKILL.md` in the trusted launcher environment, or
pass `skillPath` to its runtime-launcher options. Startup checks the
`swarm-coordination/1` frontmatter stamp. A checked file is not proof the host
loaded it; restart/reload the host according to its native skill discovery.

Compact MCP configuration is supplied per session by the trusted runtime adapter,
not by putting a shared capability into a global `.mcp.json`. The Node owner uses
a separate profile's `coordination.db`. Do not point it at a legacy `swarm.db`;
follow the [migration and cutover guide](migration-cutover.md) before activating
old data.

## Per-host launcher wiring

The built modules expose the tested launcher/plugin compositions:

- Claude: `dist/coordination/claude-launcher.js` exports `prepareClaudeLaunch`.
  Supply the absolute Node, owner and hook paths, private state directory, validated
  identity/worktree roots, native session UUID and incarnation. Launch Claude with
  the returned arguments and environment; retain native approval/sandbox settings.
- OpenCode: `dist/coordination/opencode-plugin.js` exports `opencodeLifecycle`.
  Use the trusted options and native plugin wiring in the
  [OpenCode integration specification](../integrations/opencode/SPEC.md).
- Codex: `dist/coordination/codex-launcher.js` composes the verified existing-thread
  resume path (`resumeCodexThread`, `resumeCodexRuntime`). It is not an automatic
  initial-enrollment or autonomous-delivery installer. Hermes actual-host
  operation is unverified.

Use [runtime host support](runtime-host-support.md) for the exact supported
versions and limitations. Runtime-owned credentials are generated automatically
and are not part of skill content.

## Doctor

Run `node dist/coordination/client-cli.js doctor` (the `swarm-coordinator-client`
bin) inside the enrolled environment to inspect owner/client build, API/schema/
skill contract and configured skill status.
[Startup diagnostics](startup-compatibility.md) explain mismatches and recovery
without rotating identities.

History: delivered under VUH-1344 (September 2026); merged in PR #9.
