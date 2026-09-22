# Reversible coordination cutover

VUH-1344 is in progress. The compatibility launch guard, versioned legacy
backup/restore and offline coordinator import below are implemented. The isolated
canary and release packaging are not yet complete. Do not switch a live profile
using this partial procedure.

## Database boundary

Keep legacy `swarm.db` and the coordinator profile's `coordination.db` separate.
The coordinator identifies its schema with application ID `0x53574d32`, rejects
legacy databases and never adopts one implicitly. Cutover must import a consistent
copy into a new destination; old data remains the rollback source. Active task
ownership and leases cannot be copied as live authority across these contracts.
The import retains their history and requires reconciliation before new execution.

The final upstream legacy binary (`b95f607`) checks schema version before
bootstrap, but April (`b446c18`) does not. Neither knows the redesigned
application identity. A schema-version value alone is insufficient protection
for those historical launch paths.

## Checked legacy launch

The packaged `swarm-legacy-guard` examines an existing database read-only before
starting its child. Only application ID zero with schema version zero or one is
accepted. Coordinator identity is rejected even if its version was accidentally
lowered to one. Missing legacy destinations are allowed so historical code can
initialize a fresh legacy database. No SQL pragmas or migrations are applied by
the guard. The current legacy entrypoint also runs the guard before opening its
write connection.

```powershell
node dist/legacy-guard-cli.js C:/isolated-cutover/legacy.db -- C:/Users/volpe/.bun/bin/bun.exe run C:/isolated-checkout/src/index.ts
```

Use the actual absolute executable path on the machine; the sample path is not
runtime discovery. The wrapper supplies `SWARM_DB_PATH` to its child, preserves
stdio and exit status, and forwards termination signals. It uses an argument
array, not a shell command string. The bin is included in the build/package.

This guard protects the checked launch path, not an arbitrary unwrapped old
binary deliberately opened against the coordinator file. It is not a filesystem
ACL or protection against concurrent path replacement. Keep paths distinct and
stop old writers during cutover; migration must not initialize a coordinator at
a path concurrently being launched as legacy. Native old consumers outside this
wrapper require equivalent checks or must remain pointed at the legacy snapshot.

## Current evidence

`test/coordination-legacy-guard.test.ts` runs the actual pinned April and final
upstream database modules. Each initializes an isolated legacy fixture. Both
Node and Bun guard launchers reject the coordinator before running either old
module, with its database bytes unchanged. The current legacy entrypoint also
rejects before bootstrap. An application-ID test covers a coordinator whose
version is deliberately set to one.

Historical source fixtures and their hashes/revisions live under
`test/fixtures/legacy-baselines/`; tests do not depend on a full Git history in CI.
Run `bun test test/coordination-legacy-guard.test.ts`. This is compatibility
evidence, not yet a migration, rollback or publication claim.

## Consistent legacy snapshot and restore

The migration command's `backup` action opens the source read-only and uses
SQLite `VACUUM INTO` to capture a consistent database, including committed WAL
pages. It does not copy just the main file or checkpoint/change the source.
The output directory must be new; no existing snapshot is overwritten. The
snapshot stores a complete legacy database and a version-1 manifest with its
SHA-256, byte length, schema version, table counts, unread-message count and
task/context state inventory. The manifest is written only after the copied
database passes integrity/schema checks and its file is flushed.

```powershell
node dist/coordination/migration-cli.js backup C:/isolated-cutover/legacy.db C:/isolated-cutover/snapshot-001
node dist/coordination/migration-cli.js verify C:/isolated-cutover/snapshot-001
node dist/coordination/migration-cli.js restore C:/isolated-cutover/snapshot-001 C:/isolated-cutover/restored-legacy.db
```

Restore verifies the manifest, checksum, SQLite integrity and inventory, then
creates a fresh destination exclusively. Existing destinations and SQLite
sidecars are rejected. It never overwrites a live coordinator or legacy file.
A failed/incomplete snapshot without a valid manifest is not restorable.

The snapshot retains read and unread messages, tasks, annotations, locks,
identities and all other legacy tables as historical data. Restoring this file
does not resolve side effects performed after the snapshot. Before an actual
rollback, stop candidate writers, retain their audit evidence, reconcile any
post-cutover effects and deliberately select the restored legacy path through
the checked launcher. Active legacy ownership is not valid coordinator authority;
unfinished imported tasks remain blocked on an explicit reconciliation task.

`test/coordination-legacy-snapshot.test.ts` verifies both pinned schema baselines
with WAL-only committed records, post-snapshot writes, pending messages, active
tasks and lock context. It checks Node CLI backup plus checksum corruption,
incomplete manifests, destination collisions and stray sidecars. Current result:
three tests, 24 assertions. This establishes backup/restore, not a completed
coordinator migration or live rollback.

## Offline import into a new coordinator profile

Stop legacy writers before the final snapshot. Import never merges into an
existing profile. Keep the source snapshot for rollback and forensic comparison.
Supply a versioned plan with an explicit one-to-one scope mapping, direct-recipient
mapping and broadcast audience. Unresolved pending recipients stop the import;
old process presence is not evidence of a current recipient identity.

```json
{
  "version": 1,
  "scopes": [{
    "from": "legacy-scope",
    "to": "isolated-canary",
    "recipients": { "old-worker-id": "new-worker-id" },
    "broadcastRecipients": ["new-worker-id", "new-reviewer-id"]
  }]
}
```

```powershell
node dist/coordination/migration-cli.js import C:/isolated-cutover/snapshot-001 C:/isolated-cutover/candidate-001 C:/isolated-cutover/plan.json
```

Choose the target scope/actor IDs from the intended trusted runtime enrollment;
the importer does not enroll sessions. All scoped source rows need a mapping,
including historical instances. The schema-11 candidate includes the complete
source rows in `legacy_records`, linked by `legacy_imports` to the snapshot hash
and plan. Original SQLite bytes remain in the verified snapshot. Binary values
in archived JSON use a base64 wrapper.

| Source data | Candidate behavior |
| --- | --- |
| Unread direct/broadcast message | Explicit recipients receive pending `legacy.message` deliveries; fresh lease and acknowledgment required |
| Read message | Archived only; historical read state is not a new processing acknowledgment |
| Unfinished task | Blocked on a new reconciliation task; no current attempt or owner |
| Terminal task | Historical terminal state with unverified provenance; original result in `legacy_records` |
| Existing task dependency | Retained when present and in the same scope; cross-scope edges reject import |
| Removed dependency | Named in the import report for reconciliation; never guessed complete from a missing row |
| Annotation / old lock | Historical finding; old locks create no active reservations |
| Shared key | Namespaced as `legacy/<key>` with provenance; old runtime hints confer no authority |
| Instance, session, lease | Archived source data only; fresh runtime enrollment and ownership required |

The reconciliation result must establish that old writers stopped, previous side
effects and missing dependencies were checked, and the new work contract is safe
to execute. Completing it releases the original task only when its other retained
dependencies are complete. It is an execution prerequisite, not human acceptance
or tracker integration. Imported messages can describe old assignments; processing
them must not bypass the task's reconciliation hold.

Import preserves the accepted pending backlog even if it exceeds the normal
per-recipient admission quota. New sends remain quota-limited until that backlog
drains. Use bounded fetches (one item for large messages). Oversized pending
message bodies and task titles fail with an explicit error instead of creating
unreadable active records; retain the snapshot and resolve those records before
retrying. No record is silently dropped to satisfy a limit.

`import.pending` blocks coordinator startup throughout construction. All imported
rows commit together in `importing.db`; the flushed `import.json` report is written
before the database is renamed to `coordination.db`, and the pending marker is
removed last. A failed or interrupted directory is retained for inspection and
must not be activated or repaired by simply deleting the marker. Retry into a
fresh directory. This proves process-crash boundaries, not power-loss durability
of directory operations on every filesystem.

`test/coordination-legacy-import.test.ts` exercises both pinned baselines, normal
delivery/ack, blocked claims and explicit reconciliation through the real core.
It also runs a Node importer and abruptly terminates it before transaction commit
and before publication: neither candidate can start. Combined migration tests
currently pass 11 tests / 104 assertions. Isolated runtime restart/lease-recovery
and operational rollback remain the next canary gate.
