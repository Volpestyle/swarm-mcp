# Swarm MCP supported baseline and change map

Historical record of the baseline selection made on 2026-09-21; the redesign it
describes was merged in PR #9 on 2026-09-23. Kept for provenance; not maintained.

Recorded September 21, 2026 (America/Chicago). Delivery: VUH-1330.

## Decision: retain final upstream as the redesign base

Continue Volpestyle/swarm-mcp in the local branch `redesign/coordination-core`, starting from final upstream `b95f607c7692fc931cf398ccc09374bfc6b56b88`. Use `C:\Users\volpe\swarm-mcp-redesign` as the implementation worktree. The configured April checkout remains the deployed baseline until migration and rollout pass VUH-1344.

The final upstream already contains useful identity, adapter, dispatch, event and schema work. Starting again from April would discard those contracts and duplicate shipped features. Preserve their behavior where it meets the redesign guarantees; replace internals where it does not. Desktop/mobile control planes remain consumers, not a reason to add a second coordinator.

GitHub API inspection confirmed the repository is archived, last pushed May 16, with zero public forks. An owner-scoped repository search found swarm-ui (desktop consumer) and swarm-mcp, but no public maintained server successor. This does not establish the absence of private successors. The available evidence supports continuing the existing repository locally. Unarchiving, publishing, switching the configured server, and mutating its database are separate rollout actions.

## Configured runtime and reproducible checks

- Config: `C:\Users\volpe\.codex\config.toml`, server `swarm`, command `bun`, arguments `run C:\Users\volpe\swarm-mcp\src\index.ts`, cwd `C:\Users\volpe\swarm-mcp`.
- Running checkout: `main` at `b446c18bde152b070a4dd2c402c94a504390fed6` (April 3). It has no bundled runtime integration directory.
- Bun 1.3.11; installed MCP SDK 1.27.1 in both checkouts; dependency declaration remains `^1.25.2`. Latest protocol/SDK compatibility is explicitly revalidated in VUH-1337.
- Active default database: `C:\Users\volpe\.swarm-mcp\swarm.db`; read-only inspection reports `user_version=0`, tables context, instances, kv, kv_scope_updates, messages, tasks, sqlite_sequence. No candidate migration was applied.
- Final upstream fresh fixture: `user_version=1`, shared SQL bootstrap/finalize contract with the Rust consumer.
- Development startup: set `SWARM_DB_PATH` to a new temporary path, then `bun run src/index.ts`. Built Node entrypoint requires `bun run build` and its native SQLite dependency.
- Install final upstream with `bun install --frozen-lockfile`; verify TypeScript with `node node_modules/typescript/bin/tsc --noEmit`.
- `bun test` uses fixture databases. Explicitly set a fresh temporary `SWARM_DB_PATH` before invoking broader checks as an additional guard.
- Python: `python -m unittest integrations.hermes.test_lifecycle integrations._shared.test_swarm_hook_core integrations._shared.test_swarm_adapter_contract`.
- Reproduce message loss: `bun run scripts/reproduce-baseline-loss.ts <checkout>`. The script overrides the database path before imports, creates two fixture agents and asserts baseline loss. It is a historical reproduction, not a desired-behavior regression test.

## Verification at unchanged baselines

| Check | April checkout | Final upstream |
|---|---|---|
| Bun suite | 65 pass, 0 fail, 162 assertions, 3 files | 191 pass, 38 fail, 530 assertions, 11 files |
| TypeScript | Pass | Pass |
| Python integration suites | Not present | 51 pass |
| Lost response after destructive poll | Reproduced: first poll 1, retry 0 without acknowledgement | Same |
| Unread message older than one hour | Deleted | Deleted |
| Offline recipient inbox | Deleted | Deleted |

Retained logs and fixture outputs are in `docs/verification/2026-09-21-baseline/`. These are Windows results. The final upstream failures include subprocess `uv_spawn 'bun'` ENOENT, gateway-authority failures in dispatch fixtures, Windows drive letters split by colon-based root parsing, and shell-based fake backend launch failures. Their precise fixes belong in runtime and verification work; do not waive them or call the upstream suite green.

Rust desktop/server suites and UI builds were not run: the UI is an uninitialized submodule and part of the Cargo workspace. Their compatibility remains an explicit downstream integration gate, not part of the 65-test April claim. No live host lifecycle or real peer wake was verified by the Python unit tests.

## Change map

Classification compares final upstream to the requested redesign; source paths refer to the pinned final upstream revision.

| Work | State | Evidence and next action |
|---|---|---|
| VUH-1331 architecture | Missing | Existing docs/control-plane.md describes adapters, not the requested measured reliability comparison. Select guarantees and evaluate candidate topologies. |
| VUH-1332 atomic core/events | Partial | src/events.ts and shared SQL exist. src/messages.ts send commits message then event separately. Consolidate mutation/event/idempotency transactions and explicit migrations. |
| VUH-1333 acknowledged inbox | Missing | src/messages.ts poll and consumeTaskMessages mark read before caller acknowledgement; src/cleanup.ts deletes unread/recipient messages. Add replay, acknowledgement and bounded retention semantics. |
| VUH-1334 identity/task attempts | Partial | src/registry.ts adopts preassigned IDs and tracks pending launch leases. Schema has no task attempt generation/fencing. Separate stable actor identity from session ownership and fence stale writers. |
| VUH-1335 worktrees/reservations | Partial | src/context.ts canonicalizes file roots and tracks exclusive locks; Python write hooks consult locks. No OS enforcement or safe ownership transfer across lease generations. Define worktree lifecycle and reservation contract. |
| VUH-1336 durable results/context | Partial | src/tasks.ts stores structured completions; src/kv.ts provides scoped storage. Terminal tasks/events expire after 24 hours; extend durable result/artifact references and concurrency-safe context. |
| VUH-1337 protocol modernization | Missing | package.json still depends on SDK v1; src/index.ts uses its existing server/stdio implementation. Verify current spec and host matrix before upgrading. |
| VUH-1338 compact typed API | Partial | bootstrap, swarm_status, structured completion and bounded completion waits already exist. Evolve those contracts with the new domain instead of duplicating tools. |
| VUH-1339 runtime lifecycle/wake | Partial | integrations/claude-code, integrations/codex and integrations/hermes plus shared Python core exist. docs/agent-routing.md and workspace adapters separate durable messaging from best-effort wake. Add capability/recovery tests; no bundled OpenCode lifecycle plugin found. |
| VUH-1340 native/independent routing | Partial | Gateway dispatch, role matching, spawn locks and idempotency exist in src/dispatch.ts. Native routing remains guidance; demonstrate one execution across competing execution paths. |
| VUH-1341 diagnostics | Partial | src/status.ts, CLI doctor and cleanup dry-run exist. Add attempt/ack/wake/recovery diagnostics against the redesigned state model. |
| VUH-1342 fault verification | Partial | Existing tests cover identity, dispatch and backend adapters; Windows baseline has 38 failures. Add real multi-process crash/restart and mixed-version coverage. |
| VUH-1343 performance budgets | Missing | No measured workload/budget suite proving proposed coordination choices. Establish latency, idle activity, contention, context cost and recovery budgets. |
| VUH-1344 migration/rollout | Partial | Install commands, docs and version-1 bootstrap exist. Provide tested v0/v1 migration, compatibility refusal, backups, rollback and installation verification. |

Obsolete assumptions from the April-only review: there is no identity adoption, no event history, no schema version, no lifecycle adapters, no structured completion, and no bounded completion wait. Those features exist upstream; their guarantees remain incomplete.

## Existing issue reconciliation

Archived issues remain historical evidence; do not reopen or move them merely to populate this project.

- VUH-19: the precreated identity bridge is present in src/registry.ts, src/index.ts, src/backends/herdr_spawner.ts and docs/database-contracts.md. Preserve preassigned identity adoption and advisory workspace handles. Fenced incarnations remain VUH-1334.
- VUH-42: identity labels, launcher metadata, root checks, doctor and database separation guidance are present. Labels remain routing metadata, not authenticated isolation; shared SQLite access bypasses API-level policy. The Windows root-list parsing failure is concrete remaining work.
- VUH-56/VUH-57: OpenCode launch aliases/configuration exist, but the bundled integration tree contains Claude Code, Codex and Hermes. OpenCode lifecycle capability discovery and adapter verification remain VUH-1339; do not claim those historic tickets shipped.
- VUH-9: bounded completion wait is now implemented in dispatch and tested in test/workspace_identity.test.ts; reuse it in VUH-1338. A timeout returns task state rather than establishing cancellation.
- VUH-17: local SQLite and the separate Rust desktop/mobile control plane exist; no Postgres/Turso/D1 coordination backend was found. Remote storage remains a later deployment decision, not a prerequisite for reliable local coordination.

## Migration risks carried forward

1. v0 and v1 database writers differ; never let old writers silently operate against a new coordination schema. Shared Rust/TypeScript consumers need an explicit compatibility contract.
2. Upstream bootstrap sets user_version before all column alterations/finalization complete. Add transactional, ordered migrations and interrupted-upgrade tests.
3. Adopting the same ID is not fencing. Delayed old sessions must not complete tasks, release reservations or acknowledge inbox deliveries owned by newer sessions.
4. Existing cleanup destroys inboxes and result history. Migration cannot recover rows already deleted; preserve surviving data and state that limit.
5. Destructive poll callers require an explicit transition to acknowledgement semantics. Silent compatibility shims can reintroduce message loss.
6. POSIX launchers, root-list delimiters and fake executables do not establish Windows support. Preserve the failing baseline and prove actual supported host behavior.
7. Tests share imported singleton modules and mutable environment state. Isolate processes for concurrency and crash proofs; same-process tests do not prove distributed ownership.
8. UI/mobile submodules and Rust schema readers are existing consumers. Audit and test their schema/API compatibility before rollout, or explicitly refuse incompatible versions.
