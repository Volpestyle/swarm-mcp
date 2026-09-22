# OpenCode coordinator adapter investigation

VUH-1339 includes OpenCode. Target the installed **1.4.3** V1 plugin API; V2
support is not claimed. Archived VUH-56/57 supply requirements, not dependencies.
The lifecycle adapter is implemented; tool-boundary delivery verification remains open.

`src/coordination/opencode-plugin.ts` supplies V1 event and shell-environment
hooks to a trusted plugin wrapper. Creation/update events enroll once per native
session, concurrent callbacks serialize per session, and deletion closes the
coordinator session. A per-plugin incarnation fences old credentials on reload.
The shell hook can adopt an unknown session and exports only its endpoint and
session capability; the installed-host shell probe verifies authentication with
that capability. Delivery and wake support require separate verification below.

The extended probe captures `opencode-lifecycle.json`: two real host sessions
produce exactly two coordinator sessions, each generation 1 and durably closed
after deletion. The first is adopted through an explicit native title update
after its creation event was missed. Repeated update events do not reenroll it.
That initial capture predates subscription-first reconciliation. The probe starts
and stops its own isolated coordinator.

`connectOpenCodeLifecycle` now starts a directory-scoped SSE subscription and
lists retained, unarchived sessions after `server.connected`. The tagged
[event route](https://github.com/anomalyco/opencode/blob/v1.4.3/packages/opencode/src/server/routes/event.ts)
installs its bus subscription before writing the connected event. Mutations
during the snapshot remain queued on the stream. The wrapper starts this worker
without awaiting its lifetime from plugin initialization. It uses the actual
server URL, preserves the injected SDK authentication, and stops on instance
disposal. Startup and snapshot requests have ten-second limits; transport loss
reports disconnected with no hidden infinite retry loop.

`opencode-reconciliation.json` verifies first-session enrollment without a title
update, then actual instance disposal/reinitialization. The retained session
keeps its actor and advances to generation 2; SQLite shows generation 1
superseded and generation 2 closed after deletion. A second native session
enrolls once and closes. This proves lifecycle restart, not message admission.

The V1 list endpoint has no cursor. Snapshots at the 1,001-row detection limit
fail explicitly rather than silently reconcile a truncated history. Larger
histories and automatic recovery from an unexpected stream failure still need
a supported recovery path.

`opencode-shell.json` additionally exercises the actual session shell endpoint.
Its child process uses the injected capability to bootstrap from the coordinator;
the actor matches the native session's enrollment and the configured scope.
Only the coordinator endpoint, session capability and fixture recording path
appear among its `SWARM_*` environment names. No capability values are recorded.
An explicit inert model identifier avoids model selection/inference for this
user-executed shell operation. This endpoint does not exercise post-tool hooks.

The adapter's `tool.execute.after` now fetches one leased message at a real
post-tool callback, appends a labeled peer envelope to builtin `output` or MCP
`content`, and leaves acknowledgment to the consumer. Repeated callbacks for
the same call ID are suppressed within the plugin instance. Unknown output
shapes do not fetch. The real-coordinator adapter test verifies both output
forms, retained lease state, explicit acknowledgment and repeated callbacks.
`opencode-delivery.json` exercises this hook through the installed host's real
agent loop. A localhost OpenAI-compatible fixture requests a file read, receives
the peer envelope in the next model request, and requests an explicit shell
acknowledgment using the received lease. The third request sees the acknowledgment
result and completes. SQLite confirms `leased` before that explicit action and
the coordinator confirms `acknowledged` afterward. The fixture is deterministic:
this proves host tool execution and context assembly, not model comprehension.
It uses no external model service. Retained evidence redacts lease tokens.
Durable context deduplication across restart/lease expiry and idle wakeups remain
unproven.

`opencode-availability.json` adds a real `read` permission wait to that agent
loop. The adapter observes `blocked` and the coordinator delivery remains
`pending`. The fixture replies once through the native permission API; the read
then completes, the message reaches the next model request, and explicit
acknowledgment succeeds. No permission prompt is bypassed by the adapter.

Availability tracks status events and outstanding permission/question IDs.
Duplicate asks are idempotent; one reply cannot clear a different wait. Replies
establish busy, never idle; retry is busy. Stream loss and deletion establish
disconnected. Unknown sessions/statuses are unsupported until verified host
evidence arrives. Post-tool delivery checks blocked/disconnected both before
fetch and immediately before admission. Permission/question reconstruction on
startup and idle admission via an authoritative status check remain open.

The wrapper feeds operational events from the SSE observer only. Its native
event hook may record diagnostics, but must not feed the same events back into
availability: two independently scheduled subscriptions can replay an older
status after a newer one. `connectOpenCodeLifecycle` forwards stream loss to
the adapter so subsequent tool callbacks defer until reconnection.

## Actual host evidence

Run the installed native executable, not its Windows package shim:

```powershell
bun scripts/probe-opencode-hooks.ts dist/test/opencode-hooks.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe
```

The probe starts a localhost server with disposable XDG paths, database and
`OPENCODE_TEST_HOME`, loads a local function-export plugin, and creates/deletes
two sessions without model inference. Both operations succeed. Recorded events:

```
plugin.loaded
session.updated
session.deleted
session.created
session.updated
session.updated
session.deleted
```

The first session's creation event is absent; the second arrives after plugin
initialization. Enrollment must therefore reconcile existing sessions on startup
and adopt unknown sessions from updates or verified tool boundaries. A
creation-event-only integration loses the first session in this observed run.

The initial probe also showed that killing the Windows package shim left its
native server child alive holding output pipes. The probe now requires a native
binary path on Windows and owns that process directly. XDG paths alone did not
isolate the home `.opencode` configuration; the host-specific test-home override
is required. The successful evidence uses that override.

## Plugin decision and remaining checks

Use a plugin, not a launcher-only registration shim. The tagged V1
[plugin interface](https://github.com/anomalyco/opencode/blob/v1.4.3/packages/plugin/src/index.ts)
provides events and tool hooks; the
[loader](https://github.com/anomalyco/opencode/blob/v1.4.3/packages/opencode/src/plugin/index.ts)
accepts function exports and subscribes to session events. This source contract
plus the real lifecycle probe establishes a viable plugin entrypoint. It does
not yet prove write denial, tool-result context delivery or safe idle wakeups.

OpenCode's [V2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
describes a different hook registration API. Do not copy V2 `setup` hooks into
the installed V1 adapter. Pin the tested API and exercise each host hook.

Remaining: validate tool names and deny behavior, safe context injection,
session status/permission transitions, configured command registration, resume
enumeration and idle prompt admission. Record capabilities separately: lifecycle
events do not establish an acknowledgment of message processing. Ordinary
delivery must not spawn agents, and busy sessions must not be interrupted.

Existing Codex and Claude Code subprocess integrations and Hermes's in-process
plugin remain sources for shared identity, reservation and lifecycle semantics.
On this machine, the observed CLI versions are Codex 0.155.1 and Claude Code
2.1.278; Hermes was not resolved by the PATH probe. That is an environment result,
not a permanent unsupported-host policy.
