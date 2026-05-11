# swarm Codex plugin — design notes

**Status:** v0.2.0 current
**Audience:** future contributors, the operator, agents reading this directory

This file captures the design constraints behind the Codex adapter so v0.2+
doesn't have to re-derive them from conversation. The broader adapter contract
lives in [`../../../../docs/control-plane.md`](../../../../docs/control-plane.md);
parallel designs are at [`../../../hermes/SPEC.md`](../../../hermes/SPEC.md)
and [`../../../claude-code/SPEC.md`](../../../claude-code/SPEC.md).

## 1. Three-layer model

Identical to hermes and Claude Code — the layers compose by name (`mcp_swarm_*`
tool prefix inside a session, `swarm-mcp` CLI outside it), not by import:

```
┌──────────────────────────────────────────────┐
│  Skill (skills/swarm-mcp/SKILL.md)           │   doctrine
│   when to lock, role routing, task patterns
├──────────────────────────────────────────────┤
│  Plugin (integrations/codex/plugins/swarm/)  │   behavior
│   SessionStart register, peer-lock check, /swarm
├──────────────────────────────────────────────┤
│  MCP server (src/index.ts)                   │   capability
│   29 tools: register, lock_file, request_task...
└──────────────────────────────────────────────┘
```

## 2. Shared hook core

The runtime-agnostic implementation of every hook lifecycle method —
swarm-mcp CLI resolution, identity/scope/label derivation, autonomous
registration, peer detection, session scratch, lock-pair tracking,
deny-on-conflict semantics, and herdr identity publication — lives in
[`../../../_shared/swarm_hook_core.py`](../../../_shared/swarm_hook_core.py)
as a `HookCore` class parameterized by `RuntimeConfig`.

Each plugin's `hooks/_common.py` instantiates `HookCore` with a runtime
config that captures the **only** four things that genuinely differ between
the Claude Code and Codex adapters:

| Knob | Claude Code | Codex |
|---|---|---|
| `runtime_name` (label token) | `claude-code` | `codex` |
| `env_prefix` (for `SWARM_<prefix>_*` aliases) | `CC` | `CODEX` |
| `scratch_dir_name` | `swarm-cc` | `swarm-codex` |
| `write_tools` | `{Write, Edit, MultiEdit, NotebookEdit}` | `{apply_patch}` |
| `extract_paths` | `tool_input.file_path` / `notebook_path` | parse `*** Begin Patch` envelope |

The four entry scripts (`session_start.py`, `session_end.py`,
`pre_tool_use.py`, `post_tool_use.py`) are short stubs that call
`core.run_*_hook(sys.stdin)`. `post_tool_use.py` is a no-op shim under
the current check-only lock model — see §4.1.

Hermes does not use this shared core because hermes' integration mechanism
is fundamentally different (in-process plugin API, not stdin-JSON
subprocess hooks). Hermes does duplicate a small bit of the patch-parsing
regex; if that grows, we can lift the parsing into a sub-helper of the
shared core that hermes also imports without taking on the rest of the
HookCore machinery.

## 3. Plugin shape vs. Claude Code

Codex's plugin model and Claude Code's plugin model are close-enough cousins
that a near-1:1 port works:

| Surface | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Hooks file | `hooks.json` (root or `hooks/`) | `hooks.json` (root) |
| Hook events | `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, … | `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, … |
| Slash commands | `commands/<name>.md` with frontmatter | `commands/<name>.md` with frontmatter |
| MCP servers | `.mcp.json` | `.mcp.json` |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| Hook command root | `${CLAUDE_PLUGIN_ROOT}` is available | Hook commands run from the session cwd; resolve scripts from `CODEX_HOME` / plugin cache |

What does *not* port cleanly:

1. **Tool surface.** Codex unifies file writes under a single `apply_patch`
   tool whose input is an `*** Begin Patch / *** End Patch` envelope — not a
   JSON `file_path` field like Claude Code's `Write`/`Edit`/`MultiEdit`/
   `NotebookEdit`. This plugin parses the envelope to recover the affected
   paths.
2. **Hook payload schema.** Claude Code documents the JSON shape of
   `tool_input`; codex does not (yet). v0.1 reads defensively — it accepts
   `tool_input` as either the patch string itself or a dict with the patch
   under `input`/`patch`/`text`/`arguments`. v0.2 will tighten once the
   contract is observed empirically.
3. **Hook root environment.** Claude Code exposes a plugin-root env var, but
   Codex plugin hooks should not depend on `CODEX_PLUGIN_ROOT`; marketplace
   plugin hook commands are executed from the session cwd. The hook manifest
   uses a small launcher that finds the installed plugin under `CODEX_HOME`
   or `~/.codex*` before executing the Python hook script.
4. **`additionalContext` semantics.** Claude Code reliably feeds the
   `additionalContext` JSON output back into the agent's system context.
   Codex's behavior here is treated as compatible-until-proven-otherwise; if
   it is silently ignored, the bundled `swarm-mcp` skill still drives
   registration via doctrine, so the v0.1 contract degrades gracefully.

## 4. Lifecycle contracts (v0.1)

### 4.1 Hook firing

| Hook | Fires | Plugin behavior |
|---|---|---|
| `SessionStart` (matcher: `startup\|resume`) | New or resumed conversation | Compute label/scope/identity; call `swarm-mcp register`; write per-session scratch metadata including `instance_id`; publish `identity/workspace/herdr/<instance_id>` if `HERDR_PANE_ID` is present; emit `additionalContext` telling the agent it is registered and should follow the swarm role workflow. |
| `Stop` | Conversation ends | Best-effort `kv del identity/workspace/herdr/<instance_id>`; `swarm-mcp deregister`; clear the session scratch dir. |
| `PreToolUse` (matcher: `apply_patch`) | Before each `apply_patch` dispatch | Parse the patch envelope; read-only check via `swarm-mcp locks --scope <s> --json`. If any returned lock row targets one of the patch's files and is held by an `instance_id` other than ours, emit `permissionDecision: deny`. Never acquires a lock. |
| `PostToolUse` | — | **Not wired in new installs.** A no-op stub remains in the plugin source so already-installed configs that still register `PostToolUse` keep loading; new `hooks.json` omits the entry. |

### 4.2 Why check-only (no acquire/release pair)

Earlier drafts had `PreToolUse` acquire a lock and `PostToolUse` release it,
framed as "concurrent edit protection." That protection was largely
illusory under codex's tool surface in particular:

- `apply_patch` is itself the atomic unit codex offers for file changes —
  there is no Read → Edit gap inside a single patch call that another
  agent could slip into. The OS already serializes the filesystem write.
- The patch envelope's contextual hunks fail loudly when the source text
  has shifted, so logical mid-air collisions surface without needing a
  swarm lock.
- The acquire/release pair ran on every patch, costing two CLI calls plus
  scratch state, while only actually protecting against a peer
  simultaneously calling `apply_patch` on the same file — a race that
  doesn't happen at human-paced LLM agent dispatch.

What manual `lock_file` (called by the agent for a wider critical section
across multiple `apply_patch` calls or a long refactor) *does* need is
enforcement. The check-only hook is what enforces those declarations.
Same-instance locks pass through so the declaring agent's own subsequent
patches against its reservation succeed.

### 4.3 Failure semantics (matches hermes / claude-code)

- **Fail-open by default.** CLI missing, network/db error, unknown own
  `instance_id` → tool proceeds without a check. Coordination is opt-in.
- **Block on real conflicts.** When `swarm-mcp locks --json` returns a row
  for one of the patch's paths whose `instance_id` is not ours, emit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"swarm lock blocked ..."}}`.
- **Solo sessions are implicit.** With no peer in scope, the `locks` list
  is empty (or only contains this session's own locks), so the check
  short-circuits without a separate `has_peers` probe.

### 4.4 Own-vs-peer identification

The hook reads its own `instance_id` from per-session scratch metadata
(written by `SessionStart` after `swarm-mcp register` succeeds) and treats
any lock row with a different `instance_id` as a peer conflict. If scratch
metadata has no `instance_id` (e.g. registration failed earlier in the
session), the hook fails open.

## 5. apply_patch envelope parsing

Codex's `apply_patch` tool input looks like:

```
*** Begin Patch
*** Update File: path/to/existing.py
@@
- old line
+ new line
*** Add File: path/to/new.md
+# Hello
*** Delete File: path/to/old.txt
*** Move File: a.txt -> b.txt
*** End Patch
```

The plugin extracts paths via two regexes (`Update|Add|Delete File:` and
`Move File: <from> -> <to>`), de-duplicates, and resolves to absolute paths
against `cwd`. Both ends of a `Move File:` are locked because either rename
endpoint can collide with a peer.

Edge cases handled:

- Patch text passed as the raw string vs. nested under `input` / `patch` /
  `text` / `arguments` in a dict.
- Whitespace around the path.
- Non-`apply_patch` tool calls — return `[]` immediately, before parsing.

Edge cases **not** handled in v0.1 (intentional):

- Patches inside `exec_command` shell input (e.g. heredoc'd `git apply`).
  These are out of scope; the peer-lock check only covers the dedicated
  write tool.
- Symlinks that resolve outside `cwd`. The hook compares the path string
  from the patch envelope to the `file` column on each lock row; a path
  traversal in the envelope would simply not match any swarm lock, but
  that's already the user's blast radius.

## 6. Identity, scope, labels

Same shape as hermes and Claude Code:

- `instance_id` — UUIDv4, one per registered session. Lives in the swarm DB.
- `scope` — coordination boundary. Default: git root of `cwd`. Override via
  `SWARM_CODEX_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE`.
- `label` — auto-built as
  `[identity:<id>] codex platform:cli [mode:gateway] [role:<name>]
  origin:codex session:<id-prefix>`. Override via `SWARM_CODEX_LABEL` /
  `SWARM_HERMES_LABEL`. If the override omits `identity:`, the derived token
  is prepended. `mode:gateway` is behavior metadata; `role:planner` is the
  swarm-visible routing label.

Five-identifier invariants from hermes SPEC §6.5 carry over: tasks/messages/
locks target `instance_id`; UI/control surfaces target transport handles;
user-facing text uses labels.

## 7. Why no plugin-local `swarm_prompt_peer` tool here

Same answer as the Claude Code plugin: the right home for `prompt_peer` is
the swarm-mcp server itself plus the `swarm-mcp prompt-peer` CLI. Adding it
there benefits every adapter (hermes, Claude Code, Codex, OpenCode, future
runtimes) at once, and hook/launcher code can use the CLI when it cannot call
MCP tools directly.

## 8. Testing

### 8.1 Smoke scenarios (live, must pass)

**S1: Single-agent registration**
Fresh Codex CLI session in a git repo with the plugin installed. SessionStart
should call `swarm-mcp register`, store the returned `instance_id`, and inject
context saying the session is already registered. Confirm `swarm-mcp
instances` shows the session before the agent spends a tool call on
registration.

**S2: Solo write does not lock**
Single session, no peers in scope. Apply any patch. `swarm-mcp locks`
should show no lock entries during or after the edit.

**S3: Lock conflict (the v0.1 contract)**
Peer A holds a swarm lock on `notes.md` (`swarm-mcp lock notes.md`). Peer B
(codex) runs `apply_patch` touching the same path. The `apply_patch` tool
should be denied with a message containing `swarm lock blocked apply_patch
for ... locked`. Target file is **not** modified.

**S4: Concurrent peer write releases**
Two codex sessions in shared scope, no manual locks. Both apply patches
on different files. Each lock is acquired pre, released post. After the
turns, `swarm-mcp locks` shows no residual locks.

**S5: /swarm status**
`/swarm` inside a registered session prints a compact summary listing
instance count, task counts, kv key count, and recent message count.

**S6: Stop identity cleanup**
With `HERDR_PANE_ID` set and the agent having published
`identity/workspace/herdr/<id>`, exiting the session should result in
`swarm-mcp kv get identity/workspace/herdr/<id>` returning empty/error.

### 8.2 Local unit smoke (already passing)

```sh
# label derivation + autonomous registration fallback
AGENT_IDENTITY=personal HERDR_PANE_ID=p_5 \
    HERDR_SOCKET_PATH=/path/to/herdr.sock \
    echo '{"session_id":"019ddc7a-1681-7b91-b95f-4ba467848376","cwd":"...","source":"startup"}' | \
    python3 hooks/session_start.py

# patch envelope parsing
python3 -c "
import _common
patch = '*** Begin Patch\n*** Update File: x.py\n*** Add File: y.md\n*** Move File: a -> b\n*** End Patch'
print(_common.write_paths_for_tool('apply_patch', {'input': patch}))
"
```

## 9. Design decisions

**Why register through the CLI instead of the MCP tool?**
Codex hooks run as subprocesses and cannot reach the hosted session's MCP tool
surface. The hook shells to `swarm-mcp register`, stores the returned
`instance_id` in scratch metadata, and injects context so the model can start
with `bootstrap` instead of spending its first action on manual registration.

**Why keep `--as session:<8>` when we cache the `instance_id`?**
The session substring is a fallback when metadata is missing or when a clear /
compact event refreshed scratch state without a fresh registration call. The
normal v0.2 path stores `instance_id` from CLI registration.

**Why parse `apply_patch` instead of locking the whole repo on any write?**
Coarse locks would block productive editing in solo or near-solo sessions
where collisions are unlikely. Path-level locks scale to multiple agents on
disjoint files in the same scope, which is the common case.

**Why fail-open on non-conflict errors?**
Same reason as the other plugins: a swarm outage shouldn't block productive
editing. Lock conflicts are the case the user wanted protection from;
everything else is best-effort.

## 10. Upstream tightenings recommended for swarm-mcp

Same list as the Claude Code SPEC; restating the codex-specific ones:

- **First-class in-agent dispatch/spawn orchestration.** Implemented via the
  swarm MCP `dispatch` tool. Keep the CLI bridge for hooks, wrappers, operator
  shells, and fallback sessions where MCP tools are unavailable.
- **Empirical hook contract documentation.** Once codex commits to a
  documented PreToolUse / PostToolUse payload schema, the defensive parsing
  in `_common.write_paths_for_tool` can simplify.
