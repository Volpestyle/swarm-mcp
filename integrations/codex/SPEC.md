# Codex coordinator integration

The trusted app-server adapter composes existing-thread resume, lifecycle
observation and coordinator credentials. Initial enrollment and autonomous
model-turn delivery remain unverified; see the [support matrix](../../docs/runtime-host-support.md).

The optional Python write hooks supplies `apply_patch` write reservations only.
`scripts/probe-codex-lifecycle.ts` loads fixture write event definitions with harmless
fixture commands in an isolated host. Native lifecycle is observed through the
app-server adapter, not plugin session hooks.

The extended probe also builds the real coordinator and stdio MCP entrypoints,
enrolls an isolated fixture actor, and mounts the MCP server through the disposable
Codex configuration. Thread-scoped `mcpServerStatus/list` discovers all nine tools;
`mcpServer/tool/call` verifies the authenticated actor, fetches a real message and
explicitly acknowledges its lease. A direct coordinator query proves the delivery
remains `leased` after fetch and becomes `acknowledged` only after acknowledgment.
Evidence: `docs/verification/2026-09-22-runtime/codex-mcp.json`.

Reproduce with `bun scripts/probe-codex-lifecycle.ts <capture.json> <codex-executable>`.
This path makes no model request. The fixture actor is enrolled before the native
thread exists; this verifies MCP transport and authorization, not automatic
per-thread identity, lifecycle or model-context delivery.

The extended two-thread run uses `thread/start.config` with
`mcp_servers.swarm.env` to override the second thread's endpoint/capability.
Both native threads authenticate as distinct actors, the original binding stays
unchanged, and a peer inbox fetch leaves the original actor's message pending.
Evidence: `docs/verification/2026-09-22-runtime/codex-thread-isolation.json`.
In this installed-host run, neither `CODEX_THREAD_ID` nor `CODEX_SESSION_ID` was
present in the MCP subprocess. A future lifecycle bridge must obtain the native
thread ID from the host API and bind it explicitly; it cannot infer it from
these environment variables. Rediscover this behavior when the host changes.
Per-thread MCP configuration is verified; both enrollments remain fixtures.

### Trusted native resume

`src/coordination/codex-launcher.ts` exports `resumeCodexThread`. The app-server
owner supplies a native thread ID, trusted workspace identity, incarnation and
absolute Node/MCP entrypoints. The helper verifies the saved thread's ID and
workspace and scans the loaded-thread inventory before enrolling. It refuses an
already loaded thread, resumes the existing thread with per-thread MCP credentials,
and checks the authenticated actor through the native MCP tool path. It does not
change approval or sandbox settings or create a thread. The owner must serialize
lifecycle operations and inspect uncertain outcomes before retrying.

Run the probe with a final `--resume` argument to verify this helper against the
installed host. The probe persists a harmless history item, explicitly archives/
unarchives the disposable native thread, and resumes it twice. The same native
ID retains one actor, advances generation 1 to 2, and rejects the first capability
as `stale_session`. A loaded-thread retry is refused before enrollment.
Evidence: `docs/verification/2026-09-22-runtime/codex-native-resume.json`.
This is controlled native resume without inference; it does not establish crash
recovery, automatic lifecycle observation or model-visible inbox delivery.

`CodexLifecycle`, exported by the launcher module, consumes notifications from
the trusted app-server connection for exactly one bound thread. Native idle and
active status map to idle/busy; approval or user-input flags map to blocked;
unknown flags map to unsupported. `notLoaded`, system errors and transport loss
mean disconnected and do not revoke the session. Explicit archived, deleted or
closed events close it once. Observation writes are serialized and failures
leave local availability disconnected.

The `--resume` probe now routes actual native notifications into this observer.
Installed Codex emits `thread/archived` when the test archives the resumed thread;
the observer closes its coordinator session and a subsequent bootstrap fails with
`stale_session`. Evidence: `docs/verification/2026-09-22-runtime/codex-native-lifecycle.json`.
Busy/blocked mappings have focused tests; actual model-turn delivery and automatic
attachment of the observer during initial thread creation remain unverified.

`resumeCodexRuntime` composes enrollment, native resume and observer attachment.
The owner provides `call` and `subscribe` for its trusted app-server connection.
Subscription starts before resume; a bounded queue retains early lifecycle events.
After binding, the helper reads native status and applies the snapshot only if no
newer notification arrived during the read. It returns `lifecycle`, `settle()` for
observation completion and `dispose()` to detach listeners, report disconnection
and release the coordinator connection. Disposal does not end a native session.

The actual-host `--resume` probe now uses this composed helper. It verifies initial
idle availability, native archive revocation and listener cleanup. Evidence:
`docs/verification/2026-09-22-runtime/codex-composed-resume.json`. Initial thread
creation and model-visible inbox delivery remain separate unfinished paths.

### Native context delivery probe

The final `--delivery` probe argument additionally runs a scripted localhost
Responses endpoint. It sends a real inbox message to the native-thread actor,
fetches a lease through Codex MCP, injects the envelope with `thread/inject_items`,
and starts a turn on that existing idle thread. The endpoint verifies exactly one
complete envelope in the actual model input. The turn completes while the
coordinator delivery remains leased; an explicit app-server MCP acknowledgment
then changes it to acknowledged. The fixture drives that acknowledgment, not a
model-selected tool call. No remote inference or persistent configuration is used.

Evidence: `docs/verification/2026-09-22-runtime/codex-context-delivery.json`.
This establishes native context transport, not autonomous scheduling or replay
deduplication. The app-server owner must serialize turn admission; `turn/start`
can steer an active turn, so an earlier idle observation alone is insufficient
permission for an independent wake loop.

### Retained context and lease renewal

`codexContextItem` gives full delivery items a stable message-derived native item
ID. `hasCodexContext` inspects the host-provided rollout path, validates native
session identity and workspace, and requires both that item ID and the complete
message envelope to match. Quoted user text without the injected ID cannot count.
Reads are bounded to 16 MiB / 20,000 rows; malformed, rewritten or mismatched
history is uncertain and must not trigger a blind replay. Compaction, rollback
and revert support still need verified reconstruction semantics.

The `--lease-expiry` probe waits for a real lease to expire, sweeps and refetches
it, verifies retained native context, and injects only renewal metadata with the
new token. The next actual model request must contain one original envelope and
one renewal. Acknowledgment remains explicit. This probe uses an explicit sweep
and owner-driven turn, not autonomous scheduling. It also waits for the native
archive notification before checking revocation; an archive RPC response does
not establish that notification handling has completed.

The probe's hooks are reported as untrusted. Listing a hook is not execution:
live setup must obtain normal hook trust before claiming automatic delivery.
No live trust/config changes were made. Automatic native-thread enrollment, safe
context delivery, restart deduplication and authorized idle turn admission
remain unverified in Codex. `turn/steer` is for an active turn; an idle wake needs
a validated `turn/start` path on the existing thread.
