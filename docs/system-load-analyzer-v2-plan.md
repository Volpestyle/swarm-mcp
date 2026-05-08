# System Load Analyzer V2 Plan

This document sketches the next implementation phase after the macOS-first analyzer and kill-path work.

The main goal is simple:

Make the analyzer and kill surfaces work across operating systems without weakening the exact-vs-estimated rules.

---

## Goals

- support macOS, Linux, and Windows
- preserve honest attribution semantics
- preserve protected-process rules
- keep the `Analyze` tab as the operator truth surface
- allow the same UI model to render platform-specific data without hiding uncertainty

Non-goals for v2:

- provider API billing lookups
- hidden price guessing
- privileged-only collectors as hard requirements

---

## Platform targets

### macOS

Carry forward the current implementation:

- `ps`
- `lsof`
- swarm DB
- binder/PTy state
- local Claude/Codex artifacts

### Linux

Primary inputs:

- `/proc/<pid>`
- `/proc/<pid>/stat`
- `/proc/<pid>/cmdline`
- `/proc/<pid>/status`
- `/proc/<pid>/fd`
- optional `ps` fallback for portability

Likely session forms:

- terminal Claude/Codex sessions under PTY-backed shells
- detached MCP children
- tmux/screen-hosted agent sessions

### Windows

Primary inputs:

- PowerShell or WMI process inventory
- native process tree enumeration
- ConPTY-backed terminal sessions where detectable
- open-file and command-line inspection when available without elevation

Likely session forms:

- Codex or Claude launched from PowerShell / Windows Terminal
- detached Node/Bun helpers
- terminal sessions with weaker TTY semantics than POSIX

---

## Required architecture changes

### 1. Introduce a platform scan abstraction

Split the current macOS-oriented scanner into an OS-neutral interface with per-platform implementations.

Suggested shape:

```rust
trait PlatformSystemInspector {
    fn collect_process_snapshot(&self) -> Result<Vec<RawProcess>>;
    fn collect_open_db_holders(&self, db_path: &Path) -> Result<Vec<DbHolder>>;
    fn classify_terminals(&self, processes: &[RawProcess]) -> Result<Vec<TerminalContext>>;
}
```

Implementations:

- `MacOsInspector`
- `LinuxInspector`
- `WindowsInspector`

### 2. Normalize process data before classification

Introduce an internal normalized model so the classifier does not branch on platform details everywhere.

Suggested fields:

- `pid`
- `ppid`
- `process_group_id`
- `session_id` where available
- `terminal_name`
- `started_at`
- `elapsed_seconds`
- `cpu_percent`
- `rss_kb`
- `command`
- `executable`

### 3. Separate classification from collection

The classifier should take normalized process rows plus swarm/binder data and return:

- agent sessions
- helper processes
- protected processes
- external burden processes

That keeps the rules reusable across OS backends.

### 4. Separate kill routing from platform discovery

Kill routing needs its own abstraction because POSIX process groups and Windows process trees do not behave the same way.

Suggested shape:

```rust
trait PlatformKillStrategy {
    fn kill_process_group(&self, pgid: i32) -> Result<KillResult>;
    fn kill_process_tree(&self, pid: u32) -> Result<KillResult>;
}
```

macOS/Linux can continue using process-group-aware behavior.

Windows will likely need explicit tree walking and child termination rules.

---

## Attribution rules that must survive v2

These rules are platform-independent and should not be weakened.

### Tokens

- never infer tokens from wall-clock time
- never infer tokens from CPU or memory
- never infer tokens from transcript length

### Cost

- `Exact` only if the local source explicitly provides billed cost
- `Estimated` only from exact token counts plus a matching price catalog row
- unknown model or missing price entry means `N/A`

### Confidence labels

Keep the current `exact`, `estimated`, `unlinked`, and `na` model.

Do not collapse ambiguity into fake precision.

---

## Platform-specific design notes

### Linux notes

- PTY discovery may be more reliable via `/proc/<pid>/fd` and `/dev/pts/*`
- tmux and screen can add another parent layer that should not break classification
- cgroup or container boundaries may matter when the app runs inside devcontainers or remote hosts

### Windows notes

- process-group semantics are weaker and different
- terminal identity may need to rely on Windows Terminal / PowerShell parent chains instead of TTY names
- Bun/Node child helpers may need explicit descendant enumeration rather than negative-pgid kill
- GPU metrics may be more available via non-privileged APIs, but should still remain optional

### Cross-platform pricing and attribution

- the price catalog can stay repo-local and shared
- Claude/Codex artifact readers should stay separate from process collection
- local file layouts may differ by platform and should move behind provider-specific path resolvers

---

## UI changes for v2

- show the detected host platform in the `Analyze` panel
- surface platform-specific caveats when a metric is unsupported
- preserve the same summary and row structure across platforms
- add explicit badges for `partial platform support` where a row is classifiable but not fully attributable

Possible additions:

- platform filter in summary
- richer `why N/A` tooltip text
- optional export of the current scan snapshot for bug reports

---

## Testing plan

### Unit tests

- per-platform process parsing fixtures
- session classification fixtures
- protected-process exclusion rules
- kill target derivation on each OS family
- Claude/Codex attribution behavior under missing, ambiguous, and exact-match conditions

### Integration tests

- mock process-tree snapshots for macOS, Linux, and Windows
- snapshot rendering tests for mixed confidence labels
- machine-wide kill summary behavior with protected rows mixed in

### Manual validation matrix

- macOS terminal Claude session
- macOS terminal Codex session
- macOS detached helper leftover
- Linux PTY-backed shell session
- Linux tmux-hosted session
- Windows Terminal session
- Windows detached Node/Bun helper

---

## Suggested delivery order

### Phase 1: internal abstraction

- extract OS-neutral process model
- move macOS code behind a platform inspector interface
- keep behavior unchanged

### Phase 2: Linux support

- implement Linux process collector
- validate PTY, tmux, and detached-helper behavior
- add Linux fixtures and tests

### Phase 3: Windows support

- implement Windows process and tree-kill collector
- validate Windows Terminal and detached helper behavior
- add Windows fixtures and tests

### Phase 4: polish and reporting

- improve `why N/A` explanations
- add exportable scan snapshot
- add richer operator docs and bug-report templates

---

## Success bar for v2

V2 is successful when:

- the same `Analyze` tab works credibly on macOS, Linux, and Windows
- the UI still prefers `N/A` over fiction
- kill actions stop real agent trees, not just database rows
- operators can distinguish dead graph residue from live machine load
- future agents can extend the scanner without rediscovering platform semantics from scratch
