# Runtime adapter verification

Current candidate observations, 2026-09-22. These are evidence boundaries, not
permanent claims about capabilities missing from a host.

See the [acceptance audit](runtime-acceptance.md) for the required scenarios and
the distinction between supported paths, degraded modes and later rollout work.

| Host | Evidence | Current limitation |
| --- | --- | --- |
| OpenCode 1.4.3 | Installed-host lifecycle/restart, busy/blocked gating, post-tool and autonomous idle-turn delivery, explicit ack, retained-context deduplication and autonomous metadata-only refresh after real lease expiry | Killed/resumed-host delivery, uncertain wake recovery and large-history enrollment remain open |
| Claude Code 2.1.278 | Trusted-launcher hook/MCP binding, installed-host turn-start/post-tool delivery and native MCP ack, session-end closure, transcript-based deduplication, real lease expiry and forced-kill/native-resume recovery from a saved transcript | Legacy-plugin rollout and recovery before the first saved transcript remain open; delivery only at native boundaries, no idle wake implementation |
| Codex 0.155.1 | Native MCP isolation; composed resume/lifecycle observation and archive revocation; owner-driven model-context delivery and retained-context lease renewal | Initial enrollment, autonomous delivery and rewritten-history recovery remain unverified. Fixture hooks are untrusted. Automatic integration remains degraded |
| Hermes | Existing in-process lifecycle implementation inspected; 23 Python lifecycle tests pass | No `hermes` executable on this PATH or `hermes_cli` module in the inspected Python. Actual-host delivery is unverified |

Codex's two-thread probe also verifies distinct per-thread MCP credentials in one
app server: the second actor cannot fetch the first actor's message, and its
configuration does not replace the first actor's binding. Those actors are
fixture-enrolled. A separate native-resume probe binds the real thread ID through
`resumeCodexThread`, proves actor stability across generations 1 and 2, refuses
already loaded threads and rejects the old capability. It uses explicit archive/
unarchive to unload the disposable host thread, not a crash or automatic recovery.
Neither tested native-ID environment variable was present in
the MCP subprocess; native lifecycle binding must use an explicit host API path.

The Codex lifecycle observer also receives native `thread/archived` in the probe
and revokes that thread's coordinator capability. Status mapping distinguishes
busy, blocked, idle, disconnected and unsupported; nonterminal connection loss
does not revoke identity. `resumeCodexRuntime` now attaches the observer before
resume, reconciles initial status and releases listeners on disposal; the installed
host probe verifies idle status and archive revocation through that composition.
Initial thread creation and automatic model-turn context delivery are still open.

A further Codex `--delivery` probe verifies the native context path: one complete
leased envelope reaches the scripted localhost model request through
`thread/inject_items`, the turn completes with the delivery still leased, and an
explicit app-server MCP call acknowledges it. Automatic scheduling remains open;
the fixture, not the model, drives acknowledgment.

The Codex lease-expiry probe now verifies retained-context renewal: after real
expiry and an explicit sweep/refetch, the second model request contains exactly
one original envelope plus one metadata-only renewal. The native item ID and
complete message are matched in the bound rollout. Rewritten history currently
returns uncertainty; compaction/rollback recovery and autonomous scheduling remain
open. Evidence: `codex-lease-renewal.json` in the runtime verification directory.

OpenCode and Claude evidence uses scripted localhost model endpoints; it proves
host execution and context assembly, not model comprehension. Captures live in
`docs/verification/2026-09-22-runtime/`; integration specs name their reproduction
commands and remaining work. Codex lifecycle-only captures make no model requests;
its context-delivery capture uses a scripted localhost Responses endpoint.

For another environment, discover the native host executable/version and relevant
installed API first. For Hermes also inspect the intended virtual environment or
explicit installation path. Run the existing lifecycle tests, then a disposable
actual-host probe before raising its support level. A missing executable in this
environment is not a claim that Hermes lacks the required hooks.

When automatic delivery is unverified or unavailable, retain durable inbox work
and expose that limitation. Do not substitute process liveness for idle evidence,
mark unseen messages acknowledged, or spawn another agent to consume them.
