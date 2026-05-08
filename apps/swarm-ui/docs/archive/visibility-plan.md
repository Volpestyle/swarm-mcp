# Swarm UI Visibility Plan

Fill the gaps in swarm-ui so an outsider (user, reviewer, on-call) can see **everything** the agents are doing to coordinate — not just messages.

This plan is written to be picked up by another agent or a future session. It's phased so each slice ships independently; a planner can also parallelize slices within a tier since they touch disjoint files.

## Context (read first)

The backend is a Tauri app in `apps/swarm-ui/src-tauri/` that tails `~/.swarm-mcp/swarm.db` (a plain SQLite file written by the MCP servers). A polling thread (`src-tauri/src/swarm.rs`, `POLL_INTERVAL = 500ms`) reads watermark columns; if any advanced, it reloads state and emits a `swarm:update` Tauri event with a `SwarmUpdate` payload. The frontend (Svelte + XYFlow) normalizes that into stores in `src/stores/swarm.ts`, then derives graph nodes/edges in `src/lib/graph.ts` and renders the Inspector panel (`src/panels/Inspector.svelte`) and connection edges (`src/edges/ConnectionEdge.svelte`).

What's already surfaced:

- Instances (with online/stale/offline status)
- Tasks (status, assignee, requester, priority, deps)
- Messages (per-node feed, edge packet animation)
- File locks (Inspector section per node)
- Task dependency edges

What's missing — the gaps this plan closes:

| Gap | Where it lives today | Today's UX |
|--|--|--|
| Non-`ui/*` KV entries | `kv` table | Invisible |
| Annotations (findings/warnings/bugs/todos/notes) | `context` table, `type != 'lock'` | Invisible — only `lock` rows are loaded |
| Auto / system messages | `messages` table, `sender='system'` or `[auto]` / `[signal:*]` prefix | Look identical to peer messages |
| Parent/subtask hierarchy | `tasks.parent_task_id` | Column selected in Rust, never rendered |
| Task cascades | Computed on the fly in `src/tasks.ts` — no persisted event | Only the final state is visible |
| Stale-agent auto-release | Broadcast message with `[auto]` prefix | Blends into message feed |
| Lock presence on the graph | Inspector section, but node-level | Must click to see |

The fix, in three tiers:

- **Tier 1** — surface the two data sources that already exist in the DB but aren't queried: non-`ui/*` KV entries, and non-lock annotations. Highest impact, smallest change.
- **Tier 2** — distinguishability: badge system messages, render parent/subtask trees.
- **Tier 3** — event stream: new `events` table in swarm-mcp + activity-timeline panel + graph-level signals (lock badges on nodes, edge flashes on message sends).

---

## Golden-path dev loop (use this every slice)

```sh
cd apps/swarm-ui
bun run dev           # starts Tauri + Vite
# in another terminal:
cd /path/to/any/git/repo
swarm-mcp help         # verify binary works
# to generate test traffic without spinning up real agents:
SWARM_DB_PATH=~/.swarm-mcp/swarm.db bun /path/to/swarm-mcp/src/cli.ts <commands>
```

Use the `swarm-mcp` CLI (see `docs/cli.md` in repo root, or `skills/swarm-mcp/references/cli.md`) to write test data into the shared DB. The UI should pick it up within one poll (≤500ms). For each slice, verify by:

1. Running the UI against an empty scope, confirming the new panel/badge/edge doesn't appear.
2. Using the CLI to write one row of the relevant data, confirming it appears within 500ms.
3. Using the CLI to mutate / delete, confirming the UI reflects it.
4. Running `cargo test` in `src-tauri/` and `bun test` in the swarm-ui root.

---

# Tier 1 — surface what's already in the DB

## Slice 1A — KV panel

**Goal.** Show non-`ui/*` KV entries per scope in the Inspector so agent coordination state (like `pixel:turn` or `progress/<id>`) is visible.

**Why this first.** In the real swarm-test session, `pixel:turn` and `pixel:status` drove the entire turn protocol and were invisible.

**Backend (`src-tauri/src/swarm.rs`):**

1. Add a `KvEntry { scope, key, value: String, updated_at: i64 }` struct to `src-tauri/src/model.rs` alongside `Lock`.
2. Add `kv: Vec<KvEntry>` to `SwarmUpdate` (default empty).
3. Add `load_kv(conn)` mirroring `load_ui_meta` but with `WHERE key NOT LIKE 'ui/%'`. Return raw strings — do not JSON-parse; the frontend can pretty-print if the value is valid JSON.
4. Wire into the snapshot build where `load_ui_meta` is called.
5. The existing watermark `kv_scope_changed_at` already invalidates on KV writes — no new watermark needed.

**Frontend:**

1. Add `KvEntry` to `src/lib/types.ts`.
2. Add `kvEntries = writable<KvEntry[]>([])` to `src/stores/swarm.ts`, updated by the `swarm:update` handler.
3. Add a new collapsible section to `src/panels/Inspector.svelte` at the scope level (the existing per-node sections won't fit — KV is scope-scoped, not instance-scoped). Place it below the instance list, above Messages. Title: "Coordination (KV)".
4. Render as `<key> — <value>` with `<key>` monospace, value truncated to ~80 chars and expandable on click. If the value parses as JSON, pretty-print it on expand.
5. Filter by the scope of the currently selected node (or "all" when no node is selected).

**Acceptance.** Running `swarm-mcp kv set pixel:turn '{"n":3}' --as <id>` in a scope makes the entry appear in the KV section within 500ms with the value pretty-printed as JSON on expand. Setting a `ui/*` key does NOT appear here (it remains internal).

**Out of scope.** Editing KV from the UI. Historical KV diffs (that's Tier 3). Per-instance attribution (the underlying primitive doesn't store it).

## Slice 1B — Annotations panel

**Goal.** Show non-lock annotations (`finding`, `warning`, `bug`, `note`, `todo`) alongside locks, per file and per instance.

**Backend (`src-tauri/src/swarm.rs:430`):**

1. Widen `load_locks` into `load_context`: drop the `WHERE type = 'lock'` clause, select all context rows. Rename the result to `Annotation` (or similar) with fields `{ id, scope, instance_id, file, type: String, content, created_at }`.
2. Rename `Lock` -> `Annotation` in `model.rs`, or keep `Lock` as a lightweight derived view and add a new `Annotation` struct. Recommend the latter — keep the `locks` field on `SwarmUpdate` for backward compat and add a new `annotations` field with the full set.
3. Bump the watermark query to include `MAX(created_at)` from `context` so new annotations (not just locks) invalidate the cache. Check `Watermarks` around line 53 — there's already a task/message watermark; add a `context_max_created_at`.

**Frontend:**

1. `Annotation` type in `src/lib/types.ts`.
2. `annotations` store in `src/stores/swarm.ts`.
3. Extend the existing "File Locks" section in `Inspector.svelte:226` into a "Context" section with sub-groups by `type`. Use icons/chips to distinguish types. Locks render as today; other types render with `file`, `instance_id`, `created_at`, and `content`.
4. When a node is selected, filter to rows where `instance_id === node.id`. When no node selected, show all for the current scope.

**Acceptance.** `swarm-mcp` doesn't yet expose annotate; use the MCP server in a live session OR insert directly via sqlite for testing:

```sh
sqlite3 ~/.swarm-mcp/swarm.db "INSERT INTO context (id, scope, instance_id, file, type, content) VALUES ('test-1', '<scope>', '<inst>', '/tmp/foo.ts', 'finding', 'NPE on line 42')"
```

The "Context" section shows the finding within 500ms. Locks continue to work identically.

**Out of scope.** Editing/deleting annotations from the UI. Search (already exists as an MCP tool, but UI search is Tier 3).

---

# Tier 2 — distinguishability

## Slice 2A — Badge system / auto messages

**Goal.** Make it visually obvious that `[auto]` stale-agent broadcasts, `[signal:complete]` planner signals, and any message from `sender='system'` are system events, not peer messages.

**Detection rule** (keep it simple, match what the backend actually emits):

```
isSystem = message.sender === 'system'
         || message.content.startsWith('[auto]')
         || message.content.startsWith('[signal:')
```

**Frontend only — no backend change needed.**

1. Add a `isSystemMessage(msg)` helper to `src/lib/types.ts` or a small utility file.
2. In `Inspector.svelte` message rendering (around line 257 "Messages" section), apply a CSS class when `isSystem` is true — different background, a small "SYSTEM" or gear icon badge, muted text color.
3. In `ConnectionEdge.svelte`, system messages still animate as packets but use a distinct color (neutral gray, not the peer-message color).
4. Optionally: add a "hide system" toggle in the Messages section header for users who want to focus on peer traffic.

**Acceptance.** After a stale-agent recovery (trigger by killing a registered instance and waiting 30s), the resulting `[auto]` broadcast appears with the system badge. A normal `swarm-mcp send` message does not.

## Slice 2B — Parent / subtask hierarchy

**Goal.** Show the parent-subtask tree when agents use `parent_task_id` (the schema already supports it; `swarm.rs:78,362,520` already loads it into `Task`).

**Frontend only — data is already coming across.**

1. Derive a `taskTree` map in `src/lib/graph.ts` or a new `src/lib/tasks.ts`: `parentId -> childIds[]`, plus roots.
2. In the Inspector's "Assigned Tasks" / "Requested Tasks" / scope-level "Tasks" sections (`Inspector.svelte:189, 207, 286`), render subtasks nested under their parent with an indent and a connector glyph (`└─`).
3. If showing a subtask whose parent is off-screen or from a different section, show the parent breadcrumb (e.g. `↑ parent: "Implement auth"`).

**Acceptance.** Create a task with `request_task`, then create another with `parent_task_id` pointing at the first. The second appears indented beneath the first in both the node-scoped and scope-level task lists.

**Out of scope.** Rendering the parent/child relationship on the graph canvas (too noisy). A dedicated "Task DAG" view (worth considering later if hierarchies get deep).

---

# Tier 3 — event stream (bigger lift, cross-repo)

Tier 3 introduces a persisted activity log, which gives us three things at once:

- A scrollable history of what happened (scoped and unscoped).
- A way to distinguish cascades (auto-unblock, auto-cancel) from user-driven state changes.
- A feed that graph-level signals (lock badges, edge flashes) can subscribe to.

This tier requires changes to **both swarm-mcp** (backend primitives write events) **and swarm-ui** (consume them). Do Tier 3A before 3B/3C.

## Slice 3A — `events` table in swarm-mcp

**Goal.** Every state transition in swarm-mcp emits a row to a new `events` table. The UI polls the `MAX(id)` as a watermark and streams new rows.

**Why a new table instead of deriving from existing timestamps.** Cascades happen inside DB transactions and leave only final state — no way to reconstruct "this task was unblocked because dep X completed" from a snapshot diff. Same for auto-release: by the time you observe the deletion, the actor (the `prune()` call) is gone. An append-only log is the honest shape.

**Schema.** Add to `src/db.ts` bootstrap:

```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'message.sent', 'message.broadcast',
                                    -- 'task.created', 'task.claimed', 'task.updated',
                                    -- 'task.cascade.unblocked', 'task.cascade.cancelled',
                                    -- 'task.approved', 'task.rejected',
                                    -- 'kv.set', 'kv.deleted',
                                    -- 'context.annotated', 'context.lock_acquired', 'context.lock_released',
                                    -- 'instance.registered', 'instance.deregistered', 'instance.stale_reclaimed'
  actor TEXT,                      -- instance_id or 'system'
  subject TEXT,                    -- task_id, key, file, recipient_id, etc.
  payload TEXT,                    -- JSON blob with type-specific details
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX events_scope_id_idx ON events(scope, id);
CREATE INDEX events_created_at_idx ON events(created_at);
```

**TTL.** Add to the existing `prune()` routine: delete events older than some window (24h? match task cleanup). Matches the "auto-cleanup" philosophy already in the README.

**Writers.** One-line insert in each primitive. All writes already happen inside transactions; add the event insert to the same tx so cascades either fully commit or fully roll back. Specifically:

| File | Function | Event type |
|--|--|--|
| `src/messages.ts` | `send`, `broadcast` | `message.sent`, `message.broadcast` |
| `src/tasks.ts` | `request`, `claim`, `update`, `approve`, `processCompletion`, `processFailure` | `task.created`, `task.claimed`, `task.updated`, `task.approved`/`rejected`, `task.cascade.unblocked`, `task.cascade.cancelled` |
| `src/kv.ts` | `set`, `del`, `append` | `kv.set`, `kv.deleted`, `kv.appended` |
| `src/context.ts` | `annotate`, `lock`, `clearLocks` | `context.annotated`, `context.lock_acquired`, `context.lock_released` |
| `src/registry.ts` | `register`, `deregister`, `prune` | `instance.registered`, `instance.deregistered`, `instance.stale_reclaimed` |

**Actor attribution.** Most primitives already take `instance_id` as an arg — pass it through. KV mutations don't have an actor today (underlying primitive is scope-scoped) — take it as an optional param from the MCP tool handler (which does know `instance.id`) and from `cmd.ts` (which resolves via `resolveIdentity`). Default to NULL if missing.

**Tests.** Add an `events.test.ts` suite. Verify cascades write the right event types in the right order within one transaction. Verify TTL.

**Exposed via MCP?** Optional `list_events` tool (scope + optional `since_id` filter) — useful for planners doing post-hoc analysis. Not strictly required for the UI; the UI reads the DB directly.

**Out of scope for 3A.** Any UI change.

## Slice 3B — Activity timeline panel

**Goal.** A scrolling, filterable feed of events in the swarm-ui Inspector.

**Backend (`src-tauri/src/swarm.rs`):**

1. Add `Event` struct to `model.rs` matching the table.
2. Add `last_event_id` to `Watermarks`. On each tick, `SELECT MAX(id) FROM events` — if advanced, load new rows with `WHERE id > :last_event_id`.
3. Emit a new Tauri event `swarm:events:new` with the delta (similar to `MESSAGES_APPENDED` pattern at `swarm.rs` / `events.rs`). Don't re-send old events — the frontend keeps a ring buffer.
4. On cold start, load the last N (say 200) events into the snapshot.

**Frontend:**

1. `events` store in `src/stores/swarm.ts` — a bounded ring buffer (last 500 events), append on `swarm:events:new`.
2. New "Activity" tab or section in the Inspector. Columns: time, type, actor, subject, summary. Filter chips for type categories (messages / tasks / kv / context / instances).
3. Click a row to jump to the related entity (select the task in the task list, focus the KV key, etc.).

**Acceptance.** Run a multi-agent flow (register two instances, create a task with deps, complete the dep, observe the cascade). The activity feed shows the full sequence including the `task.cascade.unblocked` row.

## Slice 3C — Graph-level signals

**Goal.** Make coordination visible at a glance without opening the Inspector.

1. **Lock badge on nodes** (`src/nodes/TerminalNode.svelte` / `NodeHeader.svelte`). If the node's instance holds any locks, show a lock icon with a count. Hover tooltip lists files. Data already available via the `locks` store; after 1B, use `annotations` filtered to `type='lock'`.
2. **Edge flash on message send.** Hook the `swarm:events:new` handler: when a `message.sent` or `message.broadcast` arrives, trigger a transient highlight on the corresponding edge in `ConnectionEdge.svelte`. The edge already animates packets from the snapshot; this adds a real-time pulse tied to the event.
3. **KV change ripple** (optional). When `kv.set` fires for a scope-shared key, briefly highlight the scope's background to signal "something changed."

**Acceptance.** Have one agent lock a file and send a message while the other observes. The first agent's node shows the lock badge. The edge pulses when the message is sent. Both effects decay after 1–2 seconds.

---

## Shared guidance

**Style / non-scope rules.**

- No emojis. Match the existing UI's visual vocabulary (see `SwarmStatus.svelte`, `Inspector.svelte`).
- Don't refactor existing surrounding code unless a slice requires it.
- Don't introduce new dependencies unless genuinely needed. XYFlow, Svelte, Tauri, tailwind — that's the stack.
- Keep Rust changes minimal and typed. Every new SQL query goes through `rusqlite::Connection::prepare` with named or numbered params.
- Every Tauri event has a matching TypeScript listener. Update `src/stores/swarm.ts` in the same slice as the Rust emit.

**Testing.**

- Rust: `cargo test` in `src-tauri/`. Add tests for any new `load_*` function with an in-memory sqlite DB (pattern exists elsewhere in the repo).
- TS: `bun test`. Add tests for any new derived store or graph transform.
- Manual: the golden-path dev loop above, one per slice.

**Out of scope for this entire plan.**

- PTY byte-stream changes (that's `src/stores/pty.ts` — a separate axis).
- Graph layout changes.
- A dedicated "task DAG" canvas view.
- Editing swarm state from the UI (read-only is the design).
- Multi-scope UI (today the UI is single-scope at a time; keep that invariant).

**Dependencies between slices.**

- 1A and 1B are independent — can run in parallel.
- 2A depends on nothing; 2B depends on nothing (data already comes across).
- 3A blocks 3B and 3C.
- 3C partially depends on 1B (for the richer lock data after annotations land).

A sensible merge order: 1A → 1B → 2A → 2B → 3A → 3B → 3C. A two-agent split could do {1A, 2A} and {1B, 2B} in parallel, then one agent does Tier 3 serially.

**Done condition for the whole plan.** Replay the swarm-test session (or an equivalent two-agent coordination test) and verify that a user who opens the UI for the first time can, from the UI alone, answer:

- Who is in the swarm and are they live.
- What they are working on (tasks + parent/child).
- What they are saying to each other (messages, distinguishing peer vs system).
- What shared state they are coordinating through (KV + annotations + locks).
- What just happened (activity feed, including cascades).
- At a glance: who holds locks and who's actively sending messages (graph signals).

That's the bar.
