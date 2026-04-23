<script lang="ts">
  import { startupPreferences, startupThemeProfile } from '../stores/startup';
  import { activeScope, instances } from '../stores/swarm';

  $: themeName = $startupThemeProfile?.name ?? 'Theme';
  $: themeId = $startupThemeProfile?.id ?? '';
  $: scopeLabel = $activeScope || $startupPreferences.selectedDirectory || 'no scope';
  $: instanceCount = $instances.size;
</script>

<header class="top-strip" data-theme-id={themeId} aria-label="swarm-ui status strip">
  <div class="strip-left">
    <span class="brand-mark">
      {#if themeId === 'tron-encom-os'}
        ENCOM · COMMAND DECK
      {:else}
        swarm-ui
      {/if}
    </span>
    <span class="brand-sep" aria-hidden="true">·</span>
    <span class="brand-theme">{themeName}</span>
  </div>

  <div class="strip-right">
    <span class="strip-cell">
      <em>SCOPE</em>
      <span class="strip-cell-value mono" title={scopeLabel}>{scopeLabel}</span>
    </span>
    <span class="strip-cell">
      <em>NODES</em>
      <span class="strip-cell-value mono">{instanceCount}</span>
    </span>
  </div>
</header>

<style>
  .top-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 25;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.32));
    background: color-mix(in srgb, var(--terminal-bg, #1e1e1e) 78%, transparent);
    backdrop-filter: blur(14px) saturate(1.08);
    -webkit-backdrop-filter: blur(14px) saturate(1.08);
    color: var(--terminal-fg, #c0caf5);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    pointer-events: none;
    user-select: none;
  }

  .strip-left,
  .strip-right {
    display: flex;
    align-items: center;
    gap: 10px;
    pointer-events: auto;
    min-width: 0;
  }

  .strip-right {
    flex-shrink: 1;
    overflow: hidden;
  }

  .brand-mark {
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 88%, transparent);
  }

  .brand-sep {
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 36%, transparent);
  }

  .brand-theme {
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 60%, transparent);
    font-size: 10px;
  }

  .strip-cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .strip-cell em {
    font-style: normal;
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 50%, transparent);
  }

  .strip-cell-value {
    color: var(--terminal-fg, #c0caf5);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .top-strip {
    background: var(--bg-base, #000);
    border-bottom: 1px solid var(--led-line, #d8dde6);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    box-shadow: 0 1px 0 0 var(--led-halo, rgba(255, 255, 255, 0.08));
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .brand-mark {
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
    letter-spacing: 0.22em;
  }

  :global([data-theme="tron-encom-os"]) .brand-sep,
  :global([data-theme="tron-encom-os"]) .brand-theme,
  :global([data-theme="tron-encom-os"]) .strip-cell em {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .strip-cell-value {
    color: var(--fg-primary, #f5f7fa);
  }
</style>
