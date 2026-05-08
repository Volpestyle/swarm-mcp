# System Load Analyzer and Rogue Session Cleanup

This page explains the `Analyze` surface in `swarm-ui`, what it can and cannot prove, and how to reason about rogue agent sessions, PTYs, TTY-backed harnesses, and detached MCP helpers.

It is written for both operators and future coding agents working in this repo.

---

## What this feature is for

The system load analyzer exists to answer three questions honestly:

1. What AI-related session trees are still running on this machine right now?
2. Which of them are real swarm sessions, orphan PTYs, terminal harnesses, or detached helpers?
3. What can be killed safely without taking down `swarm-ui`, `swarm-server`, or general dev tooling?

It is the repo's first operator surface that tries to reconcile:

- swarm truth from `~/.swarm-mcp/swarm.db`
- PTY/binder truth from the Tauri backend
- live OS process truth from `ps` and `lsof`
- local usage truth from `~/.claude` and `~/.codex`

---

## Where to find it

In `swarm-ui`, open the right-side shell surface and select `Analyze`.

Related kill surfaces:

- Node red traffic-light button: kills the real session tree for that node when possible
- Bottom `SwarmStatus` kill-all: kills all visible sessions in the current scope
- `Analyze` panel `Kill All Agent Sessions`: machine-wide kill across agent sessions and detached helpers

The design intent is:

- graph and bottom bar stay scope-local
- `Analyze` is the machine-wide operator view

---

## What the analyzer shows

The panel is split into four sections.

### Summary

High-level machine state:

- total agent sessions
- hidden or orphan sessions
- detached helper count
- estimated live cost
- top CPU offender
- top memory offender

### Agent Sessions

One row per classified session tree, such as:

- bound swarm agent session
- orphan PTY session
- terminal Claude session
- terminal Codex session

Each row can carry:

- root pid and process group
- child pids
- tty or pty id
- instance id and scope when linked
- cwd
- provider, harness, and model when known
- runtime, CPU, memory, helper count
- token and cost fields with confidence labels

### Helper MCPs

AI-adjacent helper processes such as:

- `context7-mcp`
- `xcodebuildmcp`
- repo `bun run src/index.ts` MCP children
- similar detached or attached helper processes

These rows are split from sessions so operators can see when helpers survive after the main agent is gone.

### External Burden

Read-only non-agent processes that are consuming meaningful CPU or memory and may slow the UI or agent responsiveness.

This section is intentionally non-destructive.

---

## Truth model: what to trust when surfaces disagree

Not every UI surface has the same truth quality.

Use this order:

1. OS process scan from `Analyze`, `ps`, and `lsof`
2. live daemon PTY state from `swarm-server`
3. live DB contents from `~/.swarm-mcp/swarm.db`
4. graph canvas state

Why:

- the graph can drift if the frontend store misses row removals
- the daemon can retain PTY catalog entries even after the swarm rows are gone
- stale nodes can remain visible even after the instance rows are gone
- detached helper processes can remain alive with no swarm row at all

If the graph shows nodes but the DB is empty, that is a UI drift problem, not proof of a live swarm.

For the narrower question "is something still burning tokens?", trust the OS process scan first.

For the narrower question "why does the canvas still show a node?", trust the daemon PTY catalog first.

---

## What we learned from a real stale-node incident

These are not hypothetical edge cases. They came out of debugging a real machine with dead-looking nodes that refused to disappear.

- Closing Ghostty or another terminal window does not necessarily remove the PTY node from `swarm-ui`.
- `swarm-server` owns the app PTY catalog. If that daemon still thinks a PTY exists, the graph can keep drawing it.
- A node can be gone from `instances` and still survive as a daemon PTY entry.
- A node can be gone from both the graph's backing swarm rows and the OS process list, yet still remain visible because the daemon retained a dead PTY record.
- Detached helpers such as `context7-mcp`, `xcodebuildmcp`, or repo `bun run src/index.ts` children can survive after the parent agent row is gone.
- If `Analyze` says there are no agent sessions but the graph still shows nodes, the remaining problem is almost always daemon PTY state or frontend state, not live token burn.

The practical consequence is simple:

- restarting Ghostty is not the same thing as killing the app-owned PTY session
- killing a swarm row is not the same thing as killing the real harness process tree
- a clean `Analyze` scan plus an empty daemon PTY catalog means the ghosts are visual only

---

## Daemon PTY truth

`swarm-server` exposes the live PTY catalog over its local Unix socket:

- socket path: `~/.swarm-mcp/server/swarm-server.sock`

When debugging stale nodes, this is the authoritative source for whether the app still thinks a PTY exists.

Example:

```sh
python3 - <<'PY'
import socket, json
path = '/Users/$USER/.swarm-mcp/server/swarm-server.sock'.replace('$USER', __import__('os').environ['USER'])
req = b'GET /state HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n'
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(path)
s.sendall(req)
chunks = []
while True:
    data = s.recv(65536)
    if not data:
        break
    chunks.append(data)
body = b''.join(chunks).split(b'\r\n\r\n', 1)[1]
payload = json.loads(body)
print(json.dumps({
    'pty_count': len(payload.get('ptys', [])),
    'instance_count': len(payload.get('instances', [])),
    'pty_ids': [pty['id'] for pty in payload.get('ptys', [])],
}, indent=2))
PY
```

Interpretation:

- nonzero `pty_count` means `swarm-server` still has live PTY catalog entries
- zero `pty_count` plus zero relevant AI processes means the graph ghosts are no longer machine-truth
- if the Unix socket itself is dead or refusing connections, `swarm-server` is unhealthy and should be restarted before trusting any canvas state

---

## Exact vs estimated values

This feature must stay conservative.

### Tokens

`Exact` tokens are shown only when a verified local source provides them.

- Claude: `~/.claude/sessions/<pid>.json` plus matching `~/.claude/projects/**/<sessionId>.jsonl`
- Codex: `~/.codex/state_5.sqlite` with a unique link to a live process

`Estimated` tokens are not derived from transcript length, CPU time, runtime, or guesswork.

If a trustworthy local source cannot prove tokens for that session, the UI shows `N/A`.

### Cost

`Exact` cost is shown only if a local source explicitly provides billed cost.

`Estimated` cost is shown only when:

- token counts are exact
- the provider/model pair matches the local price catalog snapshot

Unknown model, missing price row, ambiguous Codex thread linkage, or missing Claude logs all force `N/A`.

### GPU

GPU load is optional.

In macOS v1 it remains `N/A` unless a trustworthy non-privileged source is available.

---

## Kill semantics

Kill actions are intentionally cheap and final.

They do not force an agent to summarize or document itself before dying.

That is deliberate:

- runaway or high-token sessions should be stoppable immediately
- context expansion during shutdown can increase token burn
- handoff is a separate workflow, not a hard dependency of kill

### Per-session kill

The per-row kill button in `Analyze` targets the full session tree represented by that row.

Depending on the row kind, that may mean:

- a bound swarm instance
- an orphan PTY
- a terminal process group
- a detached helper process set

### Scope kill-all

The bottom `SwarmStatus` kill-all now routes through the real session-tree kill path for the visible scope instead of deregistering rows one by one.

### Machine-wide kill-all

The `Analyze` panel `Kill All Agent Sessions` button is the machine-wide cleanup path.

It is intended to remove:

- live swarm-linked sessions
- terminal Claude/Codex sessions detected outside the swarm
- detached helper MCP processes

### Protected processes

These must not be killed by the analyzer's normal destructive paths:

- `swarm-server`
- `swarm-ui`
- `tauri dev`
- `vite`
- general repo dev tooling unless it is positively classified as an agent-session helper
- arbitrary external apps listed under `External Burden`

---

## Common failure modes and how to interpret them

### Graph still shows many nodes after kill-all

Likely cause:

- stale frontend store drift
- stale daemon PTY catalog on an older build

How to verify:

- inspect `instances` in SQLite
- inspect daemon `/state`
- inspect OS processes
- compare with `Analyze`

What to trust:

- if daemon PTYs, DB rows, and process scan are all empty, the graph is stale

### DB is empty but helper processes remain

Likely cause:

- detached MCP subprocesses outlived the registered session

Examples:

- repo `bun run src/index.ts`
- `context7-mcp`
- `xcodebuildmcp`

What to trust:

- the OS process scan

### A Claude or Codex session appears with `N/A` cost

Likely cause:

- missing local usage log
- ambiguous Codex thread match
- unknown provider/model pricing entry

This is expected behavior. The analyzer prefers `N/A` over guesswork.

### A process is heavy but has no kill button

Likely cause:

- it is protected infrastructure
- it is an external burden process

That is by design.

### Restarting Ghostty did nothing

Likely cause:

- the PTY was app-owned and tracked by `swarm-server`, not by the terminal emulator you closed

What to do:

- use the in-app kill path first
- if the graph still disagrees with reality, inspect daemon `/state`
- if daemon `/state` is empty but the canvas still shows nodes, restart `swarm-ui`

---

## Practical kill playbook

Use this sequence when you want the cheapest truthful answer and the fastest cleanup.

1. Open `Analyze` and use the machine-wide kill button.
2. Re-scan and check whether agent sessions or detached helpers still appear.
3. If anything still looks suspicious, inspect:
   - `instances` in SQLite
   - AI-adjacent processes from `ps`
   - daemon `/state`
4. If daemon `/state` still has PTYs, the daemon still thinks those PTYs exist. Kill again from the fixed build or restart `swarm-server`.
5. If daemon `/state` is empty and the OS process list is clean, but the graph still shows nodes, restart `swarm-ui`. The remaining problem is visual state, not live token use.

This distinction matters because "restart the terminal" and "restart the daemon" solve different problems.

---

## Manual verification commands

When debugging the analyzer itself, these commands remain the ground truth helpers.

Current swarm rows:

```sh
sqlite3 ~/.swarm-mcp/swarm.db "SELECT id,label,pid,datetime(heartbeat,'unixepoch','localtime') hb FROM instances ORDER BY heartbeat DESC;"
```

AI-adjacent processes:

```sh
ps -axo pid,ppid,pgid,tty,etime,stat,command | egrep "swarm-server|claude|node .*codex|swarm-mcp-active/src/index.ts|xcodebuildmcp|context7-mcp" | egrep -v "egrep"
```

Who still has the DB open:

```sh
lsof -nP ~/.swarm-mcp/swarm.db
```

Inspect a suspected session group:

```sh
ps -p <pid1>,<pid2>,<pid3> -o pid,ppid,pgid,tty,etime,stat,command
```

Daemon PTY snapshot:

```sh
python3 - <<'PY'
import socket, json
path = '/Users/$USER/.swarm-mcp/server/swarm-server.sock'.replace('$USER', __import__('os').environ['USER'])
req = b'GET /state HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n'
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(path)
s.sendall(req)
chunks = []
while True:
    data = s.recv(65536)
    if not data:
        break
    chunks.append(data)
body = b''.join(chunks).split(b'\r\n\r\n', 1)[1]
payload = json.loads(body)
print(json.dumps({'pty_count': len(payload.get('ptys', [])), 'instance_count': len(payload.get('instances', []))}, indent=2))
PY
```

---

## Known issues in v1

- macOS-only implementation
- graph/store drift can keep dead nodes visible after their rows disappear
- older daemon builds can retain dead PTY rows until `swarm-server` is restarted
- GPU remains `N/A`
- some helpers can still be classified as detached instead of attached when the parent linkage is incomplete
- exact cost depends on local usage artifacts and a repo-local price catalog snapshot, not provider APIs
- manual OS-level verification is still useful while the analyzer matures

---

## Implementation map

Primary implementation files:

- `apps/swarm-ui/src/panels/AnalyzePanel.svelte`
- `apps/swarm-ui/src/stores/pty.ts`
- `apps/swarm-ui/src/lib/types.ts`
- `apps/swarm-ui/src/lib/analyze.ts`
- `apps/swarm-ui/src-tauri/src/system_load.rs`
- `apps/swarm-ui/src-tauri/src/price_catalog.json`

Related kill-path surfaces:

- `apps/swarm-ui/src/nodes/NodeHeader.svelte`
- `apps/swarm-ui/src/panels/SwarmStatus.svelte`
- `apps/swarm-ui/src-tauri/src/ui_commands.rs`

---

## Operator rule of thumb

If you are trying to answer "is something still burning tokens?" do not trust the graph alone.

Trust the analyzer, the database, and the OS process list in that order.
