# VUH-1339 acceptance audit

Audit date: 2026-09-22. Candidate source: `82375ab` plus this documentation
reconciliation. Installed-host captures below are retained results inspected in
this audit, not newly rerun host probes. The relevant Claude/OpenCode production
paths have not changed since those captures. The focused regression run is fresh:
31 tests, 215 assertions, zero failures across 17 runtime integration files.
The shared Python/Hermes regression run also passes all 48 tests.

| Requirement | Evidence and result |
| --- | --- |
| Lifecycle, capabilities, safe boundaries, recovery and acknowledgment contract | [Runtime contract](runtime-delivery.md), `enrollRuntime`, `RuntimeDelivery`, host adapters and [support matrix](runtime-host-support.md). Launcher regression verifies private state, replay, stable identity and fenced resume. |
| Validate existing host integrations; include OpenCode and declare unsupported paths | OpenCode 1.4.3 V1 plugin and pinned SDK are implemented. Claude 2.1.278 launcher/hooks/native MCP are exercised. Codex 0.155.1 existing hook configuration, native MCP, resume, lifecycle and context transport are exercised, but automatic delivery remains degraded. Hermes lifecycle code has 23 passing Python tests; an actual executable was unavailable in the inspected environment, so no installed-host claim is made. |
| Persist before waking; failed wake preserves work | Real-store runtime tests verify pending-recipient authorization before wake and retained work after failure. OpenCode wake tests cover uncertain admission with and without a persisted native prompt. |
| Supported boundaries, coalescing, no active-tool interruption or duplicate instructions | [OpenCode autonomous lease capture](verification/2026-09-22-runtime/opencode-autonomous-lease.json): busy deferral, model waits for shell, turn-start and post-tool context, retained-context renewal. [Claude native MCP capture](verification/2026-09-22-runtime/claude-mcp.json): native boundary delivery and explicit MCP ack. Duplicate hints and concurrent boundaries are covered by fresh tests. |
| Availability separate from process liveness | Contract names five states and their evidence. OpenCode installed-host permission/reconnect captures and fresh state tests establish blocked/busy/idle handling. Codex native lifecycle capture verifies archive revocation; unavailable paths defer. |
| Bounded polling/backoff; no model idle loop | OpenCode uses subscribed host/inbox events, held coordinator watches and deadline timers for TTL/lease/backoff. Observer tests prove bounded retry and stop cancellation. Autonomous lease capture records six model requests for actual work, with no fixture recovery prompt. |
| Delivery does not spawn agents | Runtime delivery interface exposes boundary admission and existing-session wake only. OpenCode wake calls `session.promptAsync` with the bound session ID, not session creation. Launcher owner startup starts the coordinator process, not another agent. |
| Two hosts end-to-end plus unavailable hooks, busy peers, restart, duplicates and backlog | Claude and OpenCode captures above establish actual host delivery/ack. [Claude forced-kill/native-resume capture](verification/2026-09-22-runtime/claude-restart.json) verifies stable actor, generation 1→2, stale capability rejection, one retained-context renewal and one replay for context not persisted before kill. Fresh runtime tests cover unsupported boundaries, concurrent/duplicate hints and backlog; inbox observer test covers a real coordinator restart. |

## Limits retained after acceptance

Acceptance does not claim identical capabilities across hosts. Codex automatic
initial enrollment/delivery and Hermes installed-host operation are degraded;
Claude delivers at native boundaries and has no idle wake. OpenCode's uncertain
absent wake intent is retained without an unsafe repeat POST. Killed OpenCode
delivery, unusually large installed-host histories, and Codex rewritten-history
reconstruction are not proven. These are explicit support limits, not claims of
message acknowledgment, exactly-once effects or successful recovery.

VUH-1342 still owns the broader concurrency/crash/protocol gate, VUH-1343 the
benchmarks, and VUH-1344 installation/skill migration, canary, rollback and release
destination. No live install, archived-remote change or publication is implied.

Reproduce the focused regression run:

```powershell
bun test coordination-runtime-delivery coordination-runtime-launcher coordination-inbox-observer coordination-inbox-backlog coordination-opencode coordination-claude coordination-codex
```
