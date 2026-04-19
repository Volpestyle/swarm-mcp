<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';

  const dispatch = createEventDispatcher<{
    cancel: void;
    confirm: void;
  }>();

  let cancelButton: HTMLButtonElement | null = null;

  onMount(() => {
    void tick().then(() => cancelButton?.focus());
  });

  function cancelClose(): void {
    dispatch('cancel');
  }

  function confirmClose(): void {
    dispatch('confirm');
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;

    if (meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelClose();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      confirmClose();
    }
  }

</script>

<svelte:window on:keydown|capture={handleWindowKeydown} />

<div class="confirm-overlay">
  <div
    class="confirm-modal"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="close-confirm-title"
    aria-describedby="close-confirm-copy"
    tabindex="-1"
  >
    <div class="confirm-header">
      <h2 id="close-confirm-title">Close swarm-ui?</h2>
    </div>

    <div class="confirm-body">
      <p id="close-confirm-copy">
        This will close the main swarm-ui window.
      </p>
      <p class="confirm-hint">
        Press Cancel to keep working, or Quit App to close the window.
      </p>
    </div>

    <div class="confirm-footer">
      <button
        bind:this={cancelButton}
        type="button"
        class="secondary-btn"
        on:click={cancelClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="danger-btn"
        on:click={confirmClose}
      >
        Quit App
      </button>
    </div>
  </div>
</div>

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(6, 7, 12, 0.48);
    backdrop-filter: blur(18px) saturate(1.08);
    -webkit-backdrop-filter: blur(18px) saturate(1.08);
  }

  .confirm-modal {
    width: min(440px, 100%);
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 16px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.76));
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    overflow: hidden;
  }

  .confirm-header,
  .confirm-footer {
    padding: 18px 20px;
  }

  .confirm-header {
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .confirm-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .confirm-body {
    padding: 20px;
  }

  .confirm-body p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--terminal-fg, #c0caf5);
  }

  .confirm-hint {
    margin-top: 10px;
    color: #8f94b2;
  }

  .confirm-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    border-top: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .secondary-btn,
  .danger-btn {
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .secondary-btn {
    background: var(--node-header-bg, rgba(24, 24, 37, 0.82));
    color: var(--terminal-fg, #c0caf5);
  }

  .secondary-btn:hover {
    background: color-mix(in srgb, var(--node-header-bg, rgba(24, 24, 37, 0.82)) 84%, white);
  }

  .danger-btn {
    background: #f38ba8;
    border-color: color-mix(in srgb, #f38ba8 74%, black);
    color: #1b1218;
  }

  .danger-btn:hover {
    background: color-mix(in srgb, #f38ba8 84%, white);
  }

  @media (max-width: 640px) {
    .confirm-overlay {
      padding: 12px;
      align-items: flex-end;
    }

    .confirm-modal {
      width: 100%;
    }
  }
</style>
