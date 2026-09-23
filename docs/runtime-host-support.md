# Runtime host support

The trusted runtime launchers and plugins support the hosts below. The matrix
records evidence boundaries, not permanent claims about capabilities missing
from a host. Installed-host captures use scripted localhost model endpoints;
they prove host execution and context assembly, not model comprehension.
Captures live in `docs/verification/2026-09-22-runtime/`; integration specs
name their reproduction commands and remaining work. Codex lifecycle-only
captures make no model requests; its context-delivery capture uses a scripted
localhost Responses endpoint.

## Support matrix

| Host | Version | Verified paths | Limitations |
| --- | --- | --- | --- |
| OpenCode | 1.4.3 | Installed-host lifecycle/restart, busy/blocked gating, post-tool and autonomous idle-turn delivery, explicit ack, retained-context deduplication and autonomous metadata-only refresh after real lease expiry | Killed/resumed-host delivery, uncertain wake recovery and large-history enrollment are not proven |
| Claude Code | 2.1.278 | Trusted-launcher hook/MCP binding, installed-host turn-start/post-tool delivery and native MCP ack, session-end closure, transcript-based deduplication, real lease expiry and forced-kill/native-resume recovery from a saved transcript | Legacy-plugin operation and recovery before the first saved transcript are not proven; delivery only at native boundaries, no idle wake implementation |
| Codex | 0.155.1 | Native MCP isolation; composed resume/lifecycle observation and archive revocation; owner-driven model-context delivery and retained-context lease renewal | Initial enrollment, autonomous delivery and rewritten-history recovery are unverified. Fixture hooks are untrusted. Automatic integration is degraded |
| Hermes | (no executable inspected) | Existing in-process lifecycle implementation inspected; 23 Python lifecycle tests pass | No `hermes` executable on the inspected PATH or `hermes_cli` module in the inspected Python. Actual-host delivery is unverified |

Codex's two-thread probe also verifies distinct per-thread MCP credentials in one
app server: the second actor cannot fetch the first actor's message, and its
configuration does not replace the first actor's binding. Those actors are
fixture-enrolled. A separate native-resume probe binds the real thread ID through
`resumeCodexThread`, proves actor stability across generations 1 and 2, refuses
already loaded threads and rejects the old capability. It uses explicit archive/
unarchive to unload the disposable host thread, not a crash or automatic recovery.
Neither tested native-ID environment variable was present in the MCP subprocess;
native lifecycle binding must use an explicit host API path.

The Codex lifecycle observer also receives native `thread/archived` in the probe
and revokes that thread's coordinator capability. Status mapping distinguishes
busy, blocked, idle, disconnected and unsupported; nonterminal connection loss
does not revoke identity. `resumeCodexRuntime` attaches the observer before
resume, reconciles initial status and releases listeners on disposal; the
installed host probe verifies idle status and archive revocation through that
composition. Initial thread creation and automatic model-turn context delivery
are not implemented.

A further Codex `--delivery` probe verifies the native context path: one complete
leased envelope reaches the scripted localhost model request through
`thread/inject_items`, the turn completes with the delivery still leased, and an
explicit app-server MCP call acknowledges it. Automatic scheduling is not
implemented; the fixture, not the model, drives acknowledgment.

The Codex lease-expiry probe verifies retained-context renewal: after real expiry
and an explicit sweep/refetch, the second model request contains exactly one
original envelope plus one metadata-only renewal. The native item ID and complete
message are matched in the bound rollout. Rewritten history returns uncertainty;
compaction/rollback recovery and autonomous scheduling are not implemented.
Evidence: `codex-lease-renewal.json`, pruned from the tree on 2026-09-23 and
retained in git history at `1fe258b`:
`git show 1fe258b:docs/verification/2026-09-22-runtime/codex-lease-renewal.json`.

## Acceptance requirements

| Requirement | Evidence and result |
| --- | --- |
| Lifecycle, capabilities, safe boundaries, recovery and acknowledgment contract | [Runtime contract](runtime-delivery.md), `enrollRuntime`, `RuntimeDelivery`, host adapters and the support matrix above. Launcher regression verifies private state, replay, stable identity and fenced resume. |
| Validate existing host integrations; include OpenCode and declare unsupported paths | OpenCode 1.4.3 V1 plugin and pinned SDK are implemented. Claude 2.1.278 launcher/hooks/native MCP are exercised. Codex 0.155.1 existing hook configuration, native MCP, resume, lifecycle and context transport are exercised, but automatic delivery is degraded. Hermes lifecycle code has 23 passing Python tests; an actual executable was unavailable in the inspected environment, so no installed-host claim is made. |
| Persist before waking; failed wake preserves work | Real-store runtime tests verify pending-recipient authorization before wake and retained work after failure. OpenCode wake tests cover uncertain admission with and without a persisted native prompt. |
| Supported boundaries, coalescing, no active-tool interruption or duplicate instructions | [OpenCode autonomous lease capture](verification/2026-09-22-runtime/opencode-autonomous-lease.json): busy deferral, model waits for shell, turn-start and post-tool context, retained-context renewal. [Claude native MCP capture](verification/2026-09-22-runtime/claude-mcp.json): native boundary delivery and explicit MCP ack. Duplicate hints and concurrent boundaries are covered by tests. |
| Availability separate from process liveness | Contract names five states and their evidence. OpenCode installed-host permission/reconnect captures and state tests establish blocked/busy/idle handling. Codex native lifecycle capture verifies archive revocation; unavailable paths defer. |
| Bounded polling/backoff; no model idle loop | OpenCode uses subscribed host/inbox events, held coordinator watches and deadline timers for TTL/lease/backoff. Observer tests prove bounded retry and stop cancellation. Autonomous lease capture records six model requests for actual work, with no fixture recovery prompt. |
| Delivery does not spawn agents | Runtime delivery interface exposes boundary admission and existing-session wake only. OpenCode wake calls `session.promptAsync` with the bound session ID, not session creation. Launcher owner startup starts the coordinator process, not another agent. |
| Two hosts end-to-end plus unavailable hooks, busy peers, restart, duplicates and backlog | Claude and OpenCode captures above establish actual host delivery/ack. [Claude forced-kill/native-resume capture](verification/2026-09-22-runtime/claude-restart.json) verifies stable actor, generation 1→2, stale capability rejection, one retained-context renewal and one replay for context not persisted before kill. Runtime tests cover unsupported boundaries, concurrent/duplicate hints and backlog; the inbox observer test covers a real coordinator restart. |

## Limits retained

Support does not claim identical capabilities across hosts. Codex automatic
initial enrollment/delivery and Hermes installed-host operation are degraded;
Claude delivers at native boundaries and has no idle wake. OpenCode's uncertain
absent wake intent is retained without an unsafe repeat POST. Killed OpenCode
delivery, unusually large installed-host histories, and Codex rewritten-history
reconstruction are not proven. These are explicit support limits, not claims of
message acknowledgment, exactly-once effects or successful recovery.

When automatic delivery is unverified or unavailable, retain durable inbox work
and expose that limitation. Do not substitute process liveness for idle evidence,
mark unseen messages acknowledged, or spawn another agent to consume them.

## Verifying a new host

For another environment, discover the native host executable/version and relevant
installed API first. For Hermes also inspect the intended virtual environment or
explicit installation path. Run the existing lifecycle tests, then a disposable
actual-host probe before raising its support level. A missing executable in one
environment is not a claim that Hermes lacks the required hooks. Preserve failed
captures and identify the actual host and tested source.

## Focused regression

The focused runtime regression covers the runtime delivery, launcher, inbox
observer/backlog and OpenCode/Claude/Codex integration tests. On `main` it runs
34 tests, 248 assertions, zero failures across 18 runtime integration files
(31 tests, 215 assertions across 17 files at acceptance). The shared
Python/Hermes regression passes all 48 tests. Reproduce it:

```powershell
bun test coordination-runtime-delivery coordination-runtime-launcher coordination-inbox-observer coordination-inbox-backlog coordination-opencode coordination-claude coordination-codex
```

History: delivered under VUH-1339 (September 2026); merged in PR #9.
