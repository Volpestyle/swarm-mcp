<!--
  ConfirmModal.svelte — in-app replacement for window.confirm()

  Mounted once at the App.svelte root. Subscribes to the `currentConfirm`
  store and renders a modal whenever a confirm() call is pending. See
  `lib/confirm.ts` for the async helper that drives it.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { currentConfirm, respondToConfirm } from '../lib/confirm';

  let confirmButton: HTMLButtonElement | null = null;

  $: request = $currentConfirm;

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
      <p class="message">{request.message}</p>
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
    max-width: 480px;
    padding: 20px 22px 16px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.98));
    border: 1px solid var(--node-border, #313244);
    border-radius: 10px;
    color: var(--terminal-fg, #c0caf5);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .title {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .message {
    margin: 0 0 18px;
    font-size: 13px;
    line-height: 1.45;
    color: #a6adc8;
    white-space: pre-wrap;
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
</style>
