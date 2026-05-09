# swarm Claude Code plugin — design notes

**Status:** v0.1.0 current
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
│   SessionStart prime, lock bridge, /swarm
├──────────────────────────────────────────────┤
│  MCP server (src/index.ts)                   │   capability
│   29 tools: register, lock_file, request_task...
└──────────────────────────────────────────────┘
```

## 2. Why this plugin is leaner than hermes

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

| Hermes-plugin responsibility | Claude Code plugin v0.1 |
|---|---|
| Auto-register via `mcp_swarm_register` | Inject `additionalContext` priming the agent to call `register`; the bundled `swarm-mcp` skill drives it. Auto-call requires upstream CLI subcommands (v0.2). |
| Auto-deregister | Best-effort herdr-identity KV cleanup; deregister waits on either the agent or stale-prune. |
| Auto-lock + auto-unlock | Same — shell to `swarm-mcp lock` / `unlock`. |
| Block on lock conflict | Same — emit `permissionDecision: deny`. |
| `/swarm` slash command | Markdown command; same shape, slightly different surface. |
| `swarm_prompt_peer` tool | Not implemented here. Right home is the swarm MCP server itself. |
| Herdr identity publish on session start | Inline in the `additionalContext` instructing the agent (chicken-and-egg: `kv_set` needs the `instance_id` register returns). |

## 3. CLI surface required for full autonomy

Today the swarm-mcp CLI exposes `lock`, `unlock`, `kv`, `send`, `broadcast`,
`inspect`, `instances`, `tasks`, `messages`, `context`, and `ui`. It does
**not** expose `register`, `deregister`, or `list_instances` as standalone
subcommands.

Adding those would let this plugin (and any other shell-hook-based adapter)
drop the `additionalContext` priming and become fully autonomous. Sketch:

```text
swarm-mcp register --label "..." --directory "$cwd" \
    [--scope <path>] [--file-root <path>] [--json]
    # prints { instance_id, scope, ... }; sets SWARM_MCP_INSTANCE_ID-style
    # output that hooks can capture into a session scratch file

swarm-mcp deregister [--as <who>] [--scope <path>]

swarm-mcp list-instances [--scope <path>] [--json]
    # already partially exposed as `instances`; just normalize the name
```

Ownership of stale instances stays unchanged — the existing prune-on-call
guarantee covers crash recovery for both adapters.

## 4. Lifecycle contracts (v0.1)

### 4.1 Hook firing

| Hook | Fires | Plugin behavior |
|---|---|---|
| `SessionStart` (source=startup or resume) | New or resumed conversation | Compute label/scope/identity; write per-session scratch metadata; emit `additionalContext` instructing the agent to call `register` with those args. If `HERDR_PANE_ID` is present, instruct the agent to also publish `identity/herdr/<instance_id>` after registering. |
| `SessionStart` (source=clear or compact) | Mid-session reset | Refresh metadata only; do not re-prompt registration. |
| `SessionEnd` | Conversation ends | Best-effort `kv del identity/herdr/<instance_id>`; clear the session scratch dir. |
| `PreToolUse` (matcher: `Write\|Edit\|MultiEdit\|NotebookEdit`) | Before each write-class tool dispatch | If peers exist in scope, `swarm-mcp lock` each path. On conflict, emit `permissionDecision: deny`. |
| `PostToolUse` (same matcher) | After each write-class tool dispatch | `swarm-mcp unlock` each path the matching pre acquired. |

### 4.2 Identity selector for the lock CLI

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

### 4.3 Failure semantics (matches hermes)

- **Fail-open by default.** CLI missing, network/db error, identity
  ambiguous → tool proceeds without a lock. Coordination is opt-in.
- **Block on real conflicts.** When `swarm-mcp lock` fails with output
  containing `locked` or `lock conflict`, emit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"swarm lock blocked ..."}}`.
- **Solo sessions skip locking entirely.** `has_peers` checks
  `swarm-mcp instances` first; if the count of peers (excluding ourselves)
  is zero, no lock attempt.

### 4.4 Lock tracking across pre/post

Claude Code does not expose a stable `tool_call_id` to hooks. We key the
PreToolUse-PostToolUse pair on `(tool_name, |joined_paths)` instead — same
shape the tool input has either way. Stored under
`$TMPDIR/swarm-cc/<session_id>/locks-<key>.json`. Cleared in PostToolUse.

If a tool is denied in PreToolUse, PostToolUse never fires (Claude Code skips
it for denied tools), so there is no lock to release.

## 5. Identity, scope, labels

Same shape as hermes:

- `instance_id` — UUIDv4, one per registered session. Lives in the swarm DB.
- `scope` — coordination boundary. Default: git root of `cwd`. Override via
  `SWARM_CC_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE`.
- `label` — auto-built as
  `[identity:<id>] claude-code platform:cli session:<id-prefix>`. Override
  via `SWARM_CC_LABEL` / `SWARM_HERMES_LABEL`. If the override omits
  `identity:`, the derived token is prepended.

The five-identifier invariants from hermes SPEC §6.5 carry over without
modification: tasks/messages/locks target `instance_id`; UI/control surfaces
target transport handles; user-facing text uses labels.

## 6. Why no `swarm_prompt_peer` tool here

The hermes plugin registers `swarm_prompt_peer` because it can — hermes
exposes `ctx.register_tool` to plugins. Claude Code does not allow plugins to
inject ad-hoc tools into a hosted session; the only way to add tools is to
ship an MCP server in the plugin.

The right architectural answer is to add a `prompt_peer` tool to the
swarm-mcp server itself. It's adapter-neutral (hermes, Claude Code, Codex,
OpenCode, any future runtime gets it for free), and it lives next to the
durable `send_message` it composes with. Tracked as v0.3.

The fallback inside Claude Code today is the regular `send_message` MCP tool
plus a manual `! herdr pane run <pane> "<wake prompt>"` invocation. Workable
for one-offs; not worth wrapping until the upstream tool exists.

## 7. Testing

### 7.1 Smoke scenarios (live, must pass)

**S1: Single-agent registration prime**
Fresh Claude Code session in a git repo. SessionStart additionalContext
should appear in the first user turn, instructing `register` with a derived
label. Confirm `swarm-mcp instances` shows the session after the agent acts
on the prompt.

**S2: Solo write does not lock**
Single session, no peers in scope. Edit any file. `swarm-mcp context` should
show no lock entries during or after the edit.

**S3: Lock conflict (the v0.1 contract)**
Peer A holds a swarm lock on `notes.md` (`swarm-mcp lock notes.md`). Peer B
(Claude Code) attempts an `Edit` on the same path. The Edit tool should be
denied with a message containing `swarm lock blocked Edit for ... File is
already locked`. Target file is **not** modified.

**S4: Concurrent peer write releases**
Two Claude Code sessions in shared scope, no manual locks. Both edit
different files. Each lock is acquired pre, released post. After the turns,
`swarm-mcp context` shows no residual locks.

**S5: /swarm status**
`/swarm` inside a registered session prints a compact summary listing
instance count, task counts, kv key count, and recent message count.

**S6: SessionEnd identity cleanup**
With `HERDR_PANE_ID` set and the agent having published
`identity/herdr/<id>`, exiting the session should result in
`swarm-mcp kv get identity/herdr/<id>` returning empty/error.

### 7.2 Mocked unit tests (future)

When/if these are added, they should cover:
- Lock conflict detection on stderr substring `locked`
- `has_peers` returning false on solo (1 instance) scope
- `as_selector` falling back to `None` for empty session_id
- PostToolUse skipping when no scratch file exists (denied or non-write tool)
- Label derivation with and without override / identity token

## 8. Design decisions

**Why prime registration via `additionalContext` instead of calling
`register` from the hook?**
Because there is no `swarm-mcp register` CLI subcommand today, and the hook
cannot reach the agent's MCP tool surface. Priming the agent is the cleanest
path that ships value now without touching swarm-mcp internals. Adding the
CLI subcommand is the v0.2 follow-up.

**Why pass `--as session:<8>` instead of caching the `instance_id`?**
Because the hook doesn't know the `instance_id` at the time it shells to
`lock`. The agent only learns it from `register`'s response, and Claude Code
doesn't expose a way to capture that into a hook-readable file. The CLI's
substring resolution makes the label do the work.

**Why fail-open on non-conflict errors?**
Same reason as hermes: a swarm outage shouldn't tank productive editing.
Lock conflicts are exactly what the user wanted protection from; everything
else is bonus.

**Why no `pre_compact` / `subagent_stop` integration?**
Out of scope for v0.1. The hermes plugin's `subagent_stop` bridge maps a
sub-agent prompt back to a swarm task; the same idea applies to Claude
Code's `SubagentStop` hook but requires the sub-agent prompt to carry a task
id, which the bundled skill doesn't currently do. Tracked as v0.5+.

## 9. Upstream tightenings recommended for swarm-mcp

These overlap with the hermes SPEC §12 list. Restating only the ones that
unblock this adapter specifically:

- **`swarm-mcp register` / `deregister` / `list-instances` CLI subcommands.**
  Highest-leverage change for shell-hook-based adapters. Removes the
  `additionalContext` priming step and lets SessionStart hooks be fully
  autonomous.
- **`prompt_peer` MCP tool.** See §6.
- **Exclusive lock semantics (already on the hermes list).** Not strictly
  required for this plugin, but if added, makes the hook's deny path more
  precise without needing the substring `locked` heuristic.
