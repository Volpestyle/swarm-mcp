# swarm Codex plugin — design notes

**Status:** v0.1.0 current
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
│   SessionStart prime, lock bridge, /swarm
├──────────────────────────────────────────────┤
│  MCP server (src/index.ts)                   │   capability
│   29 tools: register, lock_file, request_task...
└──────────────────────────────────────────────┘
```

## 2. Shared hook core

The runtime-agnostic implementation of every hook lifecycle method —
swarm-mcp CLI resolution, identity/scope/label derivation, peer detection,
session scratch, lock-pair tracking, deny-on-conflict semantics, herdr
identity prime — lives in
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
| `auto_lock_note` | `claude-code auto-lock before write` | `codex auto-lock before apply_patch` |

The four entry scripts (`session_start.py`, `session_end.py`,
`pre_tool_use.py`, `post_tool_use.py`) are 12-line stubs that just call
`core.run_*_hook(sys.stdin)`.

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
| Hook events | `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, … | Same names; codex feature flag `CodexHooks` enables them |
| Slash commands | `commands/<name>.md` with frontmatter | `commands/<name>.md` with frontmatter |
| MCP servers | `.mcp.json` | `.mcp.json` |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| Hook env root | `${CLAUDE_PLUGIN_ROOT}` | `${CODEX_PLUGIN_ROOT}` |

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
3. **`additionalContext` semantics.** Claude Code reliably feeds the
   `additionalContext` JSON output back into the agent's system context.
   Codex's behavior here is treated as compatible-until-proven-otherwise; if
   it is silently ignored, the bundled `swarm-mcp` skill still drives
   registration via doctrine, so the v0.1 contract degrades gracefully.

## 4. Lifecycle contracts (v0.1)

### 4.1 Hook firing

| Hook | Fires | Plugin behavior |
|---|---|---|
| `SessionStart` (matcher: `startup\|resume`) | New or resumed conversation | Compute label/scope/identity; write per-session scratch metadata; emit `additionalContext` instructing the agent to call `register` with those args. If `HERDR_PANE_ID` is present, instruct the agent to also publish `identity/herdr/<instance_id>` after registering. |
| `SessionEnd` | Conversation ends | Best-effort `kv del identity/herdr/<instance_id>`; clear the session scratch dir. |
| `PreToolUse` (matcher: `apply_patch`) | Before each `apply_patch` dispatch | Parse the patch envelope; if peers exist in scope, `swarm-mcp lock` each path. On conflict, emit `permissionDecision: deny`. |
| `PostToolUse` (matcher: `apply_patch`) | After each `apply_patch` dispatch | `swarm-mcp unlock` each path the matching pre acquired. |

### 4.2 Identity selector for the lock CLI

Hooks identify their session by passing `--as session:<8>` to `swarm-mcp lock`
/ `unlock`. The CLI resolves `--as` by:

1. Full UUID
2. UUID prefix
3. Unique substring of the instance label

The plugin's derived label always contains `session:<8>` (first 8 chars of
the codex `session_id` with hyphens stripped — codex's session_id is a
ULID-shaped string but the substring approach is identical), so as long as
the agent registered with the priming label, the substring match resolves to
exactly this session's instance.

### 4.3 Failure semantics (matches hermes / claude-code)

- **Fail-open by default.** CLI missing, network/db error, identity
  ambiguous → tool proceeds without a lock.
- **Block on real conflicts.** When `swarm-mcp lock` fails with output
  containing `locked` or `lock conflict`, emit
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"swarm lock blocked ..."}}`.
- **Solo sessions skip locking entirely.** `has_peers` checks
  `swarm-mcp instances` first; if the count of peers (excluding ourselves)
  is zero, no lock attempt.

### 4.4 Lock tracking across pre/post

Codex does not expose a stable `tool_call_id` to hooks. We key the
PreToolUse-PostToolUse pair on `(tool_name, |joined_paths)`, where
`joined_paths` is derived deterministically from the patch envelope. Stored
under `$TMPDIR/swarm-codex/<session_id>/locks-<key>.json`. Cleared in
PostToolUse.

If a tool is denied in PreToolUse, PostToolUse should not fire (matching
Claude Code's behavior); even if codex differs here, the post hook is a
no-op when no scratch entry exists.

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
  These are out of scope; the lock bridge only covers the dedicated write
  tool.
- Symlinks that resolve outside `cwd`. Lock keys use the resolved absolute
  path; a path traversal in the patch envelope itself would lock a strange
  file, but that's already the user's blast radius.

## 6. Identity, scope, labels

Same shape as hermes and Claude Code:

- `instance_id` — UUIDv4, one per registered session. Lives in the swarm DB.
- `scope` — coordination boundary. Default: git root of `cwd`. Override via
  `SWARM_CODEX_SCOPE` / `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE`.
- `label` — auto-built as
  `[identity:<id>] codex platform:cli session:<id-prefix>`. Override via
  `SWARM_CODEX_LABEL` / `SWARM_HERMES_LABEL`. If the override omits
  `identity:`, the derived token is prepended.

Five-identifier invariants from hermes SPEC §6.5 carry over: tasks/messages/
locks target `instance_id`; UI/control surfaces target transport handles;
user-facing text uses labels.

## 7. Why no `swarm_prompt_peer` tool here

Same answer as the Claude Code plugin: the right home for `prompt_peer` is
the swarm-mcp server itself. Adding it there benefits every adapter (hermes,
Claude Code, Codex, OpenCode, future runtimes) at once. Tracked as v0.3.

## 8. Testing

### 8.1 Smoke scenarios (live, must pass)

**S1: Single-agent registration prime**
Fresh Codex CLI session in a git repo with the plugin installed. SessionStart
`additionalContext` should appear in the first user turn, instructing
`register` with a derived label. Confirm `swarm-mcp instances` shows the
session after the agent acts on the prompt.

**S2: Solo write does not lock**
Single session, no peers in scope. Apply any patch. `swarm-mcp context`
should show no lock entries during or after the edit.

**S3: Lock conflict (the v0.1 contract)**
Peer A holds a swarm lock on `notes.md` (`swarm-mcp lock notes.md`). Peer B
(codex) runs `apply_patch` touching the same path. The `apply_patch` tool
should be denied with a message containing `swarm lock blocked apply_patch
for ... locked`. Target file is **not** modified.

**S4: Concurrent peer write releases**
Two codex sessions in shared scope, no manual locks. Both apply patches
on different files. Each lock is acquired pre, released post. After the
turns, `swarm-mcp context` shows no residual locks.

**S5: /swarm status**
`/swarm` inside a registered session prints a compact summary listing
instance count, task counts, kv key count, and recent message count.

**S6: SessionEnd identity cleanup**
With `HERDR_PANE_ID` set and the agent having published
`identity/herdr/<id>`, exiting the session should result in
`swarm-mcp kv get identity/herdr/<id>` returning empty/error.

### 8.2 Local unit smoke (already passing)

```sh
# label derivation + herdr identity prime
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

**Why register via `additionalContext` instead of calling `register` from the
hook?**
Same reason as the Claude Code plugin: there is no `swarm-mcp register` CLI
subcommand today, and hooks cannot reach the agent's MCP tool surface.
Priming the agent is the cleanest path that ships value now.

**Why pass `--as session:<8>` instead of caching the `instance_id`?**
Same reason: the hook doesn't know the `instance_id` at lock time. The agent
only learns it from `register`'s response, and codex doesn't expose a way to
capture that into a hook-readable file. The CLI's substring resolution makes
the label do the work.

**Why parse `apply_patch` instead of locking the whole repo on any write?**
Coarse locks would block productive editing in solo or near-solo sessions
where collisions are unlikely. Path-level locks scale to multiple agents on
disjoint files in the same scope, which is the common case.

**Why fail-open on non-conflict errors?**
Same reason as the other plugins: a swarm outage shouldn't tank productive
editing. Lock conflicts are exactly what the user wanted protection from;
everything else is bonus.

## 10. Upstream tightenings recommended for swarm-mcp

Same list as the Claude Code SPEC; restating the codex-specific ones:

- **`swarm-mcp register` / `deregister` / `list-instances` CLI subcommands.**
  Highest-leverage change; lets SessionStart hooks be fully autonomous.
- **`prompt_peer` MCP tool.** See §7.
- **Empirical hook contract documentation.** Once codex commits to a
  documented PreToolUse / PostToolUse payload schema, the defensive parsing
  in `_common.write_paths_for_tool` can simplify.
