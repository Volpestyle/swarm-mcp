# swarm-ui: Architecture Plan

## What This Is

A Tauri desktop app that visualizes and controls a swarm-mcp multi-agent system as a node graph. Each node is a live terminal (rendered with ghostty-web) running a Claude Code agent. Edges represent communication between agents — messages, task delegations, and dependencies. The app reads swarm-mcp's shared SQLite database for state and spawns/manages PTYs natively through Rust.

## Why Tauri

The gateway layer disappears. Instead of three processes (swarm-mcp + Bun gateway + browser), there are two (swarm-mcp + Tauri app). Rust handles PTY management and SQLite reads natively — no HTTP/WebSocket middleman.

| Concern | Pure Web | Tauri |
|---|---|---|
| PTY management | bun-pty in separate server, bridged over WebSocket | portable-pty in-process, Tauri IPC to webview |
| swarm.db reads | Bun SQLite over SSE | rusqlite direct, Tauri events |
| Process spawning | Shell exec from Bun | Native Rust Command |
| Latency | HTTP + WS hops | Tauri IPC (near-zero) |
| Deployment | "start gateway, open browser" | Single binary |

## Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | Tauri v2 | Native desktop, Rust backend, web frontend |
| Frontend framework | React | Existing team knowledge from rcs-studio |
| Node graph | @xyflow/react (React Flow) | Mature, extensible custom nodes/edges |
| Terminal rendering | ghostty-web | Ghostty's VT parser via WASM, xterm.js API compatible, ~400KB |
| PTY management | portable-pty (Rust) | Cross-platform PTY spawning |
| SQLite access | rusqlite | Direct read of ~/.swarm-mcp/swarm.db |
| Styling | Tailwind | Consistent with existing projects |

## Directory Structure

```
swarm-mcp/
├── apps/
│   └── swarm-ui/
│       ├── src/                          # React frontend
│       │   ├── App.tsx                   # Root: React Flow canvas
│       │   ├── main.tsx                  # Entry point
│       │   ├── nodes/
│       │   │   ├── TerminalNode.tsx      # ghostty-web terminal in a React Flow node
│       │   │   └── NodeHeader.tsx        # Role label, status dot, instance ID
│       │   ├── edges/
│       │   │   ├── MessageEdge.tsx       # Animated edge for direct messages
│       │   │   ├── TaskEdge.tsx          # Edge for task requester → assignee
│       │   │   └── DependencyEdge.tsx    # Edge for task → task depends_on
│       │   ├── panels/
│       │   │   ├── Inspector.tsx         # Selected node detail: tasks, locks, messages
│       │   │   ├── Launcher.tsx          # Spawn new agent: role picker, working dir
│       │   │   └── SwarmStatus.tsx       # Global: active instances, task counts
│       │   ├── hooks/
│       │   │   ├── useSwarmState.ts      # Listen to swarm:update Tauri events
│       │   │   ├── usePty.ts            # Create/write/resize PTY via Tauri invoke
│       │   │   └── useTerminal.ts       # ghostty-web Terminal lifecycle
│       │   ├── lib/
│       │   │   ├── types.ts             # Shared types: SwarmGraph, Instance, Task, Message
│       │   │   └── graph.ts             # Transform swarm state → React Flow nodes/edges
│       │   └── styles/
│       │       └── terminal.css          # ghostty-web container styling
│       ├── src-tauri/
│       │   ├── src/
│       │   │   ├── main.rs              # Tauri app setup, event loop
│       │   │   ├── pty.rs               # PTY spawn, resize, write, close
│       │   │   ├── swarm.rs             # SQLite poller, emits swarm:update events
│       │   │   └── agents.rs            # Launch Claude/agent sessions with config
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   └── capabilities/
│       │       └── default.json         # Tauri v2 permissions
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── index.html
├── src/                                  # swarm-mcp (unchanged)
├── skills/                               # (unchanged)
└── package.json
```

## Rust Backend (src-tauri/)

### pty.rs — PTY Management

Manages local shell sessions. Each PTY maps 1:1 to a terminal node in the graph.

```
Commands:
  pty_create(command, args, cwd, env) → PtyId
  pty_write(id, data)                          # Frontend keystroke → PTY stdin
  pty_resize(id, cols, rows)                   # Terminal resize
  pty_close(id)                                # Kill process, cleanup

Events (emitted to frontend):
  pty://{id}/data   → Vec<u8>                  # PTY stdout chunks
  pty://{id}/exit   → { code: i32 }            # Process exited
```

Key details:
- Use `portable-pty` to spawn processes
- Read PTY output on a dedicated thread per session
- Emit output as Tauri events (not request/response)
- Buffer recent output per PTY so reconnecting the frontend doesn't lose history
- Set TERM=xterm-256color for ghostty-web compatibility

### swarm.rs — Swarm State Poller

Reads `~/.swarm-mcp/swarm.db` (read-only) and emits graph state to the frontend.

```
Background thread:
  Every 500ms, poll swarm.db for:
    - instances (with heartbeat freshness check)
    - messages (recent, grouped by sender→recipient)
    - tasks (with status, requester, assignee, depends_on)
    - context (file locks per instance)
    - kv (ui/* keys for layout/metadata)

Event:
  swarm:update → SwarmState {
    instances: Vec<Instance>,
    messages: Vec<Message>,
    tasks: Vec<Task>,
    locks: Vec<FileLock>,
    ui_meta: HashMap<String, Value>,  // kv keys under ui/*
  }
```

Key details:
- Open DB with `rusqlite` in read-only mode (`SQLITE_OPEN_READ_ONLY`)
- Use WAL mode for non-blocking reads while swarm-mcp writes
- Only emit events when state actually changes (diff against previous snapshot)
- Respect the 30-second heartbeat staleness threshold from swarm-mcp
- Parse `depends_on` JSON arrays to build dependency edges

### agents.rs — Agent Launcher

Spawns new Claude Code sessions with swarm-mcp configured.

```
Command:
  agent_spawn(role, working_dir, scope, label) → { pty_id, token }
```

The spawn flow:
1. Generate a unique launch token (UUID)
2. Create a PTY via pty.rs with:
   - Command: `claude` (or configured agent binary)
   - Env: `SWARM_UI_TOKEN={token}`
   - Working dir: user-selected project directory
3. The agent session starts, loads its SKILL.md/AGENTS.md, and calls `register` on swarm-mcp
4. The agent includes the token in its label: `role:{role} swarm-ui-token:{token}`
5. swarm.rs detects the new instance in swarm.db, matches on token in label
6. Frontend binds the PTY node to the swarm instance

This token-based matching is how a PTY (managed by Tauri) gets linked to a swarm instance (managed by swarm-mcp) without modifying swarm-mcp's core.

## Frontend (src/)

### React Flow Canvas (App.tsx)

The main view is a React Flow canvas with:
- Custom `TerminalNode` nodes (each containing a ghostty-web terminal)
- Custom edge types for messages, tasks, and dependencies
- A fixed sidebar/panel for the inspector and launcher
- Minimap for orientation when many nodes exist

### TerminalNode (nodes/TerminalNode.tsx)

Each node wraps a ghostty-web Terminal instance:

```tsx
// Lifecycle:
// 1. Node mounts → usePty() calls pty_create via Tauri invoke
// 2. useTerminal() initializes ghostty-web Terminal, attaches to DOM
// 3. Listen to pty://{id}/data events → term.write(data)
// 4. term.onData(data) → pty_write(id, data) via Tauri invoke
// 5. ResizeObserver on container → pty_resize(id, cols, rows)
```

Node chrome includes:
- Header: role badge, instance ID (truncated), status dot (online/stale)
- Connection handles: left (inputs) and right (outputs) for React Flow edges
- Footer: current working directory, active task title (if any)

### Edge Types

**MessageEdge**: Animated dashed line with a particle/pulse effect when a message is recent (< 5s old). Color: blue. Label: truncated message content on hover.

**TaskEdge**: Solid line from task requester node to assignee node. Color varies by task status: white (open), yellow (in_progress), green (done), red (failed). Label: task title.

**DependencyEdge**: Dotted line between task nodes (task A depends on task B). These connect to the node that owns each task. Color: gray when blocked, green when satisfied.

### Graph Transformation (lib/graph.ts)

Converts SwarmState into React Flow elements:

```
Inputs:
  SwarmState { instances, messages, tasks, locks, ui_meta }

Outputs:
  nodes: one TerminalNode per instance
    - position from ui_meta[ui/layout/{scope}] or auto-layout
    - data includes: instance info, assigned tasks, locked files

  edges:
    - one MessageEdge per unique sender→recipient pair with recent messages
    - one TaskEdge per task with both requester and assignee present
    - one DependencyEdge per depends_on entry where both tasks' owners are present
```

Auto-layout: when no saved positions exist, use a force-directed or dagre layout based on edge connections. Save positions back to swarm-mcp KV via a Tauri command that writes to swarm.db.

### State Flow

```
swarm.db ──(rusqlite)──→ swarm.rs ──(Tauri event)──→ useSwarmState() ──→ graph.ts ──→ React Flow
                                                                                         │
PTY process ──(portable-pty)──→ pty.rs ──(Tauri event)──→ usePty() ──→ ghostty-web Terminal
                                                                                         │
                                                         user keystrokes ──(Tauri invoke)─┘
```

## KV Conventions for UI Metadata

These are written to swarm-mcp's KV store (same SQLite DB) so the UI gets persistent state without modifying swarm-mcp's schema:

| Key Pattern | Value | Purpose |
|---|---|---|
| `ui/layout/{scope}` | `{ nodes: { [instanceId]: { x, y } } }` | Saved node positions |
| `ui/instance/{instanceId}` | `{ color, group, collapsed }` | Per-node visual config |
| `ui/config` | `{ autoLayout, pollInterval, theme }` | Global UI preferences |

The UI reads these via swarm.rs's poller. Writes go through a Tauri command that opens swarm.db in write mode momentarily. This keeps the KV store as the single source of truth — if you close and reopen the app, layout is preserved.

## Build Phases

### Phase 1: Read-Only Visualizer
- Tauri app scaffolding (Rust + React + Vite)
- swarm.rs: poll swarm.db, emit swarm:update events
- React Flow canvas with basic nodes (no terminals yet — just instance cards)
- Message and task edges with status coloring
- Inspector panel showing selected node details
- **Goal**: see a live swarm as a graph

### Phase 2: Embedded Terminals
- pty.rs: spawn, write, resize, close
- ghostty-web integration in TerminalNode
- Wire PTY data events to ghostty-web
- Wire keystrokes back to PTY
- Terminal resize handling
- **Goal**: interactive terminals inside graph nodes

### Phase 3: Agent Launcher
- agents.rs: spawn Claude sessions with token-based binding
- Launcher panel: role picker, working directory, scope
- Auto-detect new instances from swarm.db, bind to PTY nodes
- **Goal**: spawn and orchestrate agents from the UI

### Phase 4: Polish
- Animated edges for recent activity
- Node auto-layout (dagre) with manual position override
- Persist layout to KV
- Minimap
- Keyboard shortcuts (select node, focus terminal, pan/zoom)
- **Goal**: daily-driver quality

## What Does NOT Change in swarm-mcp

- No schema changes to the SQLite database
- No new MCP tools or resources
- No modifications to skill files or AGENTS.md
- The UI is a read-mostly consumer of the same DB that agents write to
- The only writes are KV entries under the `ui/` prefix for layout/config

## Dependencies

### Rust (Cargo.toml)
- `tauri` v2
- `portable-pty` — PTY management
- `rusqlite` (with `bundled` feature) — SQLite access
- `serde`, `serde_json` — serialization
- `uuid` — launch tokens

### Frontend (package.json)
- `@tauri-apps/api` — Tauri IPC bindings
- `@xyflow/react` — node graph canvas
- `ghostty-web` — terminal rendering
- `react`, `react-dom`
- `tailwindcss`

## Open Questions

1. **Framework**: React is assumed based on existing team knowledge. Svelte with @xyflow/svelte is equally viable — same architecture, different syntax. This is a preference call, not an architectural one.

2. **Multiple scopes**: Should the UI show one scope at a time, or support viewing multiple swarm scopes simultaneously? Start with single-scope; scope selector is trivial to add later.

3. **Terminal history**: When a node is collapsed/minimized, should PTY output continue buffering in Rust? Yes — portable-pty keeps running regardless of frontend state. The Rust-side buffer (capped at ~2MB per PTY, matching opencode's approach) ensures no data loss.

4. **Agent binary**: Hardcoded to `claude` for now. Should be configurable (opencode, codex, etc.) via the launcher panel.
