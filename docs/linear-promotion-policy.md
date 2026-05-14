# Linear promotion policy

**Status:** v0 — adopted; cross-references [VUH-35](https://linear.app/vuhlp/issue/VUH-35).
**Audience:** gateway/planner authors, the Linear bridge in `integrations/*/` (VUH-36/37/38), and anyone
deciding whether a swarm task should also exist as a Linear issue.

This doc fixes the **boundary between the swarm Coordinator and the configured WorkTracker**
for the Linear-shaped first stack. It is the gate that VUH-36 (create/link), VUH-37
(mirror lifecycle), and VUH-38 (post completion comment) honor.

Linear is the concrete first WorkTracker target, but the rule shape is tracker-agnostic.
Same predicate, same metadata contract — only the adapter changes when Jira/GitHub
Issues/etc. is the configured tracker for an identity. The rest of this doc says "Linear"
because that's the implementation we're shipping; everywhere it appears, read it as
"the configured same-identity tracker."

## 1. The boundary we're enforcing

From [`control-plane.md`](./control-plane.md):

> Work trackers should not hold worker heartbeats, file locks, pane handles, or
> high-churn peer messages. Those belong in the Coordinator. Workers may update the
> configured same-identity tracker when they are publishing durable human-facing work
> state; they should not use Linear, Jira, GitHub Issues, or any other tracker as
> the live swarm bus.

The Coordinator (`swarm-mcp`) is fast, ephemeral, machine-facing. The tracker is durable,
human-facing, organizationally indexed. Promotion is the act of asserting "this is also
something a human will want to find later." The default answer is **no**.

## 2. Predicate: when promotion fires

A swarm task is promoted to a Linear issue when **at least one** of the following is true:

### 2.1 Explicit operator marker (always fires)

- The operator's intent includes an existing tracker identifier or URL that resolves
  to the configured same-identity tracker (e.g. `VUH-20`, `https://linear.app/<team>/issue/VUH-20/...`).
  → **Link**, do not create. The swarm task binds to the existing issue.
- The operator dispatch includes an explicit promotion flag (e.g. `linear=true`,
  `--tracker=linear`, a routine command tagged `tracker_required: true`).
  → **Create**.
- The operator explicitly suppresses promotion (`linear=false`, `--no-tracker`).
  → Do not promote, even if other predicates would have fired. Record the suppression
  in the task's idempotency key namespace so retries are stable.

Explicit always wins. Implicit predicates below only fire when the operator did not say.

### 2.2 Tracker-backed gateway dispatch (default-on for medium/large work)

When the gateway routes via `dispatch` (see [`agent-routing.md`](./agent-routing.md) §Prefer-swarm-peers
and [`integrations/hermes/SPEC.md`](../integrations/hermes/SPEC.md) §7), the task is promoted
when **all** of these hold:

- A `config/work_tracker/<identity>` row exists for the requester's identity (the runtime
  hook publishes this on session start; absence means "no tracker configured").
- The same-identity tracker MCP is actually loaded in the gateway's tool surface.
  (Routing metadata is config-driven, but the actual create call needs auth — if
  the MCP isn't loaded, surface that as a follow-up, do not silently skip.)
- The task is `type=implement`, `type=fix`, `type=review`, or `type=research` and the
  description is more than a one-line tweak. "Trivial inline edit" routed locally
  per §7.2 of the Hermes SPEC does not get a Linear issue. Use a heuristic the
  gateway can show the operator (e.g. token count over a threshold, >1 file in
  the contract, or "this would have been a `dispatch`" rather than "local edit").

This is the case the Hermes Telegram gateway hits most often: an operator says
"fix this issue", the gateway formulates a patch + success criterion, opens
a swarm task, and the same intent should appear in Linear so the operator can
find it from their phone tomorrow.

### 2.3 Routine dispatch produces a task graph

Routine dispatch (`/release-check`, `/review-branch`, etc. — see
[`design-routine-dispatch.md`](./design-routine-dispatch.md)) expands one operator
intent into multiple role-specific tasks. The routine declares promotion shape:

- **Parent-only**: one Linear issue for the routine, child swarm tasks stay ephemeral.
  Default for short routines (≤3 tasks, all expected to complete inside one operator
  attention window).
- **Per-task**: each child gets its own Linear issue, linked to the parent. Default
  for routines that may span operator sessions or cross reviewer/implementer
  handoffs.

The routine definition picks the shape; the operator can override per-invocation
with `tracker=parent|per_task|none`.

### 2.4 Review escalation

A `type=review` task created with `review_of_task_id` pointing at a Linear-bound
implementation task **inherits** the binding — it is recorded as a sub-issue or
linked comment thread on the same Linear issue, not a separate Linear issue,
unless §2.3 said per-task. This keeps reviewer back-and-forth on one human-facing
record.

### 2.5 Failure that requires human attention

When a task transitions to `failed` and was not already Linear-bound, promotion
fires if **all** hold:

- The task is `type=implement|fix|review` (not `research`/`test` — those failures
  are workflow noise, not human-trackable backlog).
- The failure has a structured `result` with a non-empty `summary` or `followups`
  list (i.e. the worker thinks a human should see this).
- A same-identity tracker is configured.

This catches "the operator was on a plane, the worker tried and failed, and
nobody noticed." VUH-37/38 implementations should treat retroactive promotion
as a normal path, not a special case.

## 3. When tasks stay ephemeral (explicit non-promotion list)

Promotion **does not fire** for any of these, even if the predicates above
would otherwise match:

- `type=test` tasks. They're verification, not backlog.
- `type=research` tasks that produce only KV entries / scratch notes, with
  no file changes and no `followups`. (A research task that returns a doc
  and follow-up tickets is fair game per §2.2.)
- Tasks created against `/__swarm/` synthetic resources (spawn mutex locks,
  internal coordination). These never represent operator intent.
- Tasks with `parent_task_id` set under a routine that declared `parent-only`
  promotion (§2.3).
- Tasks in scopes whose `config/work_tracker/<identity>` row is missing or
  empty. Missing config means "no tracker"; do not infer one from whichever
  MCP is loaded.
- Tasks whose label is missing an `identity:` token. We will not guess
  identity, and we will not promote into the wrong account.
- Anything happening through `lock_file`, `unlock_file`, `kv_*`, or message
  primitives. Promotion is task-shaped only.
- Tasks where the operator passed an explicit suppression marker (§2.1).
- Tasks where the matching same-identity tracker MCP is not loaded. Surface
  as a follow-up; do not retry into the wrong tracker.

## 4. Opt-in / opt-out surfaces

Four control points, in increasing precedence:

| Layer | Control | Where it lives | Scope |
|---|---|---|---|
| Repo default | `swarm.linear.promote: always \| medium-or-larger \| explicit-only` | Repo `.swarm-config` / Hermes config `swarm.linear` | Per repo/scope |
| Identity default | `config/work_tracker/<identity>` payload may include `default_promotion: ...` | Coordinator KV, published by runtime hooks | Per identity |
| Routine | `tracker: parent \| per_task \| none` in routine definition | `design-routine-dispatch.md` routines | Per routine type |
| Per-dispatch | `linear=true \| false`, identifier in intent text | Operator message / `dispatch` call | Per invocation |

Order of evaluation: per-dispatch > routine > identity > repo > built-in default
(`medium-or-larger`).

`explicit-only` is the safe choice for personal repos where most "tasks" are
throwaway. `always` is appropriate for repos that already have a 1:1 issue
discipline (most company work repos).

## 5. Metadata contract — swarm task → Linear issue

When promotion fires, the bridge sends this payload shape. Everything outside
this list stays in the Coordinator.

### 5.1 Identifiers and binding

| Swarm field | Linear field | Notes |
|---|---|---|
| `task.id` (UUID) | issue custom field or description footer | Stable Coordinator handle; never the primary identifier |
| `task.idempotency_key` | (none — internal) | The bridge uses this to dedupe its own create calls (see §6) |
| issue identifier (e.g. `VUH-31`) | — | Returned by Linear on create; stored in `task.result` and on the binding KV row |
| issue URL | — | Stored alongside the identifier |

Bindings are kept in coordinator KV at `tracker/linear/<identity>/<task_id>` with
payload `{ "identifier": "VUH-31", "url": "...", "linked_at": <unix> }`. This is
how VUH-37 finds the issue to mirror and VUH-38 finds the issue to comment on.

### 5.2 Issue content on create

| Linear field | Source |
|---|---|
| `title` | `task.title` |
| `description` | `task.description`, with a fenced footer block containing `swarm task <task.id>`, `idempotency_key <task.idempotency_key>`, `scope <task.scope>`, `requester instance label` (translated from `requester` instance id — never a raw `pane_id`, never an `instance_id` alone) |
| `team` | From `config/work_tracker/<identity>.team` |
| `labels` | Mapped from `task.type` (`implement` → `Feature`/`Improvement` depending on routine, `fix` → `Bug`, `review` → `review`, `research` → `Investigation`) plus any routine-declared labels |
| `priority` | From `task.priority` (Coordinator → Linear priority scale; document the mapping in the VUH-36 implementation) |
| `parentId` | Set when this task has a `parent_task_id` that itself is Linear-bound (§2.3 per-task routines) |
| `state` | "Triage" or "Todo" on create; VUH-37 handles transitions |

### 5.3 Status mirroring (VUH-37 contract)

| Coordinator status | Linear state (configurable per workspace) |
|---|---|
| `open` (unassigned) | Triage / Todo |
| `claimed` | Todo / In Progress (workspace-configurable) |
| `in_progress` | In Progress |
| `blocked` | In Progress with a "blocked" label or workflow state when one exists; otherwise In Progress |
| `done` | Done |
| `failed` | Done with a "failed" label, **and** a comment containing the structured `result.summary` and `followups` |
| `cancelled` | Cancelled |
| `approval_required` | In Review |

If a Linear issue has multiple bound swarm tasks (a parent routine + children
per §2.3), the parent's state is the **most advanced** non-terminal child until
all children terminate, then the parent's final state is `done` if all children
succeeded, `failed` if any failed, `cancelled` if all were cancelled. (Multi-bind
edge cases are deferred — see §8.)

### 5.4 Completion comment (VUH-38 contract)

When a bound task reaches `done` or `failed`, post one Linear comment containing:

- the worker's `result.summary`
- `files_changed`
- `tests` (command + status)
- `followups` (rendered as a list, one item per line)
- the swarm `task.id` for traceability

Do **not** include heartbeats, intermediate `report_progress` summaries, file-lock
events, or peer messages. Those stay in the Coordinator.

### 5.5 What never crosses the boundary

- Worker heartbeats and lease state.
- File-lock acquisitions/releases (both ordinary and `/__swarm/` synthetic).
- Per-edit tool-call audit (the plugin's `pre_tool_call` lock checks).
- High-churn peer messages — `send_message`, `broadcast`, `prompt_peer` wakeups.
- Transport-local handles: `pane_id`, `pty_id`, `session_key`. Translate to
  labels before publishing anywhere a human reads.
- KV scratch entries the worker uses for its own bookkeeping.
- Intermediate `report_progress` calls. The exception is the **final** progress
  summary if VUH-38 implements an optional "live update" pattern; even then, that's
  one structured comment, not a stream.

## 6. Idempotency and retries

Promotion must be safe under operator retry (Telegram resends, gateway restarts,
S7-style spawn races).

- The bridge keys its create-or-link by `task.idempotency_key`. The existing
  contract in [`integrations/hermes/SPEC.md`](../integrations/hermes/SPEC.md) §5.5 calls for stable
  semantic keys for tracker-backed work; this policy formalizes that:
  `tracker:<provider>:<identifier-or-intent-hash>:<role-stage>`, e.g.
  `linear:VUH-20:implement` or `linear:intent-9f3a:review:<implementation-task-id>`.
- The bridge stores the resulting issue identifier on the binding KV row
  (`tracker/linear/<identity>/<task_id>`) **and** as a result field on the
  swarm task. A retry that lands on an existing task returns the existing
  binding without touching Linear.
- An operator who pastes an existing Linear identifier (§2.1) takes the
  "link" path: the bridge resolves the identifier, writes the binding row,
  and does not create a new Linear issue even if the same intent already
  produced one. Detect duplicate-link by checking the binding row before
  the GraphQL call.
- Identity mismatch is fatal, not silent. If a task labeled `identity:work`
  references `linear:VUH-20` and the personal-identity tracker config is the
  one that's loaded, the bridge refuses, surfaces the conflict to the
  operator, and does not write the binding row. See §7.

## 7. Identity enforcement

Promotion respects the identity-boundary rules in
[`identity-boundaries.md`](./identity-boundaries.md). Concretely:

- A task labeled `identity:work` only promotes via the `linear_work` MCP and
  writes its binding row under `tracker/linear/work/<task_id>`.
- A task labeled `identity:personal` only promotes via `linear_personal` and
  writes under `tracker/linear/personal/<task_id>`.
- A task with no `identity:` token is **not** promoted. Surface as an operator
  question instead.
- Cross-identity delegation is already forbidden by `agent-routing.md` §SPEC
  invariants. Promotion follows the same rule: there is no "promote into the
  other identity's tracker" path. If the operator wanted that, they relaunch
  under the right launcher.

The bridge must verify the loaded MCP server's identity suffix matches the
task's identity before calling create/link/comment. If the matching MCP is not
loaded, the bridge:

1. Records the would-be promotion as a deferred entry on the task's `followups`.
2. Continues the task in coordinator-only mode.
3. Does **not** fall back to a different-identity MCP that happens to be loaded.

## 8. Open questions / decisions deferred

These are intentionally not decided here. They depend on signals VUH-36/37/38
implementations will produce.

- **Backfill threshold**: should a task that started as "ephemeral / trivial"
  but then grew (e.g. a worker discovers it needs to touch 7 files) be
  retroactively promoted? Current answer: not automatically — the worker
  surfaces it as a `followup` and the operator decides. Revisit once the
  bridge has been live for a few weeks; the right signal may be `files_changed`
  size at completion time.
- **Multi-bind cardinality**: how many swarm tasks may bind to one Linear issue,
  and what does §5.3's "most advanced non-terminal child" mirror do when
  children come from different routines? Defer to VUH-37; the pattern that
  emerges from real routines should drive the rule.
- **Comment volume**: §5.4 posts one summary on done/failed. If status mirroring
  (§5.3) crosses certain transitions (`blocked` → `in_progress`?) it may also
  comment — but commenting on every transition floods the issue. VUH-37 should
  start silent on transitions and add comments only where operator review showed
  silence was harmful.
- **Routine-parent issue lifecycle**: when a parent-only routine (§2.3) finishes,
  does the bridge close the parent Linear issue automatically, or wait for
  operator approval? Default for now: close on `done`, leave open on `failed` or
  partial completion.
- **Tracker provider abstraction surface**: the policy text says "Linear" because
  that's the implementation target. Where does the provider seam live in code —
  in `integrations/_shared/`, in `src/work_tracker.ts`, or in a new
  `integrations/work-tracker-<provider>/` directory? Defer to VUH-36's first
  implementation; align the others as that pattern hardens.
- **Approval gating**: should `approval_required` swarm tasks force a Linear
  state with a strict "blocked on human" semantic (e.g. Linear's "Blocked"
  workflow state, when it exists)? Workspace state vocabularies differ across
  Linear teams; let VUH-37 ship a configurable mapping rather than a hard
  default.
- **Cross-scope promotion**: a Linear issue spanning multiple swarm scopes
  (monorepo with several scopes, or a routine that touches two repos) is not
  supported. The first-cut rule is one binding per swarm task and one swarm
  task per scope; revisit if a real use case appears.

## 9. References

- [`control-plane.md`](./control-plane.md) — Coordinator vs WorkTracker contract.
- [`agent-routing.md`](./agent-routing.md) — dispatch routing and identity invariants.
- [`identity-boundaries.md`](./identity-boundaries.md) — `identity:work` vs `identity:personal` separation.
- [`integrations/hermes/SPEC.md`](../integrations/hermes/SPEC.md) — gateway routing (§7), no-double-spawn and tracker-backed idempotency keys (§5.5).
- [`design-routine-dispatch.md`](./design-routine-dispatch.md) — routine task graphs.
- `src/work_tracker.ts` — `config/work_tracker/<identity>` KV contract.
- Linear cluster: VUH-35 (this doc), VUH-36 (create/link), VUH-37 (status mirror), VUH-38 (completion comment).
