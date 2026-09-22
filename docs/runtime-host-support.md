# Runtime adapter verification

Current candidate observations, 2026-09-22. These are evidence boundaries, not
permanent claims about capabilities missing from a host.

| Host | Evidence | Current limitation |
| --- | --- | --- |
| OpenCode 1.4.3 | Installed-host lifecycle/restart, busy/blocked gating, post-tool and autonomous idle-turn delivery, explicit ack, retained-context deduplication and autonomous metadata-only refresh after real lease expiry | Killed/resumed-host delivery, uncertain wake recovery and large-history enrollment remain open |
| Claude Code 2.1.278 | Installed-host turn-start/post-tool delivery, explicit ack, session-end closure, transcript-based deduplication and metadata-only lease refresh after real expiry | Launcher/plugin integration and killed/resumed-host recovery remain open; delivery only at native boundaries, no idle wake implementation |
| Codex 0.155.1 | Isolated app-server initialization, actual plugin event configuration parsing, idle thread and rejected idle steering | Fixture hooks are untrusted; automatic coordinator delivery is unverified. Treat this as a degraded integration until execution evidence exists |
| Hermes | Existing in-process lifecycle implementation inspected; 23 Python lifecycle tests pass | No `hermes` executable on this PATH or `hermes_cli` module in the inspected Python. Actual-host delivery is unverified |

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
