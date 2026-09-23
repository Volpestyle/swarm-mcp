# Transactional coordination core — VUH-1332

> 1 raw capture named below were removed from the tree on 2026-09-23 (evidence prune); each remains in git history at `1fe258b`, e.g. `git show 1fe258b:docs/verification/2026-09-21-core/<file>`.

Implemented on `redesign/coordination-core`. The existing configured server and its database were not switched.

## Delivered boundary

The new `src/coordination/` layer separates domain commands, SQLite storage, migration and local IPC. It is the shared foundation for the redesigned MCP/CLI/host bindings; old bindings remain on the legacy implementation until their migration tickets. The first domain commands create and cancel open tasks. Inbox processing, session generations, task attempts and artifact retention extend this same boundary in VUH-1333–1336.

- `core.ts`: trusted actor context, legal task transitions, creator checks, version compare-and-set, scoped queries, bounded cursor waits.
- `store.ts`: one immediate transaction for state, ordered events and command receipts. A reused command ID with different content conflicts; matching retries return the original result. State mutation without an event rolls back. Payloads are bounded JSON and keyed canonically.
- `migrations.ts`: explicit application identity and schema version; schema, identity and version commit together under a write lock. A second opener checks the version after obtaining the lock. Legacy databases and unsupported future schemas are refused.
- `sqlite.ts`: instance-owned Bun/Node SQLite driver selection. There is no global default database or import-time database mutation. Callers must supply an absolute path.
- `ipc.ts`: OS-local framed requests, capability-to-actor authorization supplied by the owner, command/query/wait operations, request limits, disconnect cancellation and replay-compatible client errors. The wire cannot choose its own actor or scope. The service has no default allow-all authorizer.

The SQLite event table is the durable outbox. Notifications happen after commit and remain hints; a subscriber can reconnect and query by event cursor even when the publishing process exited before notification. Same-timestamp changes do not collapse into a clock maximum.

The task cancellation predicate checks scope, creator, version and current open state inside the transaction. Session/attempt fencing is deliberately still VUH-1334; this result does not claim that task attempts are implemented.

## Verification

Command:

`bun test test/coordination-core.test.ts test/coordination-ipc.test.ts`

Result: **19 pass, 0 fail, 69 assertions**. TypeScript checking also passed with `node node_modules/typescript/bin/tsc --noEmit`.

Tests exercise:

1. Task/event/receipt atomicity, matching retries and mismatched-payload conflict.
2. Ordered pagination when every event has the same timestamp.
3. Scope, creator and version rejection without spurious events.
4. Injected pre-commit failure leaving zero task, event and command rows.
5. Throwing notification handlers after a successful commit.
6. Mutation-without-event rollback.
7. Actual subprocess exit after commit but before notification, followed by reopening and replay, under both Bun and Node.
8. Actual subprocess exit during migration, leaving version zero and no adopted tables, under both runtimes.
9. Eight concurrent open/create subprocesses converging on one command/event, under each runtime.
10. Legacy/future database refusal without version rewriting.
11. Bun clients against a real Node service over Windows named pipes: command replay, held waits, capability rejection, scope isolation and reconnect cursor replay.
12. Node-to-Node roundtrip and duplicate-owner endpoint rejection.

The broader suite run, before adding the three extra Node persistence cases, reported **207 pass, 38 fail**. Comparison of normalized failing test names against the recorded upstream baseline found exactly the same 38 cases; no new failing case appeared. That is not a green release suite. The final targeted run above covers the additional Node cases. Raw outputs are retained beside this report; encoding and trailing whitespace are normalized for review.

## Runtime finding and decision

`node scripts/reproduce-windows-pipe.mjs --duplicate` returns `EADDRINUSE` for the second service after two successful client echoes. The same script under Bun 1.3.11 echoes to both clients, then terminates with a native assertion failure on duplicate binding (exit 3). Ordinary multiple-client communication works; duplicate service binding is the isolated failure.

Use Node 22 for the Windows coordination owner. The serving function explicitly refuses the unsupported Bun/Windows owner combination before calling the crashing API. Both Bun and Node clients are verified against the Node owner. A newer Bun owner requires this runtime contract to pass before enabling it.

Bun's asynchronous rejection matcher also stalled pending named-pipe assertions. Tests now await the actual rejection before inspecting its code; the production request/rejection behavior is unchanged. The separate duplicate-bind crash remains reproducible outside the test runner.

Cross-runtime testing exposed a real driver difference: a missing row is `null` under Bun SQLite and `undefined` under better-sqlite3. The store normalizes both to `null`, preventing omission of missing results from IPC JSON.

## Integration limits

This delivers the core and serving/client library, not a default-runtime cutover. The service requires an injected authorizer; fixed test capabilities are confined to fixtures. Production identity/session capability issuance and authority epochs belong to VUH-1334, adapter lifecycle to VUH-1339, and MCP/CLI surface migration to VUH-1337/1338. No test token is installed in a user profile.

The new store rejects legacy `swarm.db` rather than attempting an implicit upgrade. VUH-1344 must migrate a copy and establish rollback before configuration changes. Unix socket and live-host automation claims remain subject to their platform/host verification gates.

Rerun the targeted suite from the repository root. Node fixture bundles are generated under ignored `dist/test/`; databases are isolated temporary fixtures. This code introduces no remote service and no generic storage-provider framework.
