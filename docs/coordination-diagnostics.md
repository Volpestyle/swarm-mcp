# Coordination diagnostics

With the launcher's existing session environment, run:

```powershell
swarm-coordinator-client doctor
swarm-coordinator-client inspect <taskId>
```

Both issue a read-only authenticated `inspect` operation. The JSON stdin interface
also accepts `{"op":"inspect","filter":{"messageId":"…","limit":5}}`.
Actor and scope come from the session capability, not request fields. No
separate MCP tool or dashboard is involved.

The report includes supported modern/legacy protocol versions, dated adapter
coverage, delivery attempts and acknowledgment state, task ownership/leases,
recipient session generations, recent recovery events and correlated wake records.
It excludes message bodies, task results, user-supplied error text, capability
hashes and delivery tokens. Each detail section defaults to 10 rows, accepts at
most 20 and reports truncation; the response has a 48 KiB ceiling. Scope-wide
aggregates are labeled separately from filtered detail. Use the existing scoped
event cursor API for older history.

## Interpret and recover

| Evidence | Meaning and next action |
| --- | --- |
| `pending`, no wake record | Could be deferred, disconnected or missing adapter coverage. Check the recipient's runtime observation and support limitation; absence of telemetry is not proof of failed wake. |
| Wake `accepted` | The host admitted a wake, not the message's effects. Wait for explicit acknowledgment; do not start duplicate work. |
| Wake `uncertain` | Inspect the retained host outcome. Do not blindly repeat an uncertain native prompt or create. |
| `leased`, no acknowledgment | Processing may be underway. After lease expiry, recipient `inbox.sweep`/`inbox.fetch` recovers delivery; deduplicate effects by message identity. These transitions retain events. |
| `dead_letter` or expired | Inspect authorized `message_status` and recipient health. Terminal records remain; there is no automatic terminal replay. A deliberate replacement uses a new message identity and references the original task/thread. |
| Expired task lease or inactive owner | Use `task.recover` with the task ID. Recovery fences stale results; it is not proof external work stopped. Dispatch capacity remains reserved until provider stop proof permits release. |
| `cancel_requested` | Wait for the matching fenced cancellation result. Reassignment requires release, unchanged contract and current task version; it emits `dispatch.reassigned`. |
| `unknown_stale_observation` | Runtime evidence is over 60 seconds old. Refresh through the trusted adapter. Enrollment, transport activity and the retained `available` value do not establish process liveness. |

Latency aggregates distinguish first message lease from explicit acknowledgment.
Retries count lease attempts after the first; dead-letter and recovery counts use
retained state/events. Wake records are authenticated recipient self-reports and
correlate message, task, attempt, actor, session generation and delivery attempt.
They never authorize ownership or acknowledge delivery. The observer ignores its
own wake events when deciding whether another inbox scan is needed.

Stale-owner rejection and SQLite busy/locked counters are scoped, in-memory
observations since the reported owner-process start. They reset on restart;
recovery/assignment/delivery audit events remain durable. Writer acquisition
time includes uncontended overhead and is not presented as pure lock-wait time.
Unknown credential failures are not attributed to an arbitrary scope.

## Evidence

The installed OpenCode probe retained in
[`verification/2026-09-22-dispatch/diagnostics-native.json`](verification/2026-09-22-dispatch/diagnostics-native.json)
shows one accepted wake correlated to one task/attempt/session, one delivery and
one acknowledgment. The scripted endpoint received two model requests, the same
count as before telemetry was added. That capture predates the additional
session/generation fields on lease/ack audit rows; those fields have direct
inbox/IPC regression coverage.

Regression coverage: diagnostics tests exercise a real competing SQLite writer,
scope isolation, content/token omission, stale observations, acknowledgment
latency and deduplicated wake records. IPC tests execute the built Node `doctor`
CLI with no stdin and verify request scope cannot override authorization. Inbox
tests retain lease/ack behavior across Node/Bun crashes and concurrent consumers.
TypeScript and production builds pass. Runtime limitations are stated in
[runtime host support](runtime-host-support.md); diagnostics do not upgrade them.

History: delivered under VUH-1341 (September 2026); merged in PR #9.
