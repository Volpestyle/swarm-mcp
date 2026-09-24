# Claude Code integration

The [trusted launcher](../../docs/runtime-embedding.md) supplies per-session
identity, MCP configuration and native lifecycle/delivery hooks. The
[specification](SPEC.md) describes its contract and installed-host evidence.

The optional write hooks in this directory add cooperative write reservations for
`Write`, `Edit`, `MultiEdit` and `NotebookEdit`. Its pre-hook acquires the complete
write set; its post-hook releases the exact grants. Configure it only for an
enrolled runtime with `SWARM_COORDINATOR_CLIENT`, `SWARM_COORDINATOR_ENDPOINT`,
`SWARM_SESSION_CAPABILITY` and the launcher's native-session binding. Missing
bindings and failed reservations deny known writes.

The hooks and `integrations/_shared` must retain their relative layout in a
checkout. No registration CLI, shared identity file or role-based authority is
involved. See [reservation boundaries](../../docs/worktree-reservations.md) for
coverage limits and the [consumer skill](../../skills/swarm-mcp/SKILL.md) for
agent-facing guidance.
