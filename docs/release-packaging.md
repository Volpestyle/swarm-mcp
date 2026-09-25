# Package boundary

The package version lives in `package.json`. A built owner advertises its version,
source digest and SDK version through [startup diagnostics](startup-compatibility.md).
Package preparation does not publish a release or activate a live profile.

The production-file allowlist ships coordinator executables, runtime exports and
type declarations, consumer skill, lockfile,
runtime guide, README and license. `swarm-mcp` and `swarm-coordinator-mcp` point to
the same MCP entrypoint. `swarm-mcp/runtime` is the public embedding export.
Generated test state, host probe captures and development dependencies are excluded.
Optional Python write hooks are used from a checkout with their shared directory.

```sh
bun install --frozen-lockfile
bun run check
```

The build derives executable entries from `package.json`, bundles them for Node 22
and emits Node ESM declarations for the public runtime export. `verify:package`
uses npm's actual dry-run packer to check every bin and allowed production path,
including a generated-state sentinel that must not ship. CI runs the same check.

For a production-only installation check:

```sh
npm run verify:install -- dist/package-install.json
```

The probe creates an isolated tarball installation with a frozen production
lockfile, launches the packaged Node owner through the Claude launcher, and
exercises real MCP discovery, message delivery and acknowledgment. It checks
build/skill diagnostics and dependency versions without source or development
tools. It does not launch a model session or change live host configuration.
See [installation](install-skill.md) and [runtime embedding](runtime-embedding.md)
for supported deployment paths.
