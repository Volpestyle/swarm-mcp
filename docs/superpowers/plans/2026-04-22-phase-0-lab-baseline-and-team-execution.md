# Phase 0 — Lab Baseline And Team Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old `swarm-mcp-lab` checkout with the current `swarm-mcp-active` baseline, verify the lab copy, and prepare it for safe multi-agent execution.

**Architecture:** Treat `swarm-mcp-active` as the reference source and `swarm-mcp-lab` as the experimental execution lane. Use a dedicated swarm scope for lab work so agents coordinate inside the lab repo without polluting the active reference lane.

**Tech Stack:** Git, rsync, Bun, Tauri, SQLite-backed swarm coordination, swarm MCP tools

---

## File Structure

### Repos

- Source: `/Users/mathewfrazier/Desktop/swarm-mcp-active`
- Destination: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`

### New files to create in lab

- `docs/OVERHAUL_EXECUTION_STATUS.md`
  - single current-status tracker for all agents
- `docs/OVERHAUL_AGENT_ASSIGNMENTS.md`
  - role and file-ownership assignment table
- `docs/OVERHAUL_HANDOFF_PROMPT.md`
  - paste-ready bootstrap prompt for planner/implementer/reviewer agents

---

### Task 1: Preserve Existing Lab Before Replacement

**Files:**
- Read: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`
- Create: `/Users/mathewfrazier/Desktop/swarm-mcp-lab-backup-<timestamp>`

- [ ] **Step 1: Inspect both repos**

Run:

```bash
cd /Users/mathewfrazier/Desktop
test -d swarm-mcp-active && test -d swarm-mcp-lab
git -C swarm-mcp-active status --short
git -C swarm-mcp-lab status --short
```

Expected: both directories exist; status output is visible for both.

- [ ] **Step 2: Create timestamped backup of old lab**

Run:

```bash
cd /Users/mathewfrazier/Desktop
STAMP="$(date +%Y%m%d-%H%M%S)"
mv swarm-mcp-lab "swarm-mcp-lab-backup-${STAMP}"
```

Expected: old lab is moved to a backup directory.

- [ ] **Step 3: Verify backup exists**

Run:

```bash
cd /Users/mathewfrazier/Desktop
ls -d swarm-mcp-lab-backup-*
```

Expected: at least one backup directory appears.

### Task 2: Copy Active Baseline Into Lab

**Files:**
- Copy from: `/Users/mathewfrazier/Desktop/swarm-mcp-active`
- Copy to: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`

- [ ] **Step 1: Copy active into lab**

Run:

```bash
cd /Users/mathewfrazier/Desktop
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude target \
  --exclude apps/swarm-ui/dist \
  swarm-mcp-active/ swarm-mcp-lab/
```

Expected: `swarm-mcp-lab` exists and contains the current active source tree.

- [ ] **Step 2: Initialize lab git if needed**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
if [ ! -d .git ]; then git init; fi
git status --short
```

Expected: lab is a git repo and shows copied files if no previous `.git` was preserved.

- [ ] **Step 3: Install dependencies if missing**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun install
```

Expected: dependencies install without fatal errors.

### Task 3: Verify Lab Baseline

**Files:**
- Verify: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`

- [ ] **Step 1: Run authoritative repo check**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun run check
```

Expected: typecheck, tests, frontend build/check, and Rust tests pass.

- [ ] **Step 2: Verify UI build directly**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui
bun run check
bun run build
```

Expected: `svelte-check found 0 errors and 0 warnings`; Vite build exits 0.

### Task 4: Create Team Execution Docs

**Files:**
- Create: `docs/OVERHAUL_EXECUTION_STATUS.md`
- Create: `docs/OVERHAUL_AGENT_ASSIGNMENTS.md`
- Create: `docs/OVERHAUL_HANDOFF_PROMPT.md`

- [ ] **Step 1: Create status tracker**

Create `docs/OVERHAUL_EXECUTION_STATUS.md`:

```md
# Overhaul Execution Status

Repo: `/Users/mathewfrazier/Desktop/swarm-mcp-lab`
Scope: `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`

## Current Phase

Phase 0: Lab baseline and team execution setup

## Verification

- Baseline `bun run check`: not yet run in this lab copy
- UI `bun run check`: not yet run in this lab copy
- UI `bun run build`: not yet run in this lab copy

## Active Decisions

- `swarm-mcp-active` remains the reference lane.
- `swarm-mcp-lab` is the execution lane for the overhaul.
- Use a dedicated swarm scope ending in `#overhaul`.
```

- [ ] **Step 2: Create assignment table**

Create `docs/OVERHAUL_AGENT_ASSIGNMENTS.md`:

```md
# Overhaul Agent Assignments

## Planner

- Owns phase sequencing, task decomposition, and merge order.
- Does not perform broad implementation edits unless unblocking.

## Builder A — Launch/Productization

- Owns `apps/swarm-ui/src-tauri/tauri.conf.json`
- Owns app icon assets and launch profile plumbing.

## Builder B — Agent Identity

- Owns agent profile/domain model and agent card surfaces.

## Builder C — Project Spaces

- Owns project models, boundaries, project page, and project assets.

## Builder D — Visual Systems

- Owns startup hero, theme split, DarkFolder object language, and visual QA.

## Reviewer

- Reviews all merged slices for correctness, scope discipline, and regressions.
```

- [ ] **Step 3: Create handoff prompt**

Create `docs/OVERHAUL_HANDOFF_PROMPT.md`:

```md
# Overhaul Handoff Prompt

Use the swarm register tool with directory="/Users/mathewfrazier/Desktop/swarm-mcp-lab", scope="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul", and label="provider:<provider> role:<planner|implementer|reviewer> name:<short-name>".

Then call whoami, list_instances, poll_messages, and list_tasks.

Read these files before work:

- docs/superpowers/specs/2026-04-22-agentic-orchestration-os-master-spec.md
- docs/OVERHAUL_EXECUTION_STATUS.md
- docs/OVERHAUL_AGENT_ASSIGNMENTS.md

Claim only tasks matching your assigned files. Lock files before editing. Do not revert changes made by other agents. Use wait_for_activity when idle.
```

### Task 5: Swarm Readiness Check

**Files:**
- Read: `docs/OVERHAUL_HANDOFF_PROMPT.md`
- Runtime: shared `~/.swarm-mcp/swarm.db`

- [ ] **Step 1: Register one planner in lab scope**

Use the swarm tool:

```text
register(directory="/Users/mathewfrazier/Desktop/swarm-mcp-lab", scope="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul", label="provider:codex role:planner name:overhaul-planner")
```

Expected: planner appears in `list_instances` under the lab overhaul scope.

- [ ] **Step 2: Create a smoke task**

Use the swarm tool:

```text
request_task(title="Smoke check lab baseline", type="test", priority=100, description="Run bun run check in /Users/mathewfrazier/Desktop/swarm-mcp-lab and report the result.", files=["package.json"])
```

Expected: task appears in `list_tasks`.

- [ ] **Step 3: Verify UI tolerance**

Open `swarm-ui` and set the active scope to `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`.

Expected:

- lab agents appear
- active/reference agents remain separate when scope is filtered
- all-scopes may show both lanes, which is expected and should be treated carefully

---

## Multi-Agent Concurrency Guidance

The swarm MCP server and `swarm-ui` are designed to tolerate multiple agents sharing one SQLite database.

Safe pattern:

- use one shared lab scope
- assign disjoint file ownership
- require file locks before edits
- use tasks for coordination
- keep planner/reviewer roles explicit
- run verification after each merge slice

Risk pattern:

- multiple agents editing the same large Svelte files
- all agents working in `all scopes`
- unclear active/lab lane split
- direct DB/file changes outside the swarm task flow
- multiple UI dev servers competing for the same ports

Recommended team size for the first overhaul wave:

- 1 planner
- 2 implementers
- 1 reviewer

Add more only after the first wave proves clean.
