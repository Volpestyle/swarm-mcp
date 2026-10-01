# Local Swarm effectiveness review — September 30, 2026

Swarm's durable coordination works across multiple harnesses, and its transport
benchmarks are fast. The local operational record does **not** establish smooth,
delay-free swarming or a net productivity gain. The biggest observed friction is
host delivery, stale lifecycle state, and worker execution permissions.

## Evidence and scope

Read-only queries sampled two local Clankie coordinator databases at
2026-10-01 03:10 UTC (September 30 in America/Chicago). Their retained events span
September 24–October 1 UTC and mix canaries with actual work. These are local
observations, not a fleet-wide sample or controlled model comparison.
[Sanitized aggregates](retained-metrics.json) exclude message bodies, task titles,
session identities, credentials and private paths. Percentiles use nearest rank.

Source main was updated by fast-forward from `a72a2d3` to `c6fc547` during review.
The installed Clankie routes point at its vendored Swarm package, not this source
checkout. Updating source does not deploy a runtime. The native interactive
worker branch was under active development and was not deployed by this review.

## Findings

| Area | Observation | Interpretation |
| --- | --- | --- |
| Transport | Historical 2/8/32-agent delivery p95: 8/10/32 ms; 32-agent throughput: 281.94 messages/s | The measured core is fast. These are September 22 fixtures, not today's host latency. |
| Working-scope deliveries | 121 deliveries: 110 acknowledged, 5 dead letters, 5 leased past expiry, 1 pending | Accepted work is retained, but delivery is not uniformly smooth. |
| Retries | 28 deliveries required retries; 51 additional attempts | Acknowledged totals alone hide recovery work. |
| First lease | 120 observed messages: p50 16 ms, p95 34.7 min, maximum 82.9 min | Fast typical pickup coexists with substantial waiting. This includes recipient availability and host scheduling, not just transport. |
| Processing acknowledgment | 110 acknowledged messages: p50 19.8 s, p95 43.8 min, maximum 83.1 min | Includes model work and waiting; excludes the unacknowledged backlog. It is not wire latency. |
| Lifecycle | 24 tasks: 11 completed, 11 cancelled, 1 failed, 1 cancellation requested; 9 recoveries, 7 worker-blocked events | Outcomes mix real work, canaries and intentional cancellation. The completion fraction is not a productivity score. |
| Retained capacity | 10 dispatches remain bound: 9 cancelled tasks and 1 cancellation requested | Retention correctly avoids pretending unproven external workers stopped, but needs reconciliation before capacity can safely be reclaimed. |
| Acceptance scope | One completed task; all 4 messages acknowledged, one attempt each | A successful isolated acceptance path, too small to generalize. |

The unresolved working-scope records originated September 26–27 UTC. They include
four dead-letter assignments, one dead-letter reply, four expired cancellation
leases, one expired reply lease and one pending reply. They should be inspected
and reconciled through the existing lifecycle tools; age is not stop proof and
does not authorize acknowledgment or replay.

### Recent work still encountered waiting

All nine September 30 messages were eventually acknowledged, with eleven lease
attempts. However, the final two replies and completion notice waited roughly
82.5–82.9 minutes for their first lease. The record establishes late consumption;
it does not establish whether the recipient was busy, disconnected, or waiting
for a host boundary. This occurred after the September 27 canaries, so the entire
latency tail cannot be dismissed as pre-upgrade history.

That day's Codex release-preparation task finished as failed with a handoff. Its
worker reported that sandbox restrictions blocked Git index writes, local binds
and network fetch, and that dependency preflight prevented the build/check gates
from running. It returned useful prepared files and explicit limitations, but
the requester had to finish execution. Match the trusted route's actual
permissions to the task before dispatch; durable messaging cannot supply those
permissions or make an unsuitable execution environment productive.

### Cross-model coordination

September 27 retained results record successful managed Codex and pi canaries:
assignment delivery, acknowledgment, progress and fenced completion. Pi reported
Kimi K3 through OpenRouter; Codex reported GPT-6 without an independently exposed
deployment suffix. The Codex canary needed a fresh delivery after its first lease
expired. Earlier canaries for both harnesses had been cancelled.

This demonstrates a shared protocol across model families. It does not measure
better reasoning, less rework, reduced model cost, or faster completion than
single-agent/native alternatives. The inspected current route configurations
enable Codex and disable Claude/pi dispatch; the canary record does not imply
every family is currently enabled. This review session itself exposed no Swarm
MCP tools, so it could not join the live coordination channel.

### Resource overhead

A process snapshot found 36 coordinator owners older than a day, all associated
with test/proof/scratch paths, with approximately 1,105 MiB combined RSS and 0.0%
reported CPU at that instant. This is neither unique physical memory nor a
sustained CPU measurement. No pre-existing process was stopped. The documented
idle-retirement fix prevents accumulation only where the running owner supports
it; existing old processes remain a separate cleanup decision.

## Verification and next decisions

The actively edited interactive branch passed `bun run check` during this review:
218 Bun tests, one Python test, typecheck, build and package verification. This is
evidence for the observed working tree, not an immutable release or proof of
real-model/native-TUI behavior. Its owner is finishing integration and owns its
commits. No live runtime or database was modified by the review.

Priority follow-ups are to reconcile retained dispatches with actual stop proof,
explain the late recipient wake/consumption on the recent task, and match worker
permissions to the assigned work. Validate the native interactive candidate
through its owner's installed-harness canaries before rollout. To answer whether
Swarm enhances productivity, use comparable real tasks and record accepted
outcomes, rework, elapsed time, model calls/cost and human intervention; no such
matched comparison is present here.

Existing references: [benchmarks](../../coordination-benchmarks.md),
[diagnostics and recovery](../../coordination-diagnostics.md),
[September 27 lifecycle fixes](../2026-09-27-lifecycle/README.md),
[host support boundaries](../../runtime-host-support.md).
