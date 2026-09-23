# Package boundary

The package and compact MCP application advertise version `2.0.0-rc.1`. That is
a package version, not an MCP protocol revision or proof that an installed host
is using it. The package is built from `main` and is not yet published to npm.

The package uses an explicit production-file allowlist (`files` in
`package.json`). It contains built CLI, owner, MCP, migration and runtime adapter
modules, shared legacy SQL, the consumer skill, frozen Bun lockfile, README and
license. `opencode-plugin.js` is a production build entry; its lifecycle export
can be imported from the package without compiling source. Generated fixtures,
verification logs, local state and repository-internal skills are excluded. A
dry run of the old broad `dist` entry included 1,100 generated
test/verification files; nothing from that dry run was published.

The bins are `swarm-mcp` (legacy stdio entry), `swarm-legacy-guard`,
`swarm-coordinator-migrate`, `swarm-coordinator-client`, `swarm-coordinator-mcp`
and `swarm-coordinator-owner`.

Build reproducibly from the committed lockfile, then inspect packaging:

```powershell
bun install --frozen-lockfile
bun run build
npm run verify:package
```

`verify:package` runs npm's actual dry-run packer, checks every production entry
and bin, and places a generated sentinel under `dist/test` to verify exclusion.
It fails on unexpected paths and runs after the full gate in the Windows/Ubuntu
CI workflow. It reports actual file count and unpacked bytes for each build,
with all production entries present and generated files excluded.

The build pins MCP server/client SDK 2.0.0 and OpenCode SDK 1.4.3. Node 22.14.0
and Bun 1.3.11 are the locally tested runtime versions. Protocol compatibility is
documented in [MCP compatibility](mcp-v2-compatibility.md), and installed-host
support in [runtime host support](runtime-host-support.md). Reproducible source
and extracted-tarball installation use the included lockfile.

## Clean-install probe

The clean package probe extracts into a new temporary directory, performs a
production-only frozen install, launches the packaged Node owner through the
packaged Claude launcher and exercises real stdio discovery, message delivery
and acknowledgment. It checks build/skill diagnostics and installed SDK/native
SQLite versions without source or development dependencies. It does not launch
a Claude model session or claim an arbitrary registry client's resolution is
identical to the frozen install.

Run it after building with `bun scripts/probe-package-install.ts <report.json>`;
the report's parent directory must exist. The harness uses the npm CLI beside the
selected Node executable, the installed Bun binary and `tar`. It retains temporary
state for inspection and emits only a credential-free report.

The [installation guide](installation.md), packaged skill,
[startup diagnostics](startup-compatibility.md) and
[tracker policy](linear-promotion-policy.md) describe what the package installs.

History: delivered under VUH-1344 (September 2026); merged in PR #9.
