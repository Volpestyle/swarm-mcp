# Compact coordinator API (in progress)

Run `node dist/coordination/mcp-cli.js` with a trusted launcher's
`SWARM_COORDINATOR_ENDPOINT` and `SWARM_SESSION_CAPABILITY`. The adapter opens no
database and cannot choose an actor or scope from model-supplied arguments. The
Node owner authorizes every operation. Automatic launch/enrollment is VUH-1339.
The legacy `swarm-mcp` entry remains available while migration is completed.

| Tool | Common path |
| --- | --- |
| `swarm_sync` | Omit cursor for bootstrap; retain eventCursor and resume with deltas; optionally wait up to 30 seconds |
| `swarm_find` | Page scoped peers/tasks or read a normalized task with contract, dependencies, current owner and parsed result |
| `swarm_assign` | Persist a contract and dependencies; return immediately with a durable task ID |
| `swarm_task` | Claim with expectedVersion; use attemptId/fence for renew/progress/finish; cancel/retry/recover explicitly |
| `swarm_send` | Send a typed question, blocker, decision request or completion notice with a threadId |
| `swarm_inbox` | Fetch a delivery lease; explicitly ack processing or reject with a reason |
| `swarm_wait` | Resume waiting for an existing task; timeout never cancels or recreates it |
| `swarm_context` | Read, compare-and-set, append or tombstone small shared values |
| `swarm_evidence` | Capture completed files or record results, decisions and annotations with provenance |

All mutations require a stable commandId. Retry uncertain acceptance with the same
ID and payload. A new logical fetch needs a new ID: replaying an earlier fetch
returns that earlier receipt, not a new delivery. Completion reports require a
summary, evidence and explicit limitations (an empty limitations list is allowed).

Tools return a structured envelope `{ok,data,error}` and JSON text for compatible
hosts. Tool failures set `isError`; errors carry a code, message and retryable
flag. Fetch/ack and task mutations are not marked read-only. The schema advertises
the envelope; operation-specific result schemas and normalization are still open.

Task details include the authoritative scope and creator, parsed contract fields,
dependency IDs, current attempt owner/fence/lease and parsed completion evidence.
An owner is marked active only while its attempt, session and lease are active;
terminal tasks have no current owner. Historical attribution remains in the
attempt records. Expired result values are omitted while control history remains.

Resources expose shared context (`swarm://context`, `?key=…`, or `?cursor=…`),
retained findings (`swarm://findings` or `?filter=<URL-encoded JSON>`), and artifact
bytes (`swarm://artifacts/<id>`). Finding filters accept taskId, file,
currentRevision and cursor. Findings return one record per page; shared lists
return five. Artifact reads return at most 16 KiB of base64 blob content plus a
JSON metadata item with status and nextUri. Follow nextUri until null; no source
file needs to remain after capture. Unavailable artifacts return status metadata.
The paginated artifact template is registered before the base template because
SDK v2's base matcher otherwise consumes the query suffix as part of the ID.

The adapter caps concurrent waits at eight. Each wait uses its own authenticated
IPC connection so cancelling it tears down that owner-side wait without disrupting
other calls. Normal requests share a connection. A disconnected adapter currently
requires reconnection by its launcher; automatic recovery is not claimed.

`test/coordination-mcp.test.ts` exercises the actual bundled Node adapter through
a modern MCP client and separate Node owner, covering nine-tool discovery,
bootstrap, durable create/replay, claim/conflict, timeout/finish, typed messaging,
fetch and explicit acknowledgment, shared context, capture/source removal,
multi-page artifact reconstruction and annotation freshness. Fixtures use disposable databases.

Still required for VUH-1338: richer output schemas,
subscriptions on this new surface, compatibility/deprecation mapping,
bounded response sizing, and measured context/call reduction. The installed
legacy runtime remains unchanged.
