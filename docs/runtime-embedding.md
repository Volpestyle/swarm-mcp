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

## Approved Herdr execution workspaces

An owner-configured Herdr route may include `workspaces`, up to 32 entries of
`{ kind: "repository" | "directory", path: "/absolute/canonical/identity" }`.
A repository identity is its Git common directory; current registered worktrees,
including linked checkouts outside the original directory, are eligible. Directory
entries are exact. Stale entries grant nothing. They cannot prevent dispatch to
other valid entries or to the requester's existing directory. The agent's task
contract selects an eligible worktree; it cannot add approvals. Capacity remains
per runtime route, not per workspace.

The owner resolves memberships before the reservation transaction. It canonicalizes
the requested path for selection without changing the persisted intent fingerprint.
Blocked selection carries `requestedWorktree` and same-scope `routes` with
`routeId`, `worktree`, `allowedWorktrees`, `reasons`, and optional `staleWorkspaces`.
Herdr revalidates before starting; it launches and enrolls the worker at that path,
retaining the requester coordination scope and recording the target's separate
file-reservation repository identity. Lost-response recovery uses the existing
receipt and never starts another worker, even after approval removal.

Bootstrap advertises `executionWorkspaces` for this protocol addition. Embedders
must require it before writing workspace configuration to an already-running
owner. Package replacement alone does not upgrade a running process.

Owner dispatch budgets (`maximum`) and route `capacity` accept `null` for
unlimited; omitted owner configuration values default to `null`. Explicit
nonnegative integer limits are enforced atomically, including zero to pause new
admission. Changing or clearing a limit never replaces existing dispatch receipts.
Both counts belong to a coordinator scope. Separate coordinators sharing one
runtime can jointly exceed a configured runtime capacity; there is no shared
machine-wide counter.


## Herdr stream worker readiness and health

A Herdr pane and `started` launch record are physical evidence only. Dispatch
pins the enrolled worker before launching it, then waits for that worker's first
actual harness-to-Swarm MCP request. That authenticated request atomically claims
the task with the current session/generation and commits the binding and assignment.
The requester reads back the same attempt/fence before returning `bound`.
A lost reply reconciles the same intent; it does not launch another worker.
Existing-peer and OpenCode providers retain their existing protocols.

Herdr routes accept `readinessTimeoutMs` (1,000–60,000; default 60,000). Startup
returns `uncertain` with typed `reasons`, the original `intentId`, provisioning
`token`, `taskId`, `routeId` and reconciliation guidance. Reasons include
`coordinator_version_mismatch`, `worker_mcp_unavailable`, `worker_claim_failed`,
`worker_readiness_timeout` and `worker_startup_failed`. These are failures to
establish readiness, not proof of termination: capacity and receipts stay retained.
The provisioning token identifies a receipt; it is not an enrollment capability.

The MCP child publishes a private launch-local health record every five seconds
after an authenticated coordinator round-trip. The wrapper checks it independently
of model/tool activity, including process death and a 15-second freshness bound.
On MCP loss it stops inbox admission and sends `blocked:mcp_disconnected` through
its separate coordinator connection to the task creator. It does not release the
attempt or acknowledge pending mail. The wrapper is the only inbox consumer;
its Claude hooks do not independently fetch mail. The health record is observation,
not authority or readiness proof, and contains no credential or model text.

Task heartbeat renewal never extends the progress deadline. The wrapper sends a
`blocked:stale_progress` notice when it expires; `swarm_find` diagnostics expose
`signal: stale_progress` with `progressDeadline`, even if the wrapper disappears.
Health notices retain task/attempt/fence identity and reject replaced attempts.
A disconnected coordinator can delay reporting; it cannot turn missing health
into success. Host exits before the MCP starts may be known only by the bounded
readiness timeout. Do not automatically redispatch these uncertain receipts.

Install a new build only after holding dispatch and reconciling/draining every
live or uncertain worker. A package replacement is not an owner upgrade. This
change does not implement an install lock or immutable runtime generations.

## Herdr interactive workers

A Herdr route's `workerMode` is `stream` (the default when omitted) or
`interactive` (ADR 0194 in Clankie). The mode resolves at reservation from the
selected route, or from an explicit `execution.mode` on the intent, and is stored
in the intent row (`execution_mode`, schema 15), the `dispatch.reserved` event,
the dispatch result and the private launch receipt. An explicit mode is part of
the intent fingerprint; routes of a different mode are rejected with
`execution_mode:<mode>`, and a retry keeps the stored mode. A route whose owner
switched its mode after reservation refuses to launch (`execution_mode_changed`).
Nothing ever falls back from interactive to stream.

An interactive worker runs Claude's TUI with the pane's inherited terminal: no
`--print` or stream-JSON. The wrapper keeps the launch token, task-lease renewal,
MCP health supervision and stale-progress reporting, and writes its diagnostics to
`<receipt>.log` so it never draws over the TUI. Ctrl+C belongs to Claude; SIGTERM
or a closed pane (SIGHUP) stops the worker.

Mail reaches it through a Claude channel served by its own Swarm MCP, using only
its enrolled session capability. With `channelPlugin` (`name@marketplace`), that
installed plugin serves the MCP (its server command runs the argv in
`SWARM_WORKER_MCP`) and Claude starts with `--channels plugin:<id>`; an
owner-managed `allowedChannelPlugins` entry must approve it for unattended
startup. Without it, the bare `swarm` server loads as a development channel whose
confirmation a person must accept in the pane.

The MCP emits a startup channel event carrying a per-process nonce, repeated
every 15 seconds until answered. Only `swarm_ready` with that nonce commits
readiness and the fenced claim; other tools return `readiness_pending` until then.
It then projects the leased inbox: one outstanding envelope, fetched only while
the native turn is idle, and freed by the model's `swarm_inbox` ack/reject or
lease expiry. Channel workers' hooks (`UserPromptSubmit`, `Stop`) publish
busy/available and never fetch mail, so the projection is the one inbox consumer.
A startup that is never answered stays `uncertain` with
`worker_readiness_timeout` in interactive mode; reconcile the same intent.
`test/coordination-interactive-worker.test.ts` drives the real wrapper, MCP and
hooks through a scripted channel fixture; it does not replace a live Claude run.
