# Optional work tracker integration

The compact coordinator performs no automatic Linear writes. The user's mandate
or project configuration chooses whether work is tracked, which authenticated
tracker/team/project to use, and who may write. Missing tracker access never blocks
local coordination or silently selects another account. Role labels do not confer
tracker credentials or authority.

Reuse the existing design cluster: [VUH-35](https://linear.app/vuhlp/issue/VUH-35)
for promotion, [VUH-36](https://linear.app/vuhlp/issue/VUH-36) for create/link,
[VUH-37](https://linear.app/vuhlp/issue/VUH-37) for status and
[VUH-38](https://linear.app/vuhlp/issue/VUH-38) for completion evidence. These are
archived design tickets, not proof of shipped compact automation. The redesign's
VUH-1344 acceptance rule supersedes their automatic worker-done-to-issue-Done
mapping. Keep the old records intact; do not reopen or implement a second bridge
merely to use this skill.

## Promotion and binding

Prefer linking an issue explicitly named by the user. Resolve it read-only and
retain its UUID and human identifier without rewriting its title or description.
Otherwise promote substantive human-facing deliverables only within an authorized
tracking mandate and configured destination. Ephemeral messages, heartbeats, leases,
worker availability and routine coordination stay in the coordinator. Promotion
can be disabled entirely by choosing coordinator-only operation; no Linear server
is required for the compact runtime.

Use `(scope, taskId)` as the durable binding identity, never pane/process/session
IDs. Retain the provider, issue UUID, identifier, designated writer and accepted
source task version. If a create response is uncertain, inspect the destination
for that binding before attempting another create; local command idempotency does
not make a remote tracker call exactly-once. Defer unresolved promotion and keep
runtime work moving.

## One writer, explicit versions

One authorized writer owns each binding's tracker mutations. A worker may be that
writer when its contract says so; a lead or bridge must not write concurrently as
a backstop. Transfer writer authority explicitly, reconcile any in-flight remote
request, and continue from the retained binding version. A local shared-key CAS
can serialize binding changes, but it is not an atomic transaction with Linear.

Before each write, read the current issue/comment and task state. Preserve newer
human changes. Use the task's current `version` plus terminal `attemptId`/`fence`
for provenance, and record the tracker's last observed `updatedAt`. If either
changed, reconcile instead of replaying stale desired state. Without a remote
conditional-write API this is a single-writer operating policy, not a claim that
races with human edits are mechanically impossible.

Post evidence when it changes what a human can assess: accepted result, meaningful
failure, review finding or a concrete blocker. Retain the posted comment ID and
source version so retries edit/reconcile the existing evidence instead of appending
it twice. Do not mechanically mirror every local state change.

`completed` means the worker reported completion under a valid fence. Use the
project's review/acceptance workflow to decide whether the issue is In Review or
Done. Review acceptance, integration and deployment are separate facts and need
their own evidence when required. For many swarm tasks bound to one issue, the
writer evaluates the issue's full acceptance criteria; one finished child cannot
close the parent. Failed/cancelled execution likewise does not automatically cancel
a human request that still needs work.

Legacy deployments use [legacy tracker guidance](legacy-work-trackers.md) for
legacy configuration keys. Do not assume those hooks publish tracker configuration
into the compact coordinator.
