# swarm Claude Code plugin — design notes

**Status:** v0.2.0 current
**Audience:** future contributors, the operator, agents reading this directory

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
│   SessionStart register, lock bridge, /swarm
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
- Tool registration (`ctx.register_tool(...)` for `swarm_prompt_peer`)
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
| Auto-lock + auto-unlock | Same — shell to `swarm-mcp lock` / `unlock`. |
| Block on lock conflict | Same — emit `permissionDecision: deny`. |
| `/swarm` slash command | Markdown command; same shape, slightly different surface. |
| `swarm_prompt_peer` tool | Implemented adapter-neutrally as the swarm MCP `prompt_peer` tool and `swarm-mcp prompt-peer` CLI. |
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
| `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) | Before each write-class tool dispatch | Gateway mode allows trivial local edits; medium/large implementation work should route through `dispatch`. If peers exist in scope, `swarm-mcp lock` each path. On conflict, emit `permissionDecision: deny`. |
| `PostToolUse` (same matcher) | After each write-class tool dispatch | `swarm-mcp unlock` each path the matching pre acquired. |

### 5.2 Identity selector for the lock CLI

Hooks identify their session by passing `--as session:<8>` to `swarm-mcp lock`
/ `unlock`. The CLI resolves `--as` by:

1. Full UUID
2. UUID prefix
3. Unique substring of the instance label

The plugin's derived label always contains `session:<8>` (first 8 hex chars of
the Claude Code session_id with hyphens stripped), so as long as the agent
registered with the priming label, the substring match resolves to exactly
this session's instance. Collisions on the first 8 chars within the same
scope are vanishingly unlikely; if they happen, the CLI errors as ambiguous
and the lock fails open (no deny).

### 5.3 Failure semantics (matches hermes)

- **Fail-open by default.** CLI missing, network/db error, identity
  ambiguous → tool proceeds without a lock. Coordination is opt-in.
- **Block on real conflicts.** When `swarm-mcp lock` fails with output
  containing `locked` or `lock conflict`, emit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"swarm lock blocked ..."}}`.
- **Solo sessions skip locking entirely.** `has_peers` checks
  `swarm-mcp instances` first; if the count of peers (excluding ourselves)
  is zero, no lock attempt.

### 5.4 Lock tracking across pre/post

Claude Code does not expose a stable `tool_call_id` to hooks. We key the
PreToolUse-PostToolUse pair on `(tool_name, |joined_paths)` instead — same
shape the tool input has either way. Stored under
`$TMPDIR/swarm-cc/<session_id>/locks-<key>.json`. Cleared in PostToolUse.

If a tool is denied in PreToolUse, PostToolUse never fires (Claude Code skips
it for denied tools), so there is no lock to release.

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

## 7. Why no plugin-local `swarm_prompt_peer` tool here

The hermes plugin registers `swarm_prompt_peer` because it can — hermes
exposes `ctx.register_tool` to plugins. Claude Code does not allow plugins to
inject ad-hoc tools into a hosted session; the only way to add tools is to
ship an MCP server in the plugin.

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

**S3: Lock conflict (the v0.1 contract)**
Peer A holds a swarm lock on `notes.md` (`swarm-mcp lock notes.md`). Peer B
(Claude Code) attempts an `Edit` on the same path. The Edit tool should be
denied with a message containing `swarm lock blocked Edit for ... File is
already locked`. Target file is **not** modified.

**S4: Concurrent peer write releases**
Two Claude Code sessions in shared scope, no manual locks. Both edit
different files. Each lock is acquired pre, released post. After the turns,
`swarm-mcp locks` shows no residual locks.

**S5: /swarm status**
`/swarm` inside a registered session prints a compact summary listing
instance count, task counts, kv key count, and recent message count.

**S6: SessionEnd identity cleanup**
With `HERDR_PANE_ID` set and the agent having published
`identity/workspace/herdr/<id>`, exiting the session should result in
`swarm-mcp kv get identity/workspace/herdr/<id>` returning empty/error.

### 8.2 Mocked unit tests

Current shared-core tests cover autonomous registration, fallback context,
SessionEnd cleanup/deregister, and gateway write blocking. Additional cases
that still deserve coverage:
- Lock conflict detection on stderr substring `locked`
- `has_peers` returning false on solo (1 instance) scope
- `as_selector` falling back to `None` for empty session_id
- PostToolUse skipping when no scratch file exists (denied or non-write tool)
- Label derivation with and without override / identity token

## 9. Design decisions

**Why register through the CLI instead of the MCP tool?**
Claude Code hooks run as subprocesses and cannot reach the hosted session's
MCP tool surface. The hook shells to `swarm-mcp register`, stores the returned
`instance_id` in scratch metadata, and injects context so the model can start
with `bootstrap` instead of spending its first action on manual registration.

**Why pass `--as session:<8>` instead of caching the `instance_id`?**
Older versions used `--as session:<8>` because the hook did not know the
`instance_id`. v0.2 stores `instance_id` from CLI registration in scratch
metadata and uses that for lock/unlock. The session substring remains a
fallback when metadata is missing.

**Why fail-open on non-conflict errors?**
Same reason as hermes: a swarm outage shouldn't tank productive editing.
Lock conflicts are exactly what the user wanted protection from; everything
else is bonus.

**Why no `pre_compact` / `subagent_stop` integration?**
Out of scope for v0.1. The hermes plugin's `subagent_stop` bridge maps a
sub-agent prompt back to a swarm task; the same idea applies to Claude
Code's `SubagentStop` hook but requires the sub-agent prompt to carry a task
id, which the bundled skill doesn't currently do. Tracked as v0.5+.

## 10. Upstream tightenings recommended for swarm-mcp

These overlap with the hermes SPEC §12 list. Restating only the ones that
unblock this adapter specifically:

- **Exclusive lock semantics (already on the hermes list).** Not strictly
  required for this plugin, but if added, makes the hook's deny path more
  precise without needing the substring `locked` heuristic.
- **First-class in-agent dispatch/spawn orchestration.** Implemented via the
  swarm MCP `dispatch` tool. Keep the CLI bridge for hooks, wrappers, operator
  shells, and fallback sessions where MCP tools are unavailable.
