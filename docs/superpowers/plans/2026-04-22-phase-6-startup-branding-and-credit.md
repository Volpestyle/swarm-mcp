# Phase 6 — Startup Branding And Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild startup/home as a premium branded entry surface using the `FrazierCode Tron 2` artwork tastefully, with explicit friend credit and no contamination of the live working canvas.

**Architecture:** Treat startup art as a Home-only visual layer. Store artwork metadata and credit in a small brand config file so credit is not hardcoded across components.

**Tech Stack:** Svelte 5, TypeScript, Vite assets, CSS image treatment, Bun tests

---

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/panels/StartupHome.svelte`
  - integrate branded hero composition
- `apps/swarm-ui/src/app.css`
  - add global brand tokens if needed

### New files to create

- `apps/swarm-ui/src/assets/brand/fraziercode-tron-2.jpg`
- `apps/swarm-ui/src/lib/brand.ts`
- `apps/swarm-ui/src/lib/brand.test.ts`
- `apps/swarm-ui/src/panels/StartupHero.svelte`
- `docs/manual-qa/phase-6-startup-branding-and-credit.md`

---

### Task 1: Add Brand Metadata

**Files:**
- Create: `apps/swarm-ui/src/lib/brand.ts`
- Create: `apps/swarm-ui/src/lib/brand.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { startupArtworkCredit } from './brand';

describe('startupArtworkCredit', () => {
  it('formats visible artwork credit', () => {
    expect(startupArtworkCredit('MJ')).toBe('Artwork by MJ');
  });
});
```

- [ ] **Step 2: Implement brand helper**

```ts
export const STARTUP_ARTWORK_TITLE = 'FrazierCode Tron 2';

export function startupArtworkCredit(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Artwork by ${trimmed}` : 'Artwork credit unavailable';
}
```

- [ ] **Step 3: Run test**

Run: `cd apps/swarm-ui && bun test src/lib/brand.test.ts`

Expected: PASS

### Task 2: Add Optimized Artwork Asset

**Files:**
- Create: `apps/swarm-ui/src/assets/brand/fraziercode-tron-2.jpg`

- [ ] **Step 1: Copy and optimize**

Run:

```bash
mkdir -p apps/swarm-ui/src/assets/brand
sips -Z 1800 "/Users/mathewfrazier/Desktop/FrazierCode Tron 2.jpg" --out apps/swarm-ui/src/assets/brand/fraziercode-tron-2.jpg
```

Expected: optimized image exists under app assets.

- [ ] **Step 2: Verify size**

Run:

```bash
ls -lh apps/swarm-ui/src/assets/brand/fraziercode-tron-2.jpg
```

Expected: image is suitable for app bundle use and not an unbounded original asset.

### Task 3: Create Startup Hero Component

**Files:**
- Create: `apps/swarm-ui/src/panels/StartupHero.svelte`

- [ ] **Step 1: Create component**

```svelte
<script lang="ts">
  import artwork from '../assets/brand/fraziercode-tron-2.jpg';
  import { startupArtworkCredit } from '../lib/brand';

  export let creditName = '';
</script>

<section class="startup-hero">
  <img src={artwork} alt="" />
  <div class="startup-hero-shade"></div>
  <div class="startup-hero-copy">
    <span>Agentic orchestration deck</span>
    <h1>FrazierCode</h1>
    <p>Launch agents, projects, protocols, and context from one graph-first command surface.</p>
  </div>
  <p class="startup-hero-credit">{startupArtworkCredit(creditName)}</p>
</section>
```

- [ ] **Step 2: Add styling**

Hero styling rules:

- no card grid
- image darkened and cropped
- copy anchored to calm image area
- credit visible but quiet
- hero only appears on Home/startup

### Task 4: Mount Hero In StartupHome

**Files:**
- Modify: `apps/swarm-ui/src/panels/StartupHome.svelte`

- [ ] **Step 1: Replace Encom-only mini hero**

Replace the current Encom-only hero with `StartupHero` when theme is `tron-encom-os`.

Expected:

- artwork appears only in Home
- canvas remains clean
- startup operational controls remain readable

### Task 5: Manual QA And Verification

**Files:**
- Create: `docs/manual-qa/phase-6-startup-branding-and-credit.md`

- [ ] **Step 1: Create QA doc**

```md
# Phase 6 Startup Branding Manual QA

1. Open Home on Tron Encom OS.
Expected: FrazierCode artwork appears as a restrained hero, not a cluttered wallpaper.

2. Confirm operational controls are readable.
Expected: text and inputs pass visual contrast by inspection.

3. Confirm credit is visible.
Expected: `Artwork by <name>` appears in the hero or About surface.

4. Enter canvas.
Expected: artwork does not appear in the working graph canvas.
```

- [ ] **Step 2: Run checks**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/brand.test.ts
cd apps/swarm-ui && bun run check && bun run build
```

Expected: all pass.
