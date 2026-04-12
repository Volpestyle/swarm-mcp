# swarm-ui: Consolidated Architecture Plan

This document supersedes `claude-initial-plan.md` and `oc-initial-plan.md` as the implementation plan for `apps/swarm-ui`.

## Goal

Build `swarm-ui` as a desktop visual control plane for `swarm-mcp` that:

- renders swarm agents as graph nodes
- shows communication, task handoff, and dependencies as edges
- embeds live terminal sessions in nodes
- launches new local agent sessions with explicit roles
- stays low-latency, local-first, and desktop-first

## Final Decisions

### App shell

- Use `Tauri v2`.
- Target macOS desktop first.
- Keep the architecture local-only in v1: no browser gateway and no remote multi-host transport.

### Frontend

- Use `Svelte + TypeScript + Vite`.
- Use `@xyflow/svelte` for the graph canvas.
- Use `Tailwind` for styling.

Why Svelte for v1:

- Svelte is the chosen frontend direction for this package.
- The app is a live control surface with a lot of local reactive state, and Svelte keeps that UI layer small and direct.
- The backend, transport, and PTY-to-instance binding model do not depend on React, so the architecture remains the same.

### Terminal surface

- Use `ghostty-web` inside the webview.
- Do not try to embed native Ghostty windows.
- Do not attempt a real Ghostty library integration in v1.

### Backend

- Use Rust in `src-tauri`.
- Use `portable-pty` for PTY lifecycle.
- Use `rusqlite` for direct read-only access to `~/.swarm-mcp/swarm.db`.
- Spawn local shell and agent processes from Rust.

### Source of truth

- `swarm-mcp` remains the coordination backbone and source of truth.
- `swarm-ui` is read-mostly.
- The only direct UI writes in v1 are metadata under `ui/*` keys for layout and preferences.
- No schema changes, no new MCP tools, and no changes to skill files or `AGENTS.md` are required for v1.

## Why Tauri

This project needs four things the browser alone does poorly:

- local PTY management
- direct SQLite reads
- local process spawning
- desktop packaging and windowing

Tauri keeps those concerns in-process and local. That removes the need for a Bun gateway or browser transport layer between the UI and the machine resources it needs.

## Core Architecture Rules

### 1. Separate graph updates from terminal streams

- Swarm graph state is low-rate and semantic.
- PTY output is high-rate and byte-oriented.
- These must use different transport assumptions.

Rule:

- graph state uses coarse Tauri events and commands
- PTY output uses a dedicated event stream path
- terminal rendering must never trigger whole-graph recomputation

### 2. Use explicit PTY-to-instance binding

The app must not assume a spawned PTY is immediately a swarm instance.

Problem:

- a PTY exists as soon as the app spawns a process
- a swarm instance exists only after that process calls `register`

Solution:

- generate a launch token when spawning a PTY
- inject that token into the launched session context
- require launched agent labels to include `launch:<token>`
- reconcile the eventual `instances.label` back to the PTY session

Recommended label shape:

```text
provider:opencode role:implementer launch:abc123 team:core
```

This binding is mandatory for reliable graph correlation.

### 3. Keep `swarm-mcp` unchanged in v1

- Do not alter the SQLite schema.
- Do not add new server-side coordination concepts just for the UI.
- Reuse existing swarm data and optional KV conventions.

### 4. Distinguish app-owned sessions from external instances

- App-owned PTYs can be focused, resized, stopped, and rebound.
- Externally launched swarm instances can still appear in the graph, but they do not get local PTY controls.
- Unbound PTYs must remain visible as pending local sessions instead of being hidden.

## High-Level Architecture

```text
swarm-mcp server(s) <-> ~/.swarm-mcp/swarm.db
                             ^
                             |
                       rusqlite watcher
                             |
  Tauri Rust backend <------>|<------> PTY manager / launcher / binder
        |                                   |
        | events + commands                 | PTY byte stream
        v                                   v
   Svelte frontend -----------------> ghostty-web terminal nodes
                graph state + controls
```

## Node And Edge Model

### Nodes

Primary node states:

- `instance` node: a swarm agent discovered from `instances`
- `pty` node: a local PTY session managed by the app
- `bound` node: one visual card representing a PTY that has been matched to a swarm instance

Expected v1 behavior:

- externally launched instances render as graph nodes without local terminal controls
- locally spawned PTYs render immediately, even before registration completes
- once a launch token matches, the PTY and instance collapse into one visual card

### Edges

- `message` edge: direct communication from `messages.sender -> messages.recipient`
- `task` edge: task handoff from `tasks.requester -> tasks.assignee`
- `dependency` edge: task dependency from `depends_on`

Do not implement shell piping edges in v1. Keep edges semantic, not byte-stream based.

## Data Flow

### Swarm state

Rust watches `swarm.db` and emits graph updates to the frontend.

Use incremental checks instead of rebuilding from scratch every tick:

- latest `messages.id`
- latest `tasks.changed_at`
- instance count and latest registration timestamp
- heartbeat freshness for stale detection
- optional UI KV version checks when `ui/*` keys are present

Frontend state should be normalized by ID:

- instances map
- tasks map
- recent messages map
- PTY sessions map
- edges derived from normalized state

### PTY data

PTY output is high-frequency data and must stay off the graph update path.

- use a dedicated streaming event path for PTY bytes
- use normal Tauri commands/events for control actions and graph updates
- batch terminal writes where useful to reduce UI churn
- keep a bounded Rust-side output buffer so reconnecting the frontend does not lose recent history

Recommended starting buffer cap:

- `~2 MB` per PTY

### State flow summary

```text
swarm.db -> swarm.rs -> Tauri events -> Svelte stores -> graph transform -> XYFlow
PTY process -> pty.rs -> PTY events -> PTY store / terminal binding -> ghostty-web
user input -> Tauri invoke -> pty_write/pty_resize
```

## Launch Model

The app should support these launch modes:

### 1. Spawn shell

- plain shell PTY
- no agent registration required
- useful for debugging and manual sessions

### 2. Spawn agent

- launches a configured agent CLI in a PTY
- applies working directory
- ensures `swarm-mcp` MCP config is available
- injects desired role metadata and launch token

### 3. Spawn role-specific agent

Preset launch profiles:

- planner
- implementer
- reviewer
- researcher

Each preset should define:

- command
- cwd
- env
- label tokens
- optional instruction profile

The agent binary must be configurable. Do not hardcode a single provider into the architecture.

## Backend Design

### `src-tauri/src/pty.rs`

Responsibilities:

- create PTY
- write to PTY stdin
- resize terminal
- close PTY
- stream PTY output
- track PTY metadata and lifecycle

Commands:

```text
pty_create(command, args, cwd, env) -> PtyId
pty_write(id, data)
pty_resize(id, cols, rows)
pty_close(id)
```

Events:

```text
pty://{id}/data -> Vec<u8>
pty://{id}/exit -> { code: i32 }
```

Key details:

- use `portable-pty`
- read PTY output on a dedicated thread per session or equivalent isolated task
- emit output as events, not request/response calls
- set `TERM=xterm-256color` for terminal compatibility
- retain recent output for reconnect and devtools-driven remounts

### `src-tauri/src/swarm.rs`

Responsibilities:

- open `~/.swarm-mcp/swarm.db` in read-only mode
- poll for incremental changes
- load instances, tasks, messages, locks, and optional UI KV state
- compute stale/online state from heartbeat freshness
- emit frontend-ready graph updates only when state changes

Suggested polling model:

- start with a `500 ms` poll interval
- open SQLite using read-only flags
- use WAL-safe read behavior for non-blocking reads while `swarm-mcp` writes
- diff snapshots before emitting `swarm:update`

Suggested payload:

```text
swarm:update -> {
  instances,
  messages,
  tasks,
  locks,
  ui_meta
}
```

### `src-tauri/src/launch.rs`

Responsibilities:

- spawn shell or agent sessions
- inject launch token
- manage environment and cwd
- expose role presets

Suggested command:

```text
agent_spawn(role, working_dir, scope, label?) -> { pty_id, token }
```

### `src-tauri/src/bind.rs`

Responsibilities:

- reconcile PTY sessions with swarm instances
- maintain launch token mapping
- expose unresolved sessions for debugging and UI status

Binding flow:

1. generate launch token
2. create PTY and spawn process
3. process starts and eventually registers with `swarm-mcp`
4. instance label includes `launch:<token>`
5. binder matches instance to PTY
6. frontend merges the visual node state

### `src-tauri/src/model.rs`

Responsibilities:

- typed shared models for frontend/backend boundaries
- instance summaries
- task summaries
- message summaries
- PTY session summaries
- graph update payloads

### `src-tauri/src/events.rs`

Responsibilities:

- centralize event names
- graph update events
- PTY stream events
- lifecycle events

## Frontend Design

### Directory Structure

```text
swarm-mcp/
  apps/
    swarm-ui/
      architecture-plan.md
      claude-initial-plan.md
      oc-initial-plan.md
      package.json
      index.html
      vite.config.ts
      tsconfig.json
      tailwind.config.ts
      src/
        main.ts
        App.svelte
        nodes/
          TerminalNode.svelte
          NodeHeader.svelte
        edges/
          MessageEdge.svelte
          TaskEdge.svelte
          DependencyEdge.svelte
        panels/
          Inspector.svelte
          Launcher.svelte
          SwarmStatus.svelte
        stores/
          swarm.ts
          pty.ts
        lib/
          types.ts
          graph.ts
          terminal.ts
        styles/
          terminal.css
      src-tauri/
        Cargo.toml
        tauri.conf.json
        src/
          main.rs
          pty.rs
          swarm.rs
          launch.rs
          bind.rs
          model.rs
          events.rs
```

### `App.svelte`

The main view is an XYFlow canvas with:

- custom `TerminalNode` nodes
- custom edge types for messages, tasks, and dependencies
- a fixed launcher and inspector region
- minimap support once the core interactions are stable

### `nodes/TerminalNode.svelte`

Each node wraps a `ghostty-web` terminal instance when a PTY is present.

Lifecycle:

```text
1. Node mounts and binds to a PTY session if one exists
2. terminal binding initializes ghostty-web and attaches it to the DOM
3. PTY data events stream into term.write(...)
4. term input flows back through pty_write(...)
5. ResizeObserver drives pty_resize(...)
```

Node chrome should include:

- role badge
- instance ID or pending-launch state
- online/stale/offline status
- cwd
- active task summary
- controls: focus, inspect, stop

### Edge components

`MessageEdge`:

- animated dashed line for recent activity
- blue by default
- hover label shows truncated recent content

`TaskEdge`:

- solid line from requester to assignee
- white for open, yellow for in progress, green for done, red for failed
- label shows task title

`DependencyEdge`:

- dotted line for `depends_on`
- gray when blocked, green when satisfied

### `lib/graph.ts`

Transforms normalized swarm state into XYFlow nodes and edges.

Inputs:

- instances
- PTY sessions
- tasks
- messages
- locks
- `ui/*` metadata

Outputs:

- one node per external instance
- one node per unresolved local PTY
- one merged node per bound PTY/instance pair
- derived message, task, and dependency edges

Layout behavior:

- use saved positions from `ui/layout/{scope}` when present
- otherwise apply auto-layout
- keep manual placement authoritative once the user moves a node

### Panels

`Inspector` should show:

- full task detail
- recent message history
- file locks or focus context
- instance metadata
- PTY and launch metadata

`Launcher` should support:

- spawn shell
- spawn agent
- choose role preset
- choose working directory
- choose scope

`SwarmStatus` should summarize:

- active instances
- stale instances
- task counts by status
- pending local PTYs waiting to bind

## KV Conventions For UI Metadata

These keys live in the existing swarm KV store so the UI can persist state without changing schema.

| Key Pattern | Value | Purpose |
|---|---|---|
| `ui/layout/{scope}` | `{ nodes: { [nodeId]: { x, y } } }` | Saved node positions |
| `ui/instance/{instanceId}` | `{ color, group, collapsed }` | Per-node visual metadata |
| `ui/config` | `{ autoLayout, pollInterval, theme }` | Global UI preferences |

Rules:

- only write under `ui/*`
- debounce layout persistence
- treat KV as the persistence layer for UI state
- if future `swarm-mcp` APIs expose KV writes directly, prefer those over custom direct DB writes

## Performance Rules

- do not repaint the whole graph for every PTY chunk
- do not rebuild terminal instances unnecessarily
- keep graph updates coarse and terminal updates fine-grained
- keep recent message history bounded in memory
- debounce layout persistence
- only emit graph updates when the state snapshot actually changes

## Security And Safety

- default to local-only operation
- open `swarm.db` read-only for normal state ingestion
- gate destructive actions like terminating an app-owned PTY
- never treat an external swarm instance as app-owned unless binding proves it
- keep app-owned PTYs and external-only instances visually distinct

## v1 Scope

### Included

- Tauri desktop app
- Svelte graph canvas
- terminal nodes rendered with `ghostty-web`
- Rust PTY manager
- Rust swarm DB watcher
- shell and agent launch controls
- reliable PTY-to-instance binding with launch tokens
- single-scope viewing

### Excluded

- remote multi-host swarm support
- shell piping between terminals
- native Ghostty embedding
- non-UI writes into swarm state

## Delivery Phases

### Phase 1: technical proof

- scaffold Tauri + Svelte app
- prove `ghostty-web` renders inside a node container
- prove one PTY can stream bytes into the terminal
- prove keyboard input and resize round-trip correctly

Goal:

- de-risk the hardest integration path first

### Phase 2: read-only swarm visualizer

- add `swarm.rs` poller
- render live instance nodes
- derive message and task edges
- add dependency edges from `depends_on`
- add inspector panel

Goal:

- see a live swarm as a graph without launch control yet

### Phase 3: embedded terminal nodes

- add PTY session model to the frontend
- show local PTY nodes immediately on spawn
- wire terminal buffers and reconnect behavior
- surface pending-bind vs bound state clearly

Goal:

- make terminals first-class nodes in the graph

### Phase 4: launcher and binding

- add shell and agent spawn controls
- add role presets
- implement launch-token binding
- merge PTY and instance cards when matched

Goal:

- launch and orchestrate agents from the UI reliably

### Phase 5: polish

- layout persistence
- auto-layout recovery
- animated activity edges
- filters and search
- minimap
- keyboard-first interactions

Goal:

- daily-driver quality for local swarm management

## Main Risks And Mitigations

### `ghostty-web` inside Tauri

Risk:

- asset loading or lifecycle behavior may fail inside the webview

Mitigation:

- prove this in Phase 1 before building swarm-specific UI

### PTY throughput under heavy output

Risk:

- event volume may overwhelm the frontend if writes are too granular

Mitigation:

- dedicated PTY stream path
- bounded buffer
- batching or coalescing before terminal writes when needed

### Agent launch variability

Risk:

- different agent CLIs and local configs behave differently

Mitigation:

- make launch profiles explicit and configurable
- default to a known-good local profile, but keep the launcher provider-agnostic

### Binding reliability

Risk:

- graph correlation becomes ambiguous if launched agents do not carry a token

Mitigation:

- require `launch:<token>` on app-launched agents
- expose unresolved PTYs visibly instead of guessing

### Database polling cost

Risk:

- naive polling can cause unnecessary work and UI churn

Mitigation:

- incremental checks
- snapshot diffing
- bounded recent message windows

## Resolved Product Decisions

- Framework: Svelte for v1
- Scope model: single scope first, multi-scope later if needed
- Agent binary: configurable, not hardcoded into the plan
- Persistence: UI metadata under `ui/*` only
- Terminal history: keep recent PTY output buffered in Rust even if the node is not currently visible

## Bottom Line

`swarm-ui` should be a Tauri desktop app with a Svelte graph frontend and a Rust backend that owns PTYs, process launch, binding, and read-only swarm state ingestion. `swarm-mcp` remains the source of truth. The two architectural rules that matter most are:

1. keep swarm graph updates separate from PTY byte streams
2. enforce explicit launch-token binding between app-launched PTYs and registered swarm instances
