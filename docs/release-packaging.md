# Candidate package boundary

This checkout is a local redesign candidate, not a published release. The package
manifest still carries legacy version `1.0.0`; the compact MCP server advertises
application version `2.0.0`. A release must select and record its package version
and maintained destination before publication. Neither value is an MCP protocol
revision or proof that an installed host is using the candidate.

The package uses an explicit production-file allowlist. It contains built CLI,
owner, MCP, migration and runtime adapter modules, shared legacy SQL, the consumer
skill, README and license. `opencode-plugin.js` is now a production build entry;
its lifecycle export can be imported from the package without compiling source.
Generated fixtures, verification logs, local state and repository-internal skills
are excluded. A dry run of the old broad `dist` entry included 1,100 generated
test/verification files; nothing from that dry run was published.

Build reproducibly from the committed lockfile, then inspect packaging:

```powershell
bun install --frozen-lockfile
bun run build
npm run verify:package
```

`verify:package` runs npm's actual dry-run packer, checks every production entry
and bin, and places a generated sentinel under `dist/test` to verify exclusion.
It fails on unexpected paths and is included after the full gate in the prepared
Windows/Ubuntu CI workflow. Current local result: 30 files, 1,058,658 unpacked
bytes, with all production entries present and generated files excluded. These
numbers describe this build; later skill/documentation changes may change size.

The current build pins MCP server/client SDK 2.0.0 and OpenCode SDK 1.4.3.
Node 22.14.0 and Bun 1.3.11 are the locally tested runtime versions. Protocol
compatibility is documented in [MCP compatibility](mcp-v2-compatibility.md), and
installed-host support in [runtime acceptance](runtime-acceptance.md). Reproducible
source installation uses the lockfile; an eventual registry install must have
its own clean-install/native SQLite validation before a release claim.

Remaining rollout work: update consumer skill and installation paths for the
compact contract, provide stale code/config/skill diagnostics, finalize optional
tracker guidance, select release version/destination, inspect hosted CI and obtain
publication authorization. The live installation remains unchanged.
