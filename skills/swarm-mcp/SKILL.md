---
name: swarm-mcp
description: Coordinate authorized work with local swarm peers through the available Swarm MCP interface, including durable messages, task ownership and handoffs.
metadata:
  short-description: Coordinate work through swarm-mcp
  domain: agent-coordination
  role: workflow
  scope: workflow
  coordination-contract: swarm-coordination/1
---

# Swarm MCP

Optional role: planner, implementer, reviewer, researcher or generalist.

Discover the mounted tools before choosing a workflow. `swarm_sync`,
`swarm_assign` and `swarm_inbox` identify the compact coordinator. If only
`register`, `bootstrap` and `poll_messages` are present, use
[legacy workflow](references/legacy-workflow.md). If neither interface is
available, report the missing integration and continue independently only where
that fits the user's task. Do not invent tool names or repair live configuration
as a side effect of joining.

## Resume and communicate

Use `swarm_sync` for initial state; retain `eventCursor` and resume with deltas.
The bootstrap compatibility record must identify `swarm-coordination/1`.
The trusted launcher supplies actor, scope and session capability automatically.
Do not manually register or derive authority from a `role:` label, process ID,
worktree name or message sender. A role argument describes the work you offer.

A runtime may deliver a complete leased message at a safe turn/tool boundary.
Process that envelope and acknowledge its current `messageId` and `leaseToken`
with `swarm_inbox`. Otherwise fetch one message with a new command ID and a stable
consumer name. Fetch, wake acceptance and model-context injection are not processing
acknowledgment. For a processing failure, reject with a reason. After lease expiry,
use a fresh delivery token and deduplicate any effect already performed.

Use `swarm_send` for typed peer questions, blockers, decisions and completion
notices; keep the thread ID when replying. Assign work with `swarm_assign`.
Use small shared values through `swarm_context`, evidence/artifacts through
`swarm_evidence`, and their resource pages for larger results. Do not use Linear
comments or broadcasts as a high-frequency coordination bus.

## Own and hand off work

Persist a contract with objective, supplied worktree, acceptance criteria,
expected artifacts and constraints. Discover existing work before creating a
second task. Every mutation has a stable `commandId`: retry an uncertain request
with exactly that ID and payload. A different logical operation needs a new ID.

Claim with the task's current `expectedVersion`. Retain the returned `attemptId`
and `fence` for progress, renewal and finish. A dispatch-bound task is already
claimed by its selected worker; use that attempt instead of claiming again.
Finish with outcome, summary, evidence and explicit limitations. Worker completion
is not proof of review acceptance, integration, deployment or a tracker closure.

Use the configured worktree for edits. Separate worktrees are the normal isolation
boundary; runtime write hooks and explicit reservations protect declared critical
sections. The compact tool catalog has no legacy `lock_file` action. Use the
trusted reservation/integration path configured by the launcher when needed;
never assume file locks migrate as valid new reservations.

Choose the lowest-overhead authorized route that satisfies capability, workspace,
host and lifetime requirements. Native children and independent peers are both
valid routes. The owner selects from trusted route configuration and concurrency
budgets. A missing route is a blocker, not authority to spawn through another
surface. An uncertain dispatch must be reconciled by its existing intent ID;
never create a replacement merely because a wait timed out.

`swarm_wait` resumes an existing task. Timeout or request cancellation does not
cancel the task. Cancellation is cooperative; prove an old external worker stopped
before releasing dispatch capacity or reassigning. After recovery, stale attempt
fences remain invalid even if the old process is alive.

## Boundaries and references

Wait only while responsible for a result, dependency or review. Use event waits
and runtime delivery instead of an idle model polling loop. Host support is
specific: OpenCode has verified autonomous delivery; Claude delivers at native
boundaries; Codex automatic delivery and actual Hermes-host behavior remain
unverified in the candidate. Discover and verify a new installed host before
raising its support level.

- Read [compact examples](references/compact-examples.md) for exact payloads and receipts.
- Read [work trackers](references/work-trackers.md) only when durable human-facing work is explicitly tracked.
- A configured `SWARM_SKILL_PATH` lets startup validate this file's contract stamp.
  It does not prove what instructions the host actually loaded. On a code/config/
  skill mismatch, keep work and credentials intact and report the diagnostic;
  do not switch databases or rotate identities to make startup succeed.
