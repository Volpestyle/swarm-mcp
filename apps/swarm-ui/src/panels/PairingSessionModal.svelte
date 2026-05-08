<script lang="ts">
  import DOMPurify from 'dompurify';
  import QRCode from 'qrcode';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { pairingStringFromSession } from '../lib/mobileAccess';
  import { formatTimestamp, timestampToMillis } from '../lib/time';
  import type { PairingSessionInfo } from '../lib/types';

  export let session: PairingSessionInfo;
  export let refreshing = false;

  const dispatch = createEventDispatcher<{
    close: void;
    refresh: void;
  }>();

  let nowMs = Date.now();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let qrSvg = '';
  let qrError: string | null = null;
  let copied = false;
  let showManualFallback = false;
  let renderedPayload = '';

  $: pairingString = pairingStringFromSession(session);
  $: expiresAtMs = timestampToMillis(session.expires_at) ?? Date.now();
  $: secondsRemaining = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  $: expired = secondsRemaining === 0;
  $: if (pairingString !== renderedPayload) {
    renderedPayload = pairingString;
    copied = false;
    void renderQr(pairingString);
  }

  onMount(() => {
    nowMs = Date.now();
    intervalId = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  async function renderQr(payload: string): Promise<void> {
    qrError = null;

    try {
      const svg = await QRCode.toString(payload, {
        type: 'svg',
        margin: 0,
        width: 240,
        color: {
          dark: '#11111b',
          light: '#f5f7fb',
        },
      });
      qrSvg = DOMPurify.sanitize(svg);
    } catch (err) {
      qrSvg = '';
      qrError = err instanceof Error ? err.message : 'Failed to render QR code';
    }
  }

  async function copyPairingString(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pairingString);
      copied = true;
    } catch (err) {
      qrError = err instanceof Error ? err.message : 'Failed to copy pairing string';
    }
  }

  function closeModal(): void {
    dispatch('close');
  }

  function refreshSession(): void {
    dispatch('refresh');
  }

  function toggleManualFallback(): void {
    showManualFallback = !showManualFallback;
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    }
  }

  function formatCountdown(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
</script>

<svelte:window on:keydown|capture={handleWindowKeydown} />

<div class="pairing-overlay">
  <div
    class="pairing-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pairing-title"
    aria-describedby="pairing-copy"
  >
    <div class="pairing-header">
      <div>
        <h2 id="pairing-title">Pair iPhone / iPad</h2>
        <p id="pairing-copy">Scan this short-lived code in Swarm on your mobile device.</p>
      </div>

      <button type="button" class="close-btn" on:click={closeModal} aria-label="Close pairing">
        Close
      </button>
    </div>

    <div class="pairing-body">
      <div class="qr-shell" class:expired={expired}>
        {#if qrSvg}
          <div class="qr-art" aria-hidden="true">
            {@html qrSvg}
          </div>
        {:else}
          <div class="qr-placeholder">
            {#if qrError}
              <span>{qrError}</span>
            {:else}
              <span>Rendering QR…</span>
            {/if}
          </div>
        {/if}

        {#if expired}
          <div class="qr-expired">
            <strong>Expired</strong>
            <span>Generate a new code to keep pairing.</span>
          </div>
        {/if}
      </div>

      <div class="pairing-details">
        <div class="status-row">
          <div class="status-pill" class:expired-pill={expired}>
            {#if expired}
              Expired
            {:else}
              Expires in {formatCountdown(secondsRemaining)}
            {/if}
          </div>
          <span class="expires-at">Until {formatTimestamp(session.expires_at)}</span>
        </div>

        <p class="detail-copy">
          This code is generated locally on demand and only stays valid for a brief window.
        </p>

        <div class="action-row">
          <button type="button" class="primary-btn" on:click={refreshSession} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh code'}
          </button>
          <button type="button" class="secondary-btn" on:click={toggleManualFallback}>
            {showManualFallback ? 'Hide manual fallback' : "Can't scan?"}
          </button>
        </div>

        {#if showManualFallback}
          <div class="manual-fallback">
            <label for="pairing-string">Pairing string</label>
            <div class="copy-row">
              <input id="pairing-string" type="text" value={pairingString} readonly />
              <button type="button" class="secondary-btn compact-btn" on:click={copyPairingString}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p>Paste this exact string into the iOS pairing screen if the camera isn’t available.</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .pairing-overlay {
    position: fixed;
    inset: 0;
    z-index: 125;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(4, 5, 10, 0.54);
    backdrop-filter: blur(20px) saturate(1.08);
    -webkit-backdrop-filter: blur(20px) saturate(1.08);
  }

  .pairing-modal {
    width: min(720px, 100%);
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 18px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.82));
    box-shadow: 0 28px 72px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    overflow: hidden;
  }

  .pairing-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 20px 22px;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .pairing-header h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .pairing-header p {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #8f94b2;
  }

  .pairing-body {
    display: grid;
    grid-template-columns: minmax(250px, 280px) minmax(0, 1fr);
    gap: 22px;
    padding: 22px;
  }

  .qr-shell {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 280px;
    padding: 18px;
    border-radius: 18px;
    background:
      radial-gradient(circle at top, rgba(148, 226, 213, 0.2), transparent 52%),
      linear-gradient(180deg, rgba(17, 17, 27, 0.94), rgba(15, 15, 24, 0.96));
    border: 1px solid rgba(148, 163, 184, 0.2);
  }

  .qr-shell.expired {
    opacity: 0.74;
  }

  .qr-art {
    width: 100%;
    max-width: 240px;
    line-height: 0;
  }

  .qr-art :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    padding: 16px;
    border-radius: 14px;
    background: #f5f7fb;
  }

  .qr-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 220px;
    padding: 18px;
    border-radius: 14px;
    background: rgba(17, 17, 27, 0.62);
    color: #c0caf5;
    text-align: center;
  }

  .qr-expired {
    position: absolute;
    inset: auto 18px 18px 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(17, 17, 27, 0.82);
    border: 1px solid rgba(250, 204, 21, 0.24);
    color: #f9e2af;
  }

  .qr-expired strong {
    font-size: 12px;
    font-weight: 700;
  }

  .qr-expired span {
    font-size: 11px;
    line-height: 1.4;
  }

  .pairing-details {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .status-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(137, 180, 250, 0.16);
    color: #b4d7ff;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .status-pill.expired-pill {
    background: rgba(249, 226, 175, 0.14);
    color: #f9e2af;
  }

  .expires-at,
  .detail-copy,
  .manual-fallback p {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: #8f94b2;
  }

  .action-row,
  .copy-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .manual-fallback {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 2px;
    padding: 14px;
    border-radius: 14px;
    background: rgba(17, 17, 27, 0.44);
    border: 1px solid rgba(108, 112, 134, 0.34);
  }

  .manual-fallback label {
    font-size: 12px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .manual-fallback input {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    background: rgba(10, 10, 18, 0.9);
    color: #d9def5;
    font-size: 12px;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  }

  .close-btn,
  .primary-btn,
  .secondary-btn {
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 10px;
    padding: 9px 13px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }

  .close-btn,
  .secondary-btn {
    background: rgba(24, 24, 37, 0.84);
    color: var(--terminal-fg, #c0caf5);
  }

  .primary-btn {
    background: linear-gradient(180deg, #94e2d5, #74c7ec);
    border-color: rgba(116, 199, 236, 0.58);
    color: #10202a;
  }

  .compact-btn {
    padding-inline: 12px;
    white-space: nowrap;
  }

  .close-btn:hover,
  .secondary-btn:hover,
  .primary-btn:hover {
    transform: translateY(-1px);
  }

  .close-btn:disabled,
  .secondary-btn:disabled,
  .primary-btn:disabled {
    opacity: 0.6;
    cursor: default;
    transform: none;
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .pairing-overlay {
    background: rgba(0, 0, 0, 0.84);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :global([data-theme="tron-encom-os"]) .pairing-modal,
  :global([data-theme="tron-encom-os"]) .qr-shell,
  :global([data-theme="tron-encom-os"]) .manual-fallback {
    border-radius: 0;
    border-color: var(--led-line-soft, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .pairing-modal {
    border-color: var(--led-line, rgba(255, 255, 255, 0.5));
    background: var(--bg-panel, #06090d);
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      var(--glow-soft, 0 0 16px rgba(255, 255, 255, 0.07));
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :global([data-theme="tron-encom-os"]) .pairing-header h2,
  :global([data-theme="tron-encom-os"]) .manual-fallback label,
  :global([data-theme="tron-encom-os"]) .qr-expired strong {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .pairing-header p,
  :global([data-theme="tron-encom-os"]) .expires-at,
  :global([data-theme="tron-encom-os"]) .detail-copy,
  :global([data-theme="tron-encom-os"]) .manual-fallback p,
  :global([data-theme="tron-encom-os"]) .qr-expired span {
    color: var(--fg-secondary, #a4afbb);
  }

  :global([data-theme="tron-encom-os"]) .qr-shell,
  :global([data-theme="tron-encom-os"]) .manual-fallback {
    background: var(--bg-elevated, #090d12);
  }

  :global([data-theme="tron-encom-os"]) .qr-art :global(svg) {
    border-radius: 0;
    background: #ffffff;
  }

  :global([data-theme="tron-encom-os"]) .qr-placeholder,
  :global([data-theme="tron-encom-os"]) .qr-expired {
    border-radius: 0;
    background: color-mix(in srgb, var(--bg-base, #000) 92%, transparent);
    border-color: var(--led-line-soft, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .status-pill {
    border-radius: 0;
    border: 1px solid var(--led-line, rgba(255, 255, 255, 0.5));
    background: var(--bg-base, #000);
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  :global([data-theme="tron-encom-os"]) .status-pill.expired-pill {
    border-color: var(--c-amber, #f5b83d);
    color: var(--c-amber, #f5b83d);
  }

  :global([data-theme="tron-encom-os"]) .manual-fallback input,
  :global([data-theme="tron-encom-os"]) .close-btn,
  :global([data-theme="tron-encom-os"]) .primary-btn,
  :global([data-theme="tron-encom-os"]) .secondary-btn {
    border-radius: 0;
    border-color: var(--led-line, rgba(255, 255, 255, 0.5));
    background: var(--bg-base, #000);
    color: var(--fg-primary, #f5f7fa);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .close-btn,
  :global([data-theme="tron-encom-os"]) .primary-btn,
  :global([data-theme="tron-encom-os"]) .secondary-btn {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  :global([data-theme="tron-encom-os"]) .primary-btn {
    box-shadow: var(--glow-soft, 0 0 16px rgba(255, 255, 255, 0.07));
  }

  :global([data-theme="tron-encom-os"]) .close-btn:hover,
  :global([data-theme="tron-encom-os"]) .secondary-btn:hover,
  :global([data-theme="tron-encom-os"]) .primary-btn:hover {
    box-shadow: var(--glow, 0 0 18px rgba(255, 255, 255, 0.12));
  }

  @media (max-width: 720px) {
    .pairing-overlay {
      padding: 12px;
      align-items: flex-end;
    }

    .pairing-body {
      grid-template-columns: 1fr;
    }

    .copy-row {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
