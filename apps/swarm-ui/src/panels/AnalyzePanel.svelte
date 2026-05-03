<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';

  import {
    buildAnalyzeOverlayModel,
    buildAnalyzeSummaryCards,
    countKillableMachineTargets,
    formatConfidenceLabel,
    formatMemoryValue,
    formatPercent,
    formatRuntimeValue,
    formatTokenValue,
    formatUsdValue,
  } from '../lib/analyze';
  import { confirm } from '../lib/confirm';
  import type {
    AgentSessionRow,
    HelperProcessRow,
    SystemLoadSnapshot,
  } from '../lib/types';
  import {
    killAllAgentSessions,
    killSessionTree,
    refreshPtyCatalog,
    scanSystemLoad,
  } from '../stores/pty';
  import { activeScope } from '../stores/swarm';

  export let open = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  const REFRESH_INTERVAL_MS = 10_000;
  const MAX_HISTORY = 18;
  const CPU_GAUGE_RADIUS = 58;
  const CPU_GAUGE_CIRCUMFERENCE = 2 * Math.PI * CPU_GAUGE_RADIUS;

  let snapshot: SystemLoadSnapshot | null = null;
  let history: SystemLoadSnapshot[] = [];
  let loading = false;
  let refreshing = false;
  let killingAll = false;
  let error: string | null = null;
  let busyRowKey: string | null = null;
  let refreshTimer: number | null = null;
  let wasOpen = false;

  $: summaryCards = snapshot ? buildAnalyzeSummaryCards(snapshot) : [];
  $: overlayModel = snapshot ? buildAnalyzeOverlayModel(snapshot, history) : null;
  $: burdenTrendValue =
    overlayModel?.burdenTrend[overlayModel.burdenTrend.length - 1]?.value ?? 0;
  $: killableMachineTargets = countKillableMachineTargets(snapshot);
  $: killAllLabel = snapshot && snapshot.total_agent_sessions === 0 && killableMachineTargets > 0
    ? 'Kill Detached Helpers'
    : 'Kill All Agent Sessions';
  $: sessionLabelByKey = new Map(
    snapshot?.agent_sessions.map((row) => [row.session_key, row.session_label]) ?? [],
  );

  $: if (open !== wasOpen) {
    wasOpen = open;
    if (open) {
      void refresh();
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  }

  function startAutoRefresh(): void {
    stopAutoRefresh();
    refreshTimer = window.setInterval(() => {
      void refresh(true);
    }, REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh(): void {
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function rememberSnapshot(next: SystemLoadSnapshot): void {
    history = [...history, next]
      .sort((a, b) => a.scanned_at_ms - b.scanned_at_ms)
      .filter((entry, index, all) =>
        index === 0 || entry.scanned_at_ms !== all[index - 1]?.scanned_at_ms,
      )
      .slice(-MAX_HISTORY);
  }

  async function refresh(background = false): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    if (!background) loading = snapshot === null;
    error = null;

    try {
      await refreshPtyCatalog();
      const next = await scanSystemLoad(null);
      snapshot = next;
      rememberSnapshot(next);
    } catch (err) {
      console.error('[AnalyzePanel] system scan failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function handleKillAll(): Promise<void> {
    if (killingAll) return;
    const sessions = snapshot?.total_agent_sessions ?? 0;
    const targets = killableMachineTargets;
    const detachedHelpers = snapshot?.helper_processes.filter(
      (row) => row.killable && row.parent_session_key === null && row.killTarget !== null,
    ).length ?? 0;
    if (targets === 0) return;

    const message = sessions > 0
      ? `Kill ${sessions} machine-wide agent session${sessions === 1 ? '' : 's'} and ${detachedHelpers} detached helper${detachedHelpers === 1 ? '' : 's'}? Protected app/server processes stay alive.`
      : `Kill ${detachedHelpers} detached MCP helper${detachedHelpers === 1 ? '' : 's'} still running on this machine? Protected app/server processes stay alive.`;
    const ok = await confirm({
      title: sessions > 0 ? 'Kill all agent sessions' : 'Kill detached helpers',
      message,
      confirmLabel: 'Kill all',
      danger: true,
    });
    if (!ok) return;

    killingAll = true;
    try {
      await killAllAgentSessions(null);
      await refresh(true);
    } catch (err) {
      console.error('[AnalyzePanel] kill all failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      killingAll = false;
    }
  }

  async function handleKillSession(row: AgentSessionRow): Promise<void> {
    if (!row.killable || busyRowKey) return;
    const ok = await confirm({
      title: 'Kill session tree',
      message: `Kill ${row.session_label}? This stops the full session tree and any attached helpers.`,
      confirmLabel: 'Kill session',
      danger: true,
    });
    if (!ok) return;

    busyRowKey = row.session_key;
    try {
      await killSessionTree(row.killTarget);
      await refresh(true);
    } catch (err) {
      console.error('[AnalyzePanel] session kill failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busyRowKey = null;
    }
  }

  async function handleKillHelper(row: HelperProcessRow): Promise<void> {
    if (!row.killable || !row.killTarget || busyRowKey) return;
    const ok = await confirm({
      title: 'Kill detached helper',
      message: `Kill ${row.label}? This targets the detached helper process set in this row.`,
      confirmLabel: 'Kill helper',
      danger: true,
    });
    if (!ok) return;

    busyRowKey = row.helper_key;
    try {
      await killSessionTree(row.killTarget);
      await refresh(true);
    } catch (err) {
      console.error('[AnalyzePanel] helper kill failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busyRowKey = null;
    }
  }

  function closeOverlay(): void {
    dispatch('close');
  }

  function parentLabel(row: HelperProcessRow): string | null {
    if (!row.parent_session_key) return null;
    return sessionLabelByKey.get(row.parent_session_key) ?? row.parent_session_key;
  }

  function polylinePoints(
    points: { x: number; y: number }[],
    width = 100,
    height = 42,
  ): string {
    return points
      .map((point) => `${(point.x / 100) * width},${(point.y / 100) * height}`)
      .join(' ');
  }

  function cpuGaugeDashOffset(percent: number): number {
    return CPU_GAUGE_CIRCUMFERENCE * (1 - percent / 100);
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.defaultPrevented) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeOverlay();
  }

  onDestroy(() => {
    stopAutoRefresh();
  });
</script>

<svelte:window on:keydown={handleWindowKeydown} />

{#if open}
  <div class="analyze-overlay">
    <button
      type="button"
      class="analyze-backdrop"
      aria-label="Close analysis overlay"
      on:click={closeOverlay}
    ></button>

    <dialog
      open
      class="analyze-modal"
      aria-labelledby="analyze-title"
    >
      <header class="analyze-shell-header">
        <div class="shell-copy">
          <div class="shell-kicker">Machine-wide command deck</div>
          <h2 id="analyze-title">System Load and Rogue Session Trees</h2>
          <p>
            Live machine truth for agent trees, detached helpers, competing host pressure,
            and real kill paths.
          </p>
        </div>

        <div class="shell-actions">
          <div class="scope-chip">
            <span>Channel</span>
            <code>{$activeScope ?? 'all channels'}</code>
          </div>
          <div class="scope-chip">
            <span>Refresh</span>
            <code>{refreshing ? 'scanning…' : '10s auto'}</code>
          </div>
          <button
            type="button"
            class="shell-btn"
            on:click={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            class="shell-btn shell-btn--danger"
            on:click={() => void handleKillAll()}
            disabled={killingAll || !snapshot || killableMachineTargets === 0}
          >
            {killingAll ? 'Killing…' : killAllLabel}
          </button>
          <button
            type="button"
            class="shell-btn shell-btn--close"
            on:click={closeOverlay}
            aria-label="Close analysis overlay"
            title="Close analysis overlay"
          >
            ×
          </button>
        </div>
      </header>

      {#if error}
        <div class="analyze-error" role="alert">{error}</div>
      {/if}

      {#if loading && !snapshot}
        <div class="analyze-empty">
          Scanning live processes, swarm rows, helper MCPs, and local usage artifacts…
        </div>
      {:else if snapshot && overlayModel}
        <div class="analyze-scroll">
          <section class="hero-grid">
            <article class="hero-panel hero-panel--gauge">
              <div class="hero-panel-header">
                <span class="panel-kicker">Host pressure</span>
                <span class="panel-meta">Top CPU / Memory</span>
              </div>

              <div class="cpu-gauge-shell">
                <svg viewBox="0 0 160 160" class="cpu-gauge" aria-hidden="true">
                  <circle cx="80" cy="80" r={CPU_GAUGE_RADIUS} class="cpu-gauge-track"></circle>
                  <circle
                    cx="80"
                    cy="80"
                    r={CPU_GAUGE_RADIUS}
                    class="cpu-gauge-progress"
                    style={`stroke-dasharray:${CPU_GAUGE_CIRCUMFERENCE};stroke-dashoffset:${cpuGaugeDashOffset(overlayModel.hostCpuPercent)};`}
                  ></circle>
                </svg>
                <div class="cpu-gauge-copy">
                  <span class="cpu-gauge-kicker">Top CPU</span>
                  <strong>{formatPercent(snapshot.top_cpu_percent)}</strong>
                  <span>{snapshot.top_cpu_label ?? 'No offender'}</span>
                </div>
              </div>

              <div class="hero-stats">
                <div>
                  <span>Top Memory</span>
                  <strong>{formatMemoryValue(snapshot.top_memory_rss_kb)}</strong>
                </div>
                <div>
                  <span>GPU</span>
                  <strong>{snapshot.gpu_note}</strong>
                </div>
              </div>
            </article>

            <article class="hero-panel hero-panel--pressure">
              <div class="hero-panel-header">
                <span class="panel-kicker">Rogue session pressure</span>
                <span class="panel-meta">
                  {snapshot.total_agent_sessions + snapshot.detached_helper_count + snapshot.external_burden.length} tracked loads
                </span>
              </div>

              <div class="segment-list">
                {#each overlayModel.burdenSegments as segment (segment.label)}
                  <div class="segment-row">
                    <div class="segment-copy">
                      <span>{segment.label}</span>
                      <strong>{segment.value}</strong>
                    </div>
                    <div class="segment-bar">
                      <span style={`width:${segment.percent}%`}></span>
                    </div>
                    <div class="segment-meta">{formatPercent(segment.percent)}</div>
                  </div>
                {/each}
              </div>

              <div class="hero-sparkline-shell">
                <div class="sparkline-header">
                  <span>Pressure Trend</span>
                  <strong>{burdenTrendValue} live burdens</strong>
                </div>
                <svg viewBox="0 0 100 42" class="sparkline" aria-hidden="true">
                  <polyline
                    points={polylinePoints(overlayModel.burdenTrend)}
                    class="sparkline-line sparkline-line--pressure"
                  ></polyline>
                </svg>
              </div>
            </article>

            <article class="hero-panel hero-panel--triage">
              <div class="hero-panel-header">
                <span class="panel-kicker">Live triage</span>
                <span class="panel-meta">
                  {snapshot.price_catalog_as_of ? `Pricing as of ${snapshot.price_catalog_as_of}` : 'Pricing N/A'}
                </span>
              </div>

              <div class="triage-stack">
                <div class="triage-item">
                  <span>Estimated live cost</span>
                  <strong>{formatUsdValue(snapshot.estimated_live_cost_usd)}</strong>
                </div>
                <div class="triage-item">
                  <span>Hidden / orphan</span>
                  <strong>{snapshot.hidden_orphan_sessions}</strong>
                </div>
                <div class="triage-item">
                  <span>Top memory offender</span>
                  <strong>{snapshot.top_memory_label ?? 'N/A'}</strong>
                </div>
              </div>

              <div class="hero-sparkline-shell">
                <div class="sparkline-header">
                  <span>CPU Trend</span>
                  <strong>{formatPercent(snapshot.top_cpu_percent)}</strong>
                </div>
                <svg viewBox="0 0 100 42" class="sparkline" aria-hidden="true">
                  <polyline
                    points={polylinePoints(overlayModel.cpuTrend)}
                    class="sparkline-line sparkline-line--cpu"
                  ></polyline>
                </svg>
              </div>
            </article>
          </section>

          <section class="summary-strip">
            {#each summaryCards as card (card.label)}
              <article class="metric-module">
                <span class="metric-label">{card.label}</span>
                <strong class="metric-value">{card.value}</strong>
                {#if card.detail}
                  <span class="metric-detail">{card.detail}</span>
                {/if}
              </article>
            {/each}
          </section>

          <section class="ledger-section">
            <div class="ledger-header">
              <h3>Agent Session Trees</h3>
              <span>{snapshot.agent_sessions.length} live rows</span>
            </div>

            {#if snapshot.agent_sessions.length === 0}
              <div class="section-empty">No live agent session trees found in the current machine scan.</div>
            {:else}
              <div class="row-list">
                {#each snapshot.agent_sessions as row (row.session_key)}
                  <article class="scan-row">
                    <div class="scan-row-main">
                      <div class="scan-row-title">
                        <strong>{row.session_label}</strong>
                        <span class="kind-pill">{row.session_kind}</span>
                        <span class="kind-pill">{row.status}</span>
                        <span class="kind-pill">{row.activity}</span>
                      </div>

                      <div class="scan-row-meta">
                        <span>{row.provider ?? 'unknown'} / {row.harness ?? 'unknown'}</span>
                        <span>{row.model ?? 'model N/A'}</span>
                        <span>{row.scope ?? 'channel N/A'}</span>
                        <span>{row.tty ?? row.pty_id ?? 'tty / pty N/A'}</span>
                      </div>

                      <div class="scan-row-stats">
                        <span>CPU {formatPercent(row.cpu_percent)}</span>
                        <span>Memory {formatMemoryValue(row.rss_kb)}</span>
                        <span>Runtime {formatRuntimeValue(row.elapsed_seconds)}</span>
                        <span>Helpers {row.helper_count}</span>
                        <span>Tokens {formatTokenValue(row.tokensExact)}</span>
                        <span>Cost {formatUsdValue(row.costEstimatedUsd)}</span>
                      </div>

                      <div class="scan-row-stats scan-row-stats--secondary">
                        <span>Usage {formatConfidenceLabel(row.usageConfidence)}</span>
                        <span>Cost {formatConfidenceLabel(row.costConfidence)}</span>
                        {#if row.root_pid !== null}
                          <span>root {row.root_pid}</span>
                        {/if}
                        {#if row.process_group_id !== null}
                          <span>pgid {row.process_group_id}</span>
                        {/if}
                        {#if row.child_pids.length > 0}
                          <span>children {row.child_pids.join(', ')}</span>
                        {/if}
                        <span>{row.cwd ?? 'cwd N/A'}</span>
                      </div>
                    </div>

                    <div class="scan-row-actions">
                      {#if row.killable}
                        <button
                          type="button"
                          class="row-btn row-btn--danger"
                          disabled={busyRowKey === row.session_key}
                          on:click={() => void handleKillSession(row)}
                        >
                          {busyRowKey === row.session_key ? 'Killing…' : 'Kill Tree'}
                        </button>
                      {:else}
                        <span class="row-note">{row.killProtectionReason ?? 'Protected'}</span>
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>

          <section class="ledger-section">
            <div class="ledger-header">
              <h3>Detached / Helper MCPs</h3>
              <span>{snapshot.helper_processes.length} tracked rows</span>
            </div>

            {#if snapshot.helper_processes.length === 0}
              <div class="section-empty">No detached or attached helper MCP processes found.</div>
            {:else}
              <div class="row-list">
                {#each snapshot.helper_processes as row (row.helper_key)}
                  <article class="scan-row scan-row--helper">
                    <div class="scan-row-main">
                      <div class="scan-row-title">
                        <strong>{row.label}</strong>
                        <span class="kind-pill">{row.helper_kind}</span>
                        {#if parentLabel(row)}
                          <span class="kind-pill">attached to {parentLabel(row)}</span>
                        {:else}
                          <span class="kind-pill">detached</span>
                        {/if}
                      </div>

                      <div class="scan-row-meta">
                        <span>{row.command}</span>
                      </div>

                      <div class="scan-row-stats">
                        <span>CPU {formatPercent(row.cpu_percent)}</span>
                        <span>Memory {formatMemoryValue(row.rss_kb)}</span>
                        <span>Runtime {formatRuntimeValue(row.elapsed_seconds)}</span>
                        <span>PIDs {row.pids.join(', ')}</span>
                      </div>
                    </div>

                    <div class="scan-row-actions">
                      {#if row.killable && row.killTarget}
                        <button
                          type="button"
                          class="row-btn row-btn--danger"
                          disabled={busyRowKey === row.helper_key}
                          on:click={() => void handleKillHelper(row)}
                        >
                          {busyRowKey === row.helper_key ? 'Killing…' : 'Kill Helper'}
                        </button>
                      {:else if row.killProtectionReason}
                        <span class="row-note">{row.killProtectionReason}</span>
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>

          <section class="ledger-section">
            <div class="ledger-header">
              <h3>External Burden</h3>
              <span>Read-only competing load</span>
            </div>

            {#if snapshot.external_burden.length === 0}
              <div class="section-empty">
                No material external pressure detected above the current CPU / memory thresholds.
              </div>
            {:else}
              <div class="row-list">
                {#each snapshot.external_burden as row (row.external_key)}
                  <article class="scan-row scan-row--external">
                    <div class="scan-row-main">
                      <div class="scan-row-title">
                        <strong>{row.label}</strong>
                        <span class="kind-pill">external</span>
                      </div>

                      <div class="scan-row-meta">
                        <span>{row.command}</span>
                      </div>

                      <div class="scan-row-stats">
                        <span>CPU {formatPercent(row.cpu_percent)}</span>
                        <span>Memory {formatMemoryValue(row.rss_kb)}</span>
                        <span>Runtime {formatRuntimeValue(row.elapsed_seconds)}</span>
                        <span>{row.note}</span>
                      </div>
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>

          <footer class="overlay-footer">
            <span>
              Last scan:
              <strong>{new Date(snapshot.scanned_at_ms).toLocaleTimeString()}</strong>
            </span>
            <span>
              Confidence:
              <strong>Exact / Estimated / Unlinked / N/A</strong>
            </span>
            <span>
              Pricing:
              <strong>{snapshot.price_catalog_as_of ?? 'N/A'}</strong>
            </span>
          </footer>
        </div>
      {/if}
    </dialog>
  </div>
{/if}

<style>
  .analyze-overlay {
    position: absolute;
    inset: 0;
    z-index: 45;
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  .analyze-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background:
      radial-gradient(circle at center, rgba(3, 8, 18, 0.18), rgba(0, 0, 0, 0.72)),
      rgba(1, 3, 8, 0.58);
    cursor: pointer;
    pointer-events: auto;
  }

  .analyze-modal {
    position: relative;
    width: min(1480px, calc(100vw - 144px));
    height: min(880px, calc(100vh - 96px));
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 28px 28px 22px;
    box-sizing: border-box;
    border: 1px solid rgba(185, 212, 255, 0.18);
    background:
      linear-gradient(180deg, rgba(171, 211, 255, 0.06), transparent 16%),
      linear-gradient(135deg, rgba(6, 12, 23, 0.96), rgba(3, 7, 14, 0.98));
    box-shadow:
      0 36px 120px rgba(0, 0, 0, 0.56),
      inset 0 0 0 1px rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(22px) saturate(1.04);
    -webkit-backdrop-filter: blur(22px) saturate(1.04);
    pointer-events: auto;
    overflow: hidden;
  }

  .analyze-modal::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(120, 170, 255, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(120, 170, 255, 0.05) 1px, transparent 1px);
    background-size: 36px 36px;
    opacity: 0.18;
    pointer-events: none;
  }

  .analyze-shell-header,
  .hero-grid,
  .summary-strip,
  .ledger-section,
  .overlay-footer {
    position: relative;
    z-index: 1;
  }

  .analyze-shell-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(185, 212, 255, 0.12);
  }

  .shell-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .shell-kicker,
  .panel-kicker,
  .metric-label,
  .ledger-header span,
  .overlay-footer span,
  .scope-chip span {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgba(169, 197, 241, 0.78);
  }

  .shell-copy h2 {
    margin: 0;
    font-size: 34px;
    line-height: 1;
    font-weight: 600;
    color: #f6fbff;
    max-width: 18ch;
  }

  .shell-copy p {
    margin: 0;
    max-width: 56ch;
    font-size: 13px;
    line-height: 1.55;
    color: rgba(204, 221, 248, 0.84);
  }

  .shell-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }

  .scope-chip {
    min-height: 44px;
    min-width: 122px;
    padding: 8px 10px;
    box-sizing: border-box;
    border: 1px solid rgba(160, 196, 244, 0.14);
    background: rgba(9, 16, 31, 0.8);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
  }

  .scope-chip code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #e5f2ff;
  }

  .shell-btn,
  .row-btn {
    appearance: none;
    border: 1px solid rgba(160, 196, 244, 0.18);
    background: rgba(9, 16, 31, 0.84);
    color: #edf7ff;
    min-height: 44px;
    padding: 0 14px;
    font-size: 12px;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      background 140ms ease,
      color 140ms ease,
      box-shadow 140ms ease,
      transform 140ms ease;
  }

  .shell-btn:hover,
  .row-btn:hover {
    transform: translateY(-1px);
    border-color: rgba(190, 221, 255, 0.34);
    box-shadow: 0 0 16px rgba(108, 182, 255, 0.12);
  }

  .shell-btn:disabled,
  .row-btn:disabled {
    opacity: 0.56;
    cursor: default;
    transform: none;
    box-shadow: none;
  }

  .shell-btn--danger,
  .row-btn--danger {
    border-color: rgba(255, 110, 140, 0.52);
    background:
      linear-gradient(180deg, rgba(255, 130, 155, 0.14), rgba(70, 10, 23, 0.96)),
      rgba(42, 12, 18, 0.94);
    color: #ffe3e9;
    box-shadow:
      inset 0 0 0 1px rgba(255, 168, 186, 0.08),
      0 0 26px rgba(255, 74, 120, 0.12);
  }

  .shell-btn--danger:not(:disabled):hover,
  .row-btn--danger:not(:disabled):hover {
    border-color: rgba(255, 136, 162, 0.74);
    background:
      linear-gradient(180deg, rgba(255, 154, 176, 0.2), rgba(88, 9, 26, 0.98)),
      rgba(58, 11, 23, 0.96);
    box-shadow:
      inset 0 0 0 1px rgba(255, 179, 196, 0.12),
      0 0 34px rgba(255, 78, 126, 0.22);
  }

  .shell-btn--close {
    width: 44px;
    min-width: 44px;
    padding: 0;
    font-size: 22px;
    line-height: 1;
  }

  .analyze-error,
  .analyze-empty,
  .section-empty {
    position: relative;
    z-index: 1;
    border: 1px solid rgba(160, 196, 244, 0.14);
    background: rgba(8, 13, 24, 0.84);
    padding: 18px;
    color: rgba(219, 232, 255, 0.88);
    font-size: 13px;
    line-height: 1.55;
  }

  .analyze-error {
    border-color: rgba(255, 134, 156, 0.28);
    color: #ffd3dc;
  }

  .analyze-scroll {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow: auto;
    padding-right: 6px;
  }

  .hero-grid {
    display: grid;
    grid-template-columns: 1.2fr 1.1fr 0.9fr;
    gap: 16px;
  }

  .hero-panel,
  .metric-module,
  .ledger-section {
    border: 1px solid rgba(160, 196, 244, 0.14);
    background: rgba(7, 12, 23, 0.84);
  }

  .hero-panel {
    min-height: 248px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .hero-panel-header,
  .ledger-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .panel-meta {
    font-size: 12px;
    color: rgba(181, 200, 232, 0.72);
  }

  .cpu-gauge-shell {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 16px;
    align-items: center;
  }

  .cpu-gauge {
    width: 168px;
    height: 168px;
    transform: rotate(-90deg);
  }

  .cpu-gauge-track,
  .cpu-gauge-progress {
    fill: none;
    stroke-width: 8;
  }

  .cpu-gauge-track {
    stroke: rgba(160, 196, 244, 0.12);
  }

  .cpu-gauge-progress {
    stroke: #8ed8ff;
    stroke-linecap: round;
    filter: drop-shadow(0 0 12px rgba(88, 197, 255, 0.35));
  }

  .cpu-gauge-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cpu-gauge-kicker {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(168, 196, 239, 0.76);
  }

  .cpu-gauge-copy strong {
    font-size: 42px;
    line-height: 1;
    color: #f5fbff;
  }

  .cpu-gauge-copy span:last-child {
    font-size: 14px;
    color: rgba(220, 232, 255, 0.84);
  }

  .hero-stats,
  .triage-stack {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .hero-stats > div,
  .triage-item {
    padding-top: 10px;
    border-top: 1px solid rgba(160, 196, 244, 0.12);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .hero-stats span,
  .triage-item span,
  .sparkline-header span {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(168, 196, 239, 0.7);
  }

  .hero-stats strong,
  .triage-item strong,
  .sparkline-header strong {
    font-size: 16px;
    color: #f5fbff;
  }

  .segment-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .segment-row {
    display: grid;
    grid-template-columns: 164px minmax(0, 1fr) 64px;
    gap: 12px;
    align-items: center;
  }

  .segment-copy {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  .segment-copy span {
    font-size: 12px;
    color: rgba(219, 232, 255, 0.82);
  }

  .segment-copy strong,
  .segment-meta {
    font-size: 14px;
    color: #f5fbff;
  }

  .segment-bar {
    height: 10px;
    border: 1px solid rgba(160, 196, 244, 0.12);
    background: rgba(255, 255, 255, 0.03);
    overflow: hidden;
  }

  .segment-bar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, rgba(94, 181, 255, 0.5), rgba(172, 232, 255, 0.82));
    box-shadow: 0 0 16px rgba(88, 197, 255, 0.26);
  }

  .hero-sparkline-shell {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(160, 196, 244, 0.12);
  }

  .sparkline-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .sparkline {
    width: 100%;
    height: 42px;
    overflow: visible;
  }

  .sparkline-line {
    fill: none;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .sparkline-line--cpu {
    stroke: #92deff;
    filter: drop-shadow(0 0 6px rgba(88, 197, 255, 0.32));
  }

  .sparkline-line--pressure {
    stroke: #d7ff9f;
    filter: drop-shadow(0 0 6px rgba(168, 255, 110, 0.24));
  }

  .summary-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .metric-module {
    min-height: 122px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .metric-value {
    font-size: 28px;
    line-height: 1.05;
    color: #f6fbff;
    overflow-wrap: anywhere;
  }

  .metric-detail {
    margin-top: auto;
    font-size: 12px;
    line-height: 1.45;
    color: rgba(195, 214, 245, 0.78);
  }

  .ledger-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }

  .ledger-header h3 {
    margin: 0;
    font-size: 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #f5fbff;
  }

  .row-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .scan-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px;
    border: 1px solid rgba(160, 196, 244, 0.12);
    background: rgba(3, 8, 16, 0.74);
  }

  .scan-row-main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .scan-row-title,
  .scan-row-meta,
  .scan-row-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .scan-row-title strong {
    font-size: 14px;
    color: #f6fbff;
  }

  .scan-row-meta,
  .scan-row-stats {
    font-size: 12px;
    color: rgba(201, 217, 241, 0.8);
  }

  .scan-row-stats--secondary {
    color: rgba(160, 181, 213, 0.72);
  }

  .kind-pill {
    padding: 4px 7px;
    border: 1px solid rgba(160, 196, 244, 0.12);
    background: rgba(255, 255, 255, 0.03);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(234, 243, 255, 0.78);
  }

  .scan-row-actions {
    min-width: 140px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  .row-note {
    font-size: 11px;
    line-height: 1.45;
    text-align: right;
    color: #f2ce97;
  }

  .overlay-footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding-top: 6px;
    border-top: 1px solid rgba(160, 196, 244, 0.12);
  }

  .overlay-footer strong {
    display: inline-block;
    margin-left: 6px;
    font-size: 12px;
    color: #edf7ff;
    letter-spacing: normal;
    text-transform: none;
  }

  @media (max-width: 1380px) {
    .analyze-modal {
      width: calc(100vw - 96px);
      height: calc(100vh - 72px);
    }

    .hero-grid,
    .summary-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .hero-panel--triage,
    .summary-strip :global(article:nth-child(n + 5)) {
      grid-column: span 2;
    }
  }

  @media (max-width: 1120px) {
    .analyze-modal {
      width: calc(100vw - 48px);
      height: calc(100vh - 48px);
      padding: 20px;
    }

    .analyze-shell-header,
    .hero-grid,
    .summary-strip,
    .scan-row,
    .overlay-footer {
      grid-template-columns: 1fr;
      flex-direction: column;
    }

    .shell-actions,
    .scan-row-actions {
      width: 100%;
      align-items: stretch;
    }

    .cpu-gauge-shell,
    .hero-stats,
    .triage-stack {
      grid-template-columns: 1fr;
    }

    .segment-row {
      grid-template-columns: 1fr;
    }
  }

  :global([data-theme="tron-encom-os"]) .analyze-backdrop {
    background:
      radial-gradient(circle at center, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.82) 56%),
      rgba(0, 0, 0, 0.82);
  }

  :global([data-theme="tron-encom-os"]) .analyze-modal,
  :global([data-theme="tron-encom-os"]) .hero-panel,
  :global([data-theme="tron-encom-os"]) .metric-module,
  :global([data-theme="tron-encom-os"]) .ledger-section,
  :global([data-theme="tron-encom-os"]) .scope-chip,
  :global([data-theme="tron-encom-os"]) .shell-btn,
  :global([data-theme="tron-encom-os"]) .row-btn,
  :global([data-theme="tron-encom-os"]) .scan-row,
  :global([data-theme="tron-encom-os"]) .segment-bar,
  :global([data-theme="tron-encom-os"]) .kind-pill,
  :global([data-theme="tron-encom-os"]) .analyze-error,
  :global([data-theme="tron-encom-os"]) .analyze-empty,
  :global([data-theme="tron-encom-os"]) .section-empty {
    border-radius: 0;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :global([data-theme="tron-encom-os"]) .analyze-modal {
    border: 2px solid var(--led-line-x, #ffffff);
    color: var(--fg-primary, #f5f7fa);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.065), transparent 18%),
      linear-gradient(135deg, rgba(255, 255, 255, 0.045), transparent 34%),
      var(--bg-base, #000000);
    box-shadow:
      var(--led-halo-x, 0 0 28px rgba(255, 255, 255, 0.45)),
      inset 0 0 0 1px rgba(255, 255, 255, 0.07),
      0 34px 130px rgba(0, 0, 0, 0.78);
  }

  :global([data-theme="tron-encom-os"]) .analyze-modal::before {
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.055) 1px, transparent 1px);
    background-size: 28px 28px;
    opacity: 0.16;
  }

  :global([data-theme="tron-encom-os"]) .analyze-shell-header,
  :global([data-theme="tron-encom-os"]) .overlay-footer {
    border-color: var(--led-line-s, rgba(216, 221, 230, 0.45));
  }

  :global([data-theme="tron-encom-os"]) .shell-copy h2,
  :global([data-theme="tron-encom-os"]) .ledger-header h3,
  :global([data-theme="tron-encom-os"]) .metric-value,
  :global([data-theme="tron-encom-os"]) .cpu-gauge-copy strong,
  :global([data-theme="tron-encom-os"]) .hero-stats strong,
  :global([data-theme="tron-encom-os"]) .triage-item strong,
  :global([data-theme="tron-encom-os"]) .sparkline-header strong,
  :global([data-theme="tron-encom-os"]) .scan-row-title strong,
  :global([data-theme="tron-encom-os"]) .segment-copy strong,
  :global([data-theme="tron-encom-os"]) .segment-meta,
  :global([data-theme="tron-encom-os"]) .overlay-footer strong,
  :global([data-theme="tron-encom-os"]) .scope-chip code {
    color: var(--fg-primary, #f5f7fa);
    text-shadow: var(--glow, 0 0 8px rgba(255, 255, 255, 0.45));
  }

  :global([data-theme="tron-encom-os"]) .shell-copy h2 {
    max-width: 24ch;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 31px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  :global([data-theme="tron-encom-os"]) .shell-copy p,
  :global([data-theme="tron-encom-os"]) .panel-meta,
  :global([data-theme="tron-encom-os"]) .metric-detail,
  :global([data-theme="tron-encom-os"]) .scan-row-meta,
  :global([data-theme="tron-encom-os"]) .scan-row-stats,
  :global([data-theme="tron-encom-os"]) .section-empty,
  :global([data-theme="tron-encom-os"]) .row-note {
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .shell-kicker,
  :global([data-theme="tron-encom-os"]) .panel-kicker,
  :global([data-theme="tron-encom-os"]) .metric-label,
  :global([data-theme="tron-encom-os"]) .ledger-header span,
  :global([data-theme="tron-encom-os"]) .overlay-footer span,
  :global([data-theme="tron-encom-os"]) .scope-chip span,
  :global([data-theme="tron-encom-os"]) .cpu-gauge-kicker,
  :global([data-theme="tron-encom-os"]) .hero-stats span,
  :global([data-theme="tron-encom-os"]) .triage-item span,
  :global([data-theme="tron-encom-os"]) .sparkline-header span,
  :global([data-theme="tron-encom-os"]) .kind-pill,
  :global([data-theme="tron-encom-os"]) .segment-copy span {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    letter-spacing: 0.16em;
    color: var(--accent-dim, #c8cfd8);
    text-shadow: var(--glow-s, 0 0 3px rgba(255, 255, 255, 0.3));
  }

  :global([data-theme="tron-encom-os"]) .shell-btn,
  :global([data-theme="tron-encom-os"]) .row-btn,
  :global([data-theme="tron-encom-os"]) .scan-row,
  :global([data-theme="tron-encom-os"]) .hero-panel,
  :global([data-theme="tron-encom-os"]) .metric-module,
  :global([data-theme="tron-encom-os"]) .ledger-section,
  :global([data-theme="tron-encom-os"]) .scope-chip,
  :global([data-theme="tron-encom-os"]) .segment-bar {
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 24%),
      rgba(0, 0, 0, 0.74);
    color: var(--fg-primary, #f5f7fa);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.025);
  }

  :global([data-theme="tron-encom-os"]) .hero-panel,
  :global([data-theme="tron-encom-os"]) .metric-module,
  :global([data-theme="tron-encom-os"]) .ledger-section {
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.035),
      0 0 18px rgba(255, 255, 255, 0.08);
  }

  :global([data-theme="tron-encom-os"]) .scan-row,
  :global([data-theme="tron-encom-os"]) .kind-pill {
    background: rgba(0, 0, 0, 0.58);
  }

  :global([data-theme="tron-encom-os"]) .shell-btn--danger,
  :global([data-theme="tron-encom-os"]) .row-btn--danger {
    border-color: var(--c-red, #ff3a4c);
    background:
      linear-gradient(180deg, rgba(255, 58, 76, 0.16), rgba(0, 0, 0, 0.78)),
      rgba(255, 58, 76, 0.08);
    color: var(--c-red, #ff3a4c);
    box-shadow:
      0 0 14px rgba(255, 58, 76, 0.26),
      inset 0 0 0 1px rgba(255, 58, 76, 0.16);
  }

  :global([data-theme="tron-encom-os"]) .shell-btn--danger:not(:disabled):hover,
  :global([data-theme="tron-encom-os"]) .row-btn--danger:not(:disabled):hover {
    border-color: var(--c-red, #ff3a4c);
    background: rgba(255, 58, 76, 0.18);
    color: #ff6b78;
    box-shadow:
      0 0 22px rgba(255, 58, 76, 0.36),
      inset 0 0 0 1px rgba(255, 58, 76, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .shell-btn:hover,
  :global([data-theme="tron-encom-os"]) .row-btn:hover {
    border-color: var(--led-line, rgba(255, 255, 255, 0.62));
    color: var(--fg-primary, #f5f7fa);
    box-shadow:
      0 0 18px rgba(255, 255, 255, 0.2),
      inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  }

  :global([data-theme="tron-encom-os"]) .cpu-gauge-track {
    stroke: rgba(255, 255, 255, 0.16);
  }

  :global([data-theme="tron-encom-os"]) .cpu-gauge-progress {
    stroke: var(--led-line-x, #ffffff);
    filter:
      drop-shadow(0 0 10px rgba(255, 255, 255, 0.5))
      drop-shadow(0 0 24px rgba(255, 255, 255, 0.22));
  }

  :global([data-theme="tron-encom-os"]) .hero-stats > div,
  :global([data-theme="tron-encom-os"]) .triage-item,
  :global([data-theme="tron-encom-os"]) .hero-sparkline-shell {
    border-color: var(--led-line-soft, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .segment-bar span {
    background: linear-gradient(90deg, rgba(216, 221, 230, 0.38), rgba(255, 255, 255, 0.92));
    box-shadow:
      0 0 14px rgba(255, 255, 255, 0.32),
      0 0 26px rgba(255, 255, 255, 0.14);
  }

  :global([data-theme="tron-encom-os"]) .sparkline-line--cpu,
  :global([data-theme="tron-encom-os"]) .sparkline-line--pressure {
    stroke: var(--led-line-x, #ffffff);
    filter:
      drop-shadow(0 0 8px rgba(255, 255, 255, 0.44))
      drop-shadow(0 0 18px rgba(255, 255, 255, 0.18));
  }
</style>
