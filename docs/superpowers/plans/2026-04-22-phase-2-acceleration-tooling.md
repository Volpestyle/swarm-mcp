# Phase 2 — Acceleration Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add screenshot capture, UI-state export, and CLI control primitives so agents can review and evolve the product faster with less manual description.

**Architecture:** Extend the existing UI command queue and Tauri backend with read-only capture/export operations first. Keep screenshot artifacts and layout exports explicit files so they can be attached to tasks, reviewed by agents, and used for visual regression.

**Tech Stack:** Tauri 2, Rust, Svelte 5, TypeScript, Bun tests, existing `swarm-mcp ui` CLI, local filesystem artifacts

---

## File Structure

### Existing files to modify

- `src/cli.ts`
  - add `swarm-mcp ui screenshot` and `swarm-mcp ui export-layout`
- `src/cmd.ts`
  - implement CLI command parsing and DB queue writes
- `apps/swarm-ui/src-tauri/src/ui_control.rs`
  - claim and execute screenshot/export UI commands
- `apps/swarm-ui/src-tauri/src/main.rs`
  - register any new Tauri commands
- `apps/swarm-ui/src/panels/SettingsModal.svelte`
  - add diagnostics buttons for screenshot/export

### New files to create

- `apps/swarm-ui/src/lib/uiExport.ts`
  - frontend export payload helpers
- `apps/swarm-ui/src/lib/uiExport.test.ts`
  - tests for export payload shape
- `docs/manual-qa/phase-2-acceleration-tooling.md`
  - click-through and CLI verification checklist

---

## Completion Status

Phase 2 is complete in `swarm-mcp-lab`.

Verified behavior:

- CLI/UI command path for `ui export-layout`.
- CLI/UI command path for `ui screenshot`, including explicit unsupported-capture errors when runtime capture is unavailable.
- Settings diagnostics controls for export and screenshot actions.
- Manual QA checklist at `docs/manual-qa/phase-2-acceleration-tooling.md`.

Latest verification after the listener-health reliability sync:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun run check
cd apps/swarm-ui
bunx tauri build --debug --no-bundle
```

Expected: both commands pass. The Tauri debug build should produce `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`. The existing Vite chunk-size warning is acceptable until a dedicated code-splitting pass.

## Post-Phase-2 Reliability Sync

This sync is complete and belongs between Phase 2 and Phase 3 because it gives the UI a reliable way to tell whether launched agents are actually listening before Phase 3 changes the node body.

Files now covered by this sync:

- `src/events.ts`
  - includes `agent.polled`, `agent.waiting`, and `agent.wait_returned` event types.
- `src/messages.ts`
  - emits `agent.polled` from `poll_messages`, including empty polls.
- `src/index.ts`
  - emits `agent.waiting` when `wait_for_activity` enters the idle loop.
  - emits `agent.wait_returned` when the wait loop returns with changes or timeout.
- `apps/swarm-ui/src/lib/agentListenerHealth.ts`
  - derives `Listening`, `Polled`, `Needs poll`, `Working`, `Register needed`, `Scope mismatch`, `Offline`, and `Unverified`.
- `apps/swarm-ui/src/lib/graph.ts`
  - adds unread-message count and listener-health data to each graph node.
- `apps/swarm-ui/src/nodes/NodeHeader.svelte`
  - renders listener-health and unread-message badges.
- `apps/swarm-ui/src/panels/Inspector.svelte`
  - renders Listener Health details.
- `docs/manual-qa/listener-health-reliability-sync.md`
  - manual workflow verification checklist.

Tests:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test test/events.test.ts
cd apps/swarm-ui
bun test src/lib/agentListenerHealth.test.ts src/lib/graph.test.ts
```

Expected: all tests pass.

---

### Task 1: Add UI Export Payload Helper

**Files:**
- Create: `apps/swarm-ui/src/lib/uiExport.ts`
- Create: `apps/swarm-ui/src/lib/uiExport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { buildUiExportPayload } from './uiExport';

describe('buildUiExportPayload', () => {
  it('serializes nodes, edges, theme, and active scope', () => {
    const payload = buildUiExportPayload({
      activeScope: '/tmp/demo#overhaul',
      themeProfileId: 'tron-encom-os',
      nodes: [{ id: 'node-a', position: { x: 1, y: 2 } }],
      edges: [{ id: 'edge-a', source: 'node-a', target: 'node-b' }],
    });

    expect(payload.activeScope).toBe('/tmp/demo#overhaul');
    expect(payload.themeProfileId).toBe('tron-encom-os');
    expect(payload.nodes).toHaveLength(1);
    expect(payload.edges).toHaveLength(1);
    expect(payload.exportedAt).toMatch(/T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/swarm-ui && bun test src/lib/uiExport.test.ts`

Expected: FAIL because `uiExport.ts` does not exist.

- [ ] **Step 3: Implement helper**

```ts
type ExportInput = {
  activeScope: string | null;
  themeProfileId: string;
  nodes: Array<{ id: string; position?: { x: number; y: number } }>;
  edges: Array<{ id: string; source?: string; target?: string }>;
};

export function buildUiExportPayload(input: ExportInput) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    activeScope: input.activeScope,
    themeProfileId: input.themeProfileId,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      position: node.position ?? null,
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      source: edge.source ?? null,
      target: edge.target ?? null,
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/swarm-ui && bun test src/lib/uiExport.test.ts`

Expected: PASS

### Task 2: Add CLI UI Export Command

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cmd.ts`
- Test: existing Bun CLI tests or manual CLI smoke command

- [ ] **Step 1: Add command help text**

Add `ui export-layout [--scope <scope>] [--out <file>] [--json]` to `src/cli.ts` help output.

- [ ] **Step 2: Add command parser**

In `src/cmd.ts`, enqueue a UI command:

```ts
{
  kind: 'ui.export-layout',
  payload: {
    scope: flags.scope ?? null,
    out: flags.out ?? null,
  },
}
```

- [ ] **Step 3: Run CLI smoke**

Run:

```bash
bun run src/cli.ts ui export-layout --scope /tmp/demo --out /tmp/swarm-ui-layout.json --wait 0 --json
```

Expected: command returns JSON with queued command id.

### Task 3: Add Screenshot Command Path

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cmd.ts`
- Modify: `apps/swarm-ui/src-tauri/src/ui_control.rs`

- [ ] **Step 1: Add command help text**

Add `ui screenshot [--out <file>] [--json]` to CLI help.

- [ ] **Step 2: Enqueue command**

In `src/cmd.ts`, enqueue:

```ts
{
  kind: 'ui.screenshot',
  payload: {
    out: flags.out ?? null,
  },
}
```

- [ ] **Step 3: Implement UI command handler**

In `ui_control.rs`, claim `ui.screenshot` and write a screenshot file path into command result. Use Tauri/window screenshot APIs available in the current runtime. If the framework cannot capture the transparent window directly, write an explicit error result:

```json
{
  "ok": false,
  "error": "window screenshot capture unavailable in this runtime"
}
```

Expected: no silent success if screenshot capture is unsupported.

### Task 4: Add Settings Diagnostics Buttons

**Files:**
- Modify: `apps/swarm-ui/src/panels/SettingsModal.svelte`

- [ ] **Step 1: Add export controls**

Add buttons:

- `Export Layout`
- `Capture Screenshot`

Each button should call a Tauri command or enqueue a UI command and show the resulting path or error message.

- [ ] **Step 2: Verify Svelte**

Run:

```bash
cd apps/swarm-ui && bun run check
```

Expected: `svelte-check found 0 errors and 0 warnings`

### Task 5: Verification

**Files:**
- Create: `docs/manual-qa/phase-2-acceleration-tooling.md`

- [ ] **Step 1: Create manual QA doc**

```md
# Phase 2 Acceleration Tooling Manual QA

1. Run `swarm-mcp ui export-layout --wait 0 --json`.
Expected: command id is returned.

2. Open the UI and trigger layout export from Settings.
Expected: export path or clear error is shown.

3. Trigger screenshot capture.
Expected: screenshot path is returned or unsupported capture error is visible.

4. Attach exported file to a swarm task.
Expected: another agent can inspect the exported state without asking the user to describe the UI.
```

- [ ] **Step 2: Run full checks**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/uiExport.test.ts
bun run check
```

Expected: tests and full repo check pass.
