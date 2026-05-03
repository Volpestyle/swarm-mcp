# Phase 1 — Launch Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `swarm-ui` into a productized desktop entrypoint with a real app icon, bundled launch path, and explicit launch profiles/trust postures so the user no longer has to treat terminal setup as the primary way to start the product.

**Architecture:** Keep the existing PTY + binder + bootstrap flow, but add a first-class launch profile layer above harness aliases and finish the Tauri packaging path. This phase deliberately does not redesign agents or projects yet; it only makes product launch and runtime posture explicit, reusable, and visible.

**Tech Stack:** Tauri 2, Svelte 5, TypeScript, Bun test, localStorage-backed stores for this phase, macOS icon assets, existing harness bootstrap path

---

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/lib/types.ts`
  - add `LaunchProfile` and `LaunchTrustPosture` types
- `apps/swarm-ui/src/stores/harnessAliases.ts`
  - keep compatibility with raw harness aliases
- `apps/swarm-ui/src/stores/startup.ts`
  - persist selected launch profile id and defaults
- `apps/swarm-ui/src/panels/Launcher.svelte`
  - select launch profile and map it into spawn behavior
- `apps/swarm-ui/src/panels/StartupHome.svelte`
  - surface launch profile choice on startup
- `apps/swarm-ui/src/panels/SettingsModal.svelte`
  - manage launch profiles and wrapper commands
- `apps/swarm-ui/src-tauri/tauri.conf.json`
  - enable bundling metadata and icon list

### New files to create

- `apps/swarm-ui/src/stores/launchProfiles.ts`
  - source of truth for reusable launch profiles
- `apps/swarm-ui/src/stores/launchProfiles.test.ts`
  - test normalization, defaults, and selection behavior
- `apps/swarm-ui/src/assets/icons/`
  - final icon source files for bundle generation
- `docs/manual-qa/phase-1-launch-productization.md`
  - click-by-click verification checklist

---

### Task 1: Add Launch Profile Domain Types

**Files:**
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Test: `apps/swarm-ui/src/stores/launchProfiles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_LAUNCH_PROFILES,
  normalizeLaunchProfile,
  normalizeLaunchProfiles,
} from './launchProfiles';

describe('launchProfiles', () => {
  it('normalizes a custom profile with explicit trust posture', () => {
    const profile = normalizeLaunchProfile({
      id: 'trusted-local',
      name: 'Trusted Local',
      harness: 'codex',
      trustPosture: 'trusted-local',
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
    });

    expect(profile).not.toBeNull();
    expect(profile?.trustPosture).toBe('trusted-local');
    expect(profile?.command).toContain('codex');
  });

  it('returns built-in defaults when user storage is empty', () => {
    const profiles = normalizeLaunchProfiles(undefined);
    expect(profiles.length).toBeGreaterThanOrEqual(DEFAULT_LAUNCH_PROFILES.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/swarm-ui && bun test src/stores/launchProfiles.test.ts`

Expected: FAIL because `launchProfiles.ts` and the exported functions do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add these types to `apps/swarm-ui/src/lib/types.ts`:

```ts
export type LaunchTrustPosture =
  | 'trusted-local'
  | 'safe-review'
  | 'research'
  | 'visual-design'
  | 'custom';

export interface LaunchProfile {
  id: string;
  name: string;
  description: string;
  harness: string;
  command: string;
  trustPosture: LaunchTrustPosture;
  defaultRole: string;
  defaultScopeMode: 'follow-canvas' | 'fresh-project' | 'custom';
}
```

- [ ] **Step 4: Implement the store file**

Create `apps/swarm-ui/src/stores/launchProfiles.ts` with a normalized default model:

```ts
import { writable } from 'svelte/store';
import type { LaunchProfile, LaunchTrustPosture } from '../lib/types';

const STORAGE_KEY = 'swarm-ui.launch-profiles';

export const DEFAULT_LAUNCH_PROFILES: LaunchProfile[] = [
  {
    id: 'trusted-local',
    name: 'Trusted Local',
    description: 'Full local access for trusted build sessions.',
    harness: 'codex',
    command: 'codex',
    trustPosture: 'trusted-local',
    defaultRole: 'implementer',
    defaultScopeMode: 'follow-canvas',
  },
  {
    id: 'safe-review',
    name: 'Safe Review',
    description: 'Conservative launch posture for inspection and review.',
    harness: 'claude',
    command: 'claude',
    trustPosture: 'safe-review',
    defaultRole: 'reviewer',
    defaultScopeMode: 'follow-canvas',
  },
];

export function normalizeLaunchProfile(value?: Partial<LaunchProfile> | null): LaunchProfile | null {
  const id = value?.id?.trim();
  const name = value?.name?.trim();
  const harness = value?.harness?.trim();
  const command = value?.command?.trim();
  if (!id || !name || !harness || !command) return null;

  return {
    id,
    name,
    description: value?.description?.trim() || '',
    harness,
    command,
    trustPosture: (value?.trustPosture as LaunchTrustPosture) || 'custom',
    defaultRole: value?.defaultRole?.trim() || '',
    defaultScopeMode: value?.defaultScopeMode || 'follow-canvas',
  };
}

export function normalizeLaunchProfiles(value?: Partial<LaunchProfile>[] | null): LaunchProfile[] {
  const normalized = (value || [])
    .map((entry) => normalizeLaunchProfile(entry))
    .filter((entry): entry is LaunchProfile => entry !== null);
  return normalized.length > 0 ? normalized : [...DEFAULT_LAUNCH_PROFILES];
}

function loadProfiles(): LaunchProfile[] {
  if (typeof window === 'undefined') return [...DEFAULT_LAUNCH_PROFILES];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_LAUNCH_PROFILES];
    return normalizeLaunchProfiles(JSON.parse(raw) as Partial<LaunchProfile>[]);
  } catch {
    return [...DEFAULT_LAUNCH_PROFILES];
  }
}

function createLaunchProfilesStore() {
  const { subscribe, set, update } = writable<LaunchProfile[]>(loadProfiles());

  if (typeof window !== 'undefined') {
    subscribe((value) => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    });
  }

  return {
    subscribe,
    reset: () => set([...DEFAULT_LAUNCH_PROFILES]),
    save: (profile: LaunchProfile) =>
      update((current) => {
        const filtered = current.filter((entry) => entry.id !== profile.id);
        return [...filtered, profile];
      }),
  };
}

export const launchProfiles = createLaunchProfilesStore();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/swarm-ui && bun test src/stores/launchProfiles.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/swarm-ui/src/lib/types.ts \
        apps/swarm-ui/src/stores/launchProfiles.ts \
        apps/swarm-ui/src/stores/launchProfiles.test.ts
git commit -m "feat: add launch profile domain model"
```

### Task 2: Persist Launch Profile Selection in Startup State

**Files:**
- Modify: `apps/swarm-ui/src/stores/startup.ts`
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Test: `apps/swarm-ui/src/stores/startup.test.ts`

- [ ] **Step 1: Write the failing test**

Add this case to `apps/swarm-ui/src/stores/startup.test.ts`:

```ts
import { normalizeStartupPreferences } from './startup';

it('preserves the selected launch profile id', () => {
  const prefs = normalizeStartupPreferences({
    selectedLaunchProfileId: 'trusted-local',
  });

  expect(prefs.selectedLaunchProfileId).toBe('trusted-local');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/swarm-ui && bun test src/stores/startup.test.ts`

Expected: FAIL because `selectedLaunchProfileId` is not part of the startup preference model yet.

- [ ] **Step 3: Update the type and default**

Extend the startup preference shape in `apps/swarm-ui/src/lib/types.ts` and `apps/swarm-ui/src/stores/startup.ts`:

```ts
export interface StartupPreferences {
  recentDirectories: string[];
  selectedDirectory: string;
  launchDefaults: StartupLaunchDefaults;
  selectedLaunchProfileId: string;
  themeProfileId: ThemeProfileId;
  backgroundOpacityOverride: number | null;
}
```

```ts
export const DEFAULT_STARTUP_PREFERENCES: StartupPreferences = {
  recentDirectories: [],
  selectedDirectory: '',
  launchDefaults: DEFAULT_LAUNCH_DEFAULTS,
  selectedLaunchProfileId: 'trusted-local',
  themeProfileId: 'tron-encom-os',
  backgroundOpacityOverride: null,
};
```

- [ ] **Step 4: Normalize and persist the new field**

In `apps/swarm-ui/src/stores/startup.ts`, add:

```ts
selectedLaunchProfileId: typeof value?.selectedLaunchProfileId === 'string'
  ? value.selectedLaunchProfileId.trim()
  : typeof legacy.selectedLaunchProfileId === 'string'
    ? legacy.selectedLaunchProfileId.trim()
    : DEFAULT_STARTUP_PREFERENCES.selectedLaunchProfileId,
```

and add a store method:

```ts
setSelectedLaunchProfileId(value: string) {
  update((current) => ({
    ...current,
    selectedLaunchProfileId: value.trim(),
  }));
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/swarm-ui && bun test src/stores/startup.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/swarm-ui/src/lib/types.ts \
        apps/swarm-ui/src/stores/startup.ts \
        apps/swarm-ui/src/stores/startup.test.ts
git commit -m "feat: persist selected launch profile"
```

### Task 3: Surface Launch Profiles in Home, Launcher, and Settings

**Files:**
- Modify: `apps/swarm-ui/src/panels/StartupHome.svelte`
- Modify: `apps/swarm-ui/src/panels/Launcher.svelte`
- Modify: `apps/swarm-ui/src/panels/SettingsModal.svelte`
- Modify: `apps/swarm-ui/src/stores/harnessAliases.ts`
- Modify: `apps/swarm-ui/src/stores/pty.ts`

- [ ] **Step 1: Wire the selector into StartupHome**

Add a startup profile selector in `apps/swarm-ui/src/panels/StartupHome.svelte`:

```svelte
<select
  class="text-input"
  value={$startupPreferences.selectedLaunchProfileId}
  on:change={(event) =>
    startupPreferences.setSelectedLaunchProfileId(
      (event.currentTarget as HTMLSelectElement).value,
    )}
>
  {#each $launchProfiles as profile (profile.id)}
    <option value={profile.id}>{profile.name}</option>
  {/each}
</select>
```

- [ ] **Step 2: Use the selected profile in Launcher**

In `apps/swarm-ui/src/panels/Launcher.svelte`, resolve the selected launch profile and feed it into `spawnShell()`:

```ts
$: selectedLaunchProfile =
  $launchProfiles.find((profile) => profile.id === $startupPreferences.selectedLaunchProfileId)
  ?? $launchProfiles[0];
```

```ts
const result = await spawnShell(workingDir.trim(), {
  harness: selectedLaunchProfile?.harness || harness,
  harnessCommand: selectedLaunchProfile?.command || launchCommand.trim() || undefined,
  role: role || selectedLaunchProfile?.defaultRole || undefined,
  scope: explicitScopeOverride.trim() || undefined,
  label: label.trim() || undefined,
  name: name.trim() || undefined,
  bootstrapInstructions: buildAgentProfilePrompt(buildCurrentProfileDraft()) || undefined,
});
```

- [ ] **Step 3: Add trust posture editing to Settings**

In `apps/swarm-ui/src/panels/SettingsModal.svelte`, add a section for editing launch profile command strings and descriptions:

```svelte
{#each $launchProfiles as profile (profile.id)}
  <div class="setting-card">
    <div class="setting-copy">
      <label>{profile.name}</label>
      <p>{profile.description}</p>
    </div>
    <div class="setting-control">
      <input
        class="input mono"
        value={profile.command}
        on:input={(event) =>
          launchProfiles.save({
            ...profile,
            command: (event.currentTarget as HTMLInputElement).value,
          })}
      />
    </div>
  </div>
{/each}
```

- [ ] **Step 4: Preserve backward compatibility explicitly**

Do not break raw harness launches. In `apps/swarm-ui/src/panels/Launcher.svelte`, keep the profile layer optional:

```ts
const effectiveHarness = selectedLaunchProfile?.harness || harness;
const effectiveCommand =
  selectedLaunchProfile?.command?.trim()
  || launchCommand.trim()
  || undefined;

const result = await spawnShell(workingDir.trim(), {
  harness: effectiveHarness || undefined,
  harnessCommand: effectiveCommand,
  role: role || selectedLaunchProfile?.defaultRole || undefined,
  scope: explicitScopeOverride.trim() || undefined,
  label: label.trim() || undefined,
  name: name.trim() || undefined,
  bootstrapInstructions: buildAgentProfilePrompt(buildCurrentProfileDraft()) || undefined,
});
```

Expected behavior:

- existing raw harness launches still work when no launch profile is selected
- launch profiles override harness command only when explicitly chosen

- [ ] **Step 5: Verify UI behavior**

Run:

```bash
cd apps/swarm-ui && bun run check
```

Expected: `svelte-check found 0 errors and 0 warnings`

- [ ] **Step 6: Commit**

```bash
git add apps/swarm-ui/src/panels/StartupHome.svelte \
        apps/swarm-ui/src/panels/Launcher.svelte \
        apps/swarm-ui/src/panels/SettingsModal.svelte \
        apps/swarm-ui/src/stores/harnessAliases.ts \
        apps/swarm-ui/src/stores/pty.ts
git commit -m "feat: surface launch profiles across home and launcher"
```

### Task 4: Productize Tauri Bundle Metadata and Icon Assets

**Files:**
- Modify: `apps/swarm-ui/src-tauri/tauri.conf.json`
- Create: `apps/swarm-ui/src-tauri/icons/*`
- Test: `docs/manual-qa/phase-1-launch-productization.md`

- [ ] **Step 1: Define bundle metadata**

Update `apps/swarm-ui/src-tauri/tauri.conf.json`:

```json
"bundle": {
  "active": true,
  "targets": ["app"],
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/256x256.png",
    "icons/icon.icns"
  ]
}
```

- [ ] **Step 2: Create final icon assets**

Create icon assets derived from the simplified brand mark, not the full poster art.

Required set:

```text
apps/swarm-ui/src-tauri/icons/32x32.png
apps/swarm-ui/src-tauri/icons/128x128.png
apps/swarm-ui/src-tauri/icons/256x256.png
apps/swarm-ui/src-tauri/icons/icon.icns
```

- [ ] **Step 3: Add manual QA checklist**

Create `docs/manual-qa/phase-1-launch-productization.md`:

```md
# Phase 1 Launch Productization Manual QA

1. Open the bundled app from Finder.
Expected: the app opens without requiring a terminal command.

2. Confirm the Dock/Finder icon uses the new mark.
Expected: icon is legible at small size and not the full poster art.

3. Open Home.
Expected: selected launch profile is visible and editable.

4. Launch an agent using `Trusted Local`.
Expected: the configured harness command is used without manual typing outside the app.

5. Change the selected launch profile in Settings and restart.
Expected: the selected launch profile persists.
```

- [ ] **Step 4: Build the bundle**

Run:

```bash
cd apps/swarm-ui && bunx tauri build --debug
```

Expected: Tauri build completes successfully and produces a launchable app bundle using the configured icons/metadata.

- [ ] **Step 5: Commit**

```bash
git add apps/swarm-ui/src-tauri/tauri.conf.json \
        apps/swarm-ui/src-tauri/icons \
        docs/manual-qa/phase-1-launch-productization.md
git commit -m "feat: productize swarm-ui bundle metadata and icons"
```

### Task 5: End-to-End Verification and Documentation Sync

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-22-agentic-orchestration-os-master-spec.md`

- [ ] **Step 1: Update README launch wording**

Add a short desktop-launch note to `README.md`:

```md
### Desktop launch

`swarm-ui` can now be launched as a bundled desktop app on macOS. Launch profiles control the harness command, trust posture, and startup behavior shown in Home and Launcher.
```

- [ ] **Step 2: Mark Phase 1 status in the master spec**

In `docs/superpowers/specs/2026-04-22-agentic-orchestration-os-master-spec.md`, update the Phase 1 status note after implementation:

```md
### Phase 1: Launch Productization

Status: complete
```

- [ ] **Step 3: Run the full verification stack**

Run:

```bash
bun test apps/swarm-ui/src/stores/launchProfiles.test.ts
cd apps/swarm-ui && bun run check
cd /Users/mathewfrazier/Desktop/swarm-mcp-active && bun run check
```

Expected:

- launch profile tests pass
- `svelte-check found 0 errors and 0 warnings`
- repo-level `bun run check` passes

- [ ] **Step 4: Commit**

```bash
git add README.md \
        docs/superpowers/specs/2026-04-22-agentic-orchestration-os-master-spec.md \
        docs/manual-qa/phase-1-launch-productization.md
git commit -m "docs: close phase 1 launch productization"
```

---

## Self-Review

### Spec coverage

This plan intentionally covers only Phase 1 from the master spec:

- app icon
- bundle/productized launch
- explicit launch profiles
- visible trust posture

It does not attempt to implement:

- agent identity cards
- project spaces
- image/asset systems
- startup hero/art integration beyond icon/product launch
- secondary themes

Those require separate phase plans.

### Placeholder scan

No `TODO` or `TBD` placeholders remain in the plan steps. Commands, file paths, and expected outcomes are explicit.

### Type consistency

The plan uses:

- `LaunchProfile`
- `LaunchTrustPosture`
- `selectedLaunchProfileId`

These names are consistent across the tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-phase-1-launch-productization.md`.

Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in one session using executing-plans, batch execution with checkpoints
