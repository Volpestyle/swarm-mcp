# Swarm MCP v2 coordination redesign — review candidate

Legacy coordination could consume messages before processing, delete unread
inboxes and mistake process presence for valid ownership. This candidate uses
one transactional local owner with explicit acknowledgment, replay and fenced
task attempts. Thin MCP/runtime adapters provide nine tools and route authorized
work to native children or independent peers without duplicating uncertain starts.

The candidate upgrades the serving interface to MCP SDK 2.0.0 / protocol
2026-07-28 with tested legacy compatibility. It includes worktree reservations,
retained evidence/context, scoped diagnostics, runtime lifecycle adapters and a
reversible legacy import. Unfinished imported work requires reconciliation; old
leases never become new authority. Package `2.0.0-rc.1` includes frozen production
dependencies, production-only files, version-aware startup and matching skill guidance.

Validation: [release evidence](verification/2026-09-22-rollout/README.md) records
173 TypeScript tests / 1,457 assertions, 48 Python tests, typecheck/build, a clean
packed install with real MCP send/fetch/ack, and an isolated restart/recovery/
rollback canary. Current context capture stays within the selected catalog budget.
Prior latency, failure, host and memory evidence remains linked from the project
acceptance docs; it is not represented as newly rerun at every documentation commit.

Review boundaries: OpenCode and
Claude have the documented installed-host support; Codex automatic delivery and
actual Hermes-host behavior remain degraded/unverified. Rollback requires explicit
reconciliation of post-snapshot side effects. No live installation was changed.

Destination: `Volpestyle/swarm-mcp`, branch `redesign/coordination-core`,
target `main`. The repository was unarchived and the branch pushed on
2026-09-23; draft PR [#9](https://github.com/Volpestyle/swarm-mcp/pull/9) carries
this description and a passing Windows/Ubuntu gate
([evidence](verification/2026-09-23-hosted-ci/README.md)). Merging, npm
publication and live profile activation remain separate decisions.
