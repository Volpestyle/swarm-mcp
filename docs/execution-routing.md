# Execution routing (VUH-1340)

## OpenCode native provider

`openCodeDispatchProvider`, built in `dist/coordination/opencode-dispatch.js`,
creates an empty child under a trusted configured OpenCode parent and workspace.
It copies the parent's session permission rules and submits no prompt. The returned
host ID is persisted against the dispatch token before resolving plugin enrollment;
normal atomic binding and inbox delivery then admit the work.

Recovery uses that retained host ID and rechecks parent, directory and archive
state. It never searches titles/labels to establish identity and never repeats an
uncertain create. If the create response is lost before the ID is persisted,
capacity remains reserved with an uncertain outcome. OpenCode's inspected create
API has no caller-supplied session ID; resolving that case needs authoritative
external evidence. Cooperative stop uses the enrolled worker's fenced result.

SDK transport-fixture tests cover inherited permission rules, delayed enrollment,
coordinator reopen, wrong-parent rejection, single assignment and response loss
without another create. The installed OpenCode 1.4.3 probe now verifies native
creation, plugin enrollment, autonomous delivery, a fenced result, explicit
acknowledgment and capacity release. See the retained
[capture and reproduction](verification/2026-09-22-dispatch/README.md).

Owner `dispatch.opencode` entries configure native routes with `id`, a pinned
coordinator `parent` identity, native `parentSessionId`, `baseUrl`, private
`stateDirectory`, capabilities, durability, capacity and overhead. The parent
enrollment supplies workspace and recent connected runtime evidence. A busy
parent can create independent child work; unavailable/stale parents cannot.
The host API rechecks the native parent before creation.

Child resolution reads the plugin's private retained agent identity and its
current enrolled session, verifying the workspace. It never creates the identity
file or rotates enrollment. If the plugin has not enrolled yet, dispatch remains
uncertain and retries the retained child ID. A real local HTTP/SDK integration
test supplies delayed plugin enrollment and verifies one create, one assignment
and unchanged generation; this is not an installed OpenCode execution claim.

Use the lowest-overhead authorized execution path that satisfies the task's
requirements. Native runtime messaging is sufficient when its host, workspace,
lifetime and capabilities fit. Use an independent peer when those requirements
need a different host, workspace or durable lifetime. Neither path has an
unconditional preference.

`selectExecutionRoute` evaluates trusted launcher/runtime declarations against
scope, canonical worktree, optional host, required capabilities, durable lifetime,
fresh idle evidence and per-route/global concurrency budgets. Role labels confer
neither capabilities nor authority. A missing capability remains an explicit
blocker; selection never creates an agent or changes the task contract.

Selection alone is advisory. The trusted runner below composes atomic intent and
capacity reservation, provisioning reconciliation and task binding. OpenCode
native children and already-enrolled independent peers have concrete adapters. Only the
coordinator's fenced task attempt establishes an accepted owner.

Schema 9 adds `dispatch_intents`. The trusted write transaction reserves an
intent and creates its task atomically. Scope-wide intent identity spans requesting
agents; changed work under the same intent is rejected. Capacity includes all
unreleased intents, so another gateway or a reopened coordinator cannot reserve
the same slot. The policy comes from trusted adapter configuration, outside the
model command payload. The authenticated dispatch API composes this primitive.

Reservations do not expire into permission to provision again. A crash may leave
an unresolved intent; later provisioning reconciliation must prove the external
outcome before releasing or retrying it. The reservation itself never launches
a process or reports a worker as accepted.

Schema 10 records a provisioning token before external effects. `begin` advances
reserved → provisioning once; another command or restarted caller receives the
same token with `start: false`. The caller must also honor the command receipt's
`replayed` flag: replaying a cached `start: true` result is not new permission to
provision. Uncertain outcomes require lookup by this token, not another spawn.

The launcher's verified result binds route, token, external identity and an active
same-scope worker session in one transaction. Binding claims the task for that
worker with the existing attempt/fence mechanism; a duplicate result returns the
same attempt, and another worker is rejected. Ordinary task claims cannot bypass
an unreleased dispatch reservation. Native completion uses the same worker-bound
`task.finish` command and stable command ID, not a parallel legacy task record.

The dispatch regression runs two independent Node processes against one database.
Exactly one creates a reservation/task; both receive the same task ID. Reopening
the store retains that reservation and capacity, rejects different work with the
same intent, and blocks an additional intent at the configured concurrency limit.
The same processes race provisioning start: one wins, both see one token, and a
reopened caller reconciles. Binding/finish tests prove one attempt, reject another
worker's completion and replay the accepted result without a second completion.

## Trusted provider runner

`runDispatchIntent` (built as `dist/coordination/dispatch-runner.js`) composes
reservation, committed provisioning start, external reconciliation and binding.
The launcher supplies exactly one authorized provider for the selected route.
The provider receives the stable token, existing task ID and unchanged contract.
External calls are bounded and run outside the database transaction.

Only a fresh, non-replayed start receipt calls the provider's `start`. All later
calls use `find(token)`. Missing results, errors and timeouts return uncertainty
without another start or released capacity. The runner copies only the external
ID and worker session from the verified provider result; it does not accept
replacement dispatch intent, token or route fields.

The runner tests use a real coordinator store and a controlled provider fixture:
external acceptance followed by response loss or timeout, coordinator reopen,
temporarily invisible external state, then reconciliation. Both finish with one
start, one task and one attempt. This is not installed-host provisioning evidence.
The concrete adapters and authenticated API are described below and above.

`existingPeerProvider` binds a trusted, already-enrolled session incarnation; it
does not spawn or enroll another process. Recovery resolves that same configured
identity, and binding rejects a superseded session. Its route still goes through
the normal capability, availability and capacity checks. Cooperative stop checks
the persisted token, route, worker session and attempt. A fenced completed, failed
or cancelled attempt establishes that dispatch work ended; an abandoned lease
does not. Cancellation before binding is also safe because binding cannot claim
the cancelled task. The shared peer process itself remains running.

The runner now queues one `task.assigned` envelope in the binding transaction,
containing the contract and task/attempt/fence references. Inbox backpressure
rolls back ownership too, so an accepted attempt cannot lose its assignment.
Reconciliation of an existing binding does not queue a second message. Workers
must check current ownership before executing a delayed assignment; receipt alone
is not proof the attempt is still active.

The existing-peer regression fills the inbox and proves binding rolls back, then
drains it and retries. A separate Node worker fetches the durable assignment,
completes the referenced attempt and explicitly acknowledges it. Repeated runner
calls retain one assignment and one attempt. This is actual peer-process/store
delivery, not evidence of model-host launch or native MCP delivery.

Cancellation queues a `task.cancel_requested` notice with a stable command ID per
provisioning token. Its task, attempt and fence identify the work to stop. The
cancellation state commits first; if the inbox is full, retries recover notice
delivery without undoing cancellation or releasing capacity. Notice retries do
not duplicate it. The peer must finish the fenced attempt as cancelled after
stopping work; message acknowledgment alone never releases capacity. A separate
Node-process regression verifies both completion and cooperative cancellation,
including full-inbox recovery and release after the worker's terminal result.

The trusted `dispatch.release` transaction frees capacity only after the task is
terminal. A reservation cancelled before provisioning needs no external proof;
once provisioning begins, the launcher must supply confirmed termination for the
recorded token and route. A timeout, missing lookup or task completion alone does
not establish that external work stopped. Provider adapters must obtain this
evidence; this internal method is not an agent tool. Release is idempotent, and
retrying a released intent returns its existing task without another launch.
Regression tests reject early release and mismatched tokens, retain capacity
until confirmation, and allow the next reservation after release.

`cancelDispatchIntent` commits creator-authorized cancellation before calling the
provider. Before provisioning, it cancels and releases without a provider call.
Otherwise it requests idempotent `stop(token)` outside the transaction. A provider
must both stop current work and fence future starts for that token before returning
`stopped: true`; a missing lookup is insufficient, including when cancellation
races a delayed start. Stop applies to this dispatch's work, not necessarily an
entire shared worker process. Missing stop support preserves a blocker; timeouts
and incomplete stops retain uncertainty and capacity across restart.

Confirmed stop closes the matching pending-cancellation attempt and releases its
reservation atomically. Late success is rejected once cancellation is requested.
The regression exercises stop timeout, coordinator reopen, pending stop, confirmed
stop, repeated cancellation and pre-start cancellation using a controlled provider.
Concrete host adapters must still implement and prove their stop-token fencing.

## Authenticated service boundary

`CoordinationCore.dispatch` and the IPC `dispatch` operation accept assign,
cancel and explicit reassign requests. They derive actor/scope from the current
session capability. The owner injects a trusted configuration resolver for policy
and providers; request fields cannot replace it. An unconfigured owner reports
`unsupported_runtime`. Reassignment carries its stable command ID and expected
task version across retries, while assignment retains the intent identity.

The Node-owner IPC regression verifies assignment/retry, conflicting work,
capacity exhaustion and the unconfigured case. Forged top-level actor, scope and
policy fields do not change the accepted worker or configured limit.

MCP `swarm_assign` accepts optional `routing` requirements: capabilities, durable
lifetime, optional host and intent ID (defaulting to commandId). Supplying an
expected task version plus the original intent ID requests explicit reassignment;
use a stable commandId for that retry. Without routing, assignment still creates
dependency-capable work for later claiming. Routed dependency lists are rejected
rather than ignored. `swarm_task` cancellation with intentId invokes dispatch
cancellation. Results distinguish bound, blocked, uncertain and released states.

Modern and legacy stdio tests execute routed assignment, retry and cancellation
through a real Node owner. The nine-tool catalog omits repeated schema-dialect
metadata through the SDK's Standard Schema conversion interface; the original
runtime validators and constraints are retained. The dispatch context capture
under `verification/2026-09-22-dispatch` records the measured catalog budget.

The private owner JSON accepts optional `dispatch` configuration: `maximum`,
`observationMaxAgeMs` (1..60000), and `peers`. Each peer declares `id`, a pinned
`worker` (`scope`, `actor`, `sessionId`, `generation`), `host`, `capabilities`,
`durable`, `capacity`, and `overhead`. Route IDs and worker sessions are unique;
unknown dispatch fields are rejected. The existing 8 KiB private-config bound
still applies. Configuration loads at owner startup; changing the file requires
an owner restart.

The resolver derives canonical worktree and current availability/timestamp from
the enrolled session. Missing, stale, unavailable or superseded sessions cannot
be selected. A route pins its incarnation rather than silently redirecting an
uncertain old dispatch to a replacement worker. Owner configuration is the
authority for capabilities and budgets; model labels do not modify it. The
production-owner regression verifies configured dispatch after restart, no
assignment before availability, completion/release and superseded-route rejection.

OpenCode lifecycle events publish coordinator availability for those routes:
idle maps to available, busy/permission-blocked maps to busy, and unknown,
disconnected or snapshot-recovering states map to unavailable. Publication uses
the enrolled session capability and per-session serialization. The integration
test reads this state from the real owner, including withholding idle during
reconnect until snapshot reconciliation completes. This closes the gap between
plugin-local delivery state and coordinator routing evidence.

## Reassignment and fallback

The trusted `dispatch.reassign` transaction is an explicit creator retry, with a
stable command ID and expected task version. It requires the previous dispatch to
be released and the task to be failed or cancelled. It rechecks the unchanged
intent fingerprint and all route constraints and budgets before reopening the
same task and reserving its replacement route atomically. Missing capabilities
leave the task terminal with an explicit blocker; fallback never weakens the
contract. A completed task cannot be reassigned.

The next begin records a fresh token; the next claim advances the attempt fence.
Old provider bindings and late completion cannot take ownership or overwrite the
replacement result. A controlled native-to-peer test verifies one task/contract,
cancelled native attempt, completed peer attempt, changed-token rejection, late
native-result rejection and idempotent reassignment/completion. This proves the
coordinator contract. Separate installed-native and peer-process probes establish
each provider's delivery path; an installed-host cross-provider handoff is not
claimed by the controlled handoff test.
