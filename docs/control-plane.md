# Agent workspace control plane

This repo is the reference implementation of a modular agent workspace control plane: a narrow waist that lets human interfaces, agent runtimes, workspace controllers, and work trackers interoperate without hard-coding each other.

`swarm-mcp` is the first coordination backend for that control plane. It is not the whole concept. The control-plane contract is the thing adapters should converge on.

## Goal

The target workflow is:

```text
operator intent
  -> durable work item
  -> coordinated agent task graph
  -> worker spawned in a controllable workspace
  -> edits protected by locks + review handoff
  -> result summarized back to the operator
  -> external tracker updated
```

The first concrete stack is:

| Contract | First implementation |
|---|---|
| Coordinator | `swarm-mcp` |
| Work tracker | Linear MCP |
| Agent runtimes | Claude Code, Codex, OpenCode, Hermes Agent |
| Workspace control | herdr |
| User gateway | Hermes Agent via Telegram / future iOS |
| Spawner | workspace backend spawn (`herdr` pane spawn today) |
| Identity bridge | swarm `instance_id` <-> workspace handle (`herdr` `pane_id` today) <-> Linear issue/task |

This stack is the golden path, not the boundary of the system.

Auth and account separation are part of the control plane. Each stack uses a free-form launcher profile, config root, and account-scoped MCP names as the tool visibility boundary; swarm identity labels provide routing and audit metadata. See [`identity-boundaries.md`](./identity-boundaries.md).

Consumer backend selection spans host MCP config, launcher profiles, spawner env, and workspace identity publication. See [`backend-configuration.md`](./backend-configuration.md) for the current herdr/swarm-ui setup and the intended future swarm-server switch shape.

## Narrow Waist

Every adapter should preserve these concepts even if the backing product changes:

| Concept | Purpose |
|---|---|
| Worker identity | Stable logical actor identity for task ownership, locks, messages, and audit. |
| Scope | Coordination boundary for a repo/project/workspace. |
| Task lifecycle | Durable work units with status, assignment, idempotency, dependencies, and result. |
| Locks | Short-lived ownership of files or synthetic resources with cleanup semantics. |
| Messages/events | Low-latency peer/user notifications and state-change subscriptions. |
| Workspace handles | Transport-local handles for panes, PTYs, sandboxes, or sessions. |
| Human route | Where to ask approvals and deliver summaries. |
| Audit trail | Enough structured history to reconstruct what changed, who did it, and why. |

The contracts below should reference those concepts, not specific products.

## Contracts

### Coordinator

Owns durable coordination state.

Required capabilities:

- Register and heartbeat worker instances.
- List live instances in a scope.
- Create idempotent tasks and task batches.
- Claim and update tasks atomically.
- Send direct and broadcast messages.
- Wait or subscribe to activity.
- Lock and unlock files or synthetic resources.
- Store small shared KV/context entries.

First implementation: `swarm-mcp` SQLite + MCP tools.

Possible future implementations: another coordination MCP, a server-backed swarm protocol, or a hybrid coordinator that uses a remote database.

### WorkTracker

Owns human-facing backlog and organizational memory.

Required capabilities:

- Create or link external issues.
- Mirror important task state and summaries.
- Store product-level priority and acceptance criteria.
- Keep noisy runtime coordination out of the human tracker.
- Accept worker-authored comments, evidence, links, and completion details when a task is linked to a human-facing issue.

First concrete target: a configured work tracker for the current repo/scope and identity, with Linear MCP as the initial work-profile target. The tracker provider is selected by config and identity boundary, not by whichever MCP happens to be loaded.

Boundary: Work trackers should not hold worker heartbeats, file locks, pane handles, or high-churn peer messages. Those belong in the Coordinator. Workers may update the configured same-identity tracker when they are publishing durable human-facing work state; they should not use Linear, Jira, GitHub Issues, or any other tracker as the live swarm bus.

### AgentRuntime

Owns agent execution and tool-call behavior.

Required capabilities:

- Join a Coordinator scope with an identity label.
- Receive task context and role instructions.
- Lock before writes and release/complete on terminal task status.
- Leave peer notes, handoffs, and wakeups through Coordinator-backed primitives.
- Update linked WorkTracker issues when the task contract grants that authority.
- Report useful status to an OperatorSurface when available.
- Preserve runtime-specific prompt/tool constraints.

First implementations: Claude Code, Codex, OpenCode, Hermes Agent.

Boundary: no agent runtime should be required for the control plane to make sense. Runtimes are workers behind the same coordination contract.

Worker authority is task-scoped, not role-name-scoped. A planner, implementer, reviewer, or researcher can wake a peer when coordination requires it, but the wakeup must target Coordinator identity and write durable Coordinator state first. Raw workspace input is reserved for WorkspaceControl/Spawner adapters and operator surfaces.

### WorkspaceControl

Owns visible execution surfaces and low-level process control.

Required capabilities:

- Create/list/focus/close workspaces and panes/sessions.
- Apply backend-agnostic layout intents such as grouped grids, balanced trees, and other visual arrangements without making durable coordination depend on transport-local handles.
- Spawn worker processes with injected Coordinator identity env.
- Read output snapshots and send input.
- Subscribe to lifecycle and status events.
- Eventually stream PTY output and resize for full remote terminal UX.

First implementation: herdr.

Boundary: Workspace handles such as `pane_id` are transport-local. Durable coordination must reference Coordinator `instance_id`, not a pane/session handle. Worker-safe wakeups may use WorkspaceControl as a transport only after the instruction is recorded in the Coordinator; workers should not target raw pane ids directly.

### Spawner

Owns turning spawn intent into a running worker. This is a contract, not necessarily a standalone service.

Required capabilities:

- Select an agent runtime and role.
- Create an execution surface in the requested scope.
- Place workers according to generic layout intent, such as `grid` or `balance`, while translating that intent through the selected WorkspaceControl backend.
- Inject `SWARM_MCP_INSTANCE_ID` or the equivalent coordinator identity.
- Detect adoption/registration.
- Deduplicate retries using task idempotency plus spawn mutexes.

First implementation: the `dispatch` path uses a registered spawner backend. The default backend invokes herdr workspace and pane APIs. herdr owns the actual PTY/process; swarm-mcp owns the durable task, spawn mutex, and adoption observation.

Spawn dedupe has two valid ownership models:

- **Requester-held mutex (current):** the requester/gateway creates an idempotent task, checks live workers, guards spawn with a synthetic Coordinator lock, invokes herdr, then explicitly releases the lock when the worker registers and claims/binds the task. This is the Hermes v0.4 path described in [`../integrations/hermes/SPEC.md §5.5`](../integrations/hermes/SPEC.md#55-no-double-spawn-invariant-gateway-fast-dispatch).
- **Coordinator-owned spawn request (future):** the Coordinator exposes a first-class `request_spawn` primitive and owns the spawn mutex server-side. This may be cleaner later, but it is not required for the first stack.

Boundary: the Spawner may call herdr, a cloud runner, SSH, or a sandbox provider, but it must report back through the Coordinator. Do not introduce a second PTY owner for the same worker; the first stack routes physical spawning through herdr. New terminal managers should implement the spawner/workspace backend contracts instead of adding product-specific branches to task, lock, message, or KV code.

### NotificationGateway

Owns user-facing conversation, approval, and summaries.

Required capabilities:

- Translate operator intent into structured work.
- Ask for missing requirements and approvals.
- Dispatch or monitor Coordinator tasks.
- Summarize results and failures in human language.
- Route notifications to Telegram, iOS push, Slack, CLI, or another channel.

First implementation: Hermes Agent gateway via Telegram.

Boundary: the gateway may read and plan inline, but writes should flow through Coordinator tasks by default. Inline writes require explicit trusted workspace configuration.

Single-intent dispatch is the gateway's default backend path, not a user-facing mode. When the operator says "fix this issue", the gateway should create/reuse the task, route or spawn a worker, and summarize without asking the operator to think about dispatch. The user-facing layer is routine dispatch: named commands or buttons that expand into multiple role-specific tasks, monitor them, and return one summary.

### IdentityBridge

Owns mapping between durable identities and transport handles.

Required capabilities:

- Map Coordinator `instance_id` to current workspace handle(s).
- Preserve labels and role metadata across spawn/adoption.
- Surface deep links or focus handles to operator UIs.
- Avoid treating short-lived handles as durable identities.

First implementation: swarm `instance_id` plus herdr `pane_id`, with labels such as `provider:claude role:implementer`.

Coordinator-facing APIs and docs should name the generic concept: workspace
backend plus transport handle. The first backend is `herdr` and the first
handle kind is `pane`, but core coordination should expose names like
`resolve_workspace_handle` and KV rows like
`identity/workspace/herdr/<instance_id>`. Herdr-specific rows such as
`identity/herdr/<instance_id>` are compatibility details for current adapters,
not the shape new contracts should copy.

## Golden Path

The first stack should prove this end-to-end loop:

1. Operator sends a request to Hermes from Telegram or iOS.
2. Hermes creates or links an issue in the configured same-identity work tracker when the work should be human-trackable.
3. Hermes calls the Coordinator to create an idempotent swarm task.
4. If no worker is available, the gateway follows the Spawner contract: it applies spawn dedupe, then invokes herdr to create a worker pane with injected Coordinator identity.
5. The WorkspaceControl backend applies any requested placement/layout intent, such as a grouped 2x3 grid, without changing the durable task contract.
6. Worker registers/adopts, claims the task, and reports status.
7. Worker edits through runtime hooks for ordinary writes and uses Coordinator locks for wider critical sections.
8. Worker coordinates with peers through Coordinator messages, tasks, locks, KV, and coordinator-first wakeups when needed.
9. Worker updates linked tracker issues with human-facing evidence, comments, links, or completion details when the assigned contract grants that authority and the configured same-identity MCP is available.
10. Worker completes the task with structured result and test status.
11. Reviewer worker or gateway validates the result when needed.
12. Hermes summarizes back to the operator.
13. The configured work tracker is updated with the durable human-facing outcome if no worker already published the right tracker update.

This is the first integration target. New abstractions should be justified by making this loop more reliable, not by theoretical swapability.

## Design Rules

- Build one real stack first; keep seams generic enough to swap later.
- Put product-specific behavior under `integrations/` or adapter packages.
- Keep high-churn runtime state out of work trackers.
- Keep transport-local handles out of durable task/lock/message state.
- Give workers the capabilities they need, but route them through the right source of truth: swarm for live coordination, the configured same-identity tracker for human-facing work records, herdr for transport.
- Express visual workspace needs as generic placement/layout intent in the Spawner/WorkspaceControl contract; let the backend translate to `herdr tab grid` or an equivalent surface command.
- Treat `swarm-mcp` as the reference Coordinator, not as an assumption every adapter must hard-code.
- Prefer explicit adapter contracts over hidden cross-imports; terminal/process control belongs in workspace or spawner backends, not in the coordination primitives.
- Do not invent a generic framework layer until the concrete implementation creates pressure for it.

## Current Workstreams

| Workstream | Purpose |
|---|---|
| Hermes integration | AgentRuntime + NotificationGateway behavior for auto-register, locking, gateway mode, and summaries. |
| herdr integration | WorkspaceControl + Spawner behavior for panes, status, mobile bridge, and worker adoption. |
| WorkTracker integration | Configured same-identity tracker bridge for issues, priorities, acceptance criteria, and result updates; Linear is the initial concrete target. |
| iOS/herdr bridge | Remote OperatorSurface using herdr as the universal workspace owner. |
| Coordinator hardening | Task idempotency, spawn mutexes, lock cleanup, events, and exact lock lookup APIs. |

## Non-Goals For Now

- A fully generic plugin marketplace.
- Replacing Linear, herdr, Hermes, and every agent runtime before the first stack works.
- Routing all transient runtime events through human trackers.
- Requiring every future coordinator to mimic `swarm-mcp` internals exactly.

## Open Questions

- Which control-plane contract deserves the first stable interface package?
- Should spawn/adoption become a first-class Coordinator primitive instead of adapter convention?
- Should spawn/adoption mutexes become dedicated Coordinator resources instead of synthetic file locks?
- Which cross-adapter configuration belongs in repo config, user profile, launcher env, or Coordinator KV after the current [`backend-configuration.md`](./backend-configuration.md) split hardens?
- What is the minimum remote herdr bridge needed before the iOS app feels useful?
