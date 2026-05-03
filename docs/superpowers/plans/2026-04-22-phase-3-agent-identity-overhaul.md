# Phase 3 — Agent Identity Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform graph nodes from terminal-first cards into agent-first cards with editable identity, behavioral configuration, and a terminal mode.

**Architecture:** Keep existing `TerminalNode` and PTY leasing intact, but introduce an `AgentCard` composition layer that can render Overview, Terminal, Tasks, Context, and History modes. Persist agent identity through explicit profile data and label-token compatibility.

**Tech Stack:** Svelte 5, TypeScript, Bun tests, existing swarm instance labels, existing PTY terminal surface system

**Status:** Complete and closed on 2026-04-25. Mathew accepted the current Phase 3 manual UI pass and directed closeout.

**Closeout authority:** Phase 3 is all the way done for the overhaul baseline. The current accepted product shape is terminal-first launch proof with Agent Deck v2 as the agent identity surface. The checklist below remains as historical implementation evidence; any richer project/note-backed step tracking or first-class custom harness bootstrap is explicitly outside Phase 3 and belongs to later phases.

---

## Current Prerequisite State

The post-Phase-2 listener-health reliability sync is already implemented in `swarm-mcp-lab` and must be preserved during Phase 3.

Do not rebuild or remove it while converting terminal-heavy nodes into overview-first agent cards.

Existing listener-health behavior:

- `poll_messages` emits `agent.polled`, including empty polls.
- `wait_for_activity` emits `agent.waiting` and `agent.wait_returned`.
- `apps/swarm-ui/src/lib/agentListenerHealth.ts` derives node-level listener state.
- `apps/swarm-ui/src/lib/graph.ts` passes `unreadMessages` and `listenerHealth` into node data.
- `NodeHeader.svelte` shows listener-health and unread-message badges.
- `Inspector.svelte` shows Listener Health details.

Phase 3 should use this state in agent overview cards. The overview should not invent a separate listening model.

## Current Phase 3 Direction

After the active-parity recovery, launched nodes intentionally default to the live `Term` tab. The agent-first card now lives in the `Deck` tab so the terminal bootstrap remains easy to verify while Agent Card v2 is refined.

The current deck derives "Current Work" from existing live swarm data instead of adding a new project model: assigned task file first, then lock file, instance directory, and PTY cwd. Formal step display is best-effort parsing from task title/description (`Step N`, `Part N`, `Phase N`). A richer project/note-backed step tracker belongs with Project Spaces or the later notes/context phase, not this Phase 3 polish slice.

## Phase 3 Closed Baseline

- Agent identity parsing, label rewrite helpers, saved Agent Profile ownership, Inspector identity editing, provider-aware skill suggestions, role/emoji customization, and the Agent Deck v2 surface are implemented.
- The accepted runtime baseline intentionally keeps `Term` as the default node body so launch/bootstrap proof stays visible.
- Agent Deck v2 carries the agent-first overview, current-work, listener-health, task, lock, permissions, and profile signals.
- Manual UI acceptance and automated checks were recorded on 2026-04-25; Phase 3 should not be reopened for Phase 4 project-space work.

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/lib/types.ts`
  - add `AgentRuntimeProfile`, `AgentCardMode`, and `AgentDisplayState`
  - preserve existing `AgentListenerHealth`, `unreadMessages`, and `listenerHealth` node fields
- `apps/swarm-ui/src/lib/graph.ts`
  - enrich node data with agent display state without removing listener-health derivation
- `apps/swarm-ui/src/nodes/TerminalNode.svelte`
  - delegate rendering to new agent shell
- `apps/swarm-ui/src/nodes/NodeHeader.svelte`
  - reduce header dominance and support card mode switch
  - keep listener-health and unread-message badges visible in any header treatment
- `apps/swarm-ui/src/panels/Inspector.svelte`
  - expose editable agent fields
  - keep Listener Health visible while adding identity editing
- `apps/swarm-ui/src/stores/agentProfiles.ts`
  - normalize runtime profile fields and build bootstrap prompt from them

### New files to create

- `apps/swarm-ui/src/lib/agentIdentity.ts`
- `apps/swarm-ui/src/lib/agentIdentity.test.ts`
- `apps/swarm-ui/src/nodes/AgentCard.svelte`
- `apps/swarm-ui/src/nodes/AgentOverview.svelte`
- `apps/swarm-ui/src/nodes/AgentModeTabs.svelte`

---

### Task 1: Define Agent Identity Helpers

**Files:**
- Create: `apps/swarm-ui/src/lib/agentIdentity.ts`
- Create: `apps/swarm-ui/src/lib/agentIdentity.test.ts`

- [x] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { agentIdentityFromLabel, mergeAgentLabelToken } from './agentIdentity';

describe('agentIdentityFromLabel', () => {
  it('extracts name, role, provider, and persona from label tokens', () => {
    const identity = agentIdentityFromLabel('provider:codex role:planner name:Orion persona:🦉');
    expect(identity.provider).toBe('codex');
    expect(identity.role).toBe('planner');
    expect(identity.name).toBe('Orion');
    expect(identity.persona).toBe('🦉');
  });
});

describe('mergeAgentLabelToken', () => {
  it('replaces an existing token without duplicating it', () => {
    expect(mergeAgentLabelToken('role:planner name:Orion', 'role', 'reviewer'))
      .toBe('name:Orion role:reviewer');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/swarm-ui && bun test src/lib/agentIdentity.test.ts`

Expected: FAIL because helper does not exist.

Execution note: the explicit red-test-first run was skipped in the implementation slice because helper and tests landed together; the final helper coverage is verified in the closeout commands below.

- [x] **Step 3: Implement helper**

```ts
export type AgentLabelIdentity = {
  provider: string | null;
  role: string | null;
  name: string | null;
  persona: string | null;
};

export function agentIdentityFromLabel(label: string | null | undefined): AgentLabelIdentity {
  const identity: AgentLabelIdentity = {
    provider: null,
    role: null,
    name: null,
    persona: null,
  };

  for (const token of (label ?? '').split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = token.split(':');
    const value = rest.join(':');
    if (!value) continue;
    if (key === 'provider') identity.provider = value;
    if (key === 'role') identity.role = value;
    if (key === 'name') identity.name = value;
    if (key === 'persona') identity.persona = value;
  }

  return identity;
}

export function mergeAgentLabelToken(label: string | null | undefined, key: string, value: string): string {
  const tokens = (label ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith(`${key}:`));
  const trimmed = value.trim();
  if (trimmed) tokens.push(`${key}:${trimmed}`);
  return tokens.join(' ');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd apps/swarm-ui && bun test src/lib/agentIdentity.test.ts`

Expected: PASS

### Task 2: Add Agent Overview Components

**Files:**
- Create: `apps/swarm-ui/src/nodes/AgentOverview.svelte`
- Create: `apps/swarm-ui/src/nodes/AgentModeTabs.svelte`
- Create: `apps/swarm-ui/src/nodes/AgentCard.svelte`

- [x] **Step 1: Create mode tabs**

`AgentModeTabs.svelte`:

```svelte
<script lang="ts">
  export let active: 'overview' | 'terminal' | 'tasks' | 'context' | 'history' = 'overview';
  export let setMode: (mode: typeof active) => void;
  const modes = ['overview', 'terminal', 'tasks', 'context', 'history'] as const;
</script>

<div class="agent-mode-tabs">
  {#each modes as mode}
    <button class:active={active === mode} type="button" on:click={() => setMode(mode)}>
      {mode}
    </button>
  {/each}
</div>
```

- [x] **Step 2: Create overview**

`AgentOverview.svelte`:

```svelte
<script lang="ts">
  import type { SwarmNodeData } from '../lib/types';
  import { agentIdentityFromLabel } from '../lib/agentIdentity';

  export let data: SwarmNodeData;
  $: identity = agentIdentityFromLabel(data.instance?.label ?? null);
  $: taskCount = data.assignedTasks.length;
  $: lockCount = data.locks.length;
</script>

<section class="agent-overview">
  <div class="agent-hero">
    <span class="agent-avatar">{identity.persona ?? '🎯'}</span>
    <div>
      <h3>{identity.name ?? data.displayName ?? data.label}</h3>
      <p>{identity.role ?? 'generalist'} · {identity.provider ?? 'local'}</p>
    </div>
  </div>
  <div class="agent-stats">
    <span><em>{taskCount}</em> tasks</span>
    <span><em>{lockCount}</em> locks</span>
    <span><em>{data.listenerHealth.label}</em> listener</span>
    <span><em>{data.status}</em> status</span>
  </div>
</section>
```

- [x] **Step 3: Create card shell**

`AgentCard.svelte`:

```svelte
<script lang="ts">
  import type { SwarmNodeData } from '../lib/types';
  import AgentModeTabs from './AgentModeTabs.svelte';
  import AgentOverview from './AgentOverview.svelte';
  import TerminalPane from './TerminalPane.svelte';

  export let data: SwarmNodeData;
  let mode: 'overview' | 'terminal' | 'tasks' | 'context' | 'history' = 'overview';
  $: ptyId = data.ptySession?.id ?? null;
</script>

<div class="agent-card">
  <AgentModeTabs active={mode} setMode={(next) => (mode = next)} />
  {#if mode === 'overview'}
    <AgentOverview {data} />
  {:else if mode === 'terminal' && ptyId}
    <TerminalPane {ptyId} />
  {:else}
    <div class="agent-placeholder">{mode} view will use existing swarm data in the next slice.</div>
  {/if}
</div>
```

- [x] **Step 4: Verify Svelte**

Run: `cd apps/swarm-ui && bun run check`

Expected: Svelte check passes.

### Task 3: Mount AgentCard in TerminalNode

**Files:**
- Modify: `apps/swarm-ui/src/nodes/TerminalNode.svelte`

- [x] **Step 1: Replace body rendering**

Import `AgentCard` and mount it for non-compact, non-fullscreen nodes:

```svelte
<AgentCard {data} />
```

Keep compact view and fullscreen workspace behavior intact.

- [x] **Step 2: Verify terminal mode**

Run UI manually:

```bash
cd apps/swarm-ui && bunx tauri dev
```

Expected:

- node default body is agent overview
- terminal is reachable through the Terminal tab
- listener-health badge remains visible in the node chrome
- overview shows listener-health state from `data.listenerHealth`
- existing fullscreen workspace still opens for PTY nodes

Execution note: after active-parity recovery, the default runtime body intentionally opens on `Term`; Agent Card v2 lives in `Deck`. This preserves terminal/bootstrap proof while still delivering the agent-first card surface.

### Task 4: Inspector Editing

**Files:**
- Modify: `apps/swarm-ui/src/panels/Inspector.svelte`
- Modify: `apps/swarm-ui/src/lib/persona.ts`
- Modify: `apps/swarm-ui/src/lib/agentIdentity.ts`

- [x] **Step 1: Add editable identity fields**

Add fields for:

- name
- role
- persona/emoji
- mission
- skills
- permissions posture

Use existing label update command for label-backed values. Store richer fields through agent profile store until Phase 4 DB-backed metadata lands.

- [x] **Step 2: Verify behavior**

Expected:

- editing name changes node header/overview
- editing role changes role badge and bootstrap field for future launches
- editing persona changes node chip and chat avatar

Execution note: identity editing, saved Agent Profile ownership, role/emoji/accent fields, and provider-aware skill shortcut chips are implemented through Launcher/Inspector/profile surfaces. Custom non-swarm terminal commands can be saved and launched; first-class custom harness bootstrap is deferred.

### Task 5: Verification

**Files:**
- Create: `docs/manual-qa/phase-3-agent-identity-overhaul.md`

- [x] **Step 1: Manual QA checklist**

```md
# Phase 3 Agent Identity Manual QA

1. Launch a planner agent.
Expected: card opens in Overview mode with emoji/name/role/status/listener health.

2. Switch to Terminal mode.
Expected: existing PTY remains live.

3. Edit name and emoji in Inspector.
Expected: node overview and chat avatar update.

4. Compact the node.
Expected: compact card still renders without terminal remount failure.

5. Open fullscreen workspace.
Expected: terminal surface moves to immersive workspace as before.

6. Send a direct message to the agent and wait before visiting the terminal.
Expected: node shows `Needs poll` until the agent calls `poll_messages` or `wait_for_activity` consumes the message.

7. After the agent enters `wait_for_activity`, inspect the node.
Expected: Inspector Listener Health shows the latest wait-loop timestamp.
```

- [x] **Step 2: Run checks**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/agentIdentity.test.ts
bun test apps/swarm-ui/src/lib/agentListenerHealth.test.ts apps/swarm-ui/src/lib/graph.test.ts
bun run check
```

Expected: tests and full check pass.

Execution note, 2026-04-25:

- Automated implementation and verification are complete.
- The planned red-test-first failure run was skipped because the helper and tests were created in the same execution slice.
- Active-parity recovery changed the runtime default from overview-first to terminal-first. The `Deck` tab now carries Agent Card v2, while `Term` stays the default body for launch/bootstrap proof.
- The current-work panel, brighter internal card panels, and final Tron node-header control-strip polish are implemented and covered in `docs/manual-qa/phase-3-agent-identity-overhaul.md`.
- Manual terminal-mode and Inspector behavior QA was accepted by Mathew for Phase 3 closeout on 2026-04-25.
- Closeout verification: `bun test apps/swarm-ui/src/lib/*.test.ts apps/swarm-ui/src/stores/*.test.ts`, `cd apps/swarm-ui && bun run check`, and root `bun run check` passed during the Phase 3 closeout slice.
- Non-blocking follow-ups moved to later phases: project/note-backed formal-step tracking and first-class custom harness swarm bootstrap.
