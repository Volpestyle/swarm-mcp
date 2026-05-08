# OC Initial Plan

## Goal

Build `swarm-ui` as a desktop visual control plane for `swarm-mcp`:

- render swarm agents as graph nodes
- show communication and task flow as edges
- embed live terminal sessions in nodes
- launch new agent sessions with explicit roles
- stay low-latency and desktop-first

The optimal v1 architecture is `Tauri + Svelte + Rust backend + ghostty-web`.

## Why This Architecture

This project needs four things that browsers handle poorly on their own:

- local PTY management
- direct SQLite reads
- local process spawning
- desktop packaging and windowing

Tauri gives a native desktop shell and Rust backend without forcing a browser-only gateway process. The UI can still use a graph canvas and a terminal renderer, but the systems work stays local and in-process.

## Core Decisions

### 1. App shell

- Use `Tauri` for the desktop container.
- Treat the app as desktop-first on macOS.

### 2. Frontend

- Use `Svelte` with TypeScript.
- Use `@xyflow/svelte` for the graph canvas.
- Avoid React entirely.

### 3. Terminal surface

- Use `ghostty-web` inside the webview for terminal rendering.
- Do not try to embed real Ghostty windows.
- Do not fork Ghostty into an embeddable library for v1.

### 4. Backend

- Use Rust inside `src-tauri`.
- Use `portable-pty` for PTY lifecycle.
- Use `rusqlite` for read-only access to `~/.swarm-mcp/swarm.db`.
- Spawn agent processes from Rust.

### 5. swarm-mcp boundary

- Keep `swarm-mcp` unchanged for v1.
- Treat it as the source of truth for swarm coordination state.
- Add optional UI conventions later through labels or KV, not by changing core server semantics first.

## High-Level Architecture

```text
swarm-mcp server(s) <-> ~/.swarm-mcp/swarm.db
                             ^
                             |
                       rusqlite watcher
                             |
  Tauri Rust backend <------>|<------> PTY manager / agent launcher
        |                                   |
        | events + commands                 | pty bytes
        v                                   v
   Svelte frontend -----------------> ghostty-web terminal nodes
                graph state + controls
```

## Node And Edge Model

### Nodes

Primary node types:

- `instance` node: one registered swarm agent from `instances`
- `terminal` node: one local PTY session managed by the app

In v1, these should usually collapse into one visual card when they refer to the same launched agent.

### Edges

- `message` edge: direct communication from `messages.sender -> messages.recipient`
- `task` edge: task handoff from `tasks.requester -> tasks.assignee`
- `dependency` edge: task dependency from `depends_on`

Do not implement shell piping edges in v1. Keep communication semantic, not byte-stream based.

## Critical Binding Model

The app must not assume that a spawned PTY is immediately a swarm node.

Problem:

- a PTY exists as soon as the app launches a process
- a swarm instance exists only after that process calls `register`

Solution:

- create a launch token on spawn
- inject it into the launched session context
- require the launched agent label to include `launch:<token>`
- match the eventual `instances.label` back to the PTY session

Recommended label shape:

```text
provider:opencode role:implementer launch:abc123 team:core
```

This binding is mandatory for reliable graph correlation.

## Data Flow

### Swarm state

Rust watches `swarm.db` and emits graph deltas to the frontend.

Use incremental checks instead of rebuilding the whole graph every tick:

- max unread or latest `messages.id`
- max `tasks.changed_at`
- instance count + latest registration timestamp
- optional KV version checks if UI KV keys are introduced

Frontend state should be normalized by ID:

- instances map
- tasks map
- recent messages map
- edges derived from normalized state

### PTY data

PTY output is high-frequency data and should not share the same transport assumptions as graph state.

- use a dedicated streaming path for PTY bytes
- use normal Tauri commands/events for control actions and graph updates
- batch terminal writes where useful to reduce UI churn

## Launch Model

The app should support these launch modes:

### 1. Spawn shell

- plain shell PTY
- no agent yet
- useful for debugging and manual sessions

### 2. Spawn agent

- launches agent CLI in a PTY
- applies working directory
- ensures `swarm-mcp` MCP config is available
- injects desired role metadata

### 3. Spawn role-specific agent

Preset launch profiles:

- planner
- implementer
- reviewer
- researcher

These presets should control:

- command
- cwd
- env
- label tokens
- optional instruction file selection

## Interaction Model

### Canvas

- pan and zoom graph
- drag nodes freely
- auto-layout option for recovery
- animated edges for recent activity

### Node card

Each agent node should have:

- compact header with role, team, status, cwd
- live terminal viewport
- recent task summary
- locked file count or current focus
- controls: focus, rename, stop, inspect

### Inspector

Right-side inspector for:

- full message history
- task details
- file annotations and locks
- instance metadata
- launch parameters

## Suggested Repo Layout

```text
swarm-mcp/
  apps/
    swarm-ui/
      oc-initial-plan.md
      package.json
      src/
        app.html
        main.ts
        lib/
          graph/
            nodes/
            edges/
            layout/
          terminal/
            ghostty.ts
            session.ts
          swarm/
            store.ts
            types.ts
          ui/
            inspector/
            toolbar/
      src-tauri/
        Cargo.toml
        tauri.conf.json
        src/
          main.rs
          app.rs
          pty.rs
          swarm.rs
          launch.rs
          bind.rs
          model.rs
          events.rs
```

## Rust Backend Modules

### `pty.rs`

- create PTY
- resize PTY
- write to PTY
- close PTY
- stream PTY output
- track PTY metadata and lifecycle

### `swarm.rs`

- open `swarm.db` in read-only mode
- poll for incremental changes
- load instances, tasks, messages, and optionally KV
- produce frontend-ready graph deltas

### `launch.rs`

- spawn shell or agent sessions
- inject launch token
- manage environment and cwd
- expose role presets

### `bind.rs`

- reconcile PTY sessions with swarm instances
- maintain launch token mapping
- expose unresolved sessions for debugging

### `model.rs`

- typed shared models for frontend/backend boundaries
- instance summaries
- task summaries
- message summaries
- graph update payloads

### `events.rs`

- central event names
- graph update events
- PTY stream events
- lifecycle events

## Frontend Modules

### Graph store

- normalized swarm state
- derived node and edge arrays
- selection state
- layout persistence

### Terminal component

- wraps `ghostty-web`
- subscribes to PTY stream
- forwards user input to backend
- handles resize and focus cleanly

### Layout engine

- manual placement first
- optional auto-layout with dagre or elk later

### Inspector and toolbar

- add node / spawn agent
- filter by role or team
- pause animations
- inspect selected node or edge

## Performance Rules

- do not repaint the whole graph for every PTY chunk
- do not rebuild terminal instances unnecessarily
- keep graph updates coarse and terminal updates fine-grained
- keep recent message history bounded in memory
- debounce layout persistence

## Security And Safety

- default to local-only operation
- open `swarm.db` read-only from the UI backend
- gate destructive actions like terminate agent or remove PTY
- clearly separate app-owned PTYs from externally launched swarm instances

## v1 Scope

### Included

- desktop Tauri app
- Svelte graph canvas
- terminal nodes with `ghostty-web`
- Rust PTY manager
- Rust swarm DB watcher
- spawn agent presets
- reliable PTY <-> instance binding

### Excluded

- iOS support
- real Ghostty embedding
- shell piping between terminals
- multi-host remote swarm support
- write access to swarm DB outside normal swarm tools

## Delivery Phases

### Phase 1: skeleton

- scaffold Tauri + Svelte app
- prove `ghostty-web` renders in a node
- prove one PTY can stream bytes into the terminal

### Phase 2: swarm graph

- read `swarm.db`
- render live instance nodes
- derive message and task edges
- add inspector

### Phase 3: launched agents

- add spawn controls
- add role presets
- implement launch-token binding
- merge PTY and instance cards when matched

### Phase 4: polish

- layout persistence
- activity animation
- filters and search
- keyboard-first interactions

## Main Risks

- PTY stream transport may need tuning under heavy output
- `ghostty-web` asset loading inside Tauri needs to be proven early
- agent launch flows differ by CLI host and local config state
- swarm graph correlation will be unreliable if launch-token discipline is skipped

## Recommended First Build Order

1. Tauri app shell
2. one `ghostty-web` terminal node fed by one PTY
3. read-only swarm graph from `swarm.db`
4. incremental graph updates
5. launch-token binding
6. role-based agent launcher

## Bottom Line

`swarm-ui` should be a Tauri desktop app with a Svelte graph frontend and a Rust backend that owns PTYs, process launch, and read-only swarm state ingestion. `swarm-mcp` remains the coordination backbone. `ghostty-web` provides the terminal renderer. The most important architectural rule is to separate low-rate swarm graph updates from high-rate PTY streams, and to enforce an explicit binding model between launched PTYs and registered swarm instances.
