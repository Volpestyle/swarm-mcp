# Execution routing (VUH-1340, implementation in progress)

Use the lowest-overhead authorized execution path that satisfies the task's
requirements. Native runtime messaging is sufficient when its host, workspace,
lifetime and capabilities fit. Use an independent peer when those requirements
need a different host, workspace or durable lifetime. Neither path has an
unconditional preference.

`selectExecutionRoute` evaluates trusted launcher/runtime declarations against
scope, canonical worktree, optional host, required capabilities, durable lifetime,
fresh idle evidence and per-route/global concurrency budgets. Role labels confer
neither capabilities nor authority. A missing capability remains an explicit
blocker; selection never creates an agent or changes the task contract.

Selection is currently advisory. Atomic dispatch intent/capacity reservation,
task binding, provisioning reconciliation and native completion integration are
still required before this can execute work. Do not treat a selected candidate
as an accepted owner; only the coordinator's fenced task attempt establishes that.

Schema 9 adds `dispatch_intents`. The trusted write transaction reserves an
intent and creates its task atomically. Scope-wide intent identity spans requesting
agents; changed work under the same intent is rejected. Capacity includes all
unreleased intents, so another gateway or a reopened coordinator cannot reserve
the same slot. The policy comes from trusted adapter configuration, outside the
model command payload. This primitive is not yet exposed through the agent API.

Reservations do not expire into permission to provision again. A crash may leave
an unresolved intent; later provisioning reconciliation must prove the external
outcome before releasing or retrying it. External provisioning adapters, release
and cancellation still need implementation. The reservation itself never launches
a process or reports a worker as accepted.

Schema 10 records a provisioning token before external effects. `begin` advances
reserved → provisioning once; another command or restarted caller receives the
same token with `start: false`. The caller must also honor the command receipt's
`replayed` flag: replaying a cached `start: true` result is not new permission to
provision. Uncertain outcomes require lookup by this token, not another spawn.

The launcher's verified result binds route, token, external identity and an active
same-scope worker session in one transaction. Binding claims the task for that
worker with the existing attempt/fence mechanism; a duplicate result returns the
same attempt, and another worker is rejected. Ordinary task claims cannot bypass
an unreleased dispatch reservation. Native completion uses the same worker-bound
`task.finish` command and stable command ID, not a parallel legacy task record.

The dispatch regression runs two independent Node processes against one database.
Exactly one creates a reservation/task; both receive the same task ID. Reopening
the store retains that reservation and capacity, rejects different work with the
same intent, and blocks an additional intent at the configured concurrency limit.
The same processes race provisioning start: one wins, both see one token, and a
reopened caller reconciles. Binding/finish tests prove one attempt, reject another
worker's completion and replay the accepted result without a second completion.

## Legacy implementation audit

The referenced historical tickets are inputs, not execution dependencies:

| Source | Finding |
| --- | --- |
| VUH-12 / `src/tasks.ts` | Legacy task `idempotency_key` deduplicates retries. Its S7 layer-1 assertion passes on this machine. Preserve stable intent identity in the new task/dispatch path. |
| VUH-13 / `src/dispatch.ts` | Existing dispatch checks a synthetic spawn lock before acquiring an exclusive lock, creates the task before spawning and reconciles the spawned instance. Both S7 race cases currently fail at the gateway authorization check on Windows, before spawn. They do not establish no-double-spawn here. |
| VUH-16 / Hermes | No `subagent_stop` bridge was found in the inspected Python integration. Native completion must use the coordinator's current attempt/fence, rather than a second legacy task assignment. |
| VUH-27 | First-class spawn intent was proposed but remains a historical Backlog item. The redesign needs a durable dispatch intent instead of using file-reservation paths as spawn state. |

Legacy dispatch selects workers through role/generalist labels and accepts a
gateway label as authority. These are not suitable sources of trusted routing
capabilities or launch authorization in the redesign. Keep legacy compatibility
separate from the new control plane.

Fresh validation: two routing tests / nine assertions and TypeScript pass.
The legacy S7 run is one pass / two failures; no physical agent was spawned
(the fixture uses a counting fake spawner).
