# Agent routing for swarm-mcp coordination

Runtime-agnostic core for any agent (Hermes, Claude Code, Codex, OpenCode, …) joined to a swarm-mcp coordination fabric. Each runtime carries a thin adapter layer in its own config file (Hermes `SOUL.md`, Claude Code `CLAUDE.md`, etc.) naming its native subagent tool and any plugin-shipped tools. This doc covers what is shared.

For the integration plugin contract per runtime, see [`../integrations/<runtime>/SPEC.md`](../integrations/). For launcher / config-root / MCP-suffix identity conventions, see [`./identity-boundaries.md`](./identity-boundaries.md). For role doctrine (planner / implementer / reviewer / researcher / generalist flows), load the bundled `swarm-mcp` skill.

## Prefer swarm peers over native subagents

For non-trivial coding work, prefer a swarm peer over your runtime's native subagent mechanism whenever a suitable peer is registered.

Decision flow on session start:

1. Call the swarm `list_instances` and `list_tasks` MCP tools early — before deciding how to execute.
2. **Matching peer present** (compatible `scope`, useful `role:<implementer|reviewer|researcher>`, matching `identity:<work|personal>`) → delegate via `request_task` with a concrete patch + success criterion. To wake an idle peer in its herdr pane, send the durable swarm message via `send_message` first; the pane nudge (the plugin tool `swarm_prompt_peer` if your runtime exposes it, else direct `herdr pane run` if you have that capability) is best-effort and never carries the work contract itself.
3. **Gateway/lead mode and no matching peer** (`mode:gateway`) → use the swarm MCP `dispatch` tool. It creates or reuses a swarm task, wakes an exact-role or generalist live worker when one exists, or spawns through the configured Spawner backend (`herdr` for the current golden path). If no spawner surface is available, ask the operator to start a worker instead of silently using native subagents. The CLI `dispatch` bridge is only for hooks, wrappers, operator shells, or sessions where MCP tools are unavailable.
4. **Worker/generalist mode and no matching peer** → fall back to your runtime's native subagent mechanism, or do the work yourself when that is faster and safe.

Why peers when available: independent processes — possibly different harnesses (Codex, OpenCode, Claude, Hermes) or a different identity profile carrying account-scoped MCP auth your session can't reach. Their tasks are durable across sessions; native subagents typically share your process and die with the parent turn or session. The integration plugin's lock bridge already handles write-collision protection automatically across runtimes.

Do not use native subagents as the normal gateway fallback. Gateway mode exists to keep worker execution visible as separate herdr/swarm peers. Inline work or native subagents are only acceptable when the operator explicitly asks for it, or when the runtime is not in gateway mode and the local tradeoff is clearly better.

The split between MCP and CLI is deliberate. MCP owns the agent-facing
coordination surface: tasks, messages, locks, KV, notifications, and gateway
`dispatch`. Spawning a new worker crosses into WorkspaceControl/Spawner
territory: it creates a PTY or pane, chooses a launcher/config root, and injects
adoption environment. That action should stay visible to the operator and
should be available only to gateway/lead sessions or operator surfaces.
Ordinary workers must not call `dispatch`, `ui spawn`, or raw herdr pane
creation unless explicitly instructed. The MCP and CLI dispatch paths reject
identified callers whose swarm label does not include `mode:gateway`; a trusted
operator shell can bypass that accidental-use guard with
`SWARM_MCP_ALLOW_SPAWN=1`.

## SPEC invariants (do not violate)

These come from the swarm-mcp design contract and apply to every runtime.

- Tasks, messages, and locks **always** target swarm `instance_id`, never herdr `pane_id`. Pane IDs recompact when other panes close, so a captured reference can become stale or wrong. Translate to **labels** ("implementer-bob in pane 1-3") for user-facing summaries — never present raw IDs.
- Coordination is **fail-open** for ordinary worker sessions: if swarm-mcp is unreachable, work locally — don't loop on a failed `register`. Gateway/lead sessions are different: they may keep planning and asking the operator, but should not convert a write intent into local implementation just because the coordinator or spawner is unavailable. A real peer-held lock conflict is always blocking and must be respected.
- `wait_for_activity` is the warm-worker idle loop. It does not type into another agent's conversation by itself. Wake-up of an idle peer goes through the durable swarm message first; the pane nudge is best-effort.
- Solo session (only one registered instance in scope): the integration plugin skips per-edit locking automatically. Don't ceremoniously add locks when no peer can collide.
- Worker mode is the default. Gateway-mode protocol (delegated writes by default, three-tier write routing, no-double-spawn idempotency) applies only when the runtime is explicitly configured as a gateway — see the integration SPEC for your runtime.
- Delegation across the identity boundary is forbidden. Don't `request_task` across `identity:work` ↔ `identity:personal`. If a task needs cross-identity resources, surface that to the user — let them relaunch under the right launcher or hand off.

## Identity and account-scoped resources

Your profile may or may not have direct MCP servers for account-scoped resources (Linear, Figma, Atlassian / Jira, Datadog, etc.). If a resource is needed and the matching MCP isn't loaded in your tool surface, route through swarm: `request_task` to a peer whose launcher / config root owns the relevant MCP auth, with the resource URL in the task body and the expected MCP surface named explicitly.

The runtime-specific config file enumerates which MCPs your profile actually loads. The general identity rules (work vs personal, launcher binaries, MCP suffix conventions) live in [`./identity-boundaries.md`](./identity-boundaries.md).

## Plugin status by runtime

| Runtime | Plugin | Status | Capabilities |
|---|---|---|---|
| Hermes | [`integrations/hermes/`](../integrations/hermes/) | v0.3 | Auto-register / -deregister, lock bridge, `/swarm`, `swarm_prompt_peer` express lane, herdr identity publish |
| Claude Code | [`integrations/claude-code/`](../integrations/claude-code/) | v0.2 | Auto-register / -deregister, lock bridge, `/swarm`, herdr identity publish, gateway conductor mode via `SWARM_CC_ROLE=gateway` |
| Codex CLI | [`integrations/codex/plugins/swarm/`](../integrations/codex/plugins/swarm/) | v0.2 | Auto-register / -deregister, `apply_patch` lock bridge, `/swarm`, herdr identity publish, gateway conductor mode via `SWARM_CODEX_ROLE=gateway` |
| OpenCode / others | none yet | — | Participate ad-hoc via the swarm-mcp skill + MCP tools |

The Claude Code and Codex plugins share their runtime-agnostic core in [`integrations/_shared/swarm_hook_core.py`](../integrations/_shared/swarm_hook_core.py); each plugin's `_common.py` only carries the runtime-specific bits (write-tool name, path extractor, env-var prefix, label token).

Gateway-capable Claude Code and Codex lead aliases should surface both pieces
of state: `mode:gateway` for behavior and `role:planner` for routing. The
planner label lets workers discover the lead; the gateway mode tells the lead
to delegate writes by default and follow the conductor path.

Runtimes without a dedicated plugin still participate fully — they just have to call `register`, `lock_file`, `unlock_file`, etc. explicitly rather than getting them via lifecycle hooks.
