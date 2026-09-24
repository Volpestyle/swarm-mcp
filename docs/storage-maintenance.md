# Storage limits and maintenance

The owner caps SQLite database pages and artifact bytes at 1 GiB each by default.
Private owner configuration accepts optional `storage.databaseBytes` and
`storage.artifactBytes` (integer bytes, minimum 1 MiB). Restart the owner to apply
changed limits. SQLite journals, WAL files and maintenance temporary space need
additional disk headroom. Artifact admission conservatively reserves capture
space, including temporary copies; deduplication does not waive that headroom.

Capacity exhaustion returns `storage_full`. A failed SQLite batch accepts none
of its commands, even when SQLite automatically rolls back its transaction.
Reads and replay remain available. A database already larger than its configured
limit requires maintenance or a larger configured limit before owner startup.

## Offline maintenance

Stop the owner deliberately after coordinating its work. Maintenance refuses a
live endpoint and holds the same process-safe SQLite lock used by owner startup,
preventing a replacement from serving while maintenance runs. Lock files stay in
place; deleting them defeats this exclusion. The database must already have the
current schema. Back up the database and adjacent artifact directory together.

```sh
swarm-coordinator-maintenance /absolute/private/owner.json
swarm-coordinator-maintenance /absolute/private/owner.json --retain-days 30 --apply
```

The default is a dry run. `--apply`:

- Compacts responses older than the retention horizon into command tombstones.
  IDs and fingerprints remain, so a retry returns `replay_expired` instead of
  repeating the original effect. Reconcile current state; do not create a new
  operation to bypass this error. Enrollment receipts and older receipts whose
  command type is unknown remain intact.
- Removes old event prefixes and retains per-scope cursor floors. A reader behind
  the floor receives `resync_required` and bootstraps again. New event IDs never
  reuse removed cursors.
- Collects old orphan captures and expired artifact bytes only when no live
  artifact, finding, task/result, message, retained shared value or recent receipt references them.
  Collection is recorded before unlinking; interrupted collection is retryable.
  Collected artifacts report `collected` and cannot be restored by extending TTL.
- Checkpoints and vacuums the database to reclaim free pages.

Accepted unread inboxes, task/session fences, terminal outcomes, findings and
shared history remain intact. Metadata is deliberately retained for identity and
audit correctness; maintenance is not a promise of unlimited lifetime capacity
or secure erasure. Explicit capacity limits bound growth without discarding work.

## Design choices

SQLite supplies both the existing storage engine and the crash-released startup
lock. PID-file cleanup cannot atomically exclude competing starters, so it does
not authorize socket removal. Probe, stale-socket cleanup and bind share one lock.

Offline collection makes reference checking and filesystem deletion exclusive
without introducing a second live state machine. Hard capacity limits protect
the interval between maintenance runs. Durable command tombstones preserve
idempotency after response compaction; deleting old command IDs would permit
duplicate execution. This trades some retained metadata for explicit failure
instead of silent data loss.
