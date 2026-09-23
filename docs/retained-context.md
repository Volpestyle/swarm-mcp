# Retained results, artifacts and shared context

The candidate coordinator stores findings and small shared state in SQLite and
artifact bytes beside the database in `<database>.artifacts`. These APIs are
available through the authenticated local owner; the compact MCP surface is a
separate delivery step. The live legacy database is not migrated by this change.

## Publishing evidence

Import a completed file from the session's registered worktree with
`artifact_import`. Imports accept a concise summary and media type, capture up to
64 MiB, and return an artifact ID, SHA-256 digest, byte count and
`swarm://artifacts/<id>` reference. Four simultaneous captures are allowed. Bytes
are copied and flushed before the metadata transaction commits. Retries with the
same command ID return the original receipt even if the source no longer exists.
Interrupted imports can leave unreferenced blobs; they cannot accept a partially
written blob. Windows process-crash recovery is tested; directory fsync is only
performed on platforms that support it, so this is not a Windows power-loss
durability claim.

`finding.record` links artifacts to a result, decision or file annotation. Every
finding records its authenticated author, session, timestamp, full repository
revision, relevant relative paths and concise verification evidence. Results
require a task and attempt belonging to the publishing session; expired or
abandoned attempts cannot publish new results. Revision and verification are
author assertions, not a claim that the coordinator independently ran the tests.

Query `findings` by task, file or kind with a sequence cursor and a page limit of
1–100. Scope comes from authentication. Annotations report `current`, `stale` or
`unknown` against a supplied full revision. A matching revision does not establish
that uncommitted files are unchanged. Artifact links report available, expired,
missing or corrupt data; unknown references are explicitly marked. `artifact_read`
returns base64 byte pages of at most 64 KiB and verifies content integrity before
serving data. The store is locally trusted: this is corruption detection, not
protection against a malicious process rewriting files during a read.

## Retention policy

Retention is indefinite by default, independent of process/session shutdown.
Authors can set an expiry or restore indefinite retention using `retention.set`.
For messages this authority belongs to the sender; for tasks it belongs to the
creator. Active tasks cannot expire. Findings and artifacts can also receive a
TTL at creation, from 1 millisecond to 365 days.

| Entity | At expiry | Retained history |
| --- | --- | --- |
| Message | Pending delivery expires through inbox fetch/sweep | Envelope and delivery outcomes remain inspectable; expiry does not recall an acknowledged message |
| Completed task | Current task/attempt reads omit result values and report expired | Status, dependencies, fences and attempt history remain |
| Finding/annotation | Retrieval labels it expired | Summary, revision, provenance and links remain visible |
| Artifact | Byte retrieval stops and links report expired | Metadata and content-addressed bytes remain stored |
| Shared KV | Current value is hidden and version remains | Prior revisions and tombstones remain; reset requires the current version |

Expiry is a visibility/lifecycle policy, not physical deletion or secure erasure.
Idempotency receipts retain original responses, including earlier small result
values. No shutdown cleanup, automatic blob garbage collection, or total disk
quota is implemented. Back up the database and adjacent artifact directory
together; deleting blobs independently produces visible missing references. Do
not manually purge history needed for replay or ownership fencing.

## Shared state under concurrency

`kv.set` and `kv.delete` require `expectedVersion` (zero only for a never-created
key). Deletes and expiry do not reset versions, preventing stale writers from
recreating an old value accidentally. `kv.append` is transactional, with optional
compare-and-set; command replay cannot append twice. Append refuses expired or
deleted keys until an explicit versioned reset. Values and inline task results
are limited to 8 KiB: link logs, patches and reports as artifacts instead.

`kv`, `kv_list` and `kv_history` expose author, version and timestamp with bounded
pagination. Key listing supports a literal prefix. Findings, KV history and
artifact metadata remain scoped to the authenticated coordinator profile.
