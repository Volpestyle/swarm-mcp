# Agent routing for swarm-mcp coordination

Runtime-agnostic core for any agent (Hermes, Claude Code, Codex, OpenCode, …) joined to a swarm-mcp coordination fabric. Each runtime carries a thin adapter layer in its own config file (Hermes `SOUL.md`, Claude Code `CLAUDE.md`, etc.) naming its native subagent tool and any plugin-shipped tools. This doc covers what is shared.

For the integration plugin contract per runtime, see [`../integrations/<runtime>/SPEC.md`](../integrations/). For launcher / config-root / MCP-suffix identity conventions, see [`./identity-boundaries.md`](./identity-boundaries.md). For role doctrine (planner / implementer / reviewer / researcher / generalist flows), load the bundled `swarm-mcp` skill.

## Prefer swarm peers over native subagents

For non-trivial coding work, prefer a swarm peer over your runtime's native subagent mechanism whenever a suitable peer is registered.

Decision flow on session start:

1. Call the swarm `list_instances` and `list_tasks` MCP tools early — before deciding how to execute.
2. **Matching peer present** (compatible `scope`, useful `role:<implementer|reviewer|researcher>`, matching `identity:<work|personal>`) → delegate via `request_task` with a concrete patch + success criterion. To wake an idle peer in its herdr pane, send the durable swarm message via `send_message` first; the pane nudge (the plugin tool `swarm_prompt_peer` if your runtime exposes it, else direct `herdr pane run` if you have that capability) is best-effort and never carries the work contract itself.
3. **No matching peer** → fall back to your runtime's native subagent mechanism, or do the work yourself.

Why peers when available: independent processes — possibly different harnesses (Codex, OpenCode, Claude, Hermes) or a different identity profile carrying account-scoped MCP auth your session can't reach. Their tasks are durable across sessions; native subagents typically share your process and die with the parent turn or session. The integration plugin's lock bridge already handles write-collision protection automatically across runtimes.

Do not delegate when: you are the only registered instance, the round-trip cost beats just doing it, or the user explicitly asked you to do the work yourself.

## SPEC invariants (do not violate)

These come from the swarm-mcp design contract and apply to every runtime.

- Tasks, messages, and locks **always** target swarm `instance_id`, never herdr `pane_id`. Pane IDs recompact when other panes close, so a captured reference can become stale or wrong. Translate to **labels** ("implementer-bob in pane 1-3") for user-facing summaries — never present raw IDs.
- Coordination is **fail-open**: if swarm-mcp is unreachable, work locally — don't loop on a failed `register`. The exception is a real peer-held lock conflict, which the integration plugin surfaces as a tool error and you must respect.
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
| Claude Code | [`integrations/claude-code/`](../integrations/claude-code/) | v0.1 | `SessionStart` register-priming, lock bridge, `/swarm`, herdr identity hint via `additionalContext` |
| Codex CLI | [`integrations/codex/plugins/swarm/`](../integrations/codex/plugins/swarm/) | v0.1 | `SessionStart` register-priming, `apply_patch` lock bridge, `/swarm`, herdr identity hint via `additionalContext` |
| OpenCode / others | none yet | — | Participate ad-hoc via the swarm-mcp skill + MCP tools |

The Claude Code and Codex plugins share their runtime-agnostic core in [`integrations/_shared/swarm_hook_core.py`](../integrations/_shared/swarm_hook_core.py); each plugin's `_common.py` only carries the runtime-specific bits (write-tool name, path extractor, env-var prefix, label token).

Runtimes without a dedicated plugin still participate fully — they just have to call `register`, `lock_file`, `unlock_file`, etc. explicitly rather than getting them via lifecycle hooks.
