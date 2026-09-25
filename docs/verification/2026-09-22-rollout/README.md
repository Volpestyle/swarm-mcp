# Release candidate 2.0.0-rc.1

> 6 raw captures named below were removed from the tree on 2026-09-23 (evidence prune); each remains in git history at `1fe258b`, e.g. `git show 1fe258b:docs/verification/2026-09-22-rollout/<file>`.

Runtime/source revision: `4621877`. Local Windows x64 verification used Node
22.14.0 and Bun 1.3.11. No registry publication, GitHub push/unarchive or live
profile switch occurred. The selected continuation is `Volpestyle/swarm-mcp`,
branch `redesign/coordination-core`; GitHub was rechecked as archived with `main`
still at `b95f607c7692fc931cf398ccc09374bfc6b56b88`.

## Current evidence

| Requirement | Inspected evidence |
| --- | --- |
| Atomicity, delivery, fencing, protocol and runtime regression gate | [Gate manifest](gate/manifest.json): typecheck/build, 173 tests / 1,457 assertions in 48 TypeScript files, 48 Python tests; unchanged source through the run |
| Reproducible production package | [Clean install](package-install-rc1.json): actual npm tarball, 34 allowlisted files, frozen production Bun install with unchanged lockfile, no source or development tools |
| Working packaged binaries/native SQLite | Packaged Claude launcher starts packaged Node owner; real stdio discovers nine tools and completes send/fetch/ack; doctor reports matching owner/client build and configured skill |
| Explicit supported versions | Installed MCP server 2.0.0, OpenCode SDK 1.4.3, better-sqlite3 11.10.0, Zod 4.2.0; package/application 2.0.0-rc.1; modern protocol 2026-07-28 plus tested legacy compatibility |
| Stale code/config/skill diagnostics | `coordination-compatibility.test.ts`: two distinct builds reject startup before enrollment, invalid credentials cannot inspect, unsupported config version creates no database, old skill files fail; existing owner survives |
| Both legacy schema migrations and rollback | Full gate includes pinned April/upstream fixtures; [current canary](migration-rc1.json) repeats production-owner restart, reconnect, ack, fence recovery and explicitly reconciled rollback |
| Compact skill, lifecycle, worktrees and routing guidance | Validated packaged `SKILL.md`, compact payload examples matched to real tool schemas, explicit legacy-mode routing, installed-file contract check with host-context limitation |
| Optional tracker policy | Packaged tracker reference reuses VUH-35–38; one writer/version rule, uncertain-write reconciliation, no automatic worker-completed-to-issue-Done mapping |
| Context budget after bootstrap compatibility metadata | [Tokenizer output](context-rc1-tokens.json): 2- and 32-agent real stdio captures, nine tools, 2,870 schema tokens + 73 instructions, max sync text 103 tokens, three manual handoff calls after sync |
| Hosted CI | Not run at this revision. Passed on 2026-09-23 at `0ab6b90` after four runner-specific fixes; see [2026-09-23-hosted-ci](../2026-09-23-hosted-ci/README.md) |

The clean artifact is retained locally as
`dist/release/swarm-mcp-2.0.0-rc.1.tgz`, SHA-256
`24b54c5030a381a8436570d579db137ff3385b11847be601ab8992181c3134ff`.
The report records its exact contents and the embedded source digest. The clean
install uses only that extracted artifact's modules/dependencies, not repository
source or an installed Claude model session. All declared development dependency
paths were also inspected as absent after its production install.

The context captures compile the real owner/adapter sources without production
build defines, so their bootstrap build is explicitly `development-unidentified`.
They measure catalog/explicit model-call text, not billing or hidden host framing.
The packed-artifact probe separately verifies identified production build matching.
[Budget verification](budgets-rc1-context.json) combines the refreshed token capture
with the retained earlier 2/8/32 IPC measurements from VUH-1343; those latency/CPU
measurements are reused evidence, not fresh runs at this revision.

The [first clean-install probe](package-install-first.json) is retained as a
failure trace. Installation and runtime calls worked, but the harness incorrectly
looked for `doctor.inbox.acknowledged`; the actual field is `doctor.summary`.
The corrected committed harness validates acknowledgment through that field.
Earlier migration-fixture failures remain in the migration evidence archive.

## Reproduction

Run these historical commands from an isolated checkout of `bf910a1`.
Use [the current gate](../../coordination-verification.md) for current-source checks.

```powershell
bun install --frozen-lockfile
bun scripts/verify-coordination.ts
npm run verify:package
bun scripts/probe-package-install.ts dist/verification/package-install.json
bun scripts/probe-migration-cutover.ts dist/verification/migration.json
bun scripts/measure-compact-context.ts 32 dist/verification/context-32.json
uv run --with tiktoken==0.12.0 python scripts/count-context-tokens.py dist/verification/context-32.json
```

Run campaigns sequentially. Do not edit source during measurement. The verifier
creates its output directory; create the parent directory for other output paths
when using a fresh checkout. The installed skill validator also passed; it checks
frontmatter/structure, not model behavior. Supported actual-host boundaries remain
those in the runtime acceptance record.

Next external action, pending explicit authorization: unarchive the selected
repository, push the candidate branch, run/inspect Windows and Ubuntu CI, and open
a draft review PR. Merging, registry release and live installation each remain
outside that proposed action. VUH-1342 and VUH-1344 stay open until their remaining
gates are satisfied.
