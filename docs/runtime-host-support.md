# Runtime adapter verification

Current candidate observations, 2026-09-22. These are evidence boundaries, not
permanent claims about capabilities missing from a host.

| Host | Evidence | Current limitation |
| --- | --- | --- |
| OpenCode 1.4.3 | Installed-host lifecycle/restart, busy/blocked gating, post-tool and autonomous idle-turn delivery, explicit ack, retained-context deduplication and autonomous metadata-only refresh after real lease expiry | Killed/resumed-host delivery, uncertain wake recovery and large-history enrollment remain open |
| Claude Code 2.1.278 | Trusted-launcher hook/MCP binding, installed-host turn-start/post-tool delivery and native MCP ack, session-end closure, transcript-based deduplication, real lease expiry and forced-kill/native-resume recovery from a saved transcript | Legacy-plugin rollout and recovery before the first saved transcript remain open; delivery only at native boundaries, no idle wake implementation |
| Codex 0.155.1 | Native MCP discovery, actor authentication, explicit fetch/ack and per-thread isolation; trusted helper resumes an existing native thread with a stable actor and fences the previous generation | New-thread enrollment, automatic lifecycle observation and context delivery remain unverified. Fixture hooks are untrusted. Treat this as a degraded integration |
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

OpenCode and Claude evidence uses scripted localhost model endpoints; it proves
host execution and context assembly, not model comprehension. Captures live in
`docs/verification/2026-09-22-runtime/`; integration specs name their reproduction
commands and remaining work. Codex capture makes no model requests.

For another environment, discover the native host executable/version and relevant
installed API first. For Hermes also inspect the intended virtual environment or
explicit installation path. Run the existing lifecycle tests, then a disposable
actual-host probe before raising its support level. A missing executable in this
environment is not a claim that Hermes lacks the required hooks.

When automatic delivery is unverified or unavailable, retain durable inbox work
and expose that limitation. Do not substitute process liveness for idle evidence,
mark unseen messages acknowledged, or spawn another agent to consume them.
