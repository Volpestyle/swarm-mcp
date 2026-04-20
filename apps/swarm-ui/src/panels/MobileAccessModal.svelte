<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import {
    cancelPairingSession,
    createPairingSession,
    fetchDevices,
    revokeDevice,
  } from '../lib/mobileAccess';
  import { formatTimestamp, timestampToMillis } from '../lib/time';
  import type { DeviceInfo, PairingSessionInfo } from '../lib/types';
  import PairingSessionModal from './PairingSessionModal.svelte';

  const REFRESH_INTERVAL_MS = 15_000;

  const dispatch = createEventDispatcher<{ close: void }>();

  let closeButton: HTMLButtonElement | null = null;
  let devices: DeviceInfo[] = [];
  let devicesLoading = true;
  let devicesError: string | null = null;
  let pairingError: string | null = null;
  let pairingBusy = false;
  let pairingSession: PairingSessionInfo | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let nowMs = Date.now();
  let revokingIds = new Set<string>();

  $: activeDevices = devices.filter((device) => device.revoked_at === null);
  $: revokedDevices = devices.filter((device) => device.revoked_at !== null);

  onMount(() => {
    void tick().then(() => closeButton?.focus());
    void refreshDevices();

    refreshTimer = setInterval(() => {
      nowMs = Date.now();
      void refreshDevices(false);
    }, REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    destroyed = true;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    void releasePairingSession();
  });

  async function refreshDevices(showSpinner = true): Promise<void> {
    if (showSpinner) {
      devicesLoading = true;
    }
    devicesError = null;

    try {
      const nextDevices = await fetchDevices();
      if (destroyed) return;
      devices = nextDevices;
      nowMs = Date.now();
    } catch (err) {
      if (destroyed) return;
      devicesError = formatError(err, 'Failed to load paired devices');
    } finally {
      if (!destroyed) {
        devicesLoading = false;
      }
    }
  }

  async function openPairingSession(): Promise<void> {
    pairingBusy = true;
    pairingError = null;

    try {
      pairingSession = await createPairingSession();
    } catch (err) {
      pairingError = formatError(err, 'Failed to create pairing code');
    } finally {
      pairingBusy = false;
    }
  }

  async function refreshPairingSession(): Promise<void> {
    await openPairingSession();
  }

  async function releasePairingSession(): Promise<void> {
    const session = pairingSession;
    pairingSession = null;
    if (!session) return;

    try {
      await cancelPairingSession(session.session_id);
    } catch (err) {
      console.warn('[mobile-access] failed to cancel pairing session:', err);
    }
  }

  function setRevoking(deviceId: string, busy: boolean): void {
    const next = new Set(revokingIds);
    if (busy) {
      next.add(deviceId);
    } else {
      next.delete(deviceId);
    }
    revokingIds = next;
  }

  async function handleRevoke(deviceId: string): Promise<void> {
    setRevoking(deviceId, true);
    devicesError = null;

    try {
      await revokeDevice(deviceId);
      await refreshDevices(false);
    } catch (err) {
      devicesError = formatError(err, 'Failed to revoke device');
    } finally {
      setRevoking(deviceId, false);
    }
  }

  function closeModal(): void {
    void releasePairingSession();
    dispatch('close');
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();

    if (pairingSession) {
      void releasePairingSession();
      return;
    }

    closeModal();
  }

  function formatError(error: unknown, fallback: string): string {
    if (typeof error === 'string' && error.trim()) return error;
    if (error && typeof error === 'object' && 'toString' in error) {
      const message = error.toString().trim();
      if (message && message !== '[object Object]') return message;
    }
    return fallback;
  }

  function formatPlatform(platform: string | null): string {
    if (!platform) return 'mobile';
    if (platform === 'ios') return 'iPhone / iPad';
    return platform.replace(/[_-]+/g, ' ');
  }

  function formatRelativeTime(value: number | null): string {
    const millis = timestampToMillis(value);
    if (millis === null) return 'Never seen';

    const deltaMs = nowMs - millis;
    if (deltaMs < 45_000) return 'Just now';

    const minutes = Math.round(deltaMs / 60_000);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }

    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }
</script>

<svelte:window on:keydown|capture={handleWindowKeydown} />

<div class="mobile-overlay">
  <div
    class="mobile-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mobile-access-title"
    aria-describedby="mobile-access-copy"
  >
    <div class="mobile-header">
      <div>
        <h2 id="mobile-access-title">Mobile Access</h2>
        <p id="mobile-access-copy">
          Pair nearby iPhone and iPad clients, review the devices that already have access,
          and revoke any token from the desktop.
        </p>
      </div>

      <button bind:this={closeButton} type="button" class="close-btn" on:click={closeModal}>
        Close
      </button>
    </div>

    <div class="mobile-body">
      <section class="hero-card">
        <div class="hero-copy">
          <span class="eyebrow">Local only</span>
          <h3>Pair on demand</h3>
          <p>
            Generate a fresh QR code only when you’re ready to pair, then let it expire or cancel
            it when you’re done.
          </p>
        </div>

        <button type="button" class="primary-btn hero-btn" on:click={openPairingSession} disabled={pairingBusy}>
          {pairingBusy ? 'Generating…' : 'Pair iPhone / iPad'}
        </button>
      </section>

      {#if pairingError}
        <p class="banner error-banner">{pairingError}</p>
      {/if}

      {#if devicesError}
        <p class="banner error-banner">{devicesError}</p>
      {/if}

      <section class="device-section">
        <div class="section-header">
          <div>
            <h3>Paired devices</h3>
            <p>Live inventory from the daemon.</p>
          </div>
          <button type="button" class="secondary-btn" on:click={() => void refreshDevices()} disabled={devicesLoading}>
            {devicesLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {#if devicesLoading && devices.length === 0}
          <div class="empty-state">
            <strong>Loading device inventory…</strong>
            <span>The desktop daemon is reading its local auth state.</span>
          </div>
        {:else if activeDevices.length === 0}
          <div class="empty-state">
            <strong>No active mobile devices yet</strong>
            <span>Start a pairing session to grant access to an iPhone or iPad.</span>
          </div>
        {:else}
          <div class="device-list">
            {#each activeDevices as device (device.device_id)}
              <article class="device-card">
                <div class="device-copy">
                  <div class="device-title-row">
                    <h4>{device.device_name}</h4>
                    <span class="platform-pill">{formatPlatform(device.platform)}</span>
                  </div>

                  <div class="meta-grid">
                    <div>
                      <span class="meta-label">Last seen</span>
                      <strong>{formatRelativeTime(device.last_seen_at)}</strong>
                      <span>{formatTimestamp(device.last_seen_at)}</span>
                    </div>
                    <div>
                      <span class="meta-label">Paired</span>
                      <strong>{formatTimestamp(device.created_at)}</strong>
                      <span>{device.device_id}</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  class="danger-btn"
                  on:click={() => void handleRevoke(device.device_id)}
                  disabled={revokingIds.has(device.device_id)}
                >
                  {revokingIds.has(device.device_id) ? 'Revoking…' : 'Revoke'}
                </button>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      {#if revokedDevices.length > 0}
        <section class="device-section secondary-section">
          <div class="section-header">
            <div>
              <h3>Recently revoked</h3>
              <p>Historical device rows remain visible for audit context.</p>
            </div>
          </div>

          <div class="device-list compact-list">
            {#each revokedDevices as device (device.device_id)}
              <article class="device-card compact-card revoked-card">
                <div class="device-copy">
                  <div class="device-title-row">
                    <h4>{device.device_name}</h4>
                    <span class="platform-pill muted-pill">Revoked</span>
                  </div>
                  <div class="meta-grid">
                    <div>
                      <span class="meta-label">Last seen</span>
                      <strong>{formatRelativeTime(device.last_seen_at)}</strong>
                      <span>{formatTimestamp(device.last_seen_at)}</span>
                    </div>
                    <div>
                      <span class="meta-label">Revoked</span>
                      <strong>{formatTimestamp(device.revoked_at)}</strong>
                      <span>{device.device_id}</span>
                    </div>
                  </div>
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  </div>

  {#if pairingSession}
    <PairingSessionModal
      session={pairingSession}
      refreshing={pairingBusy}
      on:close={() => void releasePairingSession()}
      on:refresh={() => void refreshPairingSession()}
    />
  {/if}
</div>

<style>
  .mobile-overlay {
    position: fixed;
    inset: 0;
    z-index: 110;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(6, 7, 12, 0.46);
    backdrop-filter: blur(18px) saturate(1.08);
    -webkit-backdrop-filter: blur(18px) saturate(1.08);
  }

  .mobile-modal {
    width: min(860px, 100%);
    max-height: min(86vh, 920px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
    border-radius: 18px;
    background: var(--panel-bg, rgba(30, 30, 46, 0.76));
    box-shadow: 0 28px 72px rgba(0, 0, 0, 0.38);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    overflow: hidden;
  }

  .mobile-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    padding: 20px 22px;
    border-bottom: 1px solid var(--node-border, rgba(108, 112, 134, 0.44));
  }

  .mobile-header h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .mobile-header p {
    margin: 6px 0 0;
    max-width: 620px;
    font-size: 12px;
    line-height: 1.6;
    color: #8f94b2;
  }

  .mobile-body {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 22px;
    overflow: auto;
  }

  .hero-card,
  .device-section,
  .empty-state,
  .banner {
    border: 1px solid rgba(108, 112, 134, 0.32);
    border-radius: 16px;
  }

  .hero-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 18px 20px;
    background:
      radial-gradient(circle at top left, rgba(148, 226, 213, 0.2), transparent 44%),
      linear-gradient(135deg, rgba(18, 20, 34, 0.94), rgba(16, 19, 30, 0.92));
  }

  .hero-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #94e2d5;
  }

  .hero-copy h3,
  .section-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .hero-copy p,
  .section-header p,
  .empty-state span {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: #8f94b2;
  }

  .hero-btn {
    min-width: 180px;
  }

  .banner {
    padding: 12px 14px;
    background: rgba(243, 139, 168, 0.08);
    color: #f5c2e7;
    font-size: 12px;
    line-height: 1.5;
  }

  .device-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    background: rgba(17, 17, 27, 0.34);
  }

  .secondary-section {
    background: rgba(17, 17, 27, 0.24);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .device-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .device-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    border-radius: 14px;
    background: rgba(20, 20, 32, 0.84);
    border: 1px solid rgba(108, 112, 134, 0.28);
  }

  .compact-list .device-card {
    padding-block: 14px;
  }

  .revoked-card {
    opacity: 0.8;
  }

  .device-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .device-title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .device-title-row h4,
  .empty-state strong {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
    color: var(--terminal-fg, #c0caf5);
  }

  .platform-pill {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(137, 180, 250, 0.14);
    color: #b4d7ff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: capitalize;
  }

  .muted-pill {
    background: rgba(108, 112, 134, 0.2);
    color: #c3c8df;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .meta-grid div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .meta-grid strong {
    font-size: 12px;
    font-weight: 650;
    color: #dfe4ff;
  }

  .meta-grid span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: #8f94b2;
  }

  .meta-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6c7086;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 18px;
    background: rgba(20, 20, 32, 0.62);
  }

  .close-btn,
  .primary-btn,
  .secondary-btn,
  .danger-btn {
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

  .danger-btn {
    background: rgba(243, 139, 168, 0.14);
    border-color: rgba(243, 139, 168, 0.28);
    color: #f5c2e7;
  }

  .close-btn:hover,
  .primary-btn:hover,
  .secondary-btn:hover,
  .danger-btn:hover {
    transform: translateY(-1px);
  }

  .close-btn:disabled,
  .primary-btn:disabled,
  .secondary-btn:disabled,
  .danger-btn:disabled {
    opacity: 0.62;
    cursor: default;
    transform: none;
  }

  @media (max-width: 760px) {
    .mobile-overlay {
      padding: 12px;
      align-items: flex-end;
    }

    .mobile-modal {
      width: 100%;
      max-height: 92vh;
    }

    .hero-card,
    .device-card,
    .section-header,
    .mobile-header {
      flex-direction: column;
      align-items: stretch;
    }

    .hero-btn,
    .danger-btn {
      width: 100%;
    }

    .meta-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
