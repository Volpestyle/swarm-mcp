# Codex write reservations

These optional write hooks reserve `apply_patch` source and destination paths through
an enrolled coordinator. They require the same endpoint, capability and argv JSON
client binding as the [shared reservation integration](../../docs/worktree-reservations.md).
Keep `integrations/_shared` and these hooks in their checkout-relative layout.
They do not enroll sessions, dispatch workers or supply model-turn delivery.

Use the [native adapter specification](SPEC.md) and
[host support matrix](../../docs/runtime-host-support.md) for the trusted
app-server resume/lifecycle path and its limitations. Agent guidance lives in the
[consumer skill](../../skills/swarm-mcp/SKILL.md).
