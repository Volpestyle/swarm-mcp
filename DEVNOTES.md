# DEVNOTES — swarm-mcp-active

Running developer log for Mathew's fork. Architecture notes, gotchas, bug reports, decisions, and workflow. Newest entries go at the top of each section.

---

## Project overview

**swarm-mcp-active** is a local multi-agent coordination system. Multiple AI coding agent sessions (Claude Code, Codex, opencode, etc.) running on the same machine communicate through a shared SQLite database. No central daemon — each agent spawns its own MCP server process over stdio and they all write to `~/.swarm-mcp/swarm.db`.

On top of that sits **swarm-ui**: a native macOS desktop app (Tauri 2 + Svelte 5) that renders the agent network as an animated graph. Each agent appears as a node; messages between agents pulse along the connecting edges as animated SVG packets. Operators can spawn agents, send messages, kill sessions, and manage tasks — all from the canvas.

**Mathew's goal:** Build a polished, visually impressive enhanced version to show Connor — better styling, cleaner UX, possibly new features. Push target is the `experimental-frazier` branch on GitHub, but nothing goes up until Mathew says so.

---

## Technology stack

### MCP Server (`src/`)
| | |
|---|---|
| Language | TypeScript (ESM, strict) |
| Runtime | Bun (primary) / Node 20+ |
| DB | SQLite via `bun:sqlite` or `better-sqlite3` |
| Protocol | MCP SDK over stdio |
| Validation | Zod |
| Build | esbuild → `dist/` for Node compatibility |

### Desktop UI — Frontend (`apps/swarm-ui/src/`)
| | |
|---|---|
| Framework | Svelte 5 |
| Graph canvas | `@xyflow/svelte` (XYFlow) |
| Terminal emulator | `ghostty-web` (WASM Ghostty, patched) |
| Styling | Tailwind CSS + CSS custom properties |
| Build | Vite — hot-reloads Svelte/TS instantly |
| Type check | `svelte-check` + `tsc --noEmit` |

### Desktop UI — Backend (`apps/swarm-ui/src-tauri/`)
| | |
|---|---|
| Language | Rust (edition 2024, rust-version 1.85) |
| Framework | Tauri 2 (`macos-private-api` feature) |
| Async | Tokio (full: rt-multi-thread, time, sync, net, macros) |
| DB | `rusqlite` (bundled SQLite) — same shared `.db` file |
| Vibrancy | `window-vibrancy` — macOS HUD glass/blur effect |
| Hot reload | None — Rust changes require restarting `bunx tauri dev` |

### Shared Rust crates (`crates/`)
| | |
|---|---|
| `swarm-protocol` | Wire types crossing all process boundaries (UI ↔ daemon ↔ iOS). Msgpack for WebSocket frames, JSON for RPC. |
| `swarm-state` | DB open helpers, snapshot types, constants (RECENT_EVENT_LIMIT etc.) |

### iOS companion (`apps/swarm-ios/`)
Swift/SwiftUI. Mirrors `swarm-protocol` types by hand. Connects over LAN via HTTPS + WSS. Treat as read-only unless specifically working on iOS features.

---

## Architecture

```
Agent session (Claude Code / Codex / opencode)
    │  stdio (one MCP server process per agent)
    ▼
src/index.ts  →  ~/.swarm-mcp/swarm.db  (SQLite, WAL, shared)
                         ▲
              reads every 500ms
                         │
apps/swarm-ui/src-tauri/  (Rust backend — Tauri)
    │  Tauri IPC invoke()
    ▼
apps/swarm-ui/src/  (Svelte frontend — XYFlow canvas)
    │  renders
    ▼
User sees animated agent graph
```

Key flows:
- **Registration:** Agent calls `swarm.register` → MCP server writes instance row with `pid`, starts 10s heartbeat
- **Messaging:** `send_message` / `broadcast` → rows in `messages` table → polled by recipient's server → UI sees via watcher → ConnectionEdge animates
- **Task delegation:** Planner calls `request_task` → implementer `claim_task` + `update_task` → dependency graph auto-transitions blocked tasks
- **UI watcher:** Rust polls DB every 500ms, diffs against last snapshot, emits `swarm:update` delta events to Svelte stores
- **PTY binding:** `spawn_shell` → Rust creates PTY, registers placeholder instance, waits for agent's `swarm.register` → Binder links PTY id to instance id

---

## Data model (swarm.db)

| Table | Key columns | Notes |
|---|---|---|
| `instances` | id, scope, directory, pid, label, heartbeat, adopted | `adopted=0` = UI-pre-created placeholder awaiting agent register. Stale after 30s no heartbeat. |
| `messages` | sender, recipient, content, read | TTL 1 hour |
| `tasks` | id, scope, type, status, assignee, depends_on, priority | Status machine: open→claimed→in_progress→done/failed. Deps auto-unblock. |
| `context` | type (lock/annotation), file, instance_id, content | Locks exclusive, cleared on instance stale/deregister |
| `kv` | key, value, scope | Shared store. Conventions: `owner/planner`, `plan/latest`, `ui/layout` |
| `events` | type, scope, actor, subject | Append-only audit. UI uses for edge animations and Activity feed |
| `ui_commands` | type, payload, status | Operator commands queued for swarm-ui to claim |

---

## Coding conventions

### Svelte/TypeScript
- Stores in `src/stores/` are the source of truth for UI state — don't duplicate in component state
- `$instances` is scope-filtered (use `activeScope`); `instances` store is the raw map
- All Tauri commands go through `invoke()` from `@tauri-apps/api/core`
- Async confirm dialogs: always use `await confirm({...})` from `lib/confirm.ts` — never `window.confirm()`
- New destructive actions need a confirm with `danger: true` and a clear `confirmLabel`

### Rust/Tauri
- New `#[tauri::command]` functions go in `ui_commands.rs` and must be added to `invoke_handler![]` in `main.rs`
- `rusqlite::Connection` is `!Sync` — scope it into a block before any `.await` in async commands
- `AppError` variants: `Validation` (bad input), `NotFound` (missing row), `Operation` (DB/IO failure), `Internal` (hide from frontend)
- Async commands that need a sleep: use `tokio::time::sleep` — the `time` feature is already enabled in Cargo.toml

---

## Bugs and gotchas log

### [2026-04-22] Dead PTYs could survive in `swarm-server` after the harness was already gone — FIXED
Real stale-node incident root cause:

- the graph was not lying by itself
- `swarm-server` still had PTY catalog entries for dead sessions, so the UI kept rebuilding those nodes
- some of those PTY rows had no meaningful `pid` or `pgid` left, so OS process scans looked clean while the canvas still showed "live" nodes

What made the bug confusing:

- closing Ghostty did not remove the PTY node, because the PTY was app-owned by `swarm-server`
- deleting swarm rows did not remove the node, because the daemon PTY catalog was a separate source of truth
- the old close path accepted `ClosePtyRequest.force`, but `apps/swarm-server/src/main.rs` ignored the body on `DELETE /pty/:id` and always downgraded the request to `force: false`
- shutdown PTYs without a live child handle could sit in the daemon catalog until restart

Fixes that landed:

- `DELETE /pty/:id` now honors the request body and forwards `force`
- force-close reaps the PTY immediately instead of waiting for a delayed retention path
- daemon snapshot reads now sweep dead shutdown PTYs that no longer have a live child
- Tauri kill paths now call the stronger PTY close behavior

Operator learning:

- for "is something burning tokens?", trust OS process truth first
- for "why is a node still on the graph?", trust daemon PTY truth first
- if daemon PTYs, swarm rows, and OS processes are all empty, any remaining node is just stale UI state
- restarting Ghostty is not the same thing as restarting `swarm-server` or `swarm-ui`

Verification that proved the fix:

- `cargo test --manifest-path apps/swarm-server/Cargo.toml`
- `cd apps/swarm-ui && bun run check`
- `bun run check`
- live daemon `/state` returned `pty_count = 0` and `instance_count = 0` after restart on the rebuilt binary

### [2026-04-22] System Load Analyzer and real session-tree kill paths landed
`swarm-ui` now has an `Analyze` tab on the right-side shell surface. It is the machine-wide operator view for live AI-related load and rogue-session cleanup.

Key semantics:

- per-node red close now targets the real session tree when possible, not just a row cleanup path
- bottom `SwarmStatus` kill-all now routes through the real scope kill path
- `Analyze` adds machine-wide kill-all for agent sessions plus detached helpers
- exact tokens and exact cost remain conservative; unknown or ambiguous attribution becomes `N/A`
- GPU remains `N/A` in macOS v1 rather than guessed

Truth priority:

1. OS process scan and `Analyze`
2. daemon PTY truth from `swarm-server`
3. `swarm.db`
4. graph canvas state

This matters because stale-store drift can still leave dead nodes visible after the instance rows are gone, and older daemon PTY state could also keep dead sessions alive in the graph. If the graph disagrees with daemon state, the DB, and the process list, trust the daemon plus the OS.

Docs:

- `docs/system-load-analyzer.md`
- `docs/system-load-analyzer-v2-plan.md`

### [2026-04-22] Tauri WKWebView stubs `window.confirm()` — FIXED
**Commit:** `7768b8e`

`window.confirm()` returns `false` immediately in Tauri v2's WKWebView on macOS. No dialog ever appears. Every destructive action in the UI was silently cancelling — the button appeared broken.

**Fix:** Created `src/lib/confirm.ts` (single-slot async store) and `src/panels/ConfirmModal.svelte` (modal renderer mounted once in App.svelte). Replaced all 5 `window.confirm()` call sites in SwarmStatus, NodeHeader, and StartupHome.

**Rule:** Never use `window.confirm()`, `window.alert()`, or `window.prompt()` in swarm-ui. Always `await confirm({...})`.

---

### [2026-04-22] Stale-store drift — instance cache not cleared on external DB deletes — OPEN
When instance rows are deleted via any path that doesn't emit a `swarm:update` delta (e.g. server-side prune sweep, `ui_deregister_offline_instances`, or direct DB delete), the Svelte `$instances` store holds onto the stale entries indefinitely. The status bar shows phantom "active" counts; kill-all returns "instance X not found" for every id.

**Symptom:** DB is empty, UI shows 10 active agents.

**Workaround:** Cmd+R in swarm-ui forces `initSwarmStore()` to full-resnapshot from DB.

**Root fix needed:** The watcher's delta reconciler in `swarm.rs` needs to detect rows that were present in the previous snapshot but absent in the current one, and emit removal events accordingly.

---

### [2026-04-22] Orphaned bun MCP server processes accumulate
`bun run .../src/index.ts` processes ignore SIGTERM (they're waiting on stdio from their parent). Use SIGKILL to clean up:
```bash
pkill -KILL -f "bun run.*swarm-mcp-active/src/index.ts"
```
One of the running processes may be the MCP server for the current agent session. Check elapsed times before killing all:
```bash
ps -o pid,etime,command -p <pids>
```

---

### Close/kill path asymmetry — know which to use
Four Tauri commands remove instances. They are not interchangeable:

| Command | Svelte fn | Does |
|---|---|---|
| `pty_close` | `closePty(ptyId)` | Closes a PTY the UI owns |
| `ui_deregister_instance` | `deregisterInstance(id)` | Removes stale/offline row, no live PTY |
| `ui_force_deregister_instance` | `forceDeregisterInstance(id)` | Bypasses status checks — Home × button |
| `ui_kill_instance` | `killInstance(id)` | SIGTERM → wait 1.5s → SIGKILL → deregister |

The red icon and "kill all" button must use `ui_kill_instance`. The others leave the underlying OS process alive and burning tokens.

---

## Dev commands

```bash
# MCP server (dev)
bun run src/index.ts

# Desktop UI
cd apps/swarm-ui && bunx tauri dev

# Force Rust recompile without restarting dev server
touch apps/swarm-ui/src-tauri/src/ui_commands.rs

# Full type check + tests + build
bun run check

# Svelte type check only
cd apps/swarm-ui && bun run check

# DB inspection
sqlite3 ~/.swarm-mcp/swarm.db "SELECT id, scope, pid, adopted FROM instances"
sqlite3 ~/.swarm-mcp/swarm.db ".tables"

# Kill orphaned MCP servers
pkill -KILL -f "bun run.*swarm-mcp-active/src/index.ts"

# Remove stale git lock (if a git process crashed)
rm .git/index.lock  # only if `ps aux | grep git` shows no live git process
```

---

## Git workflow

- **Local `main`:** Mathew's active development branch. Commit freely here.
- **GitHub `main`:** Connor's upstream. Do not push to it.
- **Push target:** `experimental-frazier` branch on GitHub — only when Mathew says he's ready.
  ```bash
  git push origin main:experimental-frazier
  ```
- Stale `.git/index.lock` from a crashed git run is safe to delete after confirming no live git process.

---

## File locations

| Path | Notes |
|---|---|
| `~/.swarm-mcp/swarm.db` | Live shared database |
| `~/.local/bin/flux` | Mathew's Claude Code harness script (no-permissions Claude) |
| `apps/swarm-ui/src/lib/confirm.ts` | In-app confirm() — use this for all dialogs |
| `apps/swarm-ui/src-tauri/src/main.rs` | Add new Tauri commands here |
| `Agents.md` | Full agent briefing (architecture, rules, stack) |
| `docs/generic-AGENTS.md` | Drop-in coordination rules for agent sessions |
| `docs/agents-planner.md` | Drop-in for planner role sessions |
| `docs/agents-implementer.md` | Drop-in for implementer role sessions |
