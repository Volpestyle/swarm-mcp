# Reversible coordination cutover

VUH-1344 is in progress. The compatibility launch guard below is implemented;
the versioned legacy-data import, backup/restore tooling, isolated canary and
release packaging are not yet complete. Do not switch a live profile using this
partial procedure.

## Database boundary

Keep legacy `swarm.db` and the coordinator profile's `coordination.db` separate.
The coordinator identifies its schema with application ID `0x53574d32`, rejects
legacy databases and never adopts one implicitly. Cutover must import a consistent
copy into a new destination; old data remains the rollback source. Active task
ownership and leases cannot be copied as live authority across these contracts.
Their import policy and recovery proof remain part of the data-migration work.

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
