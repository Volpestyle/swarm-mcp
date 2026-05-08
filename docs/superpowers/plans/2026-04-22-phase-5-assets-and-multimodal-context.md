# Phase 5 — Assets And Multimodal Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make screenshots, images, notes, folders, protocols, and references first-class project assets that can be previewed, attached to agents, and injected into agent context.

**Architecture:** Store project asset metadata explicitly and keep original files on disk. Agents receive structured paths, descriptions, note/protocol content, and saved visual-analysis summaries. The terminal is not assumed to be natively multimodal; image pixels are analyzed by an explicit analyzer path, then the text summary is persisted and injected into agent context.

**Tech Stack:** Svelte 5, TypeScript, Tauri/Rust file picker and SQLite helpers, local filesystem assets, Bun tests

---

## File Structure

### Existing files to modify

- `apps/swarm-ui/src/lib/types.ts`
  - add `ProjectAsset`, `AssetKind`, and `AssetAttachment`
- `apps/swarm-ui/src/panels/ProjectPage.svelte`
  - add asset and moodboard sections
- `apps/swarm-ui/src/panels/Inspector.svelte`
  - show assets attached to selected agent/project
- `apps/swarm-ui/src-tauri/src/ui_commands.rs`
  - add asset commands
- `apps/swarm-ui/src-tauri/src/writes.rs`
  - add asset persistence helpers

### New files to create

- `apps/swarm-ui/src/stores/projectAssets.ts`
- `apps/swarm-ui/src/stores/projectAssets.test.ts`
- `apps/swarm-ui/src/panels/AssetGrid.svelte`
- `apps/swarm-ui/src/panels/AssetPreview.svelte`
- `apps/swarm-ui/src/lib/assetContext.ts`
- `apps/swarm-ui/src/lib/assetContext.test.ts`
- `docs/manual-qa/phase-5-assets-and-multimodal-context.md`

### Multimodal analysis follow-up

- [x] Add `ui_analyze_project_asset` for image/screenshot assets.
- [x] Support `SWARM_ASSET_ANALYZER_CMD` for a local/custom analyzer and `OPENAI_API_KEY` for OpenAI Responses image analysis.
- [x] Persist the generated summary into `ProjectAsset.content`.
- [x] Label image/screenshot content as `Visual analysis:` in agent-context messages.
- [x] Add Project Page and File Bubble actions to analyze/re-analyze visual assets.

---

### Task 1: Asset Domain Model

**Files:**
- Modify: `apps/swarm-ui/src/lib/types.ts`
- Create: `apps/swarm-ui/src/stores/projectAssets.ts`
- Create: `apps/swarm-ui/src/stores/projectAssets.test.ts`

- [x] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { normalizeProjectAsset } from './projectAssets';

describe('normalizeProjectAsset', () => {
  it('normalizes an image asset', () => {
    const asset = normalizeProjectAsset({
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'image',
      title: 'FrazierCode Tron reference',
      path: '/Users/mathewfrazier/Desktop/FrazierCode Tron 2.jpg',
      description: 'Startup hero visual reference',
    });

    expect(asset?.kind).toBe('image');
    expect(asset?.title).toContain('Tron');
  });
});
```

- [x] **Step 2: Add types**

```ts
export type AssetKind = 'image' | 'screenshot' | 'note' | 'folder' | 'protocol' | 'reference';

export interface ProjectAsset {
  id: string;
  projectId: string;
  kind: AssetKind;
  title: string;
  path: string | null;
  content: string | null;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface AssetAttachment {
  assetId: string;
  targetType: 'agent' | 'project' | 'protocol';
  targetId: string;
  attachedAt: number;
}
```

- [x] **Step 3: Implement normalization**

`projectAssets.ts`:

```ts
import type { AssetKind, ProjectAsset } from '../lib/types';

const KINDS: AssetKind[] = ['image', 'screenshot', 'note', 'folder', 'protocol', 'reference'];

export function normalizeProjectAsset(value: Partial<ProjectAsset>): ProjectAsset | null {
  const id = value.id?.trim();
  const projectId = value.projectId?.trim();
  const title = value.title?.trim();
  const kind = value.kind && KINDS.includes(value.kind) ? value.kind : null;
  if (!id || !projectId || !title || !kind) return null;
  const now = Date.now();
  return {
    id,
    projectId,
    kind,
    title,
    path: value.path?.trim() || null,
    content: value.content?.trim() || null,
    description: value.description?.trim() || '',
    createdAt: value.createdAt ?? now,
    updatedAt: value.updatedAt ?? now,
  };
}
```

- [x] **Step 4: Run test**

Run: `cd apps/swarm-ui && bun test src/stores/projectAssets.test.ts`

Expected: PASS

### Task 2: Asset Context Builder

**Files:**
- Create: `apps/swarm-ui/src/lib/assetContext.ts`
- Create: `apps/swarm-ui/src/lib/assetContext.test.ts`

- [x] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { buildAssetContextBlock } from './assetContext';

describe('buildAssetContextBlock', () => {
  it('builds a concise asset context block for agent injection', () => {
    const block = buildAssetContextBlock([
      {
        id: 'asset-1',
        projectId: 'project-1',
        kind: 'image',
        title: 'Hero reference',
        path: '/tmp/hero.png',
        content: null,
        description: 'Use as startup mood reference',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(block).toContain('Hero reference');
    expect(block).toContain('/tmp/hero.png');
  });
});
```

- [x] **Step 2: Implement builder**

```ts
import type { ProjectAsset } from './types';

export function buildAssetContextBlock(assets: ProjectAsset[]): string {
  if (assets.length === 0) return '';
  const lines = ['Project assets:'];
  for (const asset of assets) {
    const location = asset.path ? ` (${asset.path})` : '';
    const detail = asset.description ? ` - ${asset.description}` : '';
    lines.push(`- [${asset.kind}] ${asset.title}${location}${detail}`);
  }
  return lines.join('\n');
}
```

- [x] **Step 3: Run test**

Run: `cd apps/swarm-ui && bun test src/lib/assetContext.test.ts`

Expected: PASS

### Task 3: Asset Persistence Commands

**Files:**
- Modify: `apps/swarm-ui/src-tauri/src/writes.rs`
- Modify: `apps/swarm-ui/src-tauri/src/ui_commands.rs`
- Modify: `apps/swarm-ui/src-tauri/src/main.rs`

- [x] **Step 1: Add tables**

```sql
CREATE TABLE IF NOT EXISTS ui_project_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  content TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_asset_attachments (
  asset_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, target_type, target_id)
);
```

- [x] **Step 2: Add commands**

Add commands:

- `ui_list_project_assets`
- `ui_save_project_asset`
- `ui_delete_project_asset`
- `ui_attach_asset`
- `ui_detach_asset`

- [x] **Step 3: Run Rust tests**

Run: `cd apps/swarm-ui/src-tauri && cargo test`

Expected: PASS

### Task 4: Asset UI

**Files:**
- Create: `apps/swarm-ui/src/panels/AssetGrid.svelte`
- Create: `apps/swarm-ui/src/panels/AssetPreview.svelte`
- Modify: `apps/swarm-ui/src/panels/ProjectPage.svelte`

- [x] **Step 1: Create grid**

Asset grid should group assets by:

- image/screenshot
- note
- folder
- protocol
- reference

- [x] **Step 2: Create preview**

Preview behavior:

- image/screenshot: show thumbnail and path
- note/protocol: show text content
- folder/reference: show path/link

- [x] **Step 3: Add to project page**

Project page must expose:

- Add Image
- Add Screenshot
- Add Note
- Add Folder
- Add Protocol
- Add Reference

### Task 5: Verification

**Files:**
- Create: `docs/manual-qa/phase-5-assets-and-multimodal-context.md`

- [x] **Step 1: Manual QA doc**

```md
# Phase 5 Assets Manual QA

1. Open a project page and add an image asset.
Expected: image appears in asset grid with preview.

2. Add a note asset.
Expected: note appears and can be opened.

3. Attach an image asset to an agent.
Expected: Inspector shows the attachment and generated context includes the asset path.

4. Send asset context to an agent.
Expected: agent receives structured path/title/description text, not only a raw pasted path.
```

- [x] **Step 2: Run checks**

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/stores/projectAssets.test.ts
bun test apps/swarm-ui/src/lib/assetContext.test.ts
bun run check
```

Expected: all pass.

2026-04-26 first implementation verification:

- `cd apps/swarm-ui && bun test src/stores/projectAssets.test.ts src/lib/assetContext.test.ts`: passed, 5 tests.
- `cargo test -p swarm-ui project_assets_round_trip_and_delete_with_attachments`: passed, 1 focused Rust test.
- `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
- `bun run check`: passed, 161 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and Tauri Rust tests.
- `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
- Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app` and quick `open -n` launch smoke test started the app process successfully.

Manual click-through remains pending in the refreshed app bundle.

2026-04-26 Slice 2 real intake verification:

- Slice 1 review fixes:
  - Deleting one asset now removes only that asset's attachments from frontend state.
  - Backend asset saves now require an existing project row.
- Added Tauri dialog-backed intake:
  - `@tauri-apps/plugin-dialog` and `tauri-plugin-dialog`.
  - `dialog:allow-open` capability only.
  - Native choose-file / choose-folder actions in the Project Page asset form.
  - `asset:` and `http://asset.localhost` image CSP support for local preview URLs.
- Added validation:
  - Visual assets require absolute readable image file paths with supported image extensions.
  - Folder assets require absolute readable directory paths.
  - Note/protocol assets require content or an absolute readable text-file path.
  - Reference assets require a link/path or description.
- QA follow-up after first manual test:
  - Project Page is now a wide dedicated overlay instead of a narrow side panel.
  - Assets has a `Refresh assets` action that scans the project root and extra roots for supported image/text files.
  - Refresh saves the current Roots & Assets field before scanning and reports imported/scanned counts.
  - Text files import into note/protocol content so previews and agent context are not empty.
  - Rich text `.rtf` files are accepted as note/protocol text and stripped into readable plain text.
  - Project asset catalogs now include a top-level Folder Inventory for saved roots, listing eight or fewer entries directly and grouping larger folders by category.
  - Image preview failures now show a visible fallback path instead of a silent blank card.
  - `[project-context]` bootstraps now include a `Project assets:` summary when saved assets exist.
  - Attaching an asset to a reachable agent sends a direct `[asset-context]` swarm message.
  - Manual QA fixtures live at `/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/manual-qa/phase-5-fixtures`.
  - Verified `cd apps/swarm-ui && bun test src/lib/assetContext.test.ts src/lib/assetIntake.test.ts src/stores/projectAssets.test.ts`, `cargo test -p swarm-ui asset`, `cd apps/swarm-ui && bun run check`, full `bun run check`, and `cd apps/swarm-ui && bunx tauri build --debug`.
- Focused verification:
  - `cd apps/swarm-ui && bun test src/lib/assetIntake.test.ts src/stores/projectAssets.test.ts`: passed, 11 tests.
  - `cargo test -p swarm-ui asset_payload`: passed, 6 focused Rust tests.
  - `cargo test -p swarm-ui project_asset`: passed, 2 focused Rust tests.
- Full verification:
  - `cd apps/swarm-ui && bun run check`: passed, 0 Svelte errors and 0 warnings.
  - `bun run check`: passed, 176 Bun tests plus TypeScript, Svelte build/check, Vite build, swarm-server tests, and 81 Tauri Rust tests.
  - `cd apps/swarm-ui && bunx tauri build --debug`: passed, bundled `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/bundle/macos/swarm-ui.app`.
  - Refreshed `/Users/mathewfrazier/Applications/Swarm UI Lab.app`; quick `open -n` launch smoke test started the app process, then the app was quit cleanly.

Manual click-through remains pending in the refreshed app bundle.
