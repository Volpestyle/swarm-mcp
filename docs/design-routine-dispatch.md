# Design: Routine Dispatch

> **Status: not yet implemented.** Plumbing exists (`request_task_batch`,
> `dispatch`); the orchestration layer that composes them into named,
> reusable, multi-role workflows is the missing piece. This doc captures the
> intended shape and open questions so a future implementer has a target.

## Problem

Single-intent `dispatch` covers one operator intent → one task → one best
worker. That's the right primitive for "fix this issue" or "review this
branch."

Many real workflows are not single-intent. They are recurring or composite
graphs across roles:

- A release check that runs build/tests, code review, and release-note
  context-gathering in parallel, then collects results for sign-off.
- A weekly housekeeping pass that triages stale tasks, prunes done items, and
  posts a digest.
- A multi-step refactor template that fans out per-file work to implementers,
  then routes a single review across the whole set.

Today an operator who wants this composes it by hand: call `request_task_batch`
to create the DAG, then trigger `dispatch` per task to wake or spawn workers,
then watch for completion, then assemble a summary. That is repeatable enough
to be a primitive.

## Concept

A **routine** is a named, parameterized recipe that expands into a small task
graph plus the dispatch/wake/spawn for each part, with monitoring and a final
summary. It is runtime-agnostic — any gateway-capable lead session (Hermes,
Claude Code, Codex) should be able to host and run routines, because the
underlying primitives (`request_task_batch`, `dispatch`, task lifecycle, KV,
messages) all live in swarm-mcp.

The user-facing surface is typically a slash command, button, or scheduled
trigger:

```text
/release-check
/weekly-housekeeping
/refactor-rename <old-name> <new-name>
```

A routine invocation produces a swarm task graph, a per-role dispatch fan-out,
and a final gateway-owned summary task that the operator (or another consumer)
sees.

## Worked example: `/release-check`

```text
/release-check
  implementer -> run build/tests and fix obvious failures
  reviewer    -> review the branch for regressions
  researcher  -> check linked issue/release context
  gateway     -> collect results and ask for approval
```

Expansion under the hood:

1. **Build the graph.** Call `request_task_batch` with four task specs. The
   first three are role-targeted (`role:implementer`, `role:reviewer`,
   `role:researcher`) and start `open` (no in-batch deps). The fourth — the
   gateway summary — `depends_on: ["$1", "$2", "$3"]` and starts `blocked`.
2. **Dispatch each leaf.** For tasks 1–3, route through `dispatch` (or an
   internal call that performs the same wake-or-spawn) so a matching live
   worker is woken, or a new worker is spawned through the configured
   workspace backend. The gateway does not wait inline; it returns control to
   the operator with a routine-run handle.
3. **Monitor.** The summary task unblocks naturally when its three deps reach
   `done` (or `failed` / `cancelled`). The gateway watches via task events
   (or polls) and, when the summary is unblocked, claims it itself and runs
   the summary step.
4. **Surface results.** The summary task body collects the per-leaf task
   results (linked by ID), and the gateway posts the digest back to the
   originating transport (Telegram thread, Slack channel, CLI session, etc.).

## Composition

Routines compose existing swarm-mcp primitives. They do **not** introduce a
new persistence or messaging layer.

| Layer | Primitive |
|---|---|
| Atomic graph creation | `request_task_batch` (atomic insert, `$N` deps, idempotency keys) |
| Per-leaf routing | `dispatch` (live-worker wake or spawn through configured backend) |
| Progress tracking | Standard task lifecycle (`claim_task` → `complete_task`) and dep-resolution |
| Inter-task signal | `send_message` / `[auto]` notifications between leaves and summary |
| Operator visibility | The routine run is just a task graph; `/swarm tasks` lists it like any other |

The routine layer's job is purely orchestration: take a routine definition + a
set of bound parameters, produce a batch spec, hand off to existing
primitives, and own the summary leaf.

## What a routine definition needs

A routine, as a first-class artifact, would need at minimum:

```yaml
name: release-check
description: Run build, review, and release-context gathering, then summarize.
params:
  branch:
    type: string
    default: $current_branch
tasks:
  - role: implementer
    type: implement
    title: "Build + tests on ${branch}"
    description: |
      Run the full build and test suite on ${branch}. Fix obvious failures.
      Surface non-obvious ones in the task result.
  - role: reviewer
    type: review
    title: "Branch review: ${branch}"
    files: ["${branch}"]   # or some addressable form
  - role: researcher
    type: research
    title: "Release context for ${branch}"
  - role: gateway-summary  # special marker for the gateway-owned summary leaf
    type: other
    title: "Release-check summary for ${branch}"
    depends_on: ["$1", "$2", "$3"]
```

That YAML is one possible shape; the firm parts are: routine name, parameter
declarations, per-task spec list with role, and a summary leaf marker. The
rest is design surface.

## Open questions

These need resolution before implementation can start.

1. **Where do routine definitions live?** Repo-local (`./.swarm/routines/`)?
   Per-user dotfiles (`~/.config/swarm-mcp/routines/`)? Both, with merge
   semantics? Are routines a runtime-plugin concept (Hermes plugin ships its
   own) or a swarm-mcp concept (server loads from configured paths)?
2. **How are parameters bound?** CLI positional args? Prompt-time questions
   to the operator? A schema-driven form on a gateway transport like
   Telegram? Likely all three with a layered fallback, but the precedence
   needs spelling out.
3. **How does monitoring surface back?** A polling loop in the gateway is one
   path; subscribing to task events (would need a new subscription primitive)
   is another. The simplest first cut: gateway polls `list_tasks` filtered
   by routine-run ID, claims the summary when it unblocks.
4. **Routine-run identity.** Each invocation needs a stable ID so the
   gateway, transports, and the summary leaf can correlate. A natural choice:
   make it the parent_task_id of the summary leaf, or stash it as a KV row.
5. **Failure semantics.** If one leaf fails, does the summary still run with
   partial results, or does the whole routine cancel? Per-routine config or
   global default? `request_task_batch` already cascades `failed` /
   `cancelled` through `depends_on`, so the easy path is: summary always
   runs, sees failed-leaf statuses, reports them honestly.
6. **Scheduling.** On-demand only, or also cron-triggered? If scheduled, who
   owns the scheduler — swarm-mcp server, a gateway daemon, the host OS
   (launchd / systemd)? Scheduled routine invocations need a "wake the
   gateway from cold" story.
7. **Idempotency.** A routine retried after a transport hiccup should not
   create a duplicate task graph. `request_task_batch` already supports
   per-task `idempotency_key`; the routine layer needs a per-run key
   convention (e.g. `routine:<name>:<run_id>:<task_index>`).
8. **Approval-gated routines.** Some routines (e.g. a destructive cleanup)
   may need operator approval before any leaf claims. The `approval_required`
   task flag exists for this, but the routine has to mark the right leaves —
   probably all of them, gated through the summary or a leading approval leaf.

## Runtime adaptation

The routine concept is runtime-agnostic, but the surface area that wires it up
is per-runtime:

- **Hermes:** routines fit naturally as slash commands or named buttons.
  Plugin would expose a `routine_run <name> [params...]` tool that gateways
  call.
- **Claude Code:** routines map cleanly to skills or slash commands; the
  plugin could ship a `/routine <name>` slash that calls the same underlying
  swarm-mcp primitive.
- **Codex:** similar — routines as named lead-mode shortcuts.

The shared primitive (most likely a new `routine_run` MCP tool, or just a
documented composition pattern that integrations call) lives in the swarm-mcp
server. Integrations bind it to their preferred operator surface.

## Relationship to other primitives

- **`request_task_batch`** ([design](./design-batch-creation.md)): the atomic
  graph-creation primitive. Routines call this.
- **`dispatch`**: the single-task wake-or-spawn primitive. Routines call this
  once per leaf (or call it internally as part of `request_task_batch` if a
  future enhancement combines them).
- **Hermes SPEC §7.5** ([link](../integrations/hermes/SPEC.md)): the original
  framing of routine dispatch as the user-facing command layer above
  single-intent dispatch. This doc generalizes that framing across runtimes.

## When this gets built

Not on the critical path while no operator is actually feeling the pain of
hand-composing `request_task_batch` + `dispatch` for repeated workflows. The
right trigger is one of:

- Two or more concrete recurring workflows are being hand-composed and the
  duplication is visible.
- A gateway operator has requested it explicitly.
- A scheduled / autonomous use case (cron-style routines) becomes a need.

Until then, the plumbing is in place; this doc is the reservation for the
slot.
