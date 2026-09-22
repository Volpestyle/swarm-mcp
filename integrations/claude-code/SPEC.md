# swarm Claude Code plugin — design notes

**Status:** redesign delivery candidate; legacy v0.2 notes retained below
**Audience:** future contributors, the operator, agents reading this directory

## Redesign adapter (VUH-1339)

`src/coordination/claude-hook.ts` targets installed Claude Code 2.1.278.
The trusted launcher enrolls a fixed native session ID and supplies only its
endpoint, session capability and `SWARM_NATIVE_SESSION_ID` to the host.
Every hook checks that its input session matches that binding. `SessionStart`
verifies the capability; `SessionEnd` closes it. This is separate from the legacy
Python plugin and has not been installed into live user settings.

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
launcher/legacy-plugin integration, availability outside callbacks, and validated
idle wake admission. Until that work lands this adapter delivers only at native
turn/tool boundaries; it does not start a model loop or spawn an agent to wake it.

## Legacy design

This file captures the design constraints behind the Claude Code adapter so
v0.2+ doesn't have to re-derive them from conversation. The broader adapter
contract lives in [`../../docs/control-plane.md`](../../docs/control-plane.md);
the parallel hermes design is in [`../hermes/SPEC.md`](../hermes/SPEC.md).

## 1. Three-layer model

Identical to hermes — the layers compose by name (`mcp_swarm_*` tool prefix
inside a session, `swarm-mcp` CLI outside it), not by import:

```
┌──────────────────────────────────────────────┐
│  Skill (skills/swarm-mcp/SKILL.md)           │   doctrine
│   when to lock, role routing, task patterns
├──────────────────────────────────────────────┤
│  Plugin (integrations/claude-code/)          │   behavior
│   SessionStart register, peer-lock check, /swarm
├──────────────────────────────────────────────┤
│  MCP server (src/index.ts)                   │   capability
│   29 tools: register, lock_file, request_task...
└──────────────────────────────────────────────┘
```

## 2. Shared hook core with the Codex plugin

The runtime-agnostic implementation of every hook lifecycle method —
swarm-mcp CLI resolution, identity/scope/label derivation, autonomous
registration, peer detection, session scratch, lock-pair tracking,
deny-on-conflict semantics, herdr identity publication — lives in
[`../_shared/swarm_hook_core.py`](../_shared/swarm_hook_core.py) as a
`HookCore` class parameterized by `RuntimeConfig`.

This plugin's `hooks/_common.py` instantiates `HookCore` with the
Claude-Code-flavored config: `runtime_name="claude-code"`, `env_prefix="CC"`,
`scratch_dir_name="swarm-cc"`, `write_tools={Write, Edit, MultiEdit,
NotebookEdit}`, and a path extractor that reads `tool_input.file_path` /
`tool_input.notebook_path`. The four hook entry scripts
(`session_start.py`, `session_end.py`, `pre_tool_use.py`, `post_tool_use.py`)
are 12-line stubs that just call `core.run_*_hook(sys.stdin)`.

The Codex plugin (`integrations/codex/plugins/swarm/`) consumes the same
shared core with a different `RuntimeConfig` (write tool: `apply_patch`,
path extractor: parses the `*** Begin Patch` envelope). Hermes does *not*
use this shared core because hermes integrates via an in-process plugin
API rather than stdin-JSON subprocess hooks.

## 3. Why this plugin is leaner than hermes

The hermes plugin has the advantage of hermes-agent's plugin API, which
exposes:

- Direct dispatch of MCP tools from inside a hook (`registry.dispatch`)
- Plugin-local tool registration (`ctx.register_tool(...)`)
- Session lifecycle hooks with separable per-turn vs per-session boundaries
  (`on_session_end` vs `on_session_finalize`)

Claude Code's plugin model is shell-hook + slash-command + bundled MCP/skill
configs. Hooks run as separate subprocesses and cannot reach the agent's MCP
tool surface. That changes which lifecycle responsibilities can sit in the
plugin vs. need to live in the agent's prompt-time behavior.

The result:

| Hermes-plugin responsibility | Claude Code plugin v0.2 |
|---|---|
| Auto-register via `mcp_swarm_register` | `SessionStart` shells to `swarm-mcp register`, stores the returned `instance_id`, and injects context saying registration is complete. |
| Auto-deregister | `SessionEnd` shells to `swarm-mcp deregister` and cleans up herdr identity KV. |
| Peer-lock enforcement | Same — inspect active locks and deny writes when a peer holds the target file. |
| Block on lock conflict | Same — emit `permissionDecision: deny`. |
| `/swarm` slash command | Markdown command; same shape, slightly different surface. |
| Peer prompt express lane | Implemented adapter-neutrally as the swarm MCP `prompt_peer` tool and `swarm-mcp prompt-peer` CLI. |
| Workspace identity publish on session start | `SessionStart` publishes `identity/workspace/herdr/<instance_id>` directly after CLI registration. |

## 4. CLI surface for full autonomy

The swarm-mcp CLI exposes the lifecycle and coordination commands shell-hook
adapters need: `register`, `deregister`, `whoami`, `instances` /
`list-instances`, `lock`, `unlock`, `kv`, `send`, `broadcast`,
`prompt-peer`, `inspect`, `tasks`, `messages`, `context`, and `ui`.

```text
swarm-mcp register "$cwd" --label "..." \
    [--scope <path>] [--file-root <path>] [--lease-seconds N] [--json]
    # prints the registered instance; hooks capture id into session scratch

swarm-mcp deregister [--as <who>] [--scope <path>]

swarm-mcp list-instances [--scope <path>] [--json]

swarm-mcp prompt-peer --to <who> --message "..." [--task <id>] [--force]
```

CLI-registered hook sessions do not have an MCP heartbeat timer, so Claude
Code uses a lease (`SWARM_CC_LEASE_SECONDS`, default 86400) and deregisters
explicitly on `SessionEnd`.

## 5. Lifecycle contracts (v0.1)

### 5.1 Hook firing

| Hook | Fires | Plugin behavior |
|---|---|---|
| `SessionStart` (source=startup or resume) | New or resumed conversation | Compute label/scope/identity; call `swarm-mcp register`; write per-session scratch metadata including `instance_id`; publish `identity/workspace/herdr/<instance_id>` if `HERDR_PANE_ID` is present; emit `additionalContext` telling the agent it is registered and should follow the swarm role workflow. |
| `SessionStart` (source=clear or compact) | Mid-session reset | Refresh metadata only; do not re-prompt registration. |
| `SessionEnd` | Conversation ends | Best-effort `kv del identity/workspace/herdr/<instance_id>`; `swarm-mcp deregister`; clear the session scratch dir. |
| `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) | Before each write-class tool dispatch | Read-only check via `swarm-mcp locks --scope <s> --json`. If any returned lock row targets one of the write tool's files and is held by an `instance_id` other than ours, emit `permissionDecision: deny`. Never acquires a lock. |
| `PostToolUse` | — | **Not wired in new installs.** A no-op stub remains in the plugin source so already-installed configs that still register `PostToolUse` keep loading; new `hooks.json` omits the entry. |

### 5.2 Why check-only (no acquire/release pair)

Earlier drafts of this plugin had `PreToolUse` acquire a lock and
`PostToolUse` release it, framed as "concurrent edit protection." That
protection was largely illusory:

- Filesystem writes are already atomic at the OS level; two peers racing to
  the same byte happens in a sub-millisecond window that almost never
  coincides with two LLM agents' tool dispatches.
- The Edit tool's `old_string` anchor check catches logical collisions
  (peer A's edit displaced peer B's anchor → B's Edit fails). That's
  runtime-provided safety; the swarm lock didn't add to it.
- The acquire/release pair didn't cover the actual hazard, which is the
  Read → Edit gap — the lock was only held around the write tool call, not
  across the agent's read of the file.

What manual `lock_file` (called by the agent for a wider critical section)
*does* need is enforcement: a peer that takes a 10-minute lock for a
refactor expects other peers' writes to be denied while the lock is held.
The check-only hook is what enforces those declarations. It is intentionally
the cheaper half of the original bridge — one `swarm-mcp locks` call per
write tool, no acquire, no release, no `(tool_name, |paths)` scratch
tracking. Same-instance locks pass through so the declaring agent keeps
editing its own reservation.

### 5.3 Failure semantics (matches hermes)

- **Fail-open by default.** CLI missing, network/db error, unknown own
  `instance_id` → tool proceeds without a check. Coordination is opt-in.
- **Block on real conflicts.** When `swarm-mcp locks --json` returns a row
  for one of the write tool's paths whose `instance_id` is not ours, emit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"swarm lock blocked ..."}}`.
- **Solo sessions are implicit.** With no peer in scope, the `locks` list
  is empty (or only contains this session's own locks), so the check
  short-circuits without a separate `has_peers` probe.

### 5.4 Own-vs-peer identification

The hook needs to distinguish "I locked this earlier in a wider critical
section" from "a peer locked this." Each lock row carries the holder's
`instance_id`. The hook reads its own `instance_id` from per-session
scratch metadata (written by `SessionStart` after `swarm-mcp register`
succeeds) and treats any row with a different `instance_id` as a peer
conflict. If scratch metadata has no `instance_id` (e.g. registration
failed earlier in the session), the hook fails open.

## 6. Identity, scope, labels

Same shape as hermes:

- `instance_id` — UUIDv4, one per registered session. Lives in the swarm DB.
- `scope` — coordination boundary. Default: git root of `cwd`. Override via
  `SWARM_CC_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE`.
- `label` — auto-built as
  `[identity:<id>] claude-code platform:cli [mode:gateway] [role:<name>]
  origin:claude-code session:<id-prefix>`. Override via `SWARM_CC_LABEL` /
  `SWARM_HERMES_LABEL`. If the override omits `identity:`, the derived token
  is prepended. `mode:gateway` is behavior metadata; `role:planner` is the
  swarm-visible routing label.

The five-identifier invariants from hermes SPEC §6.5 carry over without
modification: tasks/messages/locks target `instance_id`; UI/control surfaces
target transport handles; user-facing text uses labels.

## 7. Why no plugin-local peer prompt tool here

The hermes plugin used to register a plugin-local peer prompt tool, but that
path is now retired. Claude Code also does not allow plugins to inject ad-hoc
tools into a hosted session; the only way to add tools is to ship an MCP server
in the plugin.

The architectural answer is the adapter-neutral `prompt_peer` tool in the
swarm-mcp server plus the `swarm-mcp prompt-peer` CLI. Claude Code receives
the MCP tool through the normal `swarm` server mount, and hook/launcher code
can use the CLI when it cannot call MCP tools directly.

## 8. Testing

### 8.1 Smoke scenarios (live, must pass)

**S1: Single-agent registration**
Fresh Claude Code session in a git repo. SessionStart should call
`swarm-mcp register`, store the returned `instance_id`, and inject context
saying the session is already registered. Confirm `swarm-mcp instances`
shows the session before the agent spends a tool call on registration.

**S2: Solo write does not lock**
Single session, no peers in scope. Edit any file. `swarm-mcp locks` should
show no lock entries during or after the edit.

**S3: Peer-held lock blocks write**
Peer A holds a swarm lock on `notes.md` (`swarm-mcp lock notes.md --note
"refactor"`). Peer B (Claude Code) attempts an `Edit` on the same path.
The Edit tool should be denied with a message containing `swarm lock
blocked Edit for ... held by <8-char-prefix> (refactor)`. Target file is
**not** modified. The Edit must remain denied for as long as peer A
holds the lock; releasing on peer A (`swarm-mcp unlock notes.md`) clears
the block on peer B's next attempt.

**S4: Concurrent peer writes on different files**
Two Claude Code sessions in shared scope, no manual locks held. Both
edit different files. Both writes succeed. The pre-tool check inspects
`swarm-mcp locks`, finds nothing targeting its file, and does not deny.
After the turns, `swarm-mcp locks` shows no residual locks (the hook
never acquired any).

**S4b: Self-held lock is re-entrant**
A Claude Code session calls `lock_file foo.ts` (declaring a wider
critical section) and then does multiple `Edit foo.ts` calls. None of
those Edits should be denied — the holder is the same instance.

**S5: /swarm status**
`/swarm` inside a registered session prints a compact summary listing
instance count, task counts, kv key count, and recent message count.

**S6: SessionEnd identity cleanup**
With `HERDR_PANE_ID` set and the agent having published
`identity/workspace/herdr/<id>`, exiting the session should result in
`swarm-mcp kv get identity/workspace/herdr/<id>` returning empty/error.

### 8.2 Mocked unit tests

Current shared-core tests cover autonomous registration, fallback context,
SessionEnd cleanup/deregister, and the full check-only matrix for
`run_pre_tool_use_hook`:
- No locks exist → write passes, `locks` is the only CLI call.
- Peer holds the target file → write is denied with holder prefix + note.
- Same-instance lock on the target file → write passes (re-entrant).
- Peer holds an unrelated file → write passes.
- Unknown own `instance_id` → fail-open, no `locks` call.
- `run_post_tool_use_hook` is a no-op (zero CLI calls, zero stdout).

Coverage gaps still worth filling:
- Label derivation with and without override / identity token.
- Path normalization mismatch between hook input and stored lock rows
  (the hook compares string equality today; symlink / `.`/`..` cases
  could go either way).

## 9. Design decisions

**Why register through the CLI instead of the MCP tool?**
Claude Code hooks run as subprocesses and cannot reach the hosted session's
MCP tool surface. The hook shells to `swarm-mcp register`, stores the returned
`instance_id` in scratch metadata, and injects context so the model can start
with `bootstrap` instead of spending its first action on manual registration.

**Why the hook caches `instance_id` from registration in scratch.**
The check-only flow needs the agent's own `instance_id` to distinguish
self-held from peer-held locks. `SessionStart` writes it into
`$TMPDIR/swarm-cc/<session_id>/meta.json` after `swarm-mcp register`
returns, and the pre-tool hook reads it from there. Older versions used
`--as session:<8>` for acquire/release CLI calls; that path is gone with
the acquire step, but the `session:<8>` token still appears in the
derived label and is how operators can resolve a session externally.

**Why fail-open on non-conflict errors?**
Same reason as hermes: a swarm outage shouldn't block productive editing.
Peer-held lock conflicts are the case the user wanted protection from;
everything else is best-effort.

**Why no `pre_compact` / `subagent_stop` integration?**
Out of scope for v0.1. The hermes plugin's `subagent_stop` bridge maps a
sub-agent prompt back to a swarm task; the same idea applies to Claude
Code's `SubagentStop` hook but requires the sub-agent prompt to carry a task
id, which the bundled skill doesn't currently do. Tracked as v0.5+.

## 10. Upstream tightenings recommended for swarm-mcp

These overlap with the hermes SPEC §12 list. Restating only the ones that
unblock this adapter specifically:

- **A read-only single-file lock inspector in the CLI.** Today the hook
  shells to `swarm-mcp locks --scope <s> --json` (lists every lock in
  scope) and filters client-side. A `swarm-mcp lock-info <file> --json`
  subcommand would let the hook ask for the one row it actually cares
  about. Worth doing once a scope grows enough locks that the full list
  becomes noticeable; not urgent.
- **First-class in-agent dispatch/spawn orchestration.** Implemented via the
  swarm MCP `dispatch` tool. Keep the CLI bridge for hooks, wrappers, operator
  shells, and fallback sessions where MCP tools are unavailable.
