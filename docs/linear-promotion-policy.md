# Linear promotion policy

The compact coordinator performs no automatic Linear writes. The user's mandate
or project configuration chooses whether work is tracked, which authenticated
tracker/team/project to use, and who may write. Missing tracker access never
blocks local coordination or silently selects another account; runtime progress
does not depend on tracker availability. Role labels do not confer tracker
credentials or authority. This page summarizes the packaged
[work-tracker reference](../skills/swarm-mcp/references/work-trackers.md), which
is the normative text the agent skill and operators share.

## When swarm work gets a tracker issue

Prefer linking an issue explicitly named by the user: resolve it read-only and
retain its UUID and human identifier without rewriting its title or description.
Otherwise promote substantive human-facing deliverables only within an
authorized tracking mandate and configured destination. Ephemeral messages,
heartbeats, leases, worker availability and routine coordination stay in the
coordinator. Promotion can be disabled entirely by choosing coordinator-only
operation; no Linear server is required for the compact runtime.

Use `(scope, taskId)` as the durable binding identity, never pane/process/session
IDs. Retain the provider, issue UUID, identifier, designated writer and accepted
source task version. If a create response is uncertain, inspect the destination
for that binding before attempting another create; local command idempotency
does not make a remote tracker call exactly-once. Defer unresolved promotion and
keep runtime work moving.

## One writer, explicit versions

One authorized writer owns each binding's tracker mutations. A worker may be
that writer when its contract says so; a lead or bridge must not write
concurrently as a backstop. Transfer writer authority explicitly, reconcile any
in-flight remote request, and continue from the retained binding version.

Before each write, read the current issue/comment and task state and preserve
newer human changes. Use the task's current `version` plus terminal
`attemptId`/`fence` for provenance, and record the tracker's last observed
`updatedAt`. If either changed, reconcile instead of replaying stale desired
state. Without a remote conditional-write API this is a single-writer operating
policy, not a claim that races with human edits are mechanically impossible.

Post evidence when it changes what a human can assess: accepted result,
meaningful failure, review finding or a concrete blocker. Retain the posted
comment ID and source version so retries edit/reconcile the existing evidence
instead of appending it twice. Do not mechanically mirror every local state
change.

## Completion does not close issues

`completed` means the worker reported completion under a valid fence. The
project's review/acceptance workflow decides whether the issue is In Review or
Done; there is no automatic worker-completed-to-issue-Done transition. Review
acceptance, integration and deployment are separate facts and need their own
evidence when required. For many swarm tasks bound to one issue, the writer
evaluates the issue's full acceptance criteria; one finished child cannot close
the parent. Failed/cancelled execution likewise does not automatically cancel a
human request that still needs work.

## Legacy policy

The [legacy policy](legacy/linear-promotion-policy.md) retains the earlier
worker-first/gateway-backstop design and legacy configuration keys. Its
automatic closure mapping does not govern the compact coordinator. The archived
VUH-35 through VUH-38 design tickets are historical input, not shipped bridge
claims.

History: delivered under VUH-1344 (September 2026); merged in PR #9.
