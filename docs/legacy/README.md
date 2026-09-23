# Legacy interface

The legacy interface is the original swarm-mcp design: one stdio MCP server per agent session, all of them sharing `~/.swarm-mcp/swarm.db` directly. Its tool families are `register`/`bootstrap`/`whoami`, `poll_messages`/`send_message`/`broadcast`, `lock_file`/`unlock_file`, `claim_task`/`request_task`/`request_task_batch`/`dispatch`, and the `kv_*` context store. Sessions are launched through the profile env files and shell launchers under `env/`, workers are spawned by the herdr and swarm-ui backends, and `apps/swarm-server` is the Rust daemon that reads the same database for desktop and mobile clients.

It is still shipped and unchanged because the live profile runs on it. It is retired under Linear issue VUH-1360, which happens only after that profile has moved to the v2 compact coordinator (`swarm_sync`, `swarm_find`, `swarm_assign`, `swarm_task`, `swarm_send`, `swarm_inbox`, `swarm_wait`, `swarm_context`, `swarm_evidence`). The documents in this directory describe the legacy interface accurately and will be deleted with it.

Moving an existing legacy profile to v2 is covered by [migration-cutover.md](../migration-cutover.md). New setups should not start here; use the v2 guide in [installation.md](../installation.md).

## Index

- [agent-routing.md](agent-routing.md): runtime-agnostic rules for agents joined to a swarm-mcp coordination fabric, starting with preferring registered swarm peers over native subagents.
- [backend-configuration.md](backend-configuration.md): where consumer configuration lives for `swarm-mcp`, workspace backends, spawners, and runtime integrations.
- [control-plane.md](control-plane.md): the modular agent workspace control plane for which `swarm-mcp` is the first coordination backend.
- [database-contracts.md](database-contracts.md): how `swarm.db` is bootstrapped from the SQL files in `sql/`, which writers exist, and how schema versions are checked.
- [design-batch-creation.md](design-batch-creation.md): shipped design of the atomic `request_task_batch` primitive (API shape, reference semantics, error handling, transactions).
- [design-routine-dispatch.md](design-routine-dispatch.md): unimplemented design for composing `request_task_batch` and `dispatch` into named, reusable multi-role routines.
- [getting-started.md](getting-started.md): local-clone development setup from a fresh clone to two sessions exchanging messages through the shared database.
- [identity-boundaries.md](identity-boundaries.md): separating workers from different isolation boundaries by launcher profile, config root, MCP server names, token storage, and swarm labels.
- [identity-boundary-audit.md](identity-boundary-audit.md): VUH-43 audit of the deployed launcher profiles, config roots, coordinator DB, herdr socket, and account-scoped MCP configs as of 2026-05-13.
- [identity-defense-in-depth.md](identity-defense-in-depth.md): process-internal fences layered on top of the identity boundary when several identities share one OS user account.
- [install.md](install.md): legacy `swarm-mcp init` setup and the host skill-copy locations.
- [linear-promotion-policy.md](linear-promotion-policy.md): historical v0 policy for the boundary between the swarm coordinator and the Linear work tracker; superseded by the packaged work-trackers reference.
- [quickstart.md](quickstart.md): fast path to two Claude Code sessions in the same repo seeing each other in about five minutes.
- [swarm-server.md](swarm-server.md): the Rust `swarm-server` daemon for the desktop and mobile control plane, separate from the TypeScript stdio MCP server.
- [swarm-rounds/2026-05-13-swarm-ios-r1.md](swarm-rounds/2026-05-13-swarm-ios-r1.md): event log of the 2026-05-13 swarm-ios r1 run (one planner plus six workers, about nine minutes).
