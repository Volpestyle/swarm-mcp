# Agents.md — swarm-mcp-active

Briefing for AI coding agents (Claude Code, Codex, opencode, etc.) working in this repo. Read this before making any changes. It covers mission, architecture, language stack, rules, and known landmines.

---

## Mission

**swarm-mcp-active** is a local multi-agent coordination platform. The core idea: multiple AI coding agent sessions running on the same machine can discover each other, exchange messages, delegate tasks, share file locks, and maintain a shared key-value store — all through a single SQLite database, no daemon required.

On top of the coordination layer sits a native macOS desktop UI (swarm-ui) that renders the agents as animated nodes in a live graph, embeds interactive terminal panels per agent, and lets an operator manage, spawn, and kill agents visually.

The end goal is an experience where you can watch two or more AI agents visibly communicate on a canvas, divide a real engineering task (e.g. build a game), and hand work back and forth in real time — with a polished enough visual design to be genuinely impressive.

---

## Repository layout

```
swarm-mcp-active/
├── src/                        # MCP server (TypeScript/Bun)
│   ├── index.ts                # Server entry point — exposes MCP tools
│   ├── registry.ts             # Instance registration, heartbeat, pid tracking
│   ├── messages.ts             # send / broadcast / poll_messages
│   ├── tasks.ts                # Task CRUD, dependency graph, status transitions
│   ├── planner.ts              # Planner role coordination helpers
│   ├── kv.ts                   # Shared key-value store
│   ├── context.ts              # Annotations and file locks
│   ├── events.ts               # Audit event emission
│   ├── db.ts                   # SQLite connection (bun:sqlite or better-sqlite3)
│   ├── paths.ts                # Scope/directory normalisation
│   └── cli.ts                  # swarm-mcp CLI binary
├── apps/
│   ├── swarm-ui/               # Desktop UI (Tauri 2 + Svelte 5 + TypeScript)
│   │   ├── src/                # Svelte frontend
│   │   │   ├── App.svelte      # Root — initialises stores, mounts graph
│   │   │   ├── stores/
│   │   │   │   ├── swarm.ts    # Live swarm state from Rust backend
│   │   │   │   └── pty.ts      # PTY session lifecycle + kill/deregister actions
│   │   │   ├── nodes/          # XYFlow node types (TerminalNode, NodeHeader…)
│   │   │   ├── edges/          # ConnectionEdge — animated SVG packet pulses
│   │   │   ├── panels/         # Inspector, Launcher, ConversationPanel, SwarmStatus…
│   │   │   └── lib/            # Helpers: graph builder, confirm(), types, time…
│   │   └── src-tauri/          # Rust Tauri backend
│   │       └── src/
│   │           ├── main.rs     # App setup, invoke_handler registration
│   │           ├── ui_commands.rs  # Tauri IPC commands (deregister, kill, broadcast…)
│   │           ├── writes.rs   # DB write helpers, load_instance_info
│   │           ├── swarm.rs    # Swarm state watcher, 500ms poll loop
│   │           ├── pty.rs      # PTY session management
│   │           ├── bind.rs     # PTY ↔ instance binding (Binder)
│   │           ├── launch.rs   # spawn_shell, respawn_instance
│   │           ├── daemon.rs   # swarm-server daemon management
│   │           └── events.rs   # Tauri event constants
│   └── swarm-server/           # Rust PTY daemon server
├── crates/
│   ├── swarm-protocol/         # Wire protocol types (shared between UI and server)
│   └── swarm-state/            # DB open helpers, snapshot types
├── docs/                       # User-facing docs, agent drop-in files
├── skills/                     # Installable skill for agent hosts
├── Agents.md                   # This file
└── DEVNOTES.md                 # Dev gotchas and decisions log
```

---

## Language and technology stack

### MCP server (`src/`)
- **Runtime:** Bun (primary) or Node 20+ with `better-sqlite3`
- **Language:** TypeScript (ESM, strict)
- **DB:** SQLite via `bun:sqlite` (Bun) or `better-sqlite3` (Node) — single file at `~/.swarm-mcp/swarm.db`
- **Protocol:** MCP SDK (`@modelcontextprotocol/sdk`) — exposes tools, resources, and prompts over stdio
- **Validation:** Zod schemas throughout
- **Build:** esbuild bundles to `dist/` for Node compatibility; run directly with `bun run src/index.ts` in dev

### Desktop UI — frontend (`apps/swarm-ui/src/`)
- **Framework:** Svelte 5 (runes syntax where appropriate, still uses `$:` / stores in most files)
- **Graph canvas:** `@xyflow/svelte` (XYFlow) for the node/edge canvas
- **Terminal emulator:** `ghostty-web` (WebAssembly Ghostty, patched)
- **Styling:** Tailwind CSS + custom CSS variables for theming
- **Build:** Vite; hot-reloads Svelte/TS without a Rust rebuild
- **Type checking:** `svelte-check` + `tsc --noEmit`

### Desktop UI — backend (`apps/swarm-ui/src-tauri/`)
- **Language:** Rust (edition 2024, rust-version 1.85)
- **Framework:** Tauri 2 (`tauri = { version = "2", features = ["macos-private-api"] }`)
- **Async runtime:** Tokio (`rt-multi-thread`, `time`, `sync`, `net`, `macros`)
- **DB:** `rusqlite` (bundled SQLite) — same `~/.swarm-mcp/swarm.db` the MCP server writes
- **IPC:** Tauri `invoke_handler` — frontend calls Rust via `invoke('command_name', args)`
- **Vibrancy:** `window-vibrancy` for macOS HUD glass effect
- **Protocol types:** `swarm-protocol` crate (shared with the Rust daemon)
- **Hot reload:** Vite handles frontend. Rust changes require restarting `bunx tauri dev`.

### Rust crates (`crates/`)
- **`swarm-protocol`:** Single source of truth for all types crossing process boundaries (UI ↔ daemon, daemon ↔ iOS). Msgpack for WebSocket frames, JSON for RPC.
- **`swarm-state`:** DB open helpers, snapshot types, `RECENT_EVENT_LIMIT`, `RECENT_MESSAGE_LIMIT`

### iOS companion (`apps/swarm-ios/`)
- Swift/SwiftUI, mirrors `swarm-protocol` types by hand
- Connects to swarm-server over LAN via HTTPS + WSS
- Submodule — treat as read-only unless specifically working on iOS

---

## How the system fits together

```
Agent session (Claude Code / Codex / opencode)
    │ stdio
    ▼
src/index.ts (MCP server process per agent)
    │ reads + writes
    ▼
~/.swarm-mcp/swarm.db  (shared SQLite, WAL mode)
    ▲ reads (500ms poll)
    │
apps/swarm-ui/src-tauri/ (Rust backend)
    │ Tauri IPC
    ▼
apps/swarm-ui/src/ (Svelte frontend)
    │ XYFlow canvas
    ▼
User sees animated graph of agents communicating
```

Key facts:
- Every agent session spawns its own MCP server process over stdio. They share one DB file — no central broker.
- The Rust backend polls the DB every 500ms (`POLL_INTERVAL`) and emits `swarm:update` delta events to the Svelte frontend via Tauri's event system.
- PTY sessions (terminal panels) are managed by the Rust daemon and proxied through the UI's `PtyManager`.
- The `Binder` maps PTY sessions to swarm instance ids so the graph knows which terminal belongs to which node.
- Audit events flow from the MCP server into the `events` table; the UI tails this for the Activity timeline and connection edge animations.

---

## Core data model

All live in `~/.swarm-mcp/swarm.db`:

| Table | Purpose |
|---|---|
| `instances` | One row per registered agent — id, scope, directory, pid, label, heartbeat, adopted flag |
| `messages` | Point-to-point and broadcast messages between instances |
| `tasks` | DAG-based work items with priority, dependencies, status, assignee |
| `context` | Annotations (findings, warnings, notes, todos) and exclusive file locks |
| `kv` | Shared key-value store (planner state, UI layout, turn tracking, etc.) |
| `events` | Append-only audit log — `message.sent`, `instance.registered`, etc. |
| `ui_commands` | Queued operator commands for swarm-ui to claim and execute |

Instance lifecycle: `heartbeat < now - 30s` → stale → auto-pruned by the MCP server's `prune()` call.

---

## Task status flow

```
open → claimed → in_progress → done
                             → failed
                             → cancelled
blocked (deps unmet) → open (when deps complete)
approval_required → open (after approve_task)
```

Blocked tasks auto-transition to `open` when all `depends_on` deps reach `done`. If a dep fails, downstream tasks are auto-cancelled.

---

## Agent roles and coordination conventions

Agents use the `label` field on `register` for identity tokens:

- `provider:claude-code role:planner` — plans work, delegates tasks, reviews results
- `provider:codex role:implementer` — claims tasks, edits code, reports back
- `provider:opencode role:reviewer` — focuses on review tasks

KV conventions:
- `owner/planner` — UUID of the current planner instance
- `plan/latest` — JSON blob of the current plan
- `ui/layout` — graph node positions for the active scope

The `wait_for_activity` tool is the idle loop — agents block on it rather than polling.

---

## Coding rules for this repo

### 1. Never use `window.confirm()`, `window.alert()`, or `window.prompt()` in swarm-ui
Tauri's WKWebView on macOS stubs these — they return `false`/`undefined` silently with no dialog. Use the in-app confirm helper instead:

```ts
import { confirm } from '../lib/confirm';

const ok = await confirm({
  title: 'Short action title',
  message: 'Full description of what happens if they confirm.',
  confirmLabel: 'Action verb',
  danger: true,  // red confirm button for destructive actions
});
if (!ok) return;
```

`ConfirmModal.svelte` is mounted once at the `App.svelte` root. Do not add new usages of `window.*` dialogs anywhere in `apps/swarm-ui/src/`.

### 2. Use the right remove/kill command — they are not interchangeable

| Tauri command | Svelte store fn | Use when |
|---|---|---|
| `pty_close` | `closePty(ptyId)` | Closing a PTY session the UI spawned |
| `ui_deregister_instance` | `deregisterInstance(id)` | Removing a stale/offline row with no live PTY |
| `ui_force_deregister_instance` | `forceDeregisterInstance(id)` | Bypassing status checks (Home screen × button) |
| `ui_kill_instance` | `killInstance(id)` | SIGTERM → SIGKILL the OS process, then deregister |

Destructive "remove" actions visible to the user **must** use `ui_kill_instance` / `killInstance`. The others leave the underlying bun/claude process running.

### 3. Rust changes require restarting `bunx tauri dev`
Vite hot-reloads Svelte and TypeScript. Rust changes in `src-tauri/` do **not** hot-reload. If a backend change appears to have no effect, kill the dev server and rerun:
```bash
cd apps/swarm-ui && bunx tauri dev
```
If cargo still doesn't pick up the change: `touch src-tauri/src/ui_commands.rs` to force recompile.

### 4. Use the fast visual dev loop for swarm-ui

For UI work in `apps/swarm-ui`, do not rely on typecheck alone. Use the fastest visual loop available, then escalate only when the change needs Tauri backend proof.

The app has a hybrid live-update model:

- Svelte, CSS, and most frontend TypeScript changes hot-refresh through Vite. When `bunx tauri dev` is running, the Tauri window usually receives those frontend changes without a full app restart.
- Swarm data changes through MCP tools, the CLI, or direct DB-backed UI commands are live. The Rust watcher polls `~/.swarm-mcp/swarm.db` and emits frontend updates roughly every 500ms.
- Rust/Tauri backend code, command registration, PTY daemon behavior, Tauri config, bundle metadata, icons, entitlements, and native window behavior require restarting `bunx tauri dev` or rebuilding/relaunching the app.
- The installed/bundled Dock app does not hot-refresh source edits. Use it for product smoke checks after a debug build, not as the main live-edit surface.

Preferred loop for Svelte/layout/style work:

```bash
cd apps/swarm-ui
bun run dev -- --host 127.0.0.1
```

Then inspect `http://127.0.0.1:1420/` with whichever local visual tool the host exposes:

1. In-app browser / Browser plugin, if available.
2. Playwright CLI snapshots, clicks, and screenshots, if the browser plugin is unavailable.
3. Desktop screenshot tooling only when you need to inspect the actual macOS/Tauri window.

Playwright CLI is local browser automation. It does not upload screenshots to Playwright or any third party by default. Keep screenshots/snapshots local, use them as temporary QA artifacts, and delete `.playwright-cli/` or other scratch output before handing off unless the task explicitly asks to preserve evidence.

Useful Playwright fallback pattern:

```bash
export PWCLI="$HOME/.codex/skills/playwright/scripts/playwright_cli.sh"
bash "$PWCLI" open http://127.0.0.1:1420
bash "$PWCLI" snapshot
bash "$PWCLI" click <ref>
bash "$PWCLI" screenshot
```

Important caveats:

- Plain Vite/browser mode is best for visual layout, text fit, navigation, hover/focus states, and quick screenshots. It may log expected Tauri API warnings because it is not running inside the Tauri shell.
- Use `cd apps/swarm-ui && bunx tauri dev` or a debug build when verifying Tauri IPC, Rust commands, native window behavior, PTY behavior, app storage, or Dock/bundle behavior.
- If Mathew is actively using a running app, classify the edit before touching it:
  - **Frontend-only:** patch the Svelte/CSS, let HMR refresh the running dev surface, then visually verify the edited path.
  - **DB/state-only:** use MCP/CLI/UI controls and wait for the live watcher; if stale rows remain, try an in-app refresh before restarting.
  - **Rust/native/config:** warn that a restart/rebuild boundary is required, save state if needed, then restart the dev app or rebuild the bundle.
- If HMR leaves the UI in a weird partial state, use browser refresh / Cmd+R first. Restart the whole app only after refresh does not reconcile it or the change is in Rust/native code.
- Current `swarm-mcp ui screenshot` is the queued desktop-app command path. Treat an explicit unsupported screenshot result as honest state, not as proof that browser screenshots are unavailable.
- For meaningful UI changes, verify at least the edited surface and the primary click path visually before calling the change done. If the view is responsive or first-screen critical, check both a normal desktop viewport and a narrower/mobile-ish viewport.

### 5. Keep `rusqlite::Connection` out of async futures
`rusqlite::Connection` is `!Sync`. In async Tauri commands, scope it inside a block that ends before any `.await` point:
```rust
let info = {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::load_instance_info(&conn, trimmed)?.ok_or_else(|| ...)?
}; // conn dropped here — safe to .await below
tokio::time::sleep(...).await;
```

### 6. New Tauri commands must be registered in `main.rs`
Add every new `#[tauri::command]` function to the `invoke_handler![]` list in `apps/swarm-ui/src-tauri/src/main.rs`. Missing registration = "unknown command" error in the frontend with no Rust compile error to guide you.

### 7. Don't push to GitHub without explicit instruction from Mathew
- Local `main` = active dev branch. Commit freely here.
- GitHub `main` (Connor's upstream) = off limits.
- Target push branch = `experimental-frazier` on GitHub. Only when Mathew says so:
  ```bash
  git push origin main:experimental-frazier
  ```

---

## Known issues — don't introduce workarounds, fix the root cause

### Stale-store drift
When instance rows are deleted outside the `swarm:update` delta path (server-side sweep, direct DB write, prior `ui_deregister_offline_instances` call), the Svelte `$instances` store retains stale entries indefinitely. The status bar may show phantom "active" counts; kill-all returns "instance X not found".

Workaround: Cmd+R in swarm-ui forces a full resnapshot. Root fix needed: the watcher's delta reconciler should detect rows that disappeared between snapshots and emit removal events.

### Orphaned MCP server processes
Multiple `bun run .../src/index.ts` processes accumulate when agent sessions end without clean shutdown. They ignore SIGTERM (stdio-parent keepalive). Kill with SIGKILL:
```bash
pkill -KILL -f "bun run.*swarm-mcp-active/src/index.ts"
```
One of the running processes may be the MCP server backing the current agent session. Check elapsed times first:
```bash
ps -o pid,etime,command -p <pids>
```

---

## Running the project

### MCP server (dev)
```bash
bun run src/index.ts
```

### Desktop UI (dev)
```bash
cd apps/swarm-ui
bunx tauri dev
```
Watch the terminal for `Compiling swarm-ui` on first run — Rust compile takes 1-3 min cold, seconds warm.

### Type check everything
```bash
bun run check          # typecheck + tests + build + svelte-check + cargo tests
cd apps/swarm-ui && bun run check   # Svelte only
```

### DB inspection
```bash
sqlite3 ~/.swarm-mcp/swarm.db "SELECT id, scope, pid, adopted FROM instances"
sqlite3 ~/.swarm-mcp/swarm.db "PRAGMA table_info(instances);"
```

---

## Key files quick reference

| File | What it does |
|---|---|
| `src/index.ts` | MCP server entry — registers all tools, resources, prompts |
| `src/registry.ts` | `register` / `deregister` / `list_instances` / heartbeat / pid |
| `src/tasks.ts` | Task CRUD, dependency graph auto-transitions, status machine |
| `src/messages.ts` | `send_message` / `broadcast` / `poll_messages` |
| `src/kv.ts` | `kv_get` / `kv_set` / `kv_delete` / `kv_list` |
| `apps/swarm-ui/src/App.svelte` | UI root — mounts ConfirmModal, initialises stores |
| `apps/swarm-ui/src/lib/confirm.ts` | Async `confirm()` helper — always use this, never `window.confirm()` |
| `apps/swarm-ui/src/panels/ConfirmModal.svelte` | Modal renderer for confirm() |
| `apps/swarm-ui/src/stores/swarm.ts` | Live swarm state, scope filtering, `$instances` map |
| `apps/swarm-ui/src/stores/pty.ts` | PTY lifecycle, `killInstance`, `deregisterInstance`, `spawnShell` |
| `apps/swarm-ui/src/edges/ConnectionEdge.svelte` | Animated SVG packet edges — pulses on message events |
| `apps/swarm-ui/src-tauri/src/main.rs` | Tauri invoke_handler — register new commands here |
| `apps/swarm-ui/src-tauri/src/ui_commands.rs` | All UI-initiated Tauri commands |
| `apps/swarm-ui/src-tauri/src/writes.rs` | DB write helpers — `load_instance_info`, `deregister_instance`, etc. |
| `apps/swarm-ui/src-tauri/src/swarm.rs` | 500ms watcher loop, delta emit to Svelte |
| `crates/swarm-protocol/src/lib.rs` | Shared wire types — instances, tasks, messages, events |
| `DEVNOTES.md` | Dev gotchas, bug log, git workflow |
