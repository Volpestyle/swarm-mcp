# Legacy caller compatibility and migration

`swarm-mcp` retains the existing 33-tool API in `src/index.ts`, with modern and
legacy MCP transport support. The opt-in `swarm-coordinator-mcp` exposes the new
nine-tool API. Existing configurations still select the legacy adapter. Changing
executables is an application migration, not just a protocol upgrade.

The adapters currently use separate stores. They do not mirror writes, translate
IDs, or share acknowledgments. Do not split a working swarm across them.
VUH-1344 owns installation, data migration, cutover and rollback. No legacy tool
has a removal date in this candidate.

All names below remain available on the legacy adapter. This table describes
migration routes, not aliases supported by the compact adapter. Runtime means
trusted launcher/host integration, not model-selected identity.

| Legacy tool | Coordinator route and behavior change |
| --- | --- |
| `register` | Runtime enrollment then `swarm_sync`; model cannot choose authenticated scope/actor |
| `list_instances` | `swarm_find` peers with role filter and cursor |
| `whoami` | `swarm_sync` authenticated actor/scope |
| `bootstrap` | `swarm_sync` owned-task/inbox summary and event cursor |
| `remove_instance` | Runtime lifecycle management; no compact replacement yet (VUH-1339) |
| `deregister` | Runtime shutdown; transport close must not delete durable work (VUH-1339) |
| `send_message` | `swarm_send` typed kind, recipient, threadId, commandId |
| `prompt_peer` | Runtime delivery/wake (VUH-1339/1340); acceptance differs from waking a host |
| `peek_peer` | Runtime inspection (VUH-1340/1341); no terminal-scraping alias |
| `resolve_workspace_handle` | Trusted runtime routing (VUH-1340) |
| `broadcast` | Core `message.announce` explicit audience; no compact broadcast tool yet |
| `poll_messages` | `swarm_inbox` fetch then explicit ack after processing |
| `request_task` | `swarm_assign` contract; fenced claim establishes owner |
| `request_task_batch` | Repeated stable-ID assignments and dependencies; no atomic batch equivalent |
| `dispatch` | Async `swarm_assign`, optional separate `swarm_wait`; timeout retains task reference |
| `claim_task` | `swarm_task` claim with expectedVersion; retain attemptId/fence |
| `claim_next_task` | Find open tasks then optimistic claim; handle conflicts explicitly |
| `update_task` | Specific `swarm_task` actions; no arbitrary patching |
| `complete_task` | `swarm_task` finish with fence, outcome, evidence and limitations |
| `report_progress` | `swarm_task` progress with attempt/fence |
| `approve_task` | No approval-state alias; record an evidence decision and communicate explicitly |
| `get_task` | `swarm_find` task detail with normalized contract/owner/result |
| `list_tasks` | `swarm_find` tasks with filters and cursor |
| `get_file_lock` | Core reservation query exists; compact/runtime exposure remains incomplete |
| `lock_file` | Core reservations require current session and exact grant/fence; no legacy alias |
| `unlock_file` | Release exact current reservation grant; no unconditional unlock alias |
| `kv_get` | `swarm_context` get or key resource |
| `kv_set` | `swarm_context` set with expectedVersion/commandId |
| `kv_append` | `swarm_context` append with commandId; optional expectedVersion |
| `kv_delete` | `swarm_context` delete with expectedVersion; versioned tombstone |
| `kv_list` | Paginated `swarm://context` resources |
| `swarm_status` | `swarm_sync` and targeted queries; diagnostics are VUH-1341 |
| `wait_for_activity` | `swarm_sync` cursor/waitMs or resource subscriptions |

Compact tools return `{data}` on success and `{error}` on failure as
structuredContent and JSON text. MCP `isError` determines success. The earlier
candidate's redundant `ok` field and null placeholders have been removed. Legacy
parsers must change; do not parse English success text or assume snake_case
fields. Task detail is normalized; command receipts currently retain core
result shapes `{value,cursor,replayed}`.
The catalog describes the common envelope; detailed output schemas are available
at `swarm://schemas/<tool-name>` and enforced by the server.

Use a unique commandId per logical mutation. After uncertain acceptance, retry
the same ID and payload. Fetch replay returns its original receipt; use a new ID
for a new delivery lease. Ack only after processing, and retain message IDs for
consumer-side deduplication. Leases do not guarantee exactly-once external side
effects.

Task creation does not imply ownership or completion. Claim requires an observed
version and returns an attempt fence used by subsequent writes. Wait timeout or
disconnect never cancels execution; cancellation is a separate mutation.

Held and immediate compact event reads return at most 20 relevant events, skipping
lease/transport maintenance and unrelated work. Resume from the returned cursor
to drain the rest, including when a page is empty. Event pages also stop at 96 KiB of UTF-8 JSON.
Tools offering cancellation, shared-value deletion/replacement, or delivery
acknowledgment advertise destructiveHint. Fetch/ack are not read-only.
