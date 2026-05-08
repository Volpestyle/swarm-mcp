<script lang="ts">
  import { onMount } from 'svelte';
  import { collectVisualEvidence } from '../lib/proofPack';
  import {
    visualAtlasCoverageReport,
    visualAtlasFeatureMapExport,
    visualAtlasSurfaceStates,
  } from '../lib/visualAtlasRegistry';

  const states = visualAtlasSurfaceStates();
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const surfaceFilter = params.get('surface')?.trim() || '';
  const renderedStates = surfaceFilter
    ? states.filter((state) => state.id === surfaceFilter)
    : states;
  const coverage = visualAtlasCoverageReport();
  const featureMap = visualAtlasFeatureMapExport();

  type SwarmUiProofApi = {
    snapshot: () => unknown;
  };

  onMount(() => {
    const proofApi: SwarmUiProofApi = {
      snapshot: () => ({
        mode: 'visual-atlas',
        surfaceFilter: surfaceFilter || null,
        featureMap,
        coverage,
        visual: collectVisualEvidence(document.body),
      }),
    };
    (window as unknown as { __SWARM_UI_PROOF__?: SwarmUiProofApi }).__SWARM_UI_PROOF__ = proofApi;

    return () => {
      delete (window as unknown as { __SWARM_UI_PROOF__?: SwarmUiProofApi }).__SWARM_UI_PROOF__;
    };
  });
</script>

<main class="visual-atlas" data-surface="visual-atlas" data-testid="visual-atlas-root">
  <div class="atlas-grid" data-testid="visual-atlas-decorative-grid" aria-hidden="true"></div>
  <header class="atlas-header">
    <span>swarm-ui LAB</span>
    <h1>Visual Atlas</h1>
    <p>Deterministic proof states for registered surfaces and controls.</p>
    <div class="atlas-stats" aria-label="Visual atlas coverage summary">
      <strong>{coverage.surfaceCount}</strong>
      <span>surfaces</span>
      <strong>{coverage.controlCount}</strong>
      <span>controls</span>
      <strong>{coverage.ok ? 'pass' : 'fail'}</strong>
      <span>coverage</span>
    </div>
  </header>

  {#if renderedStates.length === 0}
    <section class="surface-card" data-testid="visual-atlas-empty-state">
      <h2>No surface matched</h2>
      <p>{surfaceFilter}</p>
    </section>
  {:else}
    {#each renderedStates as state (state.id)}
      <section
        class="surface-card"
        data-surface={state.surface.id}
        data-testid="visual-atlas-surface-card"
        data-report-target="visual-atlas-surface-card"
      >
        <header>
          <span>{state.surface.route}</span>
          <h2>{state.label}</h2>
          <p>{state.surface.expectedBehavior}</p>
        </header>

        <div class="control-grid">
          {#each state.controls as control (control.id)}
            <article
              class="control-card"
              class:disabled={control.clickability === 'disabled'}
              class:exempt={control.reportability === 'exempt'}
              data-testid={control.testId}
              data-report-target={control.reportTargetId}
            >
              <div class="control-kind">{control.kind}</div>
              <h3>{control.label}</h3>
              <p>{control.expectedBehavior}</p>
              <dl>
                <div>
                  <dt>Proof</dt>
                  <dd>{control.proofLevel}</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>{control.coverage}</dd>
                </div>
                <div>
                  <dt>Click</dt>
                  <dd>{control.clickability}</dd>
                </div>
                <div>
                  <dt>Report</dt>
                  <dd>{control.reportability}</dd>
                </div>
              </dl>
              {#if control.primaryAction}
                <button type="button" aria-label={control.primaryAction}>
                  {control.primaryAction}
                </button>
              {:else if control.clickability === 'disabled'}
                <button type="button" disabled aria-label={`disabled ${control.label}`}>
                  unavailable
                </button>
              {:else}
                <span class="noninteractive">no primary action</span>
              {/if}
              {#if control.exemptionReason}
                <small>{control.exemptionReason}</small>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #080a0e;
    color: #edf3f8;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .visual-atlas {
    min-height: 100vh;
    padding: 28px;
    position: relative;
    overflow: auto;
    background:
      linear-gradient(135deg, rgba(111, 199, 255, 0.12), transparent 30%),
      linear-gradient(315deg, rgba(245, 206, 93, 0.08), transparent 34%),
      #080a0e;
  }

  .atlas-grid {
    position: fixed;
    inset: 0;
    pointer-events: none;
    opacity: 0.24;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.07) 1px, transparent 1px);
    background-size: 36px 36px;
  }

  .atlas-header,
  .surface-card {
    position: relative;
    z-index: 1;
    max-width: 1180px;
    margin: 0 auto 18px;
  }

  .atlas-header {
    display: grid;
    gap: 10px;
    padding: 8px 0 18px;
  }

  .atlas-header span,
  .control-kind,
  dt,
  small {
    color: rgba(184, 213, 231, 0.72);
    font-size: 11px;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 42px;
    font-weight: 800;
  }

  .atlas-header p {
    max-width: 760px;
    color: rgba(237, 243, 248, 0.74);
  }

  .atlas-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .atlas-stats strong,
  .atlas-stats span {
    padding: 6px 8px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.06);
  }

  .surface-card {
    display: grid;
    gap: 16px;
    padding: 18px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    background: rgba(10, 14, 20, 0.88);
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
  }

  .surface-card header {
    display: grid;
    gap: 6px;
  }

  .surface-card header span {
    color: #f5ce5d;
    font-size: 11px;
    text-transform: uppercase;
  }

  .surface-card header p,
  .control-card p {
    color: rgba(237, 243, 248, 0.72);
    line-height: 1.5;
  }

  .control-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 12px;
  }

  .control-card {
    display: grid;
    gap: 10px;
    min-height: 250px;
    padding: 14px;
    border: 1px solid rgba(122, 205, 255, 0.24);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.045);
  }

  .control-card.disabled {
    border-color: rgba(245, 206, 93, 0.28);
    background: rgba(245, 206, 93, 0.055);
  }

  .control-card.exempt {
    border-style: dashed;
    opacity: 0.78;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }

  dl div {
    min-width: 0;
    padding: 7px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.18);
  }

  dd {
    margin: 2px 0 0;
    overflow-wrap: anywhere;
    font-size: 12px;
  }

  button,
  .noninteractive {
    justify-self: start;
    padding: 8px 10px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 7px;
    background: rgba(122, 205, 255, 0.13);
    color: #edf3f8;
    font: inherit;
    font-size: 12px;
  }

  button:disabled {
    color: rgba(237, 243, 248, 0.48);
    background: rgba(255, 255, 255, 0.045);
  }
</style>
