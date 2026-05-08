<!--
  ConfirmModal.svelte — in-app replacement for window.confirm()

  Mounted once at the App.svelte root. Subscribes to the `currentConfirm`
  store and renders a modal whenever a confirm() call is pending. See
  `lib/confirm.ts` for the async helper that drives it.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { currentConfirm, respondToConfirm } from '../lib/confirm';
  import { parseConfirmMessage, type ParsedConfirmMessage } from '../lib/confirmMessage';

  let confirmButton: HTMLButtonElement | null = null;
  let parsedMessage: ParsedConfirmMessage = { intro: [], sections: [] };

  $: request = $currentConfirm;
  $: parsedMessage = parseConfirmMessage(request?.message ?? '');

  // Autofocus the confirm button when a new request opens so Enter submits
  // and focus is trapped in the modal's interactive controls.
  $: if (request) {
    void tick().then(() => confirmButton?.focus());
  }

  function onCancel() {
    if (!request) return;
    respondToConfirm(request.id, false);
  }

  function onConfirm() {
    if (!request) return;
    respondToConfirm(request.id, true);
  }

  function onKey(event: KeyboardEvent) {
    if (!request) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onConfirm();
    }
  }
</script>

<svelte:window on:keydown|capture={onKey} />

{#if request}
  <div class="backdrop" role="presentation" on:click={onCancel}>
    <!-- stopPropagation keeps clicks inside the modal from bubbling up to
         the backdrop's cancel handler. Keyboard interaction (Esc/Enter) is
         handled globally via <svelte:window on:keydown>, so the dialog
         container itself doesn't need a keyboard handler. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={request.title ?? 'Confirm'}
      tabindex="-1"
      on:click|stopPropagation
    >
      {#if request.title}
        <h2 class="title">{request.title}</h2>
      {/if}
      <div class="message-stack">
        {#each parsedMessage.intro as line}
          <p class="message-intro">{line}</p>
        {/each}
        {#each parsedMessage.sections as section}
          <section class="message-box" class:warning={section.tone === 'warning'}>
            <h3>{section.heading}</h3>
            <ul>
              {#each section.items as item}
                <li class:no-label={!item.label}>
                  {#if item.label}
                    <span>{item.label}</span>
                  {/if}
                  <strong>{item.value}</strong>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
      <div class="actions">
        <button type="button" class="cancel" on:click={onCancel}>
          {request.cancelLabel}
        </button>
        <button
          type="button"
          class="confirm"
          class:danger={request.danger}
          bind:this={confirmButton}
          on:click={onConfirm}
        >
          {request.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal {
    min-width: 320px;
    width: min(640px, calc(100vw - 32px));
    max-width: 640px;
    max-height: min(720px, calc(100vh - 40px));
    padding: 20px 22px 16px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.98));
    border: 1px solid var(--node-border, #313244);
    border-radius: 10px;
    color: var(--terminal-fg, #c0caf5);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: auto;
  }

  .title {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .message-stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0 0 18px;
  }

  .message-intro {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: #cdd6f4;
  }

  .message-box {
    border: 1px solid rgba(137, 180, 250, 0.22);
    border-radius: 8px;
    background: rgba(17, 17, 27, 0.42);
    overflow: hidden;
  }

  .message-box.warning {
    border-color: rgba(243, 139, 168, 0.34);
    background: rgba(243, 139, 168, 0.055);
  }

  .message-box h3 {
    margin: 0;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(137, 180, 250, 0.18);
    color: #89b4fa;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .message-box.warning h3 {
    border-bottom-color: rgba(243, 139, 168, 0.24);
    color: #f38ba8;
  }

  .message-box ul {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .message-box li {
    display: grid;
    grid-template-columns: minmax(120px, 0.38fr) minmax(0, 1fr);
    gap: 10px;
    padding: 8px 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }

  .message-box li:first-child {
    border-top: 0;
  }

  .message-box li.no-label {
    grid-template-columns: minmax(0, 1fr);
  }

  .message-box span {
    min-width: 0;
    color: #a6adc8;
    font-size: 11px;
  }

  .message-box strong {
    min-width: 0;
    color: #f5f7fa;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    font-weight: 600;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .actions button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid rgba(108, 112, 134, 0.4);
    background: rgba(17, 17, 27, 0.6);
    color: #a6adc8;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }

  .actions button:hover {
    background: rgba(49, 50, 68, 0.9);
    color: var(--terminal-fg, #c0caf5);
  }

  .actions button.confirm {
    background: rgba(137, 180, 250, 0.2);
    border-color: rgba(137, 180, 250, 0.55);
    color: #89b4fa;
  }

  .actions button.confirm:hover {
    background: rgba(137, 180, 250, 0.35);
    color: #c0d6ff;
  }

  .actions button.confirm.danger {
    background: rgba(243, 139, 168, 0.16);
    border-color: rgba(243, 139, 168, 0.55);
    color: #f38ba8;
  }

  .actions button.confirm.danger:hover {
    background: rgba(243, 139, 168, 0.3);
    color: #f5a1b6;
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .modal {
    background: var(--bg-base, #000);
    border: 1px solid var(--led-line, #d8dde6);
    border-radius: 0;
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      0 0 18px rgba(255, 255, 255, 0.18),
      0 24px 60px rgba(0, 0, 0, 0.7);
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .title {
    text-transform: uppercase;
    letter-spacing: 0.18em;
    font-size: 12px;
    color: var(--accent, #ffffff);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .message-intro {
    color: var(--fg-secondary, #8a94a0);
    font-size: 12px;
  }

  :global([data-theme="tron-encom-os"]) .message-box {
    border-radius: 0;
    border-color: rgba(216, 221, 230, 0.32);
    background: rgba(0, 0, 0, 0.62);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.035);
  }

  :global([data-theme="tron-encom-os"]) .message-box.warning {
    border-color: rgba(255, 58, 76, 0.62);
    background: rgba(255, 58, 76, 0.06);
  }

  :global([data-theme="tron-encom-os"]) .message-box h3 {
    border-bottom-color: rgba(216, 221, 230, 0.24);
    color: var(--accent, #ffffff);
    letter-spacing: 0.16em;
  }

  :global([data-theme="tron-encom-os"]) .message-box.warning h3 {
    border-bottom-color: rgba(255, 58, 76, 0.38);
    color: var(--c-red, #ff3a4c);
  }

  :global([data-theme="tron-encom-os"]) .message-box li {
    border-top-color: rgba(216, 221, 230, 0.11);
  }

  :global([data-theme="tron-encom-os"]) .message-box span {
    color: var(--fg-secondary, #8a94a0);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  :global([data-theme="tron-encom-os"]) .message-box strong {
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .actions button {
    border-radius: 0;
    background: transparent;
    border: 1px solid var(--led-line, #d8dde6);
    color: var(--fg-primary, #f5f7fa);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 6px 14px;
  }

  :global([data-theme="tron-encom-os"]) .actions button:hover {
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .actions button.confirm {
    background: rgba(255, 255, 255, 0.08);
    color: var(--accent, #ffffff);
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .actions button.confirm.danger {
    background: rgba(255, 58, 76, 0.12);
    border-color: var(--c-red, #ff3a4c);
    color: var(--c-red, #ff3a4c);
    box-shadow: 0 0 6px rgba(255, 58, 76, 0.3);
  }
</style>
