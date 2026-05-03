# Phase 4 — Project Spaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class project spaces with canvas boundaries, project pages, agent membership, and project-aware context attachment.

**Architecture:** Projects are semantic workspace objects layered above swarm scope. Use explicit project metadata and membership records; do not pretend project boundaries are filesystem sandboxes.

**Tech Stack:** Svelte 5, TypeScript, Tauri/Rust SQLite writes, existing XYFlow canvas, Bun tests

---

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/lib/types.ts`
  - add `ProjectSpace`, `ProjectMembership`, and `ProjectBoundary`
- `apps/swarm-ui/src/App.svelte`
  - mount project boundaries over the canvas
- `apps/swarm-ui/src/panels/StartupHome.svelte`
  - add project list and project open/create actions
- `apps/swarm-ui/src-tauri/src/ui_commands.rs`
  - add project CRUD commands
- `apps/swarm-ui/src-tauri/src/writes.rs`
  - add SQLite project table helpers
- `apps/swarm-ui/src-tauri/src/main.rs`
  - register new commands

### New files to create

- `apps/swarm-ui/src/stores/projects.ts`
- `apps/swarm-ui/src/stores/projects.test.ts`
- `apps/swarm-ui/src/canvas/ProjectBoundary.svelte`
- `apps/swarm-ui/src/panels/ProjectPage.svelte`
- `docs/manual-qa/phase-4-project-spaces.md`

---

### Task 1: Project Domain Model

**Files:**
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Create: `apps/swarm-ui/src/stores/projects.ts`
- Create: `apps/swarm-ui/src/stores/projects.test.ts`

- [x] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { normalizeProjectSpace } from './projects';

describe('normalizeProjectSpace', () => {
  it('normalizes a project with boundary geometry and roots', () => {
    const project = normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/Users/mathewfrazier/Desktop/Alpha',
      additionalRoots: ['/Users/mathewfrazier/Desktop/Alpha/assets'],
      boundary: { x: 10, y: 20, width: 800, height: 500 },
    });

    expect(project?.name).toBe('Alpha');
    expect(project?.boundary.width).toBe(800);
    expect(project?.additionalRoots).toHaveLength(1);
  });
});
```

- [x] **Step 2: Add types**

```ts
export interface ProjectBoundary {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectSpace {
  id: string;
  name: string;
  root: string;
  additionalRoots: string[];
  scope: string | null;
  boundary: ProjectBoundary;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMembership {
  projectId: string;
  instanceId: string;
  attachedAt: number;
}
```

- [x] **Step 3: Implement normalization**

`apps/swarm-ui/src/stores/projects.ts`:

```ts
import type { ProjectSpace } from '../lib/types';

export function normalizeProjectSpace(value: Partial<ProjectSpace>): ProjectSpace | null {
  const id = value.id?.trim();
  const name = value.name?.trim();
  const root = value.root?.trim();
  if (!id || !name || !root) return null;

  const now = Date.now();
  return {
    id,
    name,
    root,
    additionalRoots: Array.isArray(value.additionalRoots)
      ? value.additionalRoots.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
    scope: value.scope?.trim() || null,
    boundary: {
      x: value.boundary?.x ?? 120,
      y: value.boundary?.y ?? 120,
      width: value.boundary?.width ?? 720,
      height: value.boundary?.height ?? 420,
    },
    createdAt: value.createdAt ?? now,
    updatedAt: value.updatedAt ?? now,
  };
}
```

- [x] **Step 4: Run tests**

Run: `cd apps/swarm-ui && bun test src/stores/projects.test.ts`

Expected: PASS

### Task 2: SQLite Project Persistence

**Files:**
- Modify: `apps/swarm-ui/src-tauri/src/writes.rs`
- Modify: `apps/swarm-ui/src-tauri/src/ui_commands.rs`
- Modify: `apps/swarm-ui/src-tauri/src/main.rs`

- [x] **Step 1: Add tables**

In `writes.rs`, ensure tables:

```sql
CREATE TABLE IF NOT EXISTS ui_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  additional_roots TEXT NOT NULL DEFAULT '[]',
  scope TEXT,
  boundary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_project_memberships (
  project_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, instance_id)
);
```

- [x] **Step 2: Add commands**

Add Tauri commands:

- `ui_list_projects`
- `ui_save_project`
- `ui_delete_project`
- `ui_attach_instance_to_project`
- `ui_detach_instance_from_project`

- [x] **Step 3: Register commands**

Add each command to the invoke handler in `main.rs`.

- [x] **Step 4: Rust check**

Run:

```bash
cd apps/swarm-ui/src-tauri
cargo test
```

Expected: Rust tests pass.

### Task 3: Canvas Project Boundary

**Files:**
- Create: `apps/swarm-ui/src/canvas/ProjectBoundary.svelte`
- Modify: `apps/swarm-ui/src/App.svelte`

- [x] **Step 1: Create boundary component**

```svelte
<script lang="ts">
  import type { ProjectSpace } from '../lib/types';
  export let project: ProjectSpace;
</script>

<div
  class="project-boundary"
  style={`left:${project.boundary.x}px; top:${project.boundary.y}px; width:${project.boundary.width}px; height:${project.boundary.height}px;`}
>
  <div class="project-boundary-label">{project.name}</div>
</div>
```

- [x] **Step 2: Mount boundaries**

In `App.svelte`, mount project boundaries above the XYFlow background and below nodes where practical.

Expected:

- project regions are visible
- they do not block basic node interaction unless selected

### Task 4: Project Page

**Files:**
- Create: `apps/swarm-ui/src/panels/ProjectPage.svelte`
- Modify: `apps/swarm-ui/src/App.svelte`
- Modify: `apps/swarm-ui/src/panels/StartupHome.svelte`

- [x] **Step 1: Create project page**

Project page sections:

- Overview
- Agents
- Notes
- Assets
- Tasks

- [x] **Step 2: Wire open/create**

From Home:

- `New Project`
- `Open Project`

Expected:

- opening a project enters canvas with that project boundary visible
- project page can be opened from boundary label

### Task 5: Agent Attachment Behavior

**Files:**
- Modify: `apps/swarm-ui/src/App.svelte`
- Modify: `apps/swarm-ui/src/stores/projects.ts`

- [x] **Step 1: Detect node inside boundary**

When a node drag ends, compare node center to project boundary.

Expected:

- if inside one project, show attachment affordance
- do not silently change filesystem access

- [x] **Step 2: Attach with confirmation**

Prompt:

```text
Attach this agent to project "<project name>"?
This shares project context with the agent. It does not change OS-level file permissions.
```

Use the in-app confirm helper, not `window.confirm`.

### Task 6: Verification

**Files:**
- Create: `docs/manual-qa/phase-4-project-spaces.md`

- [ ] **Step 1: Manual QA**

2026-04-25 note: the implementation, checks, debug bundle, and `/Users/mathewfrazier/Applications/Swarm UI Lab.app` refresh are complete. Literal click-through from this Codex runtime is blocked because macOS denied assistive access for `System Events` and `screencapture` failed to capture the display; use `docs/manual-qa/phase-4-project-spaces.md` for the remaining human-visible pass.

```md
# Phase 4 Project Spaces Manual QA

1. Create a project from Home.
Expected: project appears in Home list and canvas boundary.

2. Open project page.
Expected: Overview, Agents, Notes, Assets, and Tasks sections are visible.

3. Drag an agent into the project boundary.
Expected: attach confirmation appears and explains this is context sharing, not sandboxing.

4. Confirm attach.
Expected: agent appears in the project's Agents section.
```

- [x] **Step 2: Run checks**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/stores/projects.test.ts
bun run check
```

Expected: tests and full check pass.

2026-04-25 verification:

- `bun test apps/swarm-ui/src/stores/projects.test.ts apps/swarm-ui/src/stores/startup.test.ts`: passed, 13 tests.
- `cargo test -p swarm-ui project_`: passed, 2 tests.
- `cargo test -p swarm-ui retarget_instance_runtime_context_updates_scope_and_directory`: passed, 1 test.
- `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
- `bun run check`: passed, 155 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and Tauri Rust tests.
- `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
- Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app` and launched the refreshed app process successfully.
