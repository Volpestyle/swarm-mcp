# Session identity and task ownership

The coordination core separates three identities:

| Record | Lifetime and purpose |
| --- | --- |
| Agent | Stable launcher-issued ID, scoped to project and profile; addresses inboxes and creator ownership. |
| Session | One process incarnation, with a monotonically increasing generation and capability. |
| Task attempt | One accepted execution, with its own ID, increasing fence and explicit lease expiry. |

Pane numbers and labels are metadata, never coordination handles. The stable ID
can be the existing `SWARM_MCP_INSTANCE_ID` from the VUH-19 precreation/adoption
contract. A trusted launcher also retains a randomly generated resume secret
(at least 32 characters; generate 32 random bytes). Knowing an agent ID alone
does not authorize adoption. Existing workspace identity KV handles remain a
runtime integration concern and are not replaced by pane-number addressing.

`launcherIdentity` resolves real paths, checks the configured profile's allowed
roots, and derives the scope from canonical project root plus configured profile.
Labels cannot alter that boundary. Explicit database paths retain physical profile
isolation where configured. Resolve configuration before enrollment: passing a
caller-selected profile or allowed-root list to this helper defeats that boundary.

## Enrollment and fencing

`store.openSession` is a trusted launcher API, not a generic IPC operation. It
requires scope, stable agent ID, resume secret and a command request ID. Repeating
the request recovers its original session. A new request ID adopts the identity
as a new generation and supersedes prior active/suspended sessions atomically.
After another adoption, replaying an older enrollment returns an obsolete session;
it does not reactivate it. Use a new request ID for a new incarnation.

Capabilities are derived from the resume secret and enrollment request, and only
their hashes are stored. Neither resume secrets nor capabilities are written in
command receipts or events. The owner calls `store.authorize` on each request.
The core validates session generation inside the write transaction before even
replaying a command receipt. Reads also check the generation. Old sessions cannot
omit it: once an agent is enrolled, an unfenced context is rejected.

`session.suspend` and `session.close` immediately disable the current capability.
Resume requires trusted enrollment and creates a new session. Old task attempts
are recoverable; they are not silently attached to the new process. Once ended,
a session cannot replay even its successful end command through that capability.

Transport contact, runtime availability (`available`, `busy`, `unavailable`), and
meaningful progress have independent timestamps. A transport heartbeat does not
renew a task, report progress, or prove runtime availability. A runtime can remain
busy without model turns; its adapter must renew the task lease while legitimate
work continues. No cleanup infers task failure merely from absent model activity.

## Task transitions

| Command | Preconditions | Result |
| --- | --- | --- |
| create | Dependencies already exist in the same scope | open, or blocked while any dependency is incomplete |
| claim | open, dependencies completed, expected version, current session | running with a new attempt and fence |
| renew | Current actor/session/attempt/fence and unexpired lease | Extend lease, without implying progress |
| progress | Same current-ownership checks | Record progress and note, extend the progress deadline and renew the short lease |
| finish | Current ownership; valid outcome | completed or failed; retain attempt result/reason |
| cancel | Creator and expected version; open/blocked/running | cancelled immediately, or cancel_requested during work |
| finish cancelled | Current ownership and cancel_requested | cancelled; preserve cancellation attempt |
| retry | Creator, expected version, failed/cancelled | open or blocked; keep prior attempts/results |
| recover | Lease expired or owning session suspended/closed/superseded | Abandon old attempt; open/blocked, or cancelled if cancellation was requested |

Claims and every ownership mutation execute under the same SQLite transaction as
their receipt and event. A unique partial index permits only one running attempt
per task. Fences increase across retry and recovery. Completion from a replaced
attempt cannot overwrite the accepted result, even if its session remains valid.
Repeat recovery after the attempt is detached is a harmless no-op.

Leases default to 60 seconds and may be requested up to five minutes. Every
attempt also has a progress timeout (15 minutes by default, configurable at claim
from one minute to 24 hours). The latest progress report, or claim time before
the first report, anchors this deadline. Host renewals cannot extend past it.
An accepted progress report also renews the lease for at least 60 seconds within
the applicable deadline, so reporting near expiry does not race the host timer.
Task detail exposes `owner.progressAt` and `owner.progressDeadline`.
Cancellation caps the lease at one minute after the request, including renewals.
A replayed claim/renew receipt reports its original deadline;
clients must check that deadline rather than treating replay as a fresh renewal.
Recovering a healthy current lease is rejected. A cancellation request rejects
late success: the worker must acknowledge cancellation or expire for recovery.

Dependencies are fixed when a task is created and can only reference existing
tasks, so creation cannot introduce a cycle. Terminal and retry transitions update
direct dependents atomically. Failed/cancelled prerequisites keep dependents
blocked with a reason; successful retry opens them. Completed tasks are immutable
and cannot be retried in place. Create a new task for new work.

Trusted runtime launchers supply enrollment and availability observations.
See [migration](migration-cutover.md) for importing historical data without
resurrecting live ownership.
