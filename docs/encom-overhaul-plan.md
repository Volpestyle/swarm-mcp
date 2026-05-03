# Tron Encom OS — swarm-ui visual overhaul

Source mock: `Encom Theme Preview.html` (Claude Design handoff, rev 0.7).
Goal: ship "Tron Encom OS" as a new default theme, keep the four existing themes selectable, add per-agent emoji personas that show on the node and in chat.

## What changes at a glance

- New theme `tron-encom-os` becomes the default. Existing four themes stay in the selector unchanged.
- Every node gets a floating square emoji "tab" attached to its top edge. Click it to pick a different emoji from a 24-grid persona picker.
- Default emoji is derived from the role (planner=🦉, scout=🔭, builder=👷🏻‍♂️, …). User picks override and persist.
- Chat messages render a matching square emoji avatar chip on the left.
- Full visual port of all surfaces (top strip, launcher, inspector sidebar, status bar, modals, terminal panel, edges) — pixel-close to the mock.

## Data model

Persona emoji needs to persist per agent across restarts. The DB already has `instances.label` formatted as comma-tokens (`name:scout,role:planner,team:frontend`). I'll piggyback on that:

- Add `persona:🦉` token. Read with the same regex pattern `labelFor()` in `ConversationPanel.svelte` already uses for `name:` and `role:`.
- Default persona resolved client-side from role at render time if no `persona:` token is present (no migration, no DB change).
- Override persists by patching the label via existing `ui_update_instance_label` Tauri command (need to confirm this exists; if not, add it — small backend addition).

Why this and not a new column: zero schema migration, immediate compatibility with existing rows, keeps the persona transport-agnostic.

## File-by-file plan

### Phase 1 — Theme tokens, default, selector entry

**1. `src/lib/types.ts`**
- Extend `ThemeProfileId` union with `'tron-encom-os'`.
- Add optional `chrome?: EncomChrome` field to `ThemeProfile` carrying Encom-only tokens (`ledLine`, `ledLineSoft`, `ledLineBright`, `ledHalo`, `ledHaloBright`, `glow`, `glowSoft`, `bgBase`, `bgPanel`, `bgElevated`, `accentAmber`, `accentRed`, `accentViolet`, `accentTron`). Keeps the existing `ThemeAppearance` shape clean for the four legacy themes.

**2. `src/lib/themeProfiles.ts`**
- Append a fifth entry `tron-encom-os` with `name: "Tron Encom OS"`, description, both the standard `appearance` block (mapped from Encom palette so legacy CSS bridge vars still work) and the new `chrome` block carrying the full Encom token set.
- Reorder array so `tron-encom-os` is element 0 → becomes `getThemeProfile()` default fallback.

**3. `src/stores/appearance.ts`**
- When `state.themeProfile.chrome` is present, set the Encom-only CSS vars on `:root` (`--led-line`, `--led-halo`, `--glow`, `--bg-base`, etc.).
- Set `document.documentElement.dataset.theme = state.themeProfileId`. This lets Encom-only CSS rules (e.g. sharp 0px corners, JetBrains Mono, uppercase HUD type) be scoped via `[data-theme="tron-encom-os"]`.
- Existing legacy var assignments stay — they'll overlap harmlessly when Encom is active because Encom-specific styles win on the scoped selectors.

**4. `src/stores/startup.ts`**
- Change `DEFAULT_STARTUP_PREFERENCES.themeProfileId` from `'ghostty-dark'` to `'tron-encom-os'`. Existing users keep their current pick (the persistence layer reads first); only fresh installs get the new default.

**5. `src/app.css`**
- Add `[data-theme="tron-encom-os"]` block:
  - Load JetBrains Mono via `@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap")` (or self-host if offline-first matters — see Open Questions).
  - Body font-family override, font-size 12px, dotted radial-gradient grid background, sharp `--node-radius: 0`.
  - Override `--node-border` etc. to point at `--led-line` so existing components inherit the Encom hairline without code changes.

**Verify Phase 1:**
- Open Settings → Theme Profile dropdown shows "Tron Encom OS" and selecting it changes the canvas/panel chrome to white-LED on black.
- Other four themes still work when re-selected.
- Fresh-install (clear localStorage) defaults to Tron Encom OS.

### Phase 2 — Node redesign + persona tab + edges + chat avatar

**6. `src/lib/persona.ts` (new)**
- `DEFAULT_PERSONAS_BY_ROLE: Record<string, string>` map (planner=🦉, scout=🔭, builder=👷🏻‍♂️, researcher=🔬, reviewer=🧪, …).
- `PERSONA_POOL: Array<{ emoji: string; name: string }>` — exact 24 from the mock.
- `personaForInstance(instance)` → reads `persona:` token from label with fallback to role default.
- `setPersonaForInstance(instance, emoji)` → calls Tauri command to patch the label token.

**7. `src/nodes/NodePersonaTab.svelte` (new)**
- Square 28×28 chip with white-LED border + halo, emoji centered, dropdown caret bottom-right.
- Positioned absolutely above the parent node (`top: 0; left: 14px; transform: translateY(-100%)` with a small overlap so it appears attached to the top edge).
- Click → toggles persona picker (24-grid menu, mirrors mock's `.persona-menu`).
- Selecting an emoji calls `setPersonaForInstance` and closes the menu.
- Click-outside closes (window-level listener cleaned up on destroy).
- Outside Encom theme: hidden (we keep the node header's existing chrome for legacy themes — Encom-only feature, scoped via `:global([data-theme="tron-encom-os"]) ...`).

**8. `src/nodes/TerminalNode.svelte`**
- Render `<NodePersonaTab>` above the existing `<NodeHeader>` when an instance is bound.
- Pass `instance` and a callback that invokes `setPersonaForInstance`.
- Single CSS rule under `[data-theme="tron-encom-os"]` adds top padding to the node container so the tab clears.

**9. `src/edges/ConnectionEdge.svelte`**
- Add a scoped `[data-theme="tron-encom-os"] .message-edge-path` rule: white stroke, 1.4px, dasharray `6 4`, `drop-shadow` glow, `dashFlow` keyframe animation matching the mock.
- Packets become white circles with halo when Encom is active. Existing color-via-CSS-var path stays for other themes.

**10. `src/panels/ConversationPanel.svelte`**
- Add per-message avatar chip (square, white-LED, 24×24, emoji centered) to the left of `.msg-meta`. Emoji from `personaForInstance` lookup; for `operator:*` senders use 🎮 (or surface a setting later); for `system` use ⚙️.
- Chip is theme-aware: `[data-theme="tron-encom-os"]` styles it Encom-style; legacy themes get a flat outlined version (still nice, no halo) — keeps it usable everywhere.

**Verify Phase 2:**
- Each agent shows an emoji tab on top-edge of its node, defaulting from role.
- Clicking the tab opens picker → selecting persists across page reload.
- Each chat row has a matching emoji chip on the left.
- Edges between agents are white animated dashes with halo.

### Phase 3 — Pixel-port the rest of the chrome

**11. `src/panels/Launcher.svelte`**
- Re-skin to match mock's `LAUNCH · 01` panel: floating `| TITLE` tab, white-LED hairline, white-led button "LAUNCH ⌘ N", uppercase labels w/ wide letter-spacing, Encom `select` chevrons. Keep all existing logic and inputs unchanged.

**12. `src/panels/Inspector.svelte` (sidebar list)**
- Re-skin folder rows per mock: SVG manila folder glyph, uppercase label, status dot + label on right (`ACTIVE / IDLE / STALE / FAILED / ADOPTING`), white-LED hover bar on the left edge of the active row.

**13. `src/panels/SwarmStatus.svelte`**
- Re-skin to match mock's `.statusbar`: pill chips, white-led halo on the active scope, separator bars, `TRACE · OK` right-aligned.

**14. `src/panels/SettingsModal.svelte` & `ConfirmModal.svelte` & `CloseConfirmModal.svelte`**
- Wrap modals in Encom `.panel`-style chrome (white-LED border, halo, sharp corners), uppercase headings with wide letter-spacing, Encom buttons.

**15. `src/panels/StartupHome.svelte`**
- Add the mock's hero block (`ENCOM · COMMAND DECK` / "Tron Encom OS" branding) and the meta cells row. Keep existing functionality (recent dirs, start fresh, etc.) inside Encom-styled panels.

**16. New `src/panels/TopStrip.svelte` (or fold into App.svelte)**
- Top bar with mark glyph, theme/scope crumb, and HUD pills (`GRID ONLINE`, `MCP X BOUND`, `UTC ...`). Renders only when Encom theme is active so we don't disturb the other themes' layouts.

**17. `src/styles/terminal.css` and node CSS in `TerminalNode.svelte`**
- Scoped Encom overrides: header background pure black, role badge → 1px outlined chip with white text + glow, traffic lights → outline-only matching mock's `.node .hdr .lights i` pattern.

**Verify Phase 3:**
- Side-by-side compare each surface against the mock — buttons, fields, chips, status bar, sidebar rows, hero, top strip all match the Encom aesthetic.
- Switching back to Ghostty Dark / Solar Dusk / Arctic / Operator Amber leaves them visually unchanged from today.

## Success criteria (final acceptance)

1. New install → app boots into Tron Encom OS.
2. Settings dropdown lists 5 themes; "Tron Encom OS" first; all 5 switch live without reload.
3. Every agent node has an emoji tab on its top edge; default emoji matches role; clicking opens 24-emoji picker; selection persists across app restart.
4. Chat panel renders an emoji avatar chip beside every message matching the sender's persona.
5. Edges in Encom theme are white animated dashed lines with halo. Packets are white.
6. All chrome (top strip, launcher, sidebar, status bar, modals, hero) matches the mock when Encom is active.
7. Switching to any of the four legacy themes returns them to their pre-change appearance.

## Decisions (answered 2026-04-21)

1. **Persona persistence backend** — confirmed: no existing `ui_update_instance_label` command. Adding `ui_set_instance_persona(instance_id, emoji)` in `ui_commands.rs` + helper in `writes.rs` that does `UPDATE instances SET label = ? WHERE id = ?` after rewriting just the `persona:` token in the existing label string.
2. **Operator/system avatar emojis** — 🎮 (operator), ⚙️ (system). Easy to change later.
3. **Top strip** — **all themes** (retrofit into legacy themes with theme-appropriate styling). The mock's top strip becomes a permanent layout element across all 5 themes, restyled per theme.
4. **JetBrains Mono** — **vendor woff2 locally** under `apps/swarm-ui/public/fonts/jetbrains-mono/`. Self-hosted `@font-face`. Offline-first; no network dependency.
5. **Hero panel on StartupHome** — **add the hero** (`ENCOM · COMMAND DECK` block + meta cells) when Encom is active. Existing StartupHome functionality (recent dirs, start fresh) stays inside Encom-styled panels below the hero.
6. **Terminal ANSI palette** — **apply Encom palette** to xterm.js when Encom is active. Map ANSI blue/cyan → white-grey neutrals per the mock. Other themes keep their current xterm palette.

## Branch / commit strategy

- One branch off the current dev branch, three commits matching phases 1/2/3 so we can land them incrementally if needed.
- Per the project memory: don't push to `experimental-frazier` until you say go.
