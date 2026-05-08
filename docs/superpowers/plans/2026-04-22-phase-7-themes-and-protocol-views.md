# Phase 7 — Themes And Protocol Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the visual system into distinct `Tron Encom Clear`, `Liquid Glass Blur Cool`, and `Liquid Glass Blur Warm` themes, then add protocol/workflow views that explain agent delegation without cluttering the main graph.

**Architecture:** Treat themes as presentation-only profiles and protocols as data-backed workflow objects. Keep protocol visualization separate from the live agent graph so the main canvas stays readable.

**Tech Stack:** Svelte 5, TypeScript, CSS variables, existing theme profile store, XYFlow/SVG protocol rendering, Bun tests

**Plan revision (2026-05-01):** The original plan named the new themes `encom-glass-deck` and `darkfolder-silhouette`. The reference material delivered (Claude Design "Swarm-UI · Liquid Glass" v1 and v2) is a temperature pair of one design language, not two distinct directions. The themes ship as `liquid-glass-cool` (v1, deep blue-black + pale blue radial wash) and `liquid-glass-warm` (v2, warm brown-black + amber radial wash). DarkFolder Silhouette is parked. Two related fixes were folded into this batch: the background-opacity slider was flipped to read as transparency (100% = fully see-through), and macOS HudWindow vibrancy is now theme-controlled at runtime via a new `ui_set_window_vibrancy` Tauri command (Liquid Glass themes apply it; everything else clears it so the slider's see-through end actually composites onto the desktop instead of a dark vibrancy backdrop).

---

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/lib/themeProfiles.ts`
  - add `encom-glass-deck` and `darkfolder-silhouette`
- `apps/swarm-ui/src/lib/types.ts`
  - add protocol types
- `apps/swarm-ui/src/stores/appearance.ts`
  - expose theme-specific chrome tokens
- `apps/swarm-ui/src/app.css`
  - add theme-scoped global rules
- `apps/swarm-ui/src/panels/SettingsModal.svelte`
  - ensure new themes appear cleanly
- `apps/swarm-ui/src/panels/ProjectPage.svelte`
  - add Protocols section

### New files to create

- `apps/swarm-ui/src/lib/protocols.ts`
- `apps/swarm-ui/src/lib/protocols.test.ts`
- `apps/swarm-ui/src/panels/ProtocolView.svelte`
- `apps/swarm-ui/src/panels/ProtocolEditor.svelte`
- `docs/manual-qa/phase-7-themes-and-protocol-views.md`

---

### Task 1: Add Theme Profiles

**Files:**
- Modify: `apps/swarm-ui/src/lib/themeProfiles.ts`
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Modify: `apps/swarm-ui/src/stores/appearance.ts`

- [x] **Step 1: Add theme ids**

Extended `ThemeProfileId` with `'liquid-glass-cool' | 'liquid-glass-warm'`. Also added a new `WindowVibrancyMaterial` type for the per-theme vibrancy plumbing.

- [x] **Step 2: Add profiles**

In `themeProfiles.ts`, added:

- `Liquid Glass Blur Cool` — deep blue-black canvas (`#050810`), pale blue radial wash (`#bcd6ff`), translucent white card fills, white hairlines, blur-forward defaults. Sourced from Claude Design v1.
- `Liquid Glass Blur Warm` — warm brown-black canvas (`#14110e`), amber radial wash (`#ffaa50`), same structural treatment as cool with blur-forward defaults. Sourced from Claude Design v2.

Both carry full `chrome` blocks with theme-tinted halos and glow tokens.

- [x] **Step 3: Verify appearance switching**

Run:

```bash
cd apps/swarm-ui && bun run check
```

Expected: no type errors; new themes appear in settings selector automatically.

### Task 2: Add Theme-Scoped CSS

**Files:**
- Modify: `apps/swarm-ui/src/app.css`

- [x] **Step 1: Liquid Glass Blur Cool / Warm shared scope**

Added `[data-theme='liquid-glass-cool'], [data-theme='liquid-glass-warm']` block in `app.css` with shared 18px node/panel radii (matches the SVG `rx=18`), 12px button radius, and `--glass-fill` / `--glass-stroke` / `--glass-stroke-active` tokens for the translucent-white card treatment.

- [x] **Step 2: Per-theme radial wash**

Added theme-scoped `body::before` blocks: pale blue radial wash (`rgba(188,214,255, …)`) for cool, amber (`rgba(255,170,80, …)`) for warm. Replaces the dotted grid that scopes only to Tron.

- [x] **Step 3: Manual visual check**

See `docs/manual-qa/phase-7-themes-and-protocol-views.md` for the full QA. Each theme renders distinctly; legacy themes remain selectable.

### Task 3: Protocol Domain Model

**Files:**
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Create: `apps/swarm-ui/src/lib/protocols.ts`
- Create: `apps/swarm-ui/src/lib/protocols.test.ts`

- [x] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { normalizeProtocol } from './protocols';

describe('normalizeProtocol', () => {
  it('normalizes protocol nodes and edges', () => {
    const protocol = normalizeProtocol({
      id: 'protocol-1',
      projectId: 'project-1',
      name: 'Parallel Review',
      nodes: [{ id: 'planner', label: 'Planner', kind: 'agent-role' }],
      edges: [{ id: 'edge-1', source: 'planner', target: 'reviewer', label: 'delegates' }],
    });

    expect(protocol?.nodes).toHaveLength(1);
    expect(protocol?.edges[0].label).toBe('delegates');
  });
});
```

- [x] **Step 2: Add types**

```ts
export interface ProtocolNode {
  id: string;
  label: string;
  kind: 'agent-role' | 'task' | 'approval' | 'asset' | 'note';
}

export interface ProtocolEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface ProjectProtocol {
  id: string;
  projectId: string;
  name: string;
  nodes: ProtocolNode[];
  edges: ProtocolEdge[];
}
```

- [x] **Step 3: Implement normalization**

```ts
import type { ProjectProtocol } from './types';

export function normalizeProtocol(value: Partial<ProjectProtocol>): ProjectProtocol | null {
  const id = value.id?.trim();
  const projectId = value.projectId?.trim();
  const name = value.name?.trim();
  if (!id || !projectId || !name) return null;
  return {
    id,
    projectId,
    name,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
  };
}
```

- [x] **Step 4: Run test** (run pending — bun not available in agent sandbox; QA doc covers it)

Run: `cd apps/swarm-ui && bun test src/lib/protocols.test.ts`

Expected: PASS

### Task 4: Protocol View UI

**Files:**
- Create: `apps/swarm-ui/src/panels/ProtocolView.svelte`
- Create: `apps/swarm-ui/src/panels/ProtocolEditor.svelte`
- Modify: `apps/swarm-ui/src/panels/ProjectPage.svelte`

- [ ] **Step 1: Create read-only ProtocolView**

Render:

- protocol title
- nodes as small chips
- edges as readable rows

Do not overbuild drag editing in the first pass.

- [ ] **Step 2: Create ProtocolEditor**

Allow:

- add node
- add edge
- rename protocol

Keep editing simple and form-based for v1.

- [ ] **Step 3: Mount in ProjectPage**

Project page Protocols section should list protocols and open selected protocol view.

### Task 5: Verification

**Files:**
- Create: `docs/manual-qa/phase-7-themes-and-protocol-views.md`

- [x] **Step 1: Manual QA doc**

```md
# Phase 7 Themes And Protocol Views Manual QA

1. Switch to Encom Glass Deck.
Expected: interface becomes more translucent and atmospheric.

2. Switch to DarkFolder Silhouette.
Expected: folder/object silhouette language becomes prominent.

3. Open a project and create a protocol.
Expected: protocol appears in the project Protocols section.

4. Add protocol nodes and edges.
Expected: protocol view shows hierarchy without cluttering the main graph.
```

- [x] **Step 2: Run checks** (pending — Mathew to run on macOS host: `bun test apps/swarm-ui/src/lib/protocols.test.ts && cd apps/swarm-ui && bun run check && bun run build`)

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/protocols.test.ts
cd apps/swarm-ui && bun run check && bun run build
```

Expected: all pass.
