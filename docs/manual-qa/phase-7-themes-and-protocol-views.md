# Phase 7 — Themes And Protocol Views Manual QA

Manual QA for Phase 7 Tasks 1–3 + 5. Task 4 (ProtocolView / ProtocolEditor UI)
is deferred to a follow-up batch and not exercised here.

This batch also resolved two bugs that surfaced while building the new themes:

1. The background-opacity slider semantic was inverted from user expectation —
   100% used to mean "fully opaque." It now means "fully transparent."
2. macOS `NSVisualEffectMaterial::HudWindow` vibrancy was being applied
   unconditionally at startup, which painted a dark frosted backdrop *behind*
   the window and made Tron Encom Clear effectively impossible to see through to
   the desktop. Vibrancy is now theme-controlled — Liquid Glass themes apply
   it on activation, every other theme clears it.

## Pre-flight

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/protocols.test.ts
cd apps/swarm-ui && bun run check && bun run build
```

Expected: protocols tests pass (7 cases), `bun run check` is clean, build
succeeds. The TypeScript narrowing on the new `WindowVibrancyMaterial` and
the two new `ThemeProfileId` literals is what `bun run check` is exercising.

## Theme switching

1. Launch the app on macOS. Default theme is Tron Encom Clear.

   Expected: pure-black canvas, white-LED hairlines on every chrome surface,
   sharp-cornered panels. The **See-Through Override** slider sits at 0% —
   fully opaque, and **Backdrop Blur Override** sits at 0% — crisp/no blur.

2. Open Settings → Appearance and slide **See-Through Override** to 100%.

   Expected: the canvas becomes fully transparent. You should see whatever
   is behind the swarm-ui window (your desktop, another app, a wallpaper).
   Hairlines and dotted grid remain visible at low alpha.

   *If this still shows a dark frosted backdrop instead of the desktop:*
   the unconditional `apply_vibrancy` call in `main.rs` was not removed
   correctly. Re-check that `setup` no longer calls `apply_vibrancy` and
   that no other call site re-applies it.

3. Leave **See-Through Override** high and slide **Backdrop Blur Override**
   above 0%.

   Expected:
   - The same desktop content remains visible, but becomes frosted/softened.
   - Returning **Backdrop Blur Override** to 0% clears the native macOS blur and
     returns to crisp see-through.

4. Slide the **See-Through Override** back to 0%.

   Expected: pure black returns. The slider is the only thing that
   distinguishes opaque from translucent under Tron — there's no other
   black-painting layer behind it.

5. Switch the theme to **Liquid Glass Blur Cool**.

   Expected:
   - canvas becomes deep blue-black (`#050810`)
   - a pale blue radial wash blooms from the bottom of the window
   - panels gain 18px rounded corners
   - macOS HudWindow vibrancy activates — the window picks up the system
     frosted-glass material behind translucent panels
   - the slider's "Use Theme Default" button restores 55% transparency

6. Switch to **Liquid Glass Blur Warm**.

   Expected: same structural treatment, but canvas becomes warm brown-black
   (`#14110e`) and the radial wash is amber (`#ffaa50`). HudWindow vibrancy
   stays on.

7. Switch back to **Tron Encom Clear**.

   Expected: vibrancy clears (window is no longer frosted-glass behind
   translucent areas) and the canvas returns to pure black. Sliding to 100%
   transparency must again reveal the desktop, not a dark vibrancy backdrop.

8. Switch through each of the four legacy themes (Ghostty Dark, Solar Dusk,
   Arctic Console, Operator Amber).

   Expected: each renders at its `defaultBackgroundOpacity` translucency over
   a transparent window (no vibrancy backdrop). Slight visual difference vs.
   pre-Phase-7 because vibrancy is no longer providing a frosted backdrop —
   the legacy themes' translucent surfaces now composite directly onto the
   desktop. If you want the old frosted-HUD look back for a specific legacy
   theme, register it in `THEME_VIBRANCY` in `apps/swarm-ui/src/stores/appearance.ts`.

## Protocol domain model

This is the data layer for Phase 7 Task 4 (UI). With Task 4 deferred, the
exercise here is purely the test suite and TypeScript correctness.

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test apps/swarm-ui/src/lib/protocols.test.ts
```

Expected output: 7 passing cases covering happy path, defaults, trimming,
and missing/blank identity fields.

The `ProtocolNode`, `ProtocolEdge`, and `ProjectProtocol` types are exported
from `apps/swarm-ui/src/lib/types.ts`. The existing `AssetKind` already
included `'protocol'`, so protocols can attach via `AssetAttachment` once the
Task 4 UI lands.

## Pivot note

The Phase 7 plan originally named the two new themes `encom-glass-deck` and
`darkfolder-silhouette`. The actual reference material delivered (Claude
Design "Swarm-UI · Liquid Glass" v1 and v2) is a temperature pair of one
design language, not two distinct directions. The themes now ship as
`liquid-glass-cool` and `liquid-glass-warm`. **DarkFolder Silhouette** is
parked for a future phase if the silhouette/folder language is still a
direction worth pursuing.
