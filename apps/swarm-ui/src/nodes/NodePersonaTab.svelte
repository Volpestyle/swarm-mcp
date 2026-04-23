<!--
  NodePersonaTab.svelte — Agent identity plate floating above a node

  Renders a theme-aware plate with a larger persona picker, friendly name,
  provider initial, model label, and role. Selecting a persona still calls
  `setPersonaForInstance`, which writes the rewritten label via the Tauri
  `ui_set_instance_label` command — the swarm watcher fans the change back
  out and re-renders.

  Theme awareness: the chip and dropdown use neutral CSS vars
  (--node-border, --node-bg, --text-primary). The Encom override in
  `app.css`/this component's `[data-theme="tron-encom-os"]` scope swaps in the
  white-LED hairline + halo so it matches the mock without bleeding into the
  four legacy themes.

  Design note: Click-outside is wired at window level so clicks on canvas
  background, other nodes, or panel chrome dismiss the menu. The listener is
  installed only while open so it doesn't accumulate.
-->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import anthropicLogoUrl from '../assets/anthropic-logo.png';
  import openAiLogoUrl from '../assets/openai-old-logo.png';
  import { deriveAgentIdentity } from '../lib/agentIdentity';
  import type { Instance, PtySession } from '../lib/types';
  import {
    PERSONA_POOL,
    personaForInstance,
    setPersonaForInstance,
  } from '../lib/persona';

  /**
   * The instance this tab belongs to. May be null for unbound PTY-only nodes;
   * in that case the chip still renders (showing the fallback persona) but the
   * picker is disabled — there is no row to write the label back to.
   */
  export let instance: Instance | null = null;
  export let ptySession: PtySession | null = null;
  export let role: string = '';
  export let displayName: string | null = null;

  let menuOpen = false;
  let rootEl: HTMLDivElement | null = null;

  $: emoji = personaForInstance(instance);
  $: pickable = instance !== null;
  $: identity = deriveAgentIdentity({ instance, ptySession, role, displayName });
  $: providerLogo = identity.providerKind === 'anthropic'
    ? anthropicLogoUrl
    : identity.providerKind === 'openai'
      ? openAiLogoUrl
      : null;
  $: roleKind = identity.roleLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'default';

  async function toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    if (!pickable) return;
    menuOpen = !menuOpen;
    if (menuOpen) {
      await tick();
      window.addEventListener('mousedown', handleOutsideClick, true);
      window.addEventListener('keydown', handleKeydown, true);
    } else {
      teardownListeners();
    }
  }

  function handleOutsideClick(event: MouseEvent) {
    const target = event.target as Node | null;
    if (rootEl && target && rootEl.contains(target)) return;
    closeMenu();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    }
  }

  function closeMenu() {
    menuOpen = false;
    teardownListeners();
  }

  function teardownListeners() {
    window.removeEventListener('mousedown', handleOutsideClick, true);
    window.removeEventListener('keydown', handleKeydown, true);
  }

  async function pick(nextEmoji: string) {
    if (!instance) return;
    closeMenu();
    try {
      await setPersonaForInstance(instance, nextEmoji);
    } catch (err) {
      console.error('[NodePersonaTab] failed to set persona:', err);
    }
  }

  onDestroy(teardownListeners);
</script>

<div class="persona-tab" bind:this={rootEl} class:disabled={!pickable}>
  <div class="identity-card" data-provider={identity.providerKind}>
    <button
      type="button"
      class="persona-chip"
      title={pickable ? 'Pick a persona' : 'Bound persona (no instance to write to)'}
      aria-haspopup="true"
      aria-expanded={menuOpen}
      on:click={toggleMenu}
    >
      <span class="persona-emoji">{emoji}</span>
      {#if pickable}
        <span class="persona-caret" aria-hidden="true">▾</span>
      {/if}
    </button>

    <div class="identity-copy">
      <div class="identity-topline">
        <strong class="identity-name" title={identity.nameLabel}>{identity.nameLabel}</strong>
      </div>

      <div class="identity-model">
        <span class="model-label" title={`${identity.providerLabel} ${identity.modelLabel}`}>
          {identity.modelLabel}
        </span>
        <span class={`identity-role role-${roleKind}`} title={identity.roleLabel}>
          {identity.roleLabel}
        </span>
      </div>
    </div>

    {#if providerLogo}
      <span
        class="provider-logo-frame"
        title={identity.providerLabel}
        aria-label={`${identity.providerLabel} logo`}
      >
        <img src={providerLogo} alt="" />
      </span>
    {:else}
      <span
        class="provider-initial"
        title={identity.providerLabel}
        aria-label={identity.providerLabel}
      >
        {identity.providerLabel.slice(0, 1)}
      </span>
    {/if}
  </div>

  {#if menuOpen}
    <div class="persona-menu" role="menu">
      {#each PERSONA_POOL as item (item.emoji)}
        <button
          type="button"
          class="persona-menu-item"
          class:selected={item.emoji === emoji}
          title={item.name}
          role="menuitem"
          on:click|stopPropagation={() => pick(item.emoji)}
        >
          {item.emoji}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Floating plate attached to the top edge of the parent node card.
     The parent (.terminal-node) is position: relative in TerminalNode.svelte.
     The extra lift creates a readable label band instead of hiding details
     inside the terminal title bar. */
  .persona-tab {
    position: absolute;
    top: 0;
    left: 50%;
    width: min(620px, calc(100% + 190px));
    transform: translate(-50%, calc(-100% - 14px));
    z-index: 7;
    pointer-events: auto;
  }

  .identity-card {
    display: grid;
    grid-template-columns: 68px minmax(0, 1fr) 68px;
    align-items: center;
    gap: 13px;
    width: 100%;
    min-height: 90px;
    padding: 10px;
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.2));
    border-radius: 14px;
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 42%),
      color-mix(in srgb, var(--node-header-bg, #181825) 90%, black 10%);
    box-shadow:
      0 18px 36px rgba(0, 0, 0, 0.34),
      inset 0 0 0 1px rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    box-sizing: border-box;
  }

  .persona-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 68px;
    height: 68px;
    padding: 0;
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.2));
    background:
      radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.18), transparent 44%),
      var(--node-bg, rgba(15, 15, 22, 0.96));
    color: var(--text-primary, #c0caf5);
    cursor: pointer;
    line-height: 1;
    border-radius: 12px;
    box-sizing: border-box;
    font-family: inherit;
    flex: 0 0 auto;
    position: relative;
    box-shadow: inset 0 0 14px rgba(255, 255, 255, 0.04);
  }

  .persona-tab.disabled .persona-chip {
    cursor: default;
    opacity: 0.7;
  }

  .persona-chip:hover {
    background: var(--node-header-bg-hover, rgba(255, 255, 255, 0.06));
  }

  .persona-emoji {
    font-size: 40px;
    line-height: 1;
  }

  .persona-caret {
    position: absolute;
    right: 5px;
    bottom: 4px;
    font-size: 10px;
    opacity: 0.68;
  }

  .identity-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 9px;
  }

  .identity-topline {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 9px;
  }

  .identity-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--node-title-fg, #e5e5e5);
    font-size: 20px;
    font-weight: 750;
    letter-spacing: -0.01em;
    line-height: 1.05;
  }

  .identity-role {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    max-width: 136px;
    height: 17px;
    padding: 0 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid color-mix(in srgb, var(--role-color, var(--node-status-muted, #888)) 60%, transparent);
    border-radius: 2px;
    background: color-mix(in srgb, var(--role-color, var(--node-status-muted, #888)) 14%, transparent);
    color: var(--role-color, var(--node-status-muted, #888));
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.09em;
    line-height: 1;
    text-transform: uppercase;
  }

  .identity-model {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .role-planner,
  .role-plan,
  .role-orchestrator {
    --role-color: #cba6f7;
  }

  .role-implementer,
  .role-builder,
  .role-coder {
    --role-color: #89dceb;
  }

  .role-reviewer,
  .role-review {
    --role-color: #f9e2af;
  }

  .role-researcher,
  .role-analyst {
    --role-color: #a6e3a1;
  }

  .role-operator,
  .role-owner {
    --role-color: #fab387;
  }

  .provider-logo-frame,
  .provider-initial {
    width: 68px;
    height: 68px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--node-border, #313244) 72%, transparent);
    background: rgba(255, 255, 255, 0.88);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    overflow: hidden;
  }

  .provider-logo-frame {
    background: rgba(255, 255, 255, 0.94);
    overflow: hidden;
  }

  .provider-logo-frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .provider-initial {
    background: color-mix(in srgb, var(--node-border-selected, #89b4fa) 18%, black);
    color: var(--terminal-fg, #c0caf5);
    font-size: 24px;
    font-weight: 800;
  }

  .model-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--terminal-fg, #c0caf5) 88%, transparent);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: 0.01em;
  }

  /* Dropdown menu — 6×4 grid, mirrors the mock's `.persona-menu`. */
  .persona-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    display: grid;
    grid-template-columns: repeat(6, 28px);
    grid-auto-rows: 28px;
    gap: 2px;
    padding: 6px;
    background: var(--node-bg, rgba(15, 15, 22, 0.96));
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.2));
    border-radius: 4px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    z-index: 6;
  }

  .persona-menu-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    border-radius: 3px;
    font-family: inherit;
  }

  .persona-menu-item:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.18);
  }

  .persona-menu-item.selected {
    border-color: var(--text-primary, #c0caf5);
  }

  /* ── Tron Encom OS overrides ──────────────────────────────────────────
     Thick white-LED frame, sharp corners, and readable operator labels. */
  :global([data-theme="tron-encom-os"]) .identity-card {
    grid-template-columns: 70px minmax(0, 1fr) 70px;
    min-height: 92px;
    padding: 10px;
    border: 3px solid var(--led-line-x, #ffffff);
    border-radius: 0;
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0.11), transparent 22%),
      linear-gradient(180deg, var(--bg-elevated, #0b0f14), var(--bg-base, #000000));
    box-shadow:
      var(--led-halo-x, 0 0 18px rgba(255, 255, 255, 0.35)),
      0 18px 44px rgba(0, 0, 0, 0.62);
  }

  :global([data-theme="tron-encom-os"]) .persona-chip {
    width: 70px;
    height: 70px;
    border: 2px solid var(--led-line-x, #ffffff);
    background: var(--bg-base, #050505);
    border-radius: 0;
    box-shadow:
      inset 0 0 14px rgba(255, 255, 255, 0.08),
      0 0 12px rgba(255, 255, 255, 0.42);
  }

  :global([data-theme="tron-encom-os"]) .persona-chip:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  :global([data-theme="tron-encom-os"]) .persona-emoji {
    font-size: 42px;
    text-shadow: var(--glow, 0 0 8px rgba(255, 255, 255, 0.45));
  }

  :global([data-theme="tron-encom-os"]) .identity-name {
    color: var(--fg-primary, #f5f7fa);
    font-size: 21px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-shadow: var(--glow, 0 0 8px rgba(255, 255, 255, 0.45));
  }

  :global([data-theme="tron-encom-os"]) .identity-role {
    border-radius: 0;
    border-color: var(--role-color, var(--accent-dim, #c8cfd8));
    background: color-mix(in srgb, var(--role-color, var(--accent-dim, #c8cfd8)) 18%, transparent);
    color: var(--role-color, var(--accent-dim, #c8cfd8));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.04),
      0 0 8px color-mix(in srgb, var(--role-color, #ffffff) 34%, transparent);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .provider-logo-frame,
  :global([data-theme="tron-encom-os"]) .provider-initial {
    width: 70px;
    height: 70px;
    border: 2px solid var(--led-line-x, #ffffff);
    border-radius: 0;
    box-shadow:
      inset 0 0 12px rgba(255, 255, 255, 0.08),
      0 0 12px rgba(255, 255, 255, 0.42);
  }

  :global([data-theme="tron-encom-os"]) .provider-initial {
    font-size: 24px;
  }

  :global([data-theme="tron-encom-os"]) .model-label {
    color: var(--fg-primary, #f5f7fa);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .persona-menu {
    border: 2px solid var(--led-line-x, #ffffff);
    background: var(--bg-base, #050505);
    border-radius: 0;
    box-shadow:
      var(--led-halo, 0 0 12px rgba(255, 255, 255, 0.26)),
      0 12px 28px rgba(0, 0, 0, 0.7);
  }

  :global([data-theme="tron-encom-os"]) .persona-menu-item {
    border-radius: 0;
  }

  :global([data-theme="tron-encom-os"]) .persona-menu-item.selected {
    border-color: var(--led-line, rgba(255, 255, 255, 0.7));
    box-shadow: inset 0 0 6px var(--glow, rgba(255, 255, 255, 0.18));
  }
</style>
