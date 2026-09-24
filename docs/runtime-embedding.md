# Embedded runtime

The `swarm-mcp/runtime` export exposes enrollment, owner startup, authenticated
IPC, runtime delivery, inbox observation and Claude launcher composition. Its
declarations support Node ESM consumers. Callers supply private state, a canonical
repository/worktree identity, a stable host session ID and an incarnation that
changes only on a genuine host restart. The `pi` host is supported for embeddings.

Clankie mounts a separate MCP session per operator conversation and implements
admission with its existing turn queue. It packages the coordinator executables
beside `runtime.js`; bundlers must preserve those files and package dependencies.

The optional owner `dispatch.herdr` accepts one route object or an array of up to
64 routes within the owner config's 64 KiB limit. IDs are unique across Herdr, OpenCode and existing-peer routes. Each
route has an optional `enabled` flag (default true) and contains absolute paths for Herdr, Node,
Claude, the worker entrypoint, private state and the chosen Herdr socket, plus
profile, capabilities, route ID and capacity. Its optional `mcpServers` map adds
trusted stdio MCP commands, arguments and environment to each Claude launch;
`swarm` is reserved for the enrolled runtime. Enrollment exports `SWARM_SCOPE`
alongside the session capability. These MCP clients can authenticate to an
embedding's existing delegation service without provider secrets in the launch
configuration. Enrollment itself grants no connected-service authority. Dispatch uses the requester's
canonical worktree. The provider persists an exclusive provisioning record before
creating an owned workspace. Herdr's native `layout.apply` API replaces only that
new workspace's initial tab with a direct argv process. Interactive shell startup
cannot consume the launch command. The worker saves its actual `HERDR_PANE_ID`
in the private startup receipt; binding also requires its authenticated
available/busy observation. A missing response is reconciled with the same token
and receipt, never another launch. Missing startup evidence leaves provisioning
uncertain and retains its capacity reservation. Cancellation is cooperative and
requires the fenced terminal task outcome before releasing capacity.

Provisioning receipts pin the route ID, socket, profile, state directory and
executable paths. Recovery and cancellation refuse receipts whose runtime identity
is different or absent. Changing capabilities/capacity affects new selection; it
does not move an existing intent. Use a new route ID for a different runtime and
retain the original route for outstanding work. The owner reloads dispatch configuration for each dispatch/cancellation request;
it refuses configuration that changes its database path or launcher identity.
Disabled routes cannot authorize new provisioning or recovery. Existing worker
sessions and task attempts remain intact. `bootstrap.dispatchConfigReload` is
true only for an owner with this behavior; embeddings must check it before
claiming live execution-connection management. Receipts
without a verified runtime fingerprint require explicit reconciliation; they do
not authorize a launch or a query against a newly selected socket.

The owned Claude stream worker runs in auto mode, reads durable inbox envelopes
at idle boundaries and publishes runtime observations. While its child is alive,
it renews that session's current unexpired task leases every 15 seconds, including
while a model turn runs or waits for a peer. It never claims, recovers or changes
an attempt's fence; renewal stops on child exit and cannot extend the core's
progress or cancellation deadlines. Workers report meaningful progress at least
once per default 15-minute progress window. Lease renewal is liveness, not
progress or completion. It never acknowledges for
the model. Native interactive Claude launchers retain native hook delivery and
make no idle-wake claim. Worker records contain capabilities and remain private;
do not include them in diagnostics or source artifacts.

`bun test --timeout 30000 test/coordination-herdr.test.ts` checks the real Node
owner against Herdr CLI topology and native layout API contracts, including
fragmented socket responses, response loss, actual pane identity and one launch
per token. Two routes reuse the same pane IDs on different sockets, select work
by capability, retain separate receipts and reject retargeted recovery. These fixtures do not substitute for an installed
Claude/Herdr round trip when changing the stream driver.


## Assignment instructions

`TaskContract.instructions` is an optional ordered list of up to 20 immutable
`swarm://artifacts/ID` references, inside the existing 8 KiB contract limit.
Embeddings publish generated text with authenticated `artifact_import`, supplying
`data` (canonical base64, at most 32 KiB decoded) instead of `path`. File imports
retain worktree path confinement. Both use the same verified artifact store and
command replay rules. Artifacts remain visible within their coordination scope;
a task reference does not create a private per-worker ACL.

`swarm_evidence` action `read` takes `artifactId`, a read-label `commandId`, and
optional byte `offset`. A complete text artifact of at most 32 KiB returns `text`;
other pages return base64 `data`, `nextOffset`, and total `bytes`. An unavailable
artifact returns its status rather than fabricated instructions. Embeddings pin
instruction bytes before dispatch and reuse them for retries and reassignment;
changed preferences apply to a new work intent. Instructions carry no authority,
credentials or worker identity.
