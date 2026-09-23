# Legacy migration and isolated cutover evidence

> 7 raw captures named below were removed from the tree on 2026-09-23 (evidence prune); each remains in git history at `1fe258b`, e.g. `git show 1fe258b:docs/verification/2026-09-22-migration/<file>`.

Production revision: `8a1a0b5`. Windows x64, Node 22.14.0, Bun 1.3.11.
The [final gate manifest](gate/manifest.json) records an unchanged source tree
through the run. Typecheck, production build, 171 TypeScript tests / 1,436
assertions in 47 files, and 48 Python tests passed. Hosted CI remains unrun.

The [canary capture](canary.json) comes from the committed
`scripts/probe-migration-cutover.ts` harness over actual local IPC to the production
Node owner. It records the source revision, diff, harness and owner bundle hashes.
It uses disposable final-upstream data and an isolated scope; no live profile,
installed agent host, external service or published package participates.

Verified sequence:

1. Initialize the pinned upstream legacy schema with two pending messages, an
   active task and an old file lock. Stop its writer, snapshot, then import into
   a fresh coordinator directory with explicit recipient/controller mappings.
2. Reject claiming the imported task before reconciliation. Acknowledge the first
   message; lease the second without acknowledging it. Complete reconciliation
   and acquire a short-lived task attempt, then terminate the owner process.
3. Restart the owner, replay the first acknowledgment receipt, and refetch the
   second message after real lease expiry/backoff. Reject its old lease token;
   close/reconnect the consumer before acknowledging its current token.
4. Recover the task, advance fence 1 to 2 and reject the first attempt's finish.
   Exclusively create one fixture result and finish under the current fence.
   A repeated finish replays its receipt. Both messages are acknowledged; task
   history contains one abandoned and one completed attempt.
5. Stop candidate writers. Restore into a fresh legacy path. Explicitly reconcile
   the retained fixture effect and processed messages into that restored copy,
   then run the actual pinned legacy module through the checked Node launcher.
   Verify the reconciled result/read state and unchanged original snapshot hash.

The generic restore does not perform step 5's reconciliation. Restoring a snapshot
alone would expose the old unfinished task and unread messages again. This canary
demonstrates an inspectable operator procedure with a known fixture effect, not
automatic rollback of arbitrary external effects or exactly-once execution of
uncooperative workers. Process crashes are covered; hard-power-loss guarantees
for directory publication are not claimed.

The [retained failed gate](gate-before-fixture-fix/manifest.json), at `b3a5c97`,
found an obsolete fixture construction: it dropped newer tables to pretend to be
schema 1, but left schema 11's import tables behind. `843882e` replaces this with
a fixed schema-1 SQL fixture and checks preserved task data plus migration rollback.
The failed trace is kept rather than rewritten as a passing run.

Reproduce from the candidate checkout:

```powershell
bun install --frozen-lockfile
bun run build
bun scripts/probe-migration-cutover.ts dist/verification/migration-canary.json
bun scripts/verify-coordination.ts
```

The output directory for the canary must already exist. The harness prints its
report path and exits nonzero on failure. Temporary fixture state is retained for
inspection; credentials are not included in the committed report. Live cutover,
release-destination authorization and Windows/Ubuntu hosted CI remain separate gates.
