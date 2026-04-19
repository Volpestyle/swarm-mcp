# swarm-ui: Parallel Implementation Plan

This plan splits the v1 implementation of `swarm-ui` across 4 agents that work concurrently after a shared scaffold step.

Reference: `architecture-plan.md` is the authoritative spec. This document only describes the work split.

## Phase 0: Scaffold (Sequential Prerequisite)

One agent scaffolds the Tauri v2 + Svelte + Vite project before the parallel agents start. This creates the skeleton that all 4 agents write into.

### What gets created

Config files:

```text
apps/swarm-ui/
  package.json          # svelte, @xyflow/svelte, @tauri-apps/api, tailwindcss, vite, etc.
  index.html            # minimal HTML with #app mount point
  vite.config.ts        # svelte + tauri vite plugins
  svelte.config.js      # svelte preprocessor config
  tsconfig.json         # strict TS, svelte support
  tailwind.config.ts    # tailwind with content paths
  postcss.config.js     # tailwind postcss pipeline
  src-tauri/
    Cargo.toml          # tauri, portable-pty, rusqlite, serde, serde_json, uuid, dirs
    tauri.conf.json     # app identity, window config, security scope
    build.rs            # tauri build script
```

Minimal entry points:

```text
  src/
    main.ts             # mount App.svelte into #app
    app.css             # tailwind @import directives
  src-tauri/src/
    lib.rs              # empty module declarations for all backend files
```

Empty directories:

```text
  src/nodes/
  src/edges/
  src/panels/
  src/stores/
  src/lib/
  src/styles/
```

### Completion criteria

- `npm install` succeeds
- `cargo check` succeeds in `src-tauri/`
- `npm run dev` starts the vite dev server (even if the app is blank)

---

## Agent 1: Rust Core — Models + Events + Swarm Watcher

### Files owned

| File | Purpose |
|------|---------|
| `src-tauri/src/model.rs` | All shared Rust types used across backend modules and serialized to the frontend |
| `src-tauri/src/events.rs` | Centralized event name constants |
| `src-tauri/src/swarm.rs` | Read-only SQLite watcher for `~/.swarm-mcp/swarm.db` |

### model.rs spec

Define serde-serializable structs for:

- `Instance` — id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, status (derived: online/stale/offline)
- `Task` — id, scope, type_, title, description, requester, assignee, status, files, result, created_at, updated_at, changed_at, priority, depends_on, parent_task_id
- `Message` — id, scope, sender, recipient, content, created_at, read
- `Lock` — scope, file, instance_id (from context where type = 'lock')
- `PtySession` — id, command, cwd, started_at, exit_code (optional), bound_instance_id (optional), launch_token (optional)
- `SwarmUpdate` — instances: Vec<Instance>, tasks: Vec<Task>, messages: Vec<Message>, locks: Vec<Lock>, ui_meta: Option<serde_json::Value>
- `GraphNode` — id, node_type (instance/pty/bound), instance (optional), pty_session (optional), position (optional)
- `GraphEdge` — id, edge_type (message/task/dependency), source, target, metadata

Status enums:

- `InstanceStatus` — Online, Stale, Offline (derived from heartbeat freshness: stale > 30s, offline > 60s)
- `TaskStatus` — Open, Claimed, InProgress, Done, Failed, Cancelled, Blocked, ApprovalRequired
- `TaskType` — Review, Implement, Fix, Test, Research, Other
- `NodeType` — Instance, Pty, Bound
- `EdgeType` — Message, Task, Dependency

### events.rs spec

String constants:

```rust
pub const SWARM_UPDATE: &str = "swarm:update";
pub const PTY_DATA_PREFIX: &str = "pty://";    // format: pty://{id}/data
pub const PTY_EXIT_PREFIX: &str = "pty://";    // format: pty://{id}/exit
pub const PTY_CREATED: &str = "pty:created";
pub const PTY_CLOSED: &str = "pty:closed";
pub const BIND_RESOLVED: &str = "bind:resolved";
pub const BIND_UNRESOLVED: &str = "bind:unresolved";
```

Helper functions:

```rust
pub fn pty_data_event(id: &str) -> String
pub fn pty_exit_event(id: &str) -> String
```

### swarm.rs spec

Core logic:

1. Open `~/.swarm-mcp/swarm.db` with `rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`
2. Enable WAL mode reads: `PRAGMA journal_mode` check (do not set, just read)
3. Start a background thread or tokio task that polls every 500ms
4. Track watermarks: `last_message_id`, `last_task_changed_at`, `instance_count`, `last_heartbeat_max`, `kv_scope_changed_at`
5. On each poll, check watermarks first. If no change, skip the full read
6. When changes detected, read full snapshot of instances, tasks (recent), messages (recent, bounded to last 100), locks, and `ui/*` KV entries
7. Compute `InstanceStatus` from heartbeat: online if heartbeat within 30s, stale if 30-60s, offline if >60s
8. Diff against previous snapshot. Only emit `swarm:update` if the serialized payload differs
9. Emit via `app_handle.emit("swarm:update", &payload)`

Tauri commands:

```rust
#[tauri::command]
fn get_swarm_state() -> Result<SwarmUpdate, String>
// Returns current cached snapshot for initial load
```

### Dependencies

- `rusqlite` with `bundled` feature
- `serde`, `serde_json`
- `tauri` (for app handle and events)
- `dirs` (for `~/.swarm-mcp` path resolution)

### Does NOT touch

- pty.rs, launch.rs, bind.rs, main.rs (Agent 2)
- Any frontend files (Agents 3, 4)

---

## Agent 2: Rust PTY — PTY + Launch + Bind + main.rs

### Files owned

| File | Purpose |
|------|---------|
| `src-tauri/src/pty.rs` | PTY lifecycle management using `portable-pty` |
| `src-tauri/src/launch.rs` | Agent/shell process spawning with token injection |
| `src-tauri/src/bind.rs` | PTY-to-swarm-instance reconciliation via launch tokens |
| `src-tauri/src/main.rs` | Tauri app setup, command registration, poller startup |

### pty.rs spec

State:

- `PtyManager` struct holding `HashMap<String, PtyHandle>` behind a `Mutex` or `RwLock`
- `PtyHandle` — child process, writer (for stdin), metadata, output ring buffer (2MB cap)

Tauri commands:

```rust
#[tauri::command]
fn pty_create(command: String, args: Vec<String>, cwd: String, env: HashMap<String, String>) -> Result<String, String>
// Returns PtyId (UUID). Spawns PTY via portable-pty.
// Sets TERM=xterm-256color in env.
// Starts dedicated reader thread that:
//   - reads from PTY master in a loop
//   - appends to ring buffer
//   - emits pty://{id}/data events with the bytes
// On process exit, emits pty://{id}/exit with exit code.

#[tauri::command]
fn pty_write(id: String, data: Vec<u8>) -> Result<(), String>
// Writes bytes to PTY stdin

#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String>
// Resizes the PTY

#[tauri::command]
fn pty_close(id: String) -> Result<(), String>
// Kills the child process, cleans up resources, emits pty:closed

#[tauri::command]
fn pty_get_buffer(id: String) -> Result<Vec<u8>, String>
// Returns the current ring buffer contents for reconnect/remount
```

Key implementation details:

- Use `portable_pty::native_pty_system()` to create PTYs
- Reader thread: read in 4KB chunks, coalesce writes within 16ms windows before emitting events
- Ring buffer: circular buffer capped at 2MB, oldest data evicted
- On exit: detect via reader thread EOF, capture exit code, emit exit event, mark session

### launch.rs spec

```rust
#[tauri::command]
fn agent_spawn(
    role: Option<String>,
    working_dir: String,
    scope: Option<String>,
    label: Option<String>,
    command: Option<String>,
) -> Result<LaunchResult, String>
// LaunchResult = { pty_id: String, token: String }
```

Logic:

1. Generate launch token: `nanoid` or UUID v4 short prefix (8 chars)
2. Build label string: `role:{role} launch:{token}` plus any user-supplied label tokens
3. Resolve command from role preset or explicit `command` param
4. Set up env: inject `SWARM_MCP_LABEL`, `SWARM_MCP_SCOPE` if scope provided
5. Call `pty_create` internally with the resolved command, args, cwd, env
6. Register the token + pty_id in the binder

Role presets:

```rust
struct RolePreset {
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    default_label_tokens: String,
}
```

Default presets should be configurable (loaded from a config file or hardcoded defaults). The agent binary (e.g., `opencode`, `claude`, `codex`) must be configurable, not baked in.

Tauri commands:

```rust
#[tauri::command]
fn get_role_presets() -> Vec<RolePresetSummary>

#[tauri::command]
fn spawn_shell(cwd: String) -> Result<String, String>
// Convenience: spawns $SHELL or /bin/zsh with no agent registration
```

### bind.rs spec

State:

- `Binder` struct holding:
  - `pending: HashMap<String, String>` — token -> pty_id (unresolved)
  - `resolved: HashMap<String, String>` — instance_id -> pty_id (matched)

Logic:

```rust
pub fn register_pending(token: &str, pty_id: &str)
pub fn try_resolve(instances: &[Instance]) -> Vec<BindEvent>
// Scans instance labels for `launch:{token}`, matches to pending, moves to resolved
// Returns list of newly resolved bindings

pub fn get_unresolved() -> Vec<(String, String)>
// Returns (token, pty_id) pairs that have not yet matched
```

Called from the swarm poller: after each `swarm:update`, run `try_resolve` against the new instance list. Emit `bind:resolved` events for new matches.

Tauri commands:

```rust
#[tauri::command]
fn get_binding_state() -> BindingState
// Returns { pending: [...], resolved: [...] }
```

### main.rs spec

```rust
fn main() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .manage(Binder::new())
        .invoke_handler(tauri::generate_handler![
            // swarm (from Agent 1)
            get_swarm_state,
            // pty
            pty_create, pty_write, pty_resize, pty_close, pty_get_buffer,
            // launch
            agent_spawn, spawn_shell, get_role_presets,
            // bind
            get_binding_state,
        ])
        .setup(|app| {
            // Start swarm poller (from Agent 1's swarm.rs)
            // Pass app handle for event emission
            // Pass binder reference for binding on each poll cycle
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Dependencies

- `portable-pty`
- `uuid` (for PTY IDs and tokens)
- `tauri`
- `serde`, `serde_json`
- Uses types from `model.rs` and constants from `events.rs` (Agent 1)

### Does NOT touch

- model.rs, events.rs, swarm.rs (Agent 1)
- Any frontend files (Agents 3, 4)

---

## Agent 3: Frontend Data Layer — Types + Stores + Graph + Terminal

### Files owned

| File | Purpose |
|------|---------|
| `src/lib/types.ts` | TypeScript types mirroring Rust models |
| `src/lib/graph.ts` | Transform normalized state into XYFlow nodes + edges |
| `src/lib/terminal.ts` | ghostty-web initialization and lifecycle helpers |
| `src/stores/swarm.ts` | Svelte store for swarm state from Tauri events |
| `src/stores/pty.ts` | Svelte store for PTY session state |
| `src/styles/terminal.css` | Terminal container and node styling |

### lib/types.ts spec

Mirror the Rust models as TypeScript types:

```typescript
// Enums
type InstanceStatus = 'online' | 'stale' | 'offline';
type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'approval_required';
type TaskType = 'review' | 'implement' | 'fix' | 'test' | 'research' | 'other';
type NodeType = 'instance' | 'pty' | 'bound';
type EdgeType = 'message' | 'task' | 'dependency';

// Data models
interface Instance { id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, status }
interface Task { id, scope, type, title, description, requester, assignee, status, files, result, created_at, updated_at, changed_at, priority, depends_on, parent_task_id }
interface Message { id, scope, sender, recipient, content, created_at, read }
interface Lock { scope, file, instance_id }
interface PtySession { id, command, cwd, started_at, exit_code?, bound_instance_id?, launch_token? }

// Payloads
interface SwarmUpdate { instances, tasks, messages, locks, ui_meta? }
interface BindingState { pending: [string, string][], resolved: [string, string][] }
interface LaunchResult { pty_id: string, token: string }

// Graph types
interface SwarmNode { id, type: NodeType, instance?, pty_session?, position? }
interface SwarmEdge { id, type: EdgeType, source, target, data? }
```

### lib/graph.ts spec

```typescript
function buildGraph(
  instances: Map<string, Instance>,
  ptySessions: Map<string, PtySession>,
  tasks: Map<string, Task>,
  messages: Message[],
  locks: Lock[],
  bindings: BindingState,
  savedLayout?: Record<string, { x: number, y: number }>
): { nodes: XYFlowNode[], edges: XYFlowEdge[] }
```

Node derivation:

1. For each instance not bound to a PTY -> create instance node
2. For each PTY not bound to an instance -> create pty node (pending state)
3. For each resolved binding -> create bound node (merged card)
4. Apply saved positions if available, else auto-layout (grid or force-directed)

Edge derivation:

1. Messages: group recent messages by (sender, recipient) pair -> one edge per pair, most recent message in metadata
2. Tasks: for each task with assignee -> edge from requester to assignee, colored by status
3. Dependencies: for each task with depends_on -> edge from dependency to dependent, styled by resolution state

### lib/terminal.ts spec

```typescript
function createTerminal(container: HTMLElement, options?: TerminalOptions): TerminalHandle
function destroyTerminal(handle: TerminalHandle): void
function writeToTerminal(handle: TerminalHandle, data: Uint8Array): void
function resizeTerminal(handle: TerminalHandle, cols: number, rows: number): void
```

- Wraps ghostty-web initialization
- Handles attach/detach lifecycle for Svelte component mount/destroy
- Provides onData callback for user input -> Tauri invoke pty_write
- Provides onResize callback -> Tauri invoke pty_resize

Note: ghostty-web integration is the highest-risk part. If ghostty-web proves unviable in Phase 1, this file becomes the swap point for xterm.js fallback.

### stores/swarm.ts spec

```typescript
import { writable, derived } from 'svelte/store';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Normalized state
export const instances = writable<Map<string, Instance>>(new Map());
export const tasks = writable<Map<string, Task>>(new Map());
export const messages = writable<Message[]>([]);
export const locks = writable<Lock[]>([]);
export const uiMeta = writable<Record<string, unknown> | null>(null);

// Derived
export const activeInstances = derived(instances, ...);
export const staleInstances = derived(instances, ...);
export const tasksByStatus = derived(tasks, ...);

// Initialize: fetch current state, then listen for updates
export async function initSwarmStore() {
  const initial = await invoke<SwarmUpdate>('get_swarm_state');
  applyUpdate(initial);
  await listen<SwarmUpdate>('swarm:update', (event) => applyUpdate(event.payload));
}
```

### stores/pty.ts spec

```typescript
export const ptySessions = writable<Map<string, PtySession>>(new Map());
export const bindings = writable<BindingState>({ pending: [], resolved: [] });

// PTY event listeners per session
export function subscribeToPty(ptyId: string, onData: (data: Uint8Array) => void): UnlistenFn
export function subscribeToPtyExit(ptyId: string, onExit: (code: number) => void): UnlistenFn

// Actions
export async function createPty(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string>
export async function writeToPty(id: string, data: Uint8Array): Promise<void>
export async function resizePty(id: string, cols: number, rows: number): Promise<void>
export async function closePty(id: string): Promise<void>
export async function getPtyBuffer(id: string): Promise<Uint8Array>
```

### styles/terminal.css spec

- `.terminal-node` — container sizing, overflow hidden, border radius
- `.terminal-container` — ghostty-web mount point, flex fill
- `.node-header` — role badge, status dot, controls layout
- Theme variables for terminal background, text, cursor colors

### Does NOT touch

- Any Rust files (Agents 1, 2)
- Any `.svelte` component files (Agent 4)

---

## Agent 4: Frontend UI — App + Nodes + Edges + Panels

### Files owned

| File | Purpose |
|------|---------|
| `src/App.svelte` | Main app layout with XYFlow canvas |
| `src/nodes/TerminalNode.svelte` | Agent/PTY node card with embedded terminal |
| `src/nodes/NodeHeader.svelte` | Shared node header chrome |
| `src/edges/MessageEdge.svelte` | Message communication edge |
| `src/edges/TaskEdge.svelte` | Task handoff edge |
| `src/edges/DependencyEdge.svelte` | Task dependency edge |
| `src/panels/Inspector.svelte` | Selected node detail panel |
| `src/panels/Launcher.svelte` | Agent/shell spawn controls |
| `src/panels/SwarmStatus.svelte` | Swarm health summary bar |

### App.svelte spec

```svelte
<script lang="ts">
  import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import { onMount } from 'svelte';
  import { initSwarmStore, instances, tasks, messages, locks, uiMeta } from './stores/swarm';
  import { ptySessions, bindings } from './stores/pty';
  import { buildGraph } from './lib/graph';
  import TerminalNode from './nodes/TerminalNode.svelte';
  import MessageEdge from './edges/MessageEdge.svelte';
  import TaskEdge from './edges/TaskEdge.svelte';
  import DependencyEdge from './edges/DependencyEdge.svelte';
  import Inspector from './panels/Inspector.svelte';
  import Launcher from './panels/Launcher.svelte';
  import SwarmStatus from './panels/SwarmStatus.svelte';

  const nodeTypes = { terminal: TerminalNode };
  const edgeTypes = { message: MessageEdge, task: TaskEdge, dependency: DependencyEdge };

  let nodes = [];
  let edges = [];
  let selectedNodeId: string | null = null;

  // Reactive graph rebuild when stores change
  $: ({ nodes, edges } = buildGraph($instances, $ptySessions, $tasks, $messages, $locks, $bindings));

  onMount(() => { initSwarmStore(); });
</script>

<div class="h-screen w-screen flex">
  <div class="flex-1 relative">
    <SvelteFlow {nodes} {edges} {nodeTypes} {edgeTypes} fitView>
      <Background />
      <Controls />
    </SvelteFlow>
    <SwarmStatus />
  </div>
  <aside class="w-80 border-l">
    <Launcher />
    {#if selectedNodeId}
      <Inspector nodeId={selectedNodeId} />
    {/if}
  </aside>
</div>
```

### nodes/TerminalNode.svelte spec

- Receives node data via XYFlow props (id, data containing Instance, PtySession, NodeType)
- Renders `NodeHeader` at top
- If PTY is present: mounts ghostty-web terminal using `lib/terminal.ts`
- Uses `onMount` / `onDestroy` for terminal lifecycle
- Uses `ResizeObserver` to drive `pty_resize`
- Subscribes to PTY data events via `stores/pty.ts`
- Sends keyboard input via `pty_write`
- If no PTY (external instance): shows instance metadata card instead of terminal
- Visual states: online (green dot), stale (yellow dot), offline (gray dot), pending-bind (pulsing blue)

### nodes/NodeHeader.svelte spec

- Props: `role`, `instanceId`, `status`, `cwd`, `nodeType`, `taskSummary`
- Role badge (colored pill)
- Status indicator dot
- Instance ID or "Pending..." label
- CWD truncated path
- Active task count badge
- Controls: focus button, inspect button, stop button (only for app-owned PTYs)

### edges/MessageEdge.svelte spec

- Custom XYFlow edge component
- Animated dashed blue line
- Animation speed proportional to message recency (faster = more recent activity)
- Hover: shows tooltip with truncated last message content
- Click: selects the edge, inspector shows message history between the two nodes

### edges/TaskEdge.svelte spec

- Custom XYFlow edge component
- Solid line from requester node to assignee node
- Color by status: `#ffffff` open, `#eab308` in_progress/claimed, `#22c55e` done, `#ef4444` failed, `#6b7280` cancelled
- Label: task title (truncated)
- Click: selects edge, inspector shows full task detail

### edges/DependencyEdge.svelte spec

- Custom XYFlow edge component
- Dotted line from dependency task's assignee to dependent task's assignee
- Gray (`#6b7280`) when dependency is not done (blocked)
- Green (`#22c55e`) when dependency is done (satisfied)
- No label by default, tooltip shows dependency task title

### panels/Inspector.svelte spec

- Shows detail for selected node or edge
- Node selected: instance metadata, PTY metadata, task list, recent messages, file locks
- Edge selected: full message history (message edge) or task detail (task edge)
- Scrollable content area
- Close button to deselect

### panels/Launcher.svelte spec

- "Spawn Shell" button — calls `spawn_shell` with cwd picker
- "Spawn Agent" section:
  - Role preset dropdown (planner, implementer, reviewer, researcher, custom)
  - Working directory input (with folder picker or text input)
  - Scope input (optional, defaults to detected scope)
  - Custom label tokens input
  - Launch button — calls `agent_spawn`
- Shows list of pending (unbound) PTY sessions with their tokens

### panels/SwarmStatus.svelte spec

- Fixed bar at bottom or top of the canvas
- Shows: `{n} active` | `{n} stale` | `{n} tasks open` | `{n} in progress` | `{n} pending PTYs`
- Derived from swarm store values
- Compact, non-intrusive, always visible

### Does NOT touch

- Any Rust files (Agents 1, 2)
- `lib/types.ts`, `lib/graph.ts`, `lib/terminal.ts`, `stores/`, `styles/` (Agent 3)

---

## Cross-Agent Contract

All 4 agents use `architecture-plan.md` as the shared API specification.

### Rust boundary (Agents 1 ↔ 2)

- Agent 1 owns `model.rs` — defines all types
- Agent 2 imports from `model.rs` and `events.rs`
- Both agents code against the type names and signatures documented above
- Integration pass resolves any naming drift

### TypeScript boundary (Agents 3 ↔ 4)

- Agent 3 owns `lib/types.ts` — defines all TS types
- Agent 4 imports from `lib/types.ts`, `lib/graph.ts`, `stores/*`
- Both agents code against the interface names documented above

### Frontend ↔ Backend boundary (Agents 1+2 ↔ 3+4)

- Tauri command names: `get_swarm_state`, `pty_create`, `pty_write`, `pty_resize`, `pty_close`, `pty_get_buffer`, `agent_spawn`, `spawn_shell`, `get_role_presets`, `get_binding_state`
- Event names: `swarm:update`, `pty://{id}/data`, `pty://{id}/exit`, `pty:created`, `pty:closed`, `bind:resolved`
- Payload shapes: Rust `#[derive(Serialize)]` structs must match TS interfaces

---

## Integration Pass (After All 4 Complete)

1. **Wire main.rs**: ensure `mod` declarations and imports from model/events/swarm/pty/launch/bind all compile
2. **Wire lib.rs**: verify module declarations match actual files
3. **Verify type alignment**: spot-check that Rust `Serialize` output matches TS interfaces
4. **`cargo check`** in `src-tauri/` — fix any Rust compilation errors
5. **`npx svelte-check`** — fix any Svelte/TS errors
6. **`npm run build`** — verify full build pipeline
7. **Manual smoke test**: launch app, verify blank canvas renders, check console for event flow

---

## Dependency Graph

```text
          Phase 0: Scaffold
                |
    ┌───────────┼───────────┐
    │           │           │
    v           v           v
  Agent 1    Agent 2    Agent 3    Agent 4
  (Rust      (Rust      (Frontend  (Frontend
   Core)      PTY)       Data)      UI)
    │           │           │          │
    └───────┬───┘           └────┬─────┘
            │                    │
            v                    v
      Rust Integration    Frontend Integration
            │                    │
            └────────┬───────────┘
                     v
              Final Integration
              (cargo check +
               svelte-check +
               smoke test)
```

## Risk Notes

- **ghostty-web** is the highest-risk integration. Agent 3's `lib/terminal.ts` is the containment boundary. If ghostty-web fails in testing, only this file needs to swap to xterm.js.
- **Agent 2 depends on Agent 1's types**. Both agents code against the documented spec, so they can work in parallel. The integration pass handles any drift.
- **Agent 4 depends on Agent 3's exports**. Same mitigation: documented interface contract plus integration pass.
