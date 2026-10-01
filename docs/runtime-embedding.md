# Embedded runtime

The `swarm-mcp/runtime` export exposes enrollment, owner startup, authenticated
IPC, runtime delivery, inbox observation and Claude launcher composition. Its
declarations support Node ESM consumers. Callers supply private state, a canonical
repository/worktree identity, a stable host session ID and an incarnation that
changes only on a genuine host restart. The `pi` host is supported for embeddings.

Owners retire after five minutes with no connected clients or in-flight requests.
Durable state remains in place and the next `ensureCoordinator` starts an owner
with the same database and credentials. In private `owner.json`, `idleTimeoutMs`
accepts 100..86400000 milliseconds or `null` to disable retirement. Connected
MCP clients and worker wrappers keep the owner alive; no PID-age cleanup is used.

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

Owned Herdr workers run their harness's native terminal UI and admit durable
inbox envelopes at native idle boundaries. While their children are alive,
it renews that session's current unexpired task leases every 15 seconds, including
while a model turn runs or waits for a peer. It never claims, recovers or changes
an attempt's fence; renewal stops on child exit and cannot extend the core's
progress or cancellation deadlines. Workers report meaningful progress at least
once per default 15-minute progress window. Lease renewal is liveness, not
progress or completion. It never acknowledges for
the model. Worker records contain capabilities and remain private;
do not include them in diagnostics or source artifacts.

`bun test --timeout 30000 test/coordination-herdr.test.ts` checks the real Node
owner against Herdr CLI topology and native layout API contracts, including
fragmented socket responses, response loss, actual pane identity and one launch
per token. Two routes reuse the same pane IDs on different sockets, select work
by capability, retain separate receipts and reject retargeted recovery. These fixtures do not substitute for an installed
Claude/Codex/Pi and Herdr round trip when changing native delivery.

`SWARM_PACKAGE_TEST_ROOT=/absolute/extracted/package` runs the same protocol
fixtures against a separately production-installed package, without compiling
runtime entrypoints from the checkout. Use the `native: true` test-name pattern
to prove the packaged owner, native wrappers and MCP dependencies together.


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


## Herdr worker readiness and health

A Herdr pane and `started` launch record are physical evidence only. Dispatch
pins the enrolled worker before launching it, then waits for that worker's first
actual harness-to-Swarm MCP request. That authenticated request atomically claims
the task with the current session/generation and commits the binding and assignment.
The requester reads back the same attempt/fence before returning `bound`. A
worker that has already finished may prove readiness with that exact latest
terminal attempt; an abandoned, superseded or refenced attempt cannot.
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
attempt or acknowledge pending mail. Each harness has exactly one inbox consumer:
Claude's channel MCP, the Codex wrapper, or Pi's native extension. Claude hooks
only publish turn state. The health record is observation,
not authority or readiness proof, and contains no credential or model text.

Task heartbeat renewal never extends the progress deadline. The wrapper sends a
`blocked:stale_progress` notice when it expires; `swarm_find` diagnostics expose
`signal: stale_progress` with `progressDeadline`, even if the wrapper disappears.

For known long tool waits, set `contract.progressTimeoutMs` on assignment; the
initial dispatched claim and later same-worker reclaims inherit it. Liveness
heartbeats still cannot extend the configured semantic-progress deadline.

Creator cancellation writes a durable launch-local stop latch. The owned POSIX
wrapper stops every host process group it owns (TERM, then bounded KILL if
necessary) and publishes a receipt only after all are gone. Codex's app-server
and native TUI are separate owned groups. The provider
matches token, session generation and route identity before releasing capacity.
The latch and exclusive start marker prevent a delayed or duplicate wrapper from
starting after cancellation. A fenced terminal result remains valid cooperative
proof. Cancellation also wakes teardown of completed native workers.

An inbox quota or stale recipient cannot prevent provider stop. On confirmed
release, pending/leased assignment and cancellation controls expire with reason
`dispatch_released`; they are never marked acknowledged. Replies, results and
dead-letter history remain retained. Windows, missing wrappers and legacy launches
without a stop receipt remain uncertain unless cooperative proof exists. Stop
proof covers the owned process group, not independent detached work started by a
tool; providers for such work need their own termination contract.
Health notices retain task/attempt/fence identity and reject replaced attempts.
A disconnected coordinator can delay reporting; it cannot turn missing health
into success. Host exits before the MCP starts may be known only by the bounded
readiness timeout. Do not automatically redispatch these uncertain receipts.

Install a new build only after holding dispatch and reconciling/draining every
live or uncertain worker. A package replacement is not an owner upgrade. This
change does not implement an install lock or immutable runtime generations.

## Schema-15 lineage compatibility

Schema 16 retains main schema 15 (`harness`) and the earlier interactive branch
which independently numbered `execution_mode` as 15. Migration inspects the
columns under its existing SQLite writer transaction, fills the missing column,
and commits version 16 atomically. It never substitutes databases or resets
actors, tasks, claims or intent fingerprints. Interrupted migration rolls back.

## Herdr interactive workers

A Herdr route's `workerMode` defaults to `interactive` (ADR 0194 in Clankie).
`stream` remains readable for retained intents and receipts, but its route is
unavailable for new dispatch; direct launch refuses with `headless_workers_retired`.
The mode resolves at reservation from the
selected route, or from an explicit `execution.mode` on the intent, and is stored
in the intent row (`execution_mode`, schema 16), the `dispatch.reserved` event,
the dispatch result and the private launch receipt. An explicit mode is part of
the intent fingerprint; routes of a different mode are rejected with
`execution_mode:<mode>`, and a retry keeps the stored mode. A route whose owner
switched its mode after reservation refuses to launch (`execution_mode_changed`).
Nothing ever falls back from interactive to stream.

An interactive worker runs its harness's TUI with the pane's inherited terminal: no
`--print` or stream-JSON. The wrapper keeps the launch token, task-lease renewal,
MCP health supervision and stale-progress reporting, and writes its diagnostics to
`<receipt>.log` so it never draws over the TUI. Ctrl+C belongs to the native UI; SIGTERM
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

## Managed harness selection

A Herdr route may select `harness: "claude-code" | "codex" | "pi"`, an absolute
`harnessPath`, and an optional `model`. Legacy `claudePath` routes remain Claude.
Codex defaults to `gpt-6-astra`. Set `routing.host` on `swarm_assign` to constrain
selection to that host; incompatible routes return typed `host` blockers and
never fall back to Claude. The resolved harness is persisted on the dispatch
intent, returned with its receipt, and pinned with executable/model in the private
launch receipt. Recovery rejects a retargeted route (`harness_changed`). Reassignment
preserves the harness selected by the original intent.

Codex runs an owned `app-server` on a private Unix WebSocket and an owned native
`codex --remote` TUI connected to it. The TUI creates the thread and owns all
approval and elicitation answers. Before submitting any context, the wrapper
requires exactly one loaded native thread and verifies its ID and workspace. It
submits one `turn/start` to that same thread and subscribes to native turn state;
a missing reply stays uncertain and is never replayed. A native thread ID is
launch metadata, not another enrollment or claim. This adapter requires POSIX;
Windows routes refuse before process creation.

Codex receives Swarm MCP through per-process config overrides. Pi runs its
ordinary interactive CLI with a launch-local extension that projects the worker's
own MCP clients into tools. That extension owns its single leased inbox and
submits native follow-up messages only while idle and MCP-healthy. It does not
use Pi RPC, disable session persistence, or reuse a Clankie conversation. Neither
adapter writes global host configuration. Listing tools or starting a process is
insufficient for readiness: the first actual worker Swarm tool call commits the
existing fenced claim. Instruction artifacts, leased delivery, explicit ack,
progress deadlines, lease renewal, cancellation and process-group stop remain
in the shared managed lifecycle. All three managed harnesses are native interactive.

The protocol fixtures exercise all three harnesses with the real owner, wrapper,
and MCP adapter, including MCP loss and release. Codex fixtures use real Unix
WebSockets and two clients, and verify that only the native UI answers approvals.
Additional fixtures reject ambiguous/mismatched native threads and lost delivery
replies. These scripted UI/model fixtures do not establish live harness compatibility.
Real Codex/Pi canaries must additionally run in a terminal against the deliberately
installed candidate. Schema 16 handles both schema-15 lineages as described above.

Managed Codex overrides use bare dotted path segments: Codex treats quote marks
in override keys literally (TOML quoting applies to values, not the key path).
The trusted launcher preapproves only `swarm_inbox` and `swarm_task` on its enrolled
`swarm` server so unattended fenced delivery and task maintenance can run. Other
MCP servers/tools and shell approvals retain the host policy. Pi terminal model
errors are surfaced and stop the owned worker rather than becoming an opaque
readiness timeout. Pi's extension requires the production
`@modelcontextprotocol/client` dependency; changing a same-version vendor tarball
must refresh the lockfile dependency graph, not only its integrity hash.

A disabled Herdr route forbids new provisioning but retains authority to stop its
own verified token. Stop still checks the launch fingerprint and owning-wrapper
termination receipt; disabled routes never adopt other workers.

Opt-in real-binary fixture (model calls, an owned PTY via `script`, isolated local
test owner and synthetic Herdr transport; not the live Clankie canary):

```sh
SWARM_REAL_HARNESS_TEST=codex bun test test/coordination-herdr.test.ts --test-name-pattern 'real: true'
SWARM_REAL_HARNESS_TEST=pi bun test test/coordination-herdr.test.ts --test-name-pattern 'real: true'
```

`SWARM_REAL_HARNESS_BIN` selects the installed executable. Pi's fixture uses
`openrouter/moonshotai/kimi-k3`. `SWARM_REAL_PACKAGE_ROOT` selects an extracted,
production-installed candidate so the fixture cannot resolve dependencies from
the developer checkout. Both cases require actual model tool calls, an instruction
snapshot marker in completed evidence, acknowledged delivery, and release after
disabling the route. `npm run verify:install` also imports the packaged pi extension.
