# swarm hermes plugin — design spec

**Status:** v0.3.0 current, v0.4+ planned
**Audience:** future contributors, the operator, and any agent reading this directory

This doc captures the architecture behind the `swarm` Hermes plugin so future versions don't have to re-derive it from conversation. The broader adapter contract lives in [`../../docs/control-plane.md`](../../docs/control-plane.md); this file is the Hermes/herdr-first reference stack spec.

## 1. What this is

A behavioral bridge between three independent systems:

- **hermes-agent** — the agent runtime that hosts the plugin
- **swarm-mcp** — the coordination protocol/server, registered with hermes as `swarm`
- **herdr** — terminal multiplexer; the operator's view onto running agents

The plugin is **not** a feature in any of those projects. It glues them.

## 2. Three-layer model

```
┌──────────────────────────────────────────────┐
│  Skill (skills/swarm-mcp/SKILL.md)           │   doctrine
│   when to lock, role routing, task patterns
├──────────────────────────────────────────────┤
│  Plugin (integrations/hermes/)               │   behavior
│   lifecycle hooks, lock bridge, /swarm cmd, peer prompt
├──────────────────────────────────────────────┤
│  MCP server (src/index.ts)                   │   capability
│   29 tools: register, lock_file, request_task...
└──────────────────────────────────────────────┘
```

Each layer answers a different question:
- *Capability*: "what can I do?" → MCP server's tool list
- *Behavior*: "what happens automatically?" → Plugin's hooks
- *Doctrine*: "when should I do which?" → Skill's role guidance

Layers compose by name (`mcp_swarm_*` tool prefix), not by import. The plugin never reimplements MCP-server functionality; the skill never prescribes implementation.

## 3. Where each piece sits in the wider system

### 3.1 Layer roles

| Component | Role | Owns |
|---|---|---|
| swarm-mcp | Coordination protocol | Tasks, locks, messages, kv, identity. Durable, structured, portable. |
| herdr | Operator surface + transport | Pane lifecycle, visibility, direct pty I/O. Local + remote (via bridge), ephemeral, fast. |
| hermes-agent | Agent runtime | Conversation, tool dispatch, system prompt. |
| **This plugin** | Bridge | Auto-register, auto-lock, role-aware behavior, slash command, peer prompt express lane. |

These are not redundant. herdr gives transport + observability; swarm-mcp gives semantics + durability. Either alone leaves a gap. The plugin glues a hermes session into both.

### 3.2 Universal PTY owner: herdr

herdr owns local PTYs and workspace control across **all** operator surfaces — laptop CLI, mobile app, future desktop UI. This is a deliberate choice: one PTY owner per live worker eliminates the failure mode where two systems independently spawn or claim the same conceptual worker.

swarm-mcp's `swarm-server` component (`apps/swarm-server/`, with iOS pairing, HTTPS/WSS, native PTY streaming, Swift packages) is **reference / non-primary** — its design solved adjacent problems and remains useful source material (notably the SwarmPairing package), but it is not in the critical path.

The cross-layer durable identity is swarm-mcp `instance_id`. herdr `pane_id` is the active transport/UI handle. swarm-server `pty_id`, when it appears at all, is reference-only.

### 3.3 Mobile/remote operator access

The iOS app (and any future remote operator surface) is a **herdr client** — same socket protocol as the local CLI, just over network transport.

**v1 (recommended): Tailscale + bridge daemon.** Phone joins the user's tailnet. A small daemon on the host running herdr exposes the herdr Unix socket as TCP/WSS. The daemon does only protocol translation (unix-socket ⇄ network); Tailscale handles auth, encryption, and NAT traversal. Bind the listener to the Tailscale interface only, or to localhost behind `tailscale serve`.

The bridge daemon is unavoidable: iOS clients literally cannot speak Unix sockets. Tailscale removes the *security* layer of the work, not the *protocol* layer.

**v2 upgrade paths (later, optional):**
- Native network mode in herdr — TCP/WSS listener with Bonjour/PSK pairing (eliminates Tailscale dependency)
- Reuse swarm-server's existing iOS pairing + transport code as the bridge — port `apps/swarm-ios/Packages/SwarmPairing/` to drive that pairing flow against herdr's socket

**Streaming gap (must address for full iPhone UX):** herdr's current socket is a *control* API — `pane.read` (snapshot), `pane.send_input`, lifecycle events, output-match events, status events. For continuous terminal output (live scrollback, animations, REPL feedback), herdr needs `pane.output_stream` or raw PTY frame streaming, plus resize. v1 ships with snapshot-control; full terminal UX is a later milestone (see §9 mobile/iOS track).

## 4. Topology with the Telegram gateway

```
you (phone) ──Telegram──▶ [hermes-gateway]   (always-on host)
                                │
                                ├──▶ swarm-mcp (coordination fabric)
                                │
                                └──▶ herdr ──▶ [hermes/claude/codex workers]
                                       │            in panes (local or remote host)
                                       │
                                       └─◀ iOS app (via bridge daemon, §3.3)
```

Two distinct hermes roles:
- **gateway** — your voice. Translates intent, summarizes results, holds long-running context. Always-on.
- **worker** — does the editing. Lives in herdr panes. Comes and goes.

swarm-mcp is the fabric that makes them appear as one system. The plugin's behavior differs by which side it runs on (§7).

**Out of scope for v1:** "remote runners" without a herdr host (raw Modal/Daytona/SSH workers spawned directly by the gateway, bypassing herdr). The §3.2 universal-PTY-owner commitment means workers always live inside a herdr instance — local or remote. Spawning a worker on a remote host eventually means herdr-on-that-host with the gateway driving its socket via the bridge daemon. That's an m3+ direction, not v1.

## 5. Lifecycle contracts

### 5.1 Hook firing

| Hook | Fires | Plugin behavior |
|---|---|---|
| `on_session_start` | First turn of a new session | Auto-`register`, cache instance_id |
| `on_session_end` | After **every** `run_conversation()` turn | No-op (intentionally) |
| `on_session_finalize` | Real session boundary (`/new`, `/reset`, exit, gateway expiry) | Auto-`deregister` if refcount → 0 |
| `pre_tool_call` | Before tool dispatch | Auto-`lock_file` if peers + write-class tool |
| `post_tool_call` | After tool dispatch (success or error) | Release any locks acquired in pre |

### 5.2 Idempotency

- `on_session_start` keyed by `session_id`; re-entrant.
- `on_session_finalize` decrements a refcount; deregister only when count reaches zero.
- `pre`/`post` lock pairs keyed by `tool_call_id`; post finds pre's locks even if `args` mutated.

### 5.3 Failure semantics

All swarm-mcp interactions are **fail-open** except actual peer lock conflicts:
- Register fails → session has no swarm presence; agent-initiated `register` still works.
- Lock dispatch fails (network/server) → tool proceeds without a lock (logged at debug).
- **Lock conflict detected** → tool is **blocked**: `{"action": "block", "message": "swarm lock blocked write_file for X: File is already locked"}`. The agent gets this as a tool-result error and can ask the user, wait, retry, or escalate.

### 5.4 Missing-`session_id` guard (v0.2.1)

Some hermes call paths invoke `pre_tool_call` without `session_id`. The plugin falls back to the sole registered instance **only when** `len(_instances) == 1`. Multi-session ambiguity refuses to guess and skips locking. This protects gateway mode where multiple sessions may share one MCP process.

### 5.5 No-double-spawn invariant (gateway fast-dispatch)

When the gateway dispatches a worker spawn (e.g. on Telegram retry, after a network blip), it must **not** create duplicate workers. Defense is layered — task-level idempotency catches most cases, spawn-level mutex catches the rest.

**Layer 1 — task idempotency (primary).**
Every user intent that produces a task gets `idempotency_key` (hash of originating message id + content). `request_task` is server-enforced: the same key returns the existing task rather than creating a duplicate. This handles ~all retry cases at the right layer.

**Layer 2 — spawn mutex (when no task exists yet).**
Before a task can be created, the gateway may need to spawn a worker that doesn't yet exist. To avoid two concurrent gateway flows both spawning workers for the same intent, the spawn dispatch follows this protocol:

1. **In-process mutex** keyed by `(scope, role, intent_hash)`. Closes same-process concurrency races inside a single gateway hermes.
2. **Live workers** — call `list_instances` in scope. If a matching `role:` peer exists, dispatch to it; no spawn needed.
3. **Search for in-flight spawn** — `search_context` for the absolute synthetic path `/__swarm/spawn/<role>/<intent_hash>`. The leading slash matters: `lock_file` resolves relative paths through `file_root`, so two gateways in the same scope with different `cwd`/`file_root` would otherwise miss each other's locks. An absolute path falls through `paths.ts:file()`'s `within()` checks and returns unchanged. Filter the results exactly — `search_context` is substring-fuzzy (`WHERE file LIKE %query%`), so post-filter to `type === "lock" && file === <exact_resolved_path>`. **Any** matching lock — including one owned by this same gateway instance — means "spawn already in flight." Wait on (or attach to) the in-flight intent.
4. **Acquire the spawn lock** — `lock_file("/__swarm/spawn/<role>/<intent_hash>", note=...)` only after step 3 confirmed no active lock. The note carries diagnostic JSON: `{task_id, intent_hash, role, started_at, pane_id?, expires_at?}`. **Handle the search→lock race**: a concurrent gateway-from-a-different-instance could have searched empty and locked between our search and our lock call. If `lock_file` returns a conflict from a different `instance_id`, treat it identically to step 3 finding an existing lock — spawn is in flight, attach. (Same-instance re-entry can't surface here since `lock_file` is re-entrant for the same `instance_id`; step 3 is the primary detector for that case.)
5. **Spawn via herdr** and wait for the worker to register or for a timeout.
6. **Explicit release** — gateway calls `unlock_file` once the worker has both registered **and** claimed the task (or otherwise bound itself to the originating task), **or** on spawn failure/timeout. Releasing on registration alone leaves a small window between register-and-claim where a retry could see no active spawn lock and re-fire. Do not rely on `update_task` to release this lock — `update_task` only releases locks held by the *assignee* (worker), and the spawn lock is held by the *requester* (gateway).

**Why the explicit search before lock:** `context.lock` is re-entrant for the same instance — it deletes the caller's existing lock on the same path before inserting a new one. Calling `lock_file` blind would let a same-gateway retry silently re-acquire its own lock and proceed to spawn again. The pre-check via `search_context` catches that.

**Why explicit unlock instead of TTL:** swarm-mcp's KV has no TTL primitive, and `update_task` releases assignee-held locks not requester-held. Heartbeat prune (~30s on instance deregister) is crash-recovery only — it'll eventually clean up if the gateway dies mid-spawn, but it's not the normal release path. Healthy spawns must explicitly unlock.

This layered defense protects against the "Telegram message retry creates two workers" failure mode, which is common when a phone falls off Wi-Fi mid-send.

### 5.6 Peer prompt express lane

`wait_for_activity` remains the reliable warm-worker inbox loop. It is not a cold-start mechanism and it does not type into an agent conversation by itself. The plugin provides `swarm_prompt_peer` as the express lane for already-running workers that have published a workspace identity:

1. Write the instruction through `mcp_swarm_send_message` first. This is the durable source of truth.
2. Resolve the target's workspace transport handle from swarm KV at `identity/workspace/herdr/<instance_id>`.
3. Inspect the handle status through the backend (`herdr pane get` for the current stack).
4. If the handle is `idle`, `blocked`, `done`, or `unknown`, send a short wake prompt through the backend (`herdr pane run` today) telling the worker to call `poll_messages`.
5. If the handle is `working`, skip the nudge unless the caller explicitly passes `force=true`.

The injected workspace text never contains the full work contract. It only tells the worker to read its swarm inbox. This keeps audit, retry, and follow-up behavior in swarm-mcp while still making local workspace workers feel immediate.

This capability is not planner-only. Any gateway, planner, implementer, reviewer, researcher, or generalist may wake a peer when there is a real coordination reason. The boundary is the mechanism: target a swarm `instance_id`, send the durable swarm message first, and let the workspace backend carry only the wake-up. Raw backend commands such as `herdr pane run` against another worker are operator/spawner capabilities, not normal worker coordination paths.

Hermes sessions publish their current workspace identity during `on_session_start` when `HERDR_PANE_ID` is present:

```json
{
  "backend": "herdr",
  "handle_kind": "pane",
  "handle": "w64e95948145ed1-1",
  "pane_id": "w64e95948145ed1-1",
  "socket_path": "/path/to/herdr.sock",
  "workspace_id": "w64e95948145ed1"
}
```

The plugin deletes this key during `on_session_finalize`. Stale keys are advisory only; a failed `herdr pane get` or `herdr pane run` degrades to normal swarm delivery.

Workers that are not Hermes-hosted can participate by publishing the same KV shape through their own adapter or launcher. They do not need to run this plugin as long as the identity key maps their swarm `instance_id` to the current workspace handle. The legacy `identity/herdr/<instance_id>` key may be written for current Herdr consumers, but new docs and APIs should use the `identity/workspace/<backend>/<instance_id>` convention.

### 5.7 Spawn layout policy

Spawn layout is doctrine, not plugin behavior. The gateway agent decides per spawn whether to reuse a pane group, split a pane, create a tab, or create a workspace, using the `Spawn Layout Doctrine` section in `skills/swarm-mcp/SKILL.md` as its source of truth. Plugin code must keep saying only "spawn via herdr" at the behavior layer: it should not implement a deterministic layout helper, enforce soft pane/tab caps, or hide the layout decision from the agent.

## 6. Identity, scope, labels

- **instance_id** — UUIDv4, one per registered session. The plugin tracks `_instances[session_id] = instance_id` and `_refcounts[instance_id]`.
- **scope** — coordination boundary. Default: git root walking up from `directory`. Override: `SWARM_HERMES_SCOPE` / `SWARM_MCP_SCOPE`. Peers only see each other within shared scope.
- **label** — auto-generated as `hermes platform:<cli|telegram|...> session:<id-prefix>`, with `identity:<work|personal>` prepended when `SWARM_HERMES_IDENTITY`, `AGENT_IDENTITY`, or `SWARM_IDENTITY` is set. Override: `SWARM_HERMES_LABEL`; if the override omits `identity:`, the plugin prepends the derived identity token. Workers should include `role:<planner|implementer|reviewer|researcher>` for skill-routing.

### 6.5 Identity bridge across layers

The system has five identifier types. They are **not interchangeable**.

| Identifier | Owned by | Stable across | Used for |
|---|---|---|---|
| swarm `instance_id` | swarm-mcp | logical worker lifetime | tasks, messages, locks, audit trail |
| herdr `pane_id` | herdr | pane lifecycle (recompacts when other panes close) | UI control, direct pty I/O |
| hermes `session_id` | hermes-agent | one conversation thread | hook keying, session DB |
| telegram `session_key` (or discord/etc.) | gateway adapter | one user-platform session | inbound user routing |
| swarm-server `pty_id` | swarm-server (reference only) | transport-local | not used in v1 |

**Invariant:** tasks, messages, and locks **never** target `pane_id` — they target `instance_id`. Mobile/UI commands target `pane_id` (or `pty_id`). User-facing summaries translate handles back to **labels** (e.g. "implementer-bob in `pane 1-3`"). Hermes `session_id` is a *conversation* identity, not a worker identity. Telegram `session_key` is a *user route*, not a worker identity.

Why this matters: agents reading swarm state must never be told "lock pane 1-3" — pane IDs recompact when other panes close, so a captured reference can become stale or wrong. Always look up by `instance_id`, present by label.

## 7. Read-hybrid, write-conductor

The plugin diverges by role (env or config):

| Mode | Reads | Writes |
|---|---|---|
| `worker` (default, herdr pane) | Inline | Inline, with lock bridge |
| `gateway` (Telegram/Discord/etc.) | Inline for trivial edits; dispatched for larger work | Easy edits local, medium/large work via swarm `dispatch` |

### 7.1 Why gateway delegates non-trivial writes

- Medium or large work benefits from an isolated worker audit trail in swarm tasks.
- Spawning/waking workers keeps implementation in normal terminal-managed workspaces.
- The gateway should stay responsive as planner/conductor instead of becoming a long-running implementer.
- A trivial, low-risk edit can be cheaper to make locally than to dispatch.

### 7.2 Three-tier write routing

When a user intent on the gateway resolves to a write:

1. **Inline easy edits.** For trivial, low-risk edits, the gateway may edit locally. The shared hook still uses the swarm lock bridge when peers exist, so real lock conflicts remain blocking.
2. **Dispatch medium/large work.** Gateway formulates a concrete patch + success criterion, then uses the dispatch primitive (see §9 v0.5) to create/reuse the task, wake or spawn a worker, and monitor the result. When a worker is available this becomes a near-synchronous round-trip — claim → apply → `update_task` → summarize.
3. **Ask.** If non-trivial work cannot be dispatched because no spawner or worker surface is available, gateway surfaces the impasse to the operator with options to wait, spawn, or explicitly authorize local implementation.

### 7.4 Reconciliation when gateway worked inline

When gateway inline writes happen while peers exist, the lock bridge provides collision protection. For multi-step local edits, the gateway should still leave durable context with `annotate` or a small task/result record so later workers can reconcile intent.

### 7.5 Gateway default vs routine commands

Single-intent dispatch is not a product feature the operator should have to invoke. If the operator messages the gateway "fix this issue", Hermes should already behave that way by default: make or reuse a durable task, choose a suitable worker, wake or spawn it, pass the work contract through swarm, then summarize the result.

`dispatch` exists to make that default behavior reliable and inspectable across transports:
- dedupe Telegram/iOS/CLI retries before spawning duplicate workers
- reuse live workers before creating new panes
- preserve scope, identity, role, task, and message audit trails
- give every front end the same backend route instead of hand-coded spawn logic

The user-facing command layer is **routine dispatch**: named shortcuts that expand into a small task graph and route each part to the right role. For example:

```text
/release-check
  implementer -> run build/tests and fix obvious failures
  reviewer    -> review the branch for regressions
  researcher  -> check linked issue/release context
  gateway     -> collect results and ask for approval
```

The dispatch primitive remains single-task routing: one intent, one task, one best worker. Routine dispatch composes `request_task_batch`, per-role dispatch/wake/spawn, monitoring, and a final summary. That is the slash-command/button/product surface; the single-intent accelerator is plumbing for the gateway's normal behavior.

## 8. CLI bridge (`/swarm`)

Resolution order, no shell aliases (subprocess can't expand them):
1. `SWARM_MCP_BIN` as a real command (e.g. `bun run /path/to/src/cli.ts`)
2. `swarm-mcp` on `$PATH`
3. This checkout's `src/cli.ts` under `bun`, then `dist/cli.js` under `node`

Subcommands: `status` (default, compact summary), `instances`, `tasks`, `kv`, `messages`. Scope passed via `--scope` if `SWARM_HERMES_SCOPE` set.

## 9. Roadmap

### v0.1 — Lifecycle bridge ✓
- `on_session_start` → auto-register
- `on_session_finalize` → auto-deregister with refcount
- `/swarm status` slash command

### v0.2 — Lock bridge ✓
- `pre_tool_call` / `post_tool_call` for `write_file`, `patch`, `edit_file`, `apply_patch`
- Auto-`lock_file` when peers exist; release on completion
- Block on real conflicts; fail-open on coordination errors

### v0.2.1 — Sole-session fallback ✓
- `pre_tool_call` falls back to single registered instance when `session_id` missing
- Multi-session ambiguity refuses to guess

### v0.3 — Workspace identity + peer prompt express lane ✓
- Publish `identity/workspace/herdr/<instance_id>` on session start when herdr env is present
- Delete the identity key on session finalization
- Register `swarm_prompt_peer` as a plugin tool
- Always send the durable swarm message first; use `herdr pane run` only as a best-effort wake-up

### v0.4 — Background poller / gateway notifications
- Long-lived thread driving `wait_for_activity`
- Surfaces unread messages + task-state changes
- Target is **platform-aware**:
  - CLI: TUI banner / activity feed entry
  - Gateway (Telegram/Discord/etc.): pushed message via the active gateway adapter
- Suppressible via `swarm.background_poll: false`

### v0.5 — Gateway role + dispatch primitive
- Plugin reads `swarm.role: gateway|worker` from config
- CLI precursor: `swarm-mcp dispatch` creates/reuses an idempotent task,
  wakes a live worker, or invokes the configured Spawner backend (`herdr`
  for the first stack) for non-MCP gateway wrappers.
- Optional Hermes helper `swarm_fast_dispatch(intent, patch, expect, timeout_s, fallback)`
  - Wraps the dispatch primitive + `wait_for_activity` + summarize as a single synchronous-feeling call for gateway implementations
  - Returns `{status: "no_worker"}` if nothing claims within timeout; gateway can then ask user, escalate, or fall back to inline
- In gateway mode, lock bridge is suppressed (gateway doesn't write)

### v0.5.1 — Routine dispatch UX
- Named slash commands / buttons / saved prompts expand into role-specific task graphs
- Use `request_task_batch` for multi-task creation when dependencies matter
- Route each task through the dispatch primitive only when a live matching worker is absent or needs a wake/spawn
- Gateway monitors completion and produces one operator-facing summary
- Examples: `/release-check`, `/review-branch`, `/fix-tests`, `/prep-deploy`

### v0.6 — Ambient context + herdr status reporting

Two pieces, shipped together because the ambient-context block wants real worker status to embed.

**Ambient swarm context in prompts:**
- Hook into prompt build to add a swarm-aware context block
- **Worker mode**: "your instance, peer list, your active locks, recent annotations on touched files"
- **Gateway mode**: "active workers, in-flight tasks, recent completions, unread messages"
- Cache-friendly: recomputed at session boundaries only, not per-turn

**Herdr `pane.report_agent` integration** (promoted from v0.6+):
- When `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` env present, plugin calls herdr's status RPC directly:
  - `on_session_start` → `agent=hermes state=idle`
  - tool/LLM activity in flight → `state=working`
  - approval/block directive → `state=blocked`
  - `on_session_finalize` → `pane.release_agent`
- Replaces regex-based status detection in herdr for hermes panes; regex stays as fallback for sessions where the env vars aren't injected.

### v0.7+ — Open territory
- `subagent_stop` bridge: `delegate_task` outcome → `update_task` if subagent prompt carried a task id
- Network swarm-mcp backend (Postgres / Turso / D1) — unblocks cross-machine gateway↔worker
- Identity bridge with herdr: pre-create swarm instance row on `herdr pane create`, inject `SWARM_MCP_INSTANCE_ID`, MCP server adopts on first call. `list_instances` includes `pane_id`; conflict messages can deep-link to panes.

### Mobile/iOS track (parallel, independent of plugin versions)

Tracks the iOS-via-herdr workstream (§3.3). Ordered by dependency, not calendar.

- **m1 — bridge daemon.** Small unix-socket ⇄ TCP/WSS daemon for herdr, behind Tailscale. Enables iOS app to drive existing herdr control API: snapshot reads + send-input + lifecycle/status events. Sufficient for v1 mobile UX (kick off work, peek output, send prompts).
- **m2 — `pane.output_stream` in herdr socket.** Continuous PTY output streaming + resize. Required for full terminal UX on iOS (live scrollback, animations, REPL feedback). Without this, the app is "command-and-snapshot," not "real terminal."
- **m3 — native network mode in herdr.** TCP/WSS listener directly in herdr, with Bonjour/PSK pairing. Eliminates the Tailscale-required dependency.
- **m4 — pairing reuse.** Port `apps/swarm-ios/Packages/SwarmPairing/` (from swarm-server) to drive m3's pairing flow.

## 10. Testing

### 10.1 Smoke scenarios (live, must pass)

**S1: Single-agent registration round-trip**
Fresh hermes session in a git repo. After first turn, `swarm-mcp instances` shows the session. `/swarm status` shows instances=1, adopted=true. Clean exit → instance disappears.

**S2: Two-peer coordination**
Two hermes sessions in shared scope. Both visible in `list_instances`. `broadcast` from one is received by the other via `wait_for_activity` within 5s.

**S3: Lock conflict (the v0.2 contract)**
Peer A holds a swarm lock on `notes.md`. Peer B tries `write_file` on same path. B's tool returns error containing `swarm lock blocked write_file ... File is already locked`. Target file is **not** modified. After A unlocks, B retries successfully.

**S4: Solo write does not lock**
Single session, no peers. `write_file` proceeds without any lock attempt — no lock context entry appears in `swarm-mcp inspect`.

**S5: Peer prompt express lane (v0.3)**
Two Hermes sessions in herdr panes. Session A calls `swarm_prompt_peer(recipient=<B>, message="check your inbox")`. Verify B has an unread swarm message even if herdr injection fails. When B has published `identity/workspace/herdr/<instance_id>` and its pane is not `working`, verify `herdr pane run` injects the wake prompt and B is told to call `poll_messages` rather than receiving the full work contract through terminal text.

**S6: Gateway fast-dispatch (v0.5+)**
Gateway hermes + one worker peer. User on Telegram: "fix typo X in file Y." Gateway formulates patch, calls `swarm_fast_dispatch`. Worker claims, applies, marks task done. Gateway summarizes back to Telegram within timeout. File is modified; gateway never held a lock.

**S7: No-double-spawn under retry (v0.5+)**
Gateway with no live workers. Send the same user intent twice within ~5s (simulates a Telegram retry / network blip). Verify both layers:
- **Layer 1 (task idempotency)**: `request_task` with the same `idempotency_key` returns the existing task on the second call — no duplicate task row.
- **Layer 2 (spawn mutex)**: when the spawn flow runs, the second invocation's `search_context("/__swarm/spawn/<role>/<intent_hash>")` finds the existing exact lock (even though it was placed by this same gateway instance) and short-circuits to "in-flight" instead of re-acquiring + spawning again.
Result: exactly one new worker pane, exactly one task row, both calls return the same `task_id`. After the worker registers and claims/binds the task, gateway explicitly `unlock_file`s the spawn path — verify with `swarm-mcp inspect` that no `/__swarm/spawn/*` lock remains.

Negative case: also verify a *different-gateway-instance* retry (rare but possible during gateway restarts) sees the existing lock via `search_context` and behaves the same way.

**S8: Gateway local-small / dispatch-large routing (v0.5+)**
Gateway with no workers. User asks for a trivial typo edit in one file. Gateway edits locally and summarizes. User then asks for a multi-file feature. Gateway creates/reuses a swarm task and drives `dispatch`; if no spawner surface is available, it asks the operator to start a worker or explicitly authorize local implementation.

**S9: Herdr `pane.report_agent` integration (v0.6+)**
Hermes session launched in a herdr pane with `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` injected. herdr sidebar shows `agent=hermes state=idle` immediately on session start (before any agent turn fires). Send a prompt → state flips to `working`. Trigger an approval prompt → state flips to `blocked`. Exit → pane releases the agent binding. Compare to a hermes session launched without the env vars: regex-detection fallback applies, with `agent_status=unknown` until output heuristics catch up.

**S9: Mobile bridge end-to-end (m1)**
Bridge daemon running, Tailscale connected. iOS app (or curl-equivalent over the Tailscale interface) calls `pane list` → returns same JSON as local `herdr pane list`. Send `pane send-text <pane> "echo hello"` + `pane send-keys <pane> Enter` → text appears in the targeted pane's output. `pane read --source recent --lines 20` returns the resulting buffer. Daemon binds only to the Tailscale interface (or `tailscale serve`), not 0.0.0.0 — verifiable with `lsof`/`netstat`.

### 10.2 Mocked unit tests

Cover plugin behavior without a live MCP server by stubbing `lifecycle._dispatch`. Required cases:
- Register response shapes: direct dict; `{result: <json string>}`; `{content: [{text: <json>\n<prompt>}]}`
- Lock conflict (`error: "File is already locked"`) blocks; non-conflict error fails open
- Missing-`session_id` guard: single-instance fallback fires, multi-instance refuses
- Refcount: two `on_session_start` for same instance → only one deregister on finalize
- No-double-spawn:
  - first attempt: `search_context` returns empty → `lock_file` succeeds → spawn proceeds
  - second attempt (same gateway, same intent_hash): `search_context` finds existing lock → short-circuits to in-flight task ref **without** calling `lock_file` (proving the pre-check guards against same-instance re-entry)
  - explicit `unlock_file` after worker registers; verify lock is gone
- Gateway routing: trivial local edit succeeds; medium/large write request creates/reuses a dispatch task or returns an operator action request when no worker/spawner is available
- `pane.report_agent` calls: `state=idle` on register, `working` during a stubbed dispatch, `blocked` on approval directive, `release_agent` on finalize

## 11. Design decisions

**Why `on_session_finalize` instead of `on_session_end`?**
Hermes fires `on_session_end` after every `run_conversation()` turn — that's per-message, not per-session. Deregistering there would burn instances on every reply. `on_session_finalize` is the real boundary.

**Why shell out for `/swarm` instead of dispatching MCP tools?**
The slash command should work even when swarm MCP tools aren't mounted (server disabled, agent context loaded without them). Shelling to the CLI is independent of the agent's tool surface.

**Why fail-open on coordination errors but block on lock conflicts?**
Coordination is opt-in. A swarm outage shouldn't tank productive tool calls. But a peer-held lock is exactly the case the user wanted protection from — failing through it would defeat the point.

**Why not unify herdr and swarm-mcp?**
They solve different problems. herdr is local + ephemeral + transport. swarm-mcp is durable + structured + portable. Unifying loses one or the other. Bridge them at the edges (this plugin, and the planned `SWARM_MCP_INSTANCE_ID` injection).

**Why herdr as universal PTY owner instead of swarm-server?**
swarm-mcp ships `swarm-server` (Tauri + iOS pairing + WSS PTY streaming) that overlaps with herdr's PTY ownership. Both are reasonable; running both creates the failure mode where two systems independently spawn or claim the same conceptual worker. The choice: pick one. herdr wins because (a) it's already the operator's local control surface, (b) its socket protocol is sufficient for v1 iOS UX over Tailscale + a small bridge daemon, (c) keeping one PTY owner means one identity-claim path, one spawn-idempotency model, one place to add streaming. swarm-server's pairing/transport code remains useful as reference material (potential m4 reuse), but is non-primary.

**Why a bridge daemon for iOS instead of native network mode in herdr from day one?**
Tailscale + a tiny unix-socket-to-TCP/WSS daemon ships in days. Native pairing/auth/encryption in herdr is weeks. The bridge daemon lets us validate the iOS workflow first; if Tailscale dependency becomes painful for the user, the m3/m4 upgrades absorb that work without re-architecting.

**Why not bake gateway logic into hermes core?**
The gateway/worker distinction is shaped by *how this operator uses hermes* (Telegram-primary). Other operators may have different topologies. Keeping role-aware behavior in the plugin avoids opinionating hermes core.

**Why "read-hybrid, write-conductor" instead of full hybrid?**
Pure conductor (gateway never edits) fails when the laptop is off. Pure hybrid (gateway sometimes edits) means stale workspace state, lock contention with workers, divergent branches. Read-hybrid + write-conductor is the cleanest version: gateway reasons inline, dispatches edits as fast atomic tasks. UX feels the same to the operator, architecture stays clean.

## 12. Upstream tightenings recommended for swarm-mcp

These are gaps in swarm-mcp itself that surfaced while designing the plugin protocol. None block plugin v0.2.1; all would simplify v0.4+ implementation.

**Exclusive lock semantics — `lock_file(exclusive: bool = false)`.**
Today `context.lock` is re-entrant for the same `instance_id` (DELETE-then-INSERT on `(scope, file, instance_id)`). Correct for the primary use case (a peer extending its own edit lock without trampling itself), but unsound for "did anyone — including me — already start this exclusive operation?" The SPEC §5.5 spawn-mutex protocol works around this with a `search_context` pre-check + post-filter + race handling — six numbered steps that would collapse to one if `lock_file(exclusive=true)` returned conflict for ANY existing lock on the path regardless of `instance_id`. Backward compatible default: `exclusive=false` keeps current re-entrant semantics.

**KV TTL — `kv_set(key, value, ttl_ms?: number)`.**
KV today has no expiry primitive. v0.3 poller cache invalidation, v0.4 in-flight task tracking, and v0.5 ambient-context staleness all want short-lived state with automatic GC. Without TTL, every consumer hacks it via timestamp values + manual cleanup or via the lock heartbeat-prune side effect (which is coarse and intent-mismatched). Simple add: `expires_at` column, prune on read/list (same pattern the registry already uses for instance staleness).

**Exact context lookup — `context_lookup(scope, file, type?)` or `lock_exists(file)`.**
The §5.5 protocol filters `search_context` results manually because it's substring-fuzzy. An exact lookup tool would (a) shave a round-trip's worth of result data, (b) eliminate the silent-bug class where a poorly-chosen synthetic path matches an unrelated annotation. swarm-mcp already has `context.lookup(scope, file)` internally (`src/context.ts:85`); just expose it as an MCP tool.

**First-class spawn intent — `request_spawn(role, idempotency_key, intent_metadata)`.**
The SPEC §5.5 protocol is an external implementation of "request a worker spawn, deduped by intent." Today every gateway has to layer task-`idempotency_key` + manual spawn mutex correctly. Server-side primitive would collapse the layers and remove a class of correctness bugs. **Lower priority** — defer until v0.4 implementation reveals whether the layered design is genuinely painful in practice.

**Priority order for upstream work:** exclusive locks (highest leverage, smallest change) → KV TTL (medium, broad usefulness) → exact lookup (small ergonomic) → spawn intent (largest, defer).
