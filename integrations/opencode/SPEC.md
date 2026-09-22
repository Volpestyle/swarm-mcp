# OpenCode coordinator adapter investigation

VUH-1339 includes OpenCode. Target the installed **1.4.3** V1 plugin API; V2
support is not claimed. Archived VUH-56/57 supply requirements, not dependencies.
The adapter implementation and tool-boundary delivery verification remain open.

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
