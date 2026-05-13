# Agent routing for swarm-mcp coordination

Runtime-agnostic core for any agent (Hermes, Claude Code, Codex, OpenCode, …) joined to a swarm-mcp coordination fabric. Each runtime carries a thin adapter layer in a repo-owned runtime prompt (`integrations/*/SOUL.md`) or equivalent host config naming its native subagent tool and any plugin-shipped tools. This doc covers what is shared.

For the integration plugin contract per runtime, see [`../integrations/<runtime>/SPEC.md`](../integrations/). For launcher / config-root / MCP-suffix identity conventions, see [`./identity-boundaries.md`](./identity-boundaries.md). For role doctrine (planner / implementer / reviewer / researcher / generalist flows), load the bundled `swarm-mcp` skill.

## Prefer swarm peers over native subagents

For non-trivial coding work, prefer a swarm peer over your runtime's native subagent mechanism whenever a suitable peer is registered.

Decision flow on session start:

1. Call the swarm `bootstrap` MCP tool early, before deciding how to execute. Use focused reads such as `list_instances` and `list_tasks` only when you need a narrower refresh.
2. **Matching peer present** (compatible `scope`, useful `role:<implementer|reviewer|researcher>`, matching `identity:<work|personal>`) → delegate via `request_task` with a concrete patch + success criterion. To wake an idle peer through its published workspace handle, send the durable swarm message via `send_message` first; the handle nudge (the plugin tool `swarm_prompt_peer` if your runtime exposes it, else a backend-specific command such as `herdr pane run` if you have that capability) is best-effort and never carries the work contract itself.
3. **Gateway/lead mode and no matching peer** (`mode:gateway`) → for trivial, low-risk edits, work locally. For medium or large implementation work, use the swarm MCP `dispatch` tool. It creates or reuses a swarm task, wakes an exact-role or generalist live worker when one exists, or spawns through the configured Spawner backend (`herdr` for the current golden path). If no spawner surface is available for non-trivial work, ask the operator to start a worker instead of silently using native subagents. The CLI `dispatch` bridge is only for hooks, wrappers, operator shells, or sessions where MCP tools are unavailable.
4. **Worker/generalist mode and no matching peer** → fall back to your runtime's native subagent mechanism, or do the work yourself when that is faster and safe.

For gateway sessions, `dispatch` is the invisible default path for a single operator intent, not something the operator should usually request by name. User-facing slash commands belong one level up: a routine command expands into multiple role-specific tasks, then uses the same routing/wake/spawn machinery for each part.

Why peers when available: independent processes — possibly different harnesses (Codex, OpenCode, Claude, Hermes) or a different identity profile carrying account-scoped MCP auth your session can't reach. Their tasks are durable across sessions; native subagents typically share your process and die with the parent turn or session. The integration plugin's peer-lock check enforces peer-declared critical sections automatically across runtimes — when one peer manually calls `lock_file` to reserve a wider critical section, other peers' write tools are denied at the hook layer without their agents having to remember to check.

Do not use native subagents as the normal gateway fallback. Gateway mode exists to keep non-trivial worker execution visible as separate workspace/swarm peers. Inline gateway edits are acceptable for easy, low-risk tasks where spinning up a worker would add more overhead than value; medium or large work should route through `dispatch` and the configured workspace/spawner backend.

The split between MCP and CLI is deliberate. MCP owns the agent-facing
coordination surface: tasks, messages, locks, KV, notifications, and gateway
`dispatch`. Spawning a new worker crosses into WorkspaceControl/Spawner
territory: it creates a PTY or pane, chooses a launcher/config root, and injects
adoption environment. That action should stay visible to the operator and
should be available only to gateway/lead sessions or operator surfaces.
Ordinary workers must not call `dispatch`, `ui spawn`, or raw workspace backend
creation unless explicitly instructed. The MCP and CLI dispatch paths reject
identified callers whose swarm label does not include `mode:gateway`; a trusted
operator shell can bypass that accidental-use guard with
`SWARM_MCP_ALLOW_SPAWN=1`.

## SPEC invariants (do not violate)

These come from the swarm-mcp design contract and apply to every runtime.

- Tasks, messages, and locks **always** target swarm `instance_id`, never workspace transport handles such as herdr `pane_id`. Pane IDs recompact when other panes close, so a captured reference can become stale or wrong. Translate to **labels** ("implementer-bob in pane 1-3") for user-facing summaries — never present raw IDs.
- When a user refers to a visible workspace relationship such as "the pane next to you", resolve it in two steps: use the workspace backend to identify the adjacent transport handle, then call `resolve_workspace_handle` or `swarm-mcp resolve-workspace-handle <handle> --backend <backend>` to map that handle back to a swarm `instance_id`. Send durable messages/tasks to the swarm instance, not directly to the handle.
- Published workspace identity rows should use `identity/workspace/<backend>/<instance_id>` with a canonical `handle` from the backend. Backend adapters may keep compatibility rows such as `identity/herdr/<instance_id>`, but swarm-facing docs and APIs should use the generic workspace-handle terminology.
- Coordination is **fail-open** for ordinary worker sessions: if swarm-mcp is unreachable, work locally — don't loop on a failed `register`. Gateway/lead sessions may also handle trivial local edits directly, but should not convert medium or large work into local implementation just because the coordinator or spawner is unavailable. A real peer-held lock conflict is always blocking and must be respected.
- `wait_for_activity` is a blocking monitor primitive for active responsibility, not idle availability. It does not type into another agent's conversation by itself. Wake-up of an idle peer goes through the durable swarm message first; the workspace-handle nudge is best-effort.
- Per-edit locking is not the agent's job. The integration plugin's pre-tool hook checks for peer-held locks on each write and denies on conflict; it never acquires on the agent's behalf. Solo sessions short-circuit naturally — no peer means no peer-held locks to find. Manual `lock_file` is reserved for declaring critical sections wider than a single write tool call (multi-step Read→Edit, multi-file refactors, planned reservations).
- Worker mode is the default. Gateway-mode protocol (local edits for easy tasks, `dispatch` for medium/large work, no-double-spawn idempotency) applies only when the runtime is explicitly configured as a gateway — see the integration SPEC for your runtime.
- Delegation across the identity boundary is forbidden. Don't `request_task` across `identity:work` ↔ `identity:personal`. If a task needs cross-identity resources, surface that to the user — let them relaunch under the right launcher or hand off.

## Identity and account-scoped resources

Your profile may or may not have direct MCP servers for account-scoped resources (Linear, Figma, Atlassian / Jira, Datadog, etc.). If a resource is needed and the matching MCP isn't loaded in your tool surface, route through swarm: `request_task` to a peer whose launcher / config root owns the relevant MCP auth, with the resource URL in the task body and the expected MCP surface named explicitly.

Work tracker selection is config-driven. Runtime hooks publish the configured tracker to `config/work_tracker/<identity>` and `bootstrap` returns it when present. Use that tracker for the repo/scope and `identity:<work|personal>` boundary, then verify that the matching MCP is available. Do not substitute a different tracker just because that MCP is loaded.

The runtime-specific config file enumerates which MCPs your profile actually loads. The general identity rules (work vs personal, launcher binaries, MCP suffix conventions) live in [`./identity-boundaries.md`](./identity-boundaries.md).

## Plugin status by runtime

| Runtime | Plugin | Status | Capabilities |
|---|---|---|---|
| Hermes | [`integrations/hermes/`](../integrations/hermes/) | v0.3 | Auto-register / -deregister, peer-lock check on write, `/swarm`, `swarm_prompt_peer` express lane, herdr identity publish |
| Claude Code | [`integrations/claude-code/`](../integrations/claude-code/) | v0.2 | Auto-register / -deregister, peer-lock check on write, `/swarm`, herdr identity publish, gateway conductor mode via `SWARM_CC_ROLE=gateway` |
| Codex CLI | [`integrations/codex/plugins/swarm/`](../integrations/codex/plugins/swarm/) | v0.2 | Auto-register / -deregister, peer-lock check on `apply_patch`, `/swarm`, herdr identity publish, gateway conductor mode via `SWARM_CODEX_ROLE=gateway` |
| OpenCode / others | none yet | — | Participate ad-hoc via the swarm-mcp skill + MCP tools |

The Claude Code and Codex plugins share their runtime-agnostic core in [`integrations/_shared/swarm_hook_core.py`](../integrations/_shared/swarm_hook_core.py); each plugin's `_common.py` only carries the runtime-specific bits (write-tool name, path extractor, env-var prefix, label token).

Gateway-capable Claude Code and Codex lead aliases should surface both pieces
of state: `mode:gateway` for behavior and `role:planner` for routing. The
planner label lets workers discover the lead; the gateway mode tells the lead
to keep easy edits local while routing medium/large work through the conductor path.

Runtimes without a dedicated plugin still participate fully — they just have to call `register`, `lock_file`, `unlock_file`, etc. explicitly rather than getting them via lifecycle hooks.
