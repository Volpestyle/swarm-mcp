# Runtime delivery contract

Per-host evidence and supported limits: [runtime host support](runtime-host-support.md).

The production owner runs as `node dist/coordination/owner-cli.js <config.json>`.
Its private config contains `databasePath` and a generated `launcherSecret` of at
least 32 characters. The launcher must protect that file and must not export the
secret to agent environments. Readiness prints only the endpoint and PID.

`launcherEnrollment` enables the IPC `enroll` operation using that separate
credential. Ordinary agent capabilities cannot enroll, and the launcher secret
is not an agent capability. The authenticated launcher supplies validated scope,
stable agent ID, worktree, resume secret and request ID. Identical enrollment
replay returns the original capability; a new request ID advances the session
generation and fences the older capability. Owner restart preserves this state.
Enrollment is disabled unless the owner explicitly installs the callback.

`ensureCoordinator` first tries the configured endpoint. Only missing/refused
local endpoints trigger a hidden detached Node owner. Startup uses bounded
backoff (five seconds by default), and simultaneous launchers converge through
exclusive pipe binding. Errors clean up only the child that invocation launched;
an existing owner is never killed from a PID file. Config requires an absolute
database path, and launcher clients still authenticate enrollment before use.

`ownerState` and `agentState` create private launcher state under an absolute
directory whose parent the launcher owns. Windows creates the directory with a
restrictive ACL atomically and verifies owner/access rules on directories and
retained files. Unix requires current-user ownership and private mode bits.
Existing insecure state is refused rather than silently changing permissions.

Records are written and file-synced under a temporary name, then published with
an exclusive hard link. Racing writers read the same winning complete record.
The owner secret is stable; agent IDs/resume secrets are keyed by scope, host and
native host-session ID. Corrupt retained records fail rather than rotating an
identity and losing access to its work. A process crash may leave an unused
private temporary file. Directory fsync on Windows and hard-power-loss survival
of newly published secrets are not claimed. These protections do not isolate
malicious processes running as the same OS user.

`enrollRuntime` composes path/profile validation, private owner/agent state,
automatic owner startup and privileged enrollment. Callers supply a trusted host
session ID and incarnation. Reuse the incarnation when retrying uncertain
enrollment; choose a new one for an actual host restart/resume. A bootstrap with
the returned session capability verifies it is still current before returning.
Only the endpoint and session capability are returned in the child environment;
owner and resume secrets remain in launcher state. OpenCode V1 lifecycle hooks
use this composition; startup reconciliation, delivery/wake hooks and other
hosts have evidence and remaining limits in
[runtime host support](runtime-host-support.md).

`RuntimeDelivery` consumes an authenticated coordinator request function and a
trusted host adapter. It has no spawn or terminal-injection API. Enrollment and
session capabilities belong to the launcher; the adapter is bound to one actor.
OpenCode and Claude Code have installed-host evidence; Codex automatic delivery
and Hermes actual-host delivery are unverified. The shared core alone is not
proof of host delivery.

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
one-second retry floor. The shared driver has no model polling loop. The OpenCode
inbox observer uses deadline timers for lease expiry, TTL and inbox retry backoff.
It recovers only the authenticated recipient's deliveries through `inbox.sweep`
when the host is ready. A new attempt gets its own persisted wake intent, while
repeated hints within that attempt reconcile the same native prompt. Context
inspection suppresses repeated envelopes and supplies fresh lease metadata.

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

History: delivered under VUH-1339 (September 2026); merged in PR #9.
