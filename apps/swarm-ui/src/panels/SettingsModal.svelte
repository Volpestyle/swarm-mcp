<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { appearance } from '../stores/appearance';
  import {
    harnessAliases,
    HARNESS_NAMES,
    type HarnessName,
  } from '../stores/harnessAliases';

  const dispatch = createEventDispatcher<{ close: void }>();

  function closeSettings() {
    dispatch('close');
  }

  function handleBackgroundOpacityInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    appearance.setBackgroundOpacity(Number(target.value) / 100);
  }

  function handleAliasInput(harness: HarnessName, event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    harnessAliases.setAlias(harness, target.value);
  }

  function resetDefaults() {
    appearance.reset();
    harnessAliases.reset();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div class="settings-overlay">
  <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-header">
      <div>
        <h2 id="settings-title">Settings</h2>
        <p>Adjust appearance and harness command preferences.</p>
      </div>

      <button type="button" class="close-btn" on:click={closeSettings} aria-label="Close settings">
        Close
      </button>
    </div>

    <div class="settings-body">
      <section>
        <h3>Appearance</h3>

        <div class="setting-row">
          <div class="setting-copy">
            <label for="settings-background-opacity">Background Opacity</label>
            <p>Lower values let more of the desktop show through the canvas, panels, and terminals.</p>
          </div>

          <div class="setting-control">
            <span class="setting-value">{Math.round($appearance.backgroundOpacity * 100)}%</span>
            <input
              id="settings-background-opacity"
              type="range"
              min="25"
              max="100"
              step="1"
              value={Math.round($appearance.backgroundOpacity * 100)}
              on:input={handleBackgroundOpacityInput}
            />
          </div>
        </div>
      </section>

      <section class="harness-section">
        <h3>Harness Commands</h3>
        <p class="section-hint">
          Override the shell command used when launching each harness. Useful if
          your binary lives under a different name (e.g. <code>claude</code> →
          <code>clowd</code>).
        </p>

        {#each HARNESS_NAMES as harness (harness)}
          <div class="setting-row">
            <div class="setting-copy">
              <label for={`settings-harness-${harness}`}>{harness}</label>
              <p>Default: <code>{harness}</code></p>
            </div>

            <div class="setting-control alias-control">
              <input
                id={`settings-harness-${harness}`}
                type="text"
                spellcheck="false"
                autocomplete="off"
                autocapitalize="off"
                placeholder={harness}
                value={$harnessAliases[harness]}
                on:input={(event) => handleAliasInput(harness, event)}
              />
            </div>
          </div>
        {/each}
      </section>
    </div>

    <div class="settings-footer">
      <button type="button" class="secondary-btn" on:click={resetDefaults}>
        Reset Defaults
      </button>
      <button type="button" class="primary-btn" on:click={closeSettings}>
        Done
      </button>
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(6, 7, 12, 0.42);
    backdrop-filter: blur(18px) saturate(1.08);
    -webkit-backdrop-filter: blur(18px) saturate(1.08);
  }

  .settings-modal {
    width: min(560px, 100%);
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 16px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.68));
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.38);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    overflow: hidden;
  }

  .settings-header,
  .settings-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .settings-footer {
    border-top: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-bottom: none;
  }

  .settings-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .settings-header p {
    margin: 6px 0 0;
    font-size: 12px;
    color: #8f94b2;
  }

  .settings-body {
    padding: 20px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .harness-section {
    margin-top: 20px;
  }

  .section-hint {
    margin: -4px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #8f94b2;
  }

  .section-hint code,
  .setting-copy code {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(108, 112, 134, 0.22);
    color: var(--terminal-fg, #c0caf5);
  }

  .alias-control input[type='text'] {
    padding: 6px 10px;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 12px;
    color: var(--terminal-fg, #c0caf5);
    background: rgba(17, 17, 27, 0.65);
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 8px;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .alias-control input[type='text']:focus {
    border-color: var(--status-pending, #89b4fa);
    background: rgba(17, 17, 27, 0.82);
  }

  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #a6adc8;
  }

  .setting-row {
    display: flex;
    gap: 20px;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 12px;
    background: var(--node-header-bg, rgba(24, 24, 37, 0.82));
  }

  .setting-copy {
    flex: 1;
    min-width: 0;
  }

  .setting-copy label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .setting-copy p {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: #8f94b2;
  }

  .setting-control {
    width: 180px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .setting-control input {
    width: 100%;
    margin: 0;
    accent-color: var(--status-pending, #89b4fa);
    cursor: pointer;
  }

  .setting-value {
    align-self: flex-end;
    font-size: 12px;
    font-weight: 700;
    color: var(--terminal-fg, #c0caf5);
  }

  .close-btn,
  .secondary-btn,
  .primary-btn {
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .close-btn,
  .secondary-btn {
    background: var(--node-header-bg, rgba(24, 24, 37, 0.82));
    color: var(--terminal-fg, #c0caf5);
  }

  .primary-btn {
    background: var(--status-pending, #89b4fa);
    border-color: color-mix(in srgb, var(--status-pending, #89b4fa) 72%, black);
    color: #10131a;
  }

  .settings-footer {
    justify-content: flex-end;
  }

  .settings-footer .secondary-btn {
    margin-right: auto;
  }

  .close-btn:hover,
  .secondary-btn:hover {
    background: color-mix(in srgb, var(--node-header-bg, rgba(24, 24, 37, 0.82)) 84%, white);
  }

  .primary-btn:hover {
    background: color-mix(in srgb, var(--status-pending, #89b4fa) 84%, white);
  }

  @media (max-width: 640px) {
    .settings-overlay {
      padding: 12px;
      align-items: flex-end;
    }

    .settings-modal {
      width: 100%;
    }

    .setting-row {
      flex-direction: column;
      align-items: stretch;
    }

    .setting-control {
      width: 100%;
    }
  }
</style>
