# Runtime delivery contract (implementation in progress)

`RuntimeDelivery` consumes an authenticated coordinator request function and a
trusted host adapter. It has no spawn or terminal-injection API. Enrollment and
session capabilities belong to the launcher; the adapter is bound to one actor.
Host-specific integration and two-host end-to-end verification remain VUH-1339
work. The shared core alone is not proof of delivery in Codex or Claude Code.

Host observations carry a state, source evidence and observation timestamp:

| State | Required host evidence |
| --- | --- |
| busy | Active turn/tool or equivalent runtime event |
| idle | Explicit host idle event or successful authoritative status query |
| blocked | Permission/question or another explicit waiting state |
| disconnected | Lost host connection or ended session |
| unsupported | Required hooks/API absent or not verified |

Process existence does not establish idle. Adapters must recheck admission at
the host boundary; stale observations cannot authorize injection. A post-tool
callback may admit context during a busy turn if that host supports it. A
guessed timer boundary cannot. Turn-start delivery requires idle. Blocked,
disconnected and unsupported states defer without fetching.

Wake hints first query the durable message's delivery status. Only pending work
for this actor can wake an existing idle session. Concurrent hints share one
wake, accepted wakeups coalesce until a boundary, and failed attempts have a
one-second retry floor. There is no model polling loop or automatic retry timer.
The runtime event observer is responsible for subsequent opportunities.

At a supported boundary, one durable lease is fetched. Concurrent boundary calls
share that attempt. Host admission leaves the delivery leased: it is not proof
of processing. The consumer acknowledges with the message ID and exact lease
token only after processing, using the existing inbox API. Hosts deduplicate
admission by message ID and carry lease metadata through their delivery path.

Explicit host deferral rejects/requeues the lease with the inbox backoff policy.
Exceptions or five-second callback timeouts leave admission uncertain and retain
the lease until recovery; the callback receives an abort signal. A restarted
delivery driver can retry after lease expiry. The durable inbox retains work if
the host fails, but exactly-once external effects still require consumer logic.

`coordination-runtime-delivery.test.ts` exercises real store commands with test
host adapters: busy/degraded states, duplicate hints, concurrent boundaries,
explicit processing acknowledgment, failed wake/backoff, uncertain admission,
driver replacement, callback timeout and backlog preservation. Installed-host
evidence is recorded separately under `docs/verification/2026-09-22-runtime`.
