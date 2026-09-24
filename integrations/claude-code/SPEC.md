# swarm Claude Code plugin — design notes

**Status:** coordinator lifecycle and delivery adapter
**Audience:** future contributors, the operator, agents reading this directory

## Redesign adapter (VUH-1339)

`src/coordination/claude-hook.ts` targets installed Claude Code 2.1.278.
The trusted launcher enrolls a fixed native session ID and supplies only its
endpoint, session capability and `SWARM_NATIVE_SESSION_ID` to the host.
Every hook checks that its input session matches that binding. `SessionStart`
verifies the capability; `SessionEnd` closes it. The optional Python write hooks owns only cooperative write reservations.

`prepareClaudeLaunch` in `src/coordination/claude-launcher.ts` now composes this
setup for a trusted host launcher. Supply the runtime identity/state options,
native UUID, incarnation, absolute Node and hook paths, and optional additional
settings. It validates settings before enrollment, preserves existing hook
entries, appends the four coordinator hooks and returns the bound environment
plus native session/settings arguments. Set `resume: true` and use a new
incarnation for an explicit native resume. The caller owns host execution; the
helper never creates a process in response to peer delivery.

The returned arguments also configure a stdio MCP server named `swarm`, using
the supplied Node executable and `mcpPath` (default: `mcp-cli.js` beside the hook).
That server inherits the bound endpoint and session capability from the launched
host environment; credentials do not appear in the serialized command-line
configuration. This mounts the coordinator API for the agent, including
`swarm_inbox` acknowledgment, rather than requiring a fixture-specific shell
command. It does not grant tool permissions or change persistent MCP settings.

Run the probe with `--mcp` for `claude-mcp.json`. Installed Claude advertises all
nine coordinator tools to the local scripted model endpoint. The fixture invokes
`mcp__swarm__swarm_inbox` to acknowledge each delivered envelope; the real native
MCP call reaches the coordinator, and its post-tool hook admits the next message.
Three model requests finish with both deliveries acknowledged and the session
capability closed on exit. This establishes the full hook→MCP→coordinator path;
the model endpoint is scripted and supplies no evidence of model comprehension.

The environment also declares `SWARM_COORDINATOR_HOOK_OWNER=launcher` and supplies
`SWARM_COORDINATOR_CLIENT` as argv JSON. The client defaults to `client-cli.js`
beside the hook executable; callers may supply an explicit `clientPath`.
The optional Python pre/post hooks acquire and release reservations through the
coordinator client. Known writes without credentials/client binding or with a
mismatched native session are denied. Relative file paths resolve from the host
process working directory. These hooks do not enroll or close sessions.

`test/coordination-claude-writes.test.ts` exercises the real Python write hooks
with a Node owner and trusted launcher binding. The cross-process reservation
suite checks competing writes, renames, missing paths, unreachable owners,
expiry and stale releases. It does not claim an installed-host write-denial probe.

The build includes `dist/coordination/claude-launcher.js` and
`dist/coordination/claude-hook-cli.js`. Hook commands quote literal paths for the
host's POSIX shell (Git Bash on the verified Windows installation). Additional
settings are capped at 8 KiB for bounded command-line use; invalid UUIDs, malformed
hook arrays and explicitly disabled hooks fail before enrollment. Managed host
policy can still disable execution; supplied settings do not override that policy.
The installed-host probe now uses this helper instead of assembling bindings
and hook settings itself. Normal-flow evidence: `claude-launcher.json`;
forced-kill/native-resume evidence through the helper:
`claude-launcher-resume.json`. The latter again verifies stable identity,
generation fencing, transcript-based renewal/replay and both acknowledgments.

`UserPromptSubmit` and `PostToolUse` fetch at most one leased envelope through
the shared runtime delivery contract. They return
`hookSpecificOutput.additionalContext` with the matching `hookEventName`.
An actual callback establishes the supported boundary; there is no guessed
timer boundary or implicit acknowledgment. Hook transport failures return a
generic error and leave the message unacknowledged. The CLI bounds input size.

Run `bun scripts/probe-claude-hooks.ts <capture.json> <claude executable>`.
The probe uses a disposable config/workspace, explicit hook settings, no inherited
MCP servers, fixture credentials and a local scripted Anthropic-compatible endpoint.
The actual host receives one message at turn start, executes a shell acknowledgment,
receives another message at the post-tool boundary, and acknowledges that message.
The coordinator verifies each is leased before its explicit tool action and
acknowledged afterward. After native exit, the closed capability is rejected.
Capture: `docs/verification/2026-09-22-runtime/claude-delivery.json`.
The fixture proves host context assembly and tool execution, not model comprehension.
No model request bodies, capabilities or lease tokens are retained in the capture.

Before emitting a leased envelope, the adapter now checks the native transcript
for an identical envelope in a `hook_additional_context` attachment on the current
parent-UUID ancestry. User/tool quotations, sidechains, other sessions and
discarded branches cannot prove prior admission. A compaction boundary invalidates
earlier proof. If found, the hook emits only the message ID and renewed lease
metadata, with an instruction to avoid repeating completed effects. Processing
still requires explicit acknowledgment with the current token.

Transcript inspection requires the bound session's absolute `.jsonl` filename.
It rejects symlinks, malformed/partial rows, cycles and inspection beyond 16 MiB
or 20,000 ancestry nodes. An unavailable proof is not silently treated as success;
errors retain uncertain admission. A not-yet-created transcript is empty context.
This relies on the installed version's observed transcript schema. General
exactly-once external effects remain the consumer's responsibility.

`claude-context.json` verifies both original envelopes are discoverable in the
actual persisted transcript. Run the same probe with `--lease-expiry` for
`claude-lease-refresh.json`: the first real shell tool waits 32 seconds without
acknowledging. Post-tool recovery delivers the other pending message, then emits
one metadata-only lease refresh for the first. Four scripted model requests end
with both messages explicitly acknowledged. Each hook runs in a fresh process,
so the deduplication evidence comes from the host transcript rather than memory.
This tests lease expiry during a running host, not a killed/resumed host.

Run with `--restart` for `claude-restart.json`. The fixture lets the real host
complete one harmless tool exchange, then holds the next model response and
forcibly kills the process (exit 137), before either peer message is acknowledged.
After real lease expiry, the trusted launcher reenrolls the same native session
with a new incarnation, then invokes the installed host's `--resume` option.
The actor remains stable, generation advances from 1 to 2, and the old capability
is rejected. This is an explicit operator-style resume, not an idle wake.

The inspected transcript after the kill contains the first envelope but not the
second, even though the second reached the in-flight model request. Recovery
therefore emits one metadata-only renewal and one full envelope with a fresh
lease. Both are explicitly acknowledged. Five fixture model requests complete,
the resumed host exits successfully, and `SessionEnd` closes its new capability.
Both envelopes are then discoverable in the final transcript.

An earlier kill during the very first model request left no saved transcript
and native resume failed (`claude-restart-before-persistence.json`). Recovery
without native history remains an integration requirement. The retained
`claude-restart-incomplete-fixture.json` caught an incorrect fixture assumption:
an envelope seen by the model endpoint was treated as permanently delivered.
The fixture now tracks lease tokens and verifies renewal/replay counts against
the actual post-kill transcript. Deadline failures are retained separately;
the restart harness allows 180 seconds for two native startups, the real
32-second expiry wait and shutdown. Coordinator leases and hook timeouts are
unchanged. `claude-restart-regression.json` is the normal-flow regression.

The [official hook reference](https://code.claude.com/docs/en/hooks) supplies the
JSON contract; the installed executable probe supplies version-specific evidence.
Remaining: recovery before saved native history and transcript schema compatibility,
availability outside callbacks, and validated
idle wake admission. Until that work lands this adapter delivers only at native
turn/tool boundaries; it does not start a model loop or spawn an agent to wake it.
