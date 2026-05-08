<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AssetAttachment, Instance, ProjectAsset } from '../lib/types';
  import AssetPreview from './AssetPreview.svelte';

  export let assets: ProjectAsset[] = [];
  export let attachments: AssetAttachment[] = [];
  export let agents: Instance[] = [];
  export let analyzingAssetIds: Set<string> = new Set();

  const dispatch = createEventDispatcher<{
    analyzeAsset: { assetId: string };
    attachAgent: { assetId: string; instanceId: string };
    deleteAsset: { assetId: string };
  }>();

  const GROUPS: { id: string; label: string; kinds: ProjectAsset['kind'][] }[] = [
    { id: 'visual', label: 'Images & Screenshots', kinds: ['image', 'screenshot'] },
    { id: 'notes', label: 'Notes', kinds: ['note'] },
    { id: 'folders', label: 'Folders', kinds: ['folder'] },
    { id: 'protocols', label: 'Protocols', kinds: ['protocol'] },
    { id: 'references', label: 'References', kinds: ['reference'] },
  ];

  function assetsFor(kinds: ProjectAsset['kind'][]): ProjectAsset[] {
    return assets.filter((asset) => kinds.includes(asset.kind));
  }

  function displayAgent(instance: Instance): string {
    const name = instance.label
      ?.split(/\s+/)
      .find((token) => token.startsWith('name:'))
      ?.slice('name:'.length)
      .replace(/_/g, ' ');
    return name || instance.id.slice(0, 8);
  }

  function isAttached(assetId: string, instanceId: string): boolean {
    return attachments.some(
      (entry) =>
        entry.assetId === assetId &&
        entry.targetType === 'agent' &&
        entry.targetId === instanceId,
    );
  }

  function isVisualAsset(asset: ProjectAsset): boolean {
    return asset.kind === 'image' || asset.kind === 'screenshot';
  }

  function isAnalyzing(assetId: string): boolean {
    return analyzingAssetIds.has(assetId);
  }
</script>

<div class="asset-grid">
  {#each GROUPS as group (group.id)}
    {@const groupAssets = assetsFor(group.kinds)}
    {#if groupAssets.length > 0}
      <section class="asset-group">
        <div class="asset-group-heading">
          <h4>{group.label}</h4>
          <span>{groupAssets.length}</span>
        </div>
        <div class="asset-cards">
          {#each groupAssets as asset (asset.id)}
            <article
              class="asset-card"
              class:asset-card--visual={asset.kind === 'image' || asset.kind === 'screenshot'}
              class:asset-card--text={asset.kind === 'note' || asset.kind === 'protocol'}
              class:asset-card--compact={asset.kind === 'folder' || asset.kind === 'reference'}
            >
              <div class="asset-card-head">
                <div>
                  <span>{asset.kind}</span>
                  <h5>{asset.title}</h5>
                </div>
                <button
                  type="button"
                  aria-label={`Delete ${asset.title}`}
                  title="Delete asset"
                  on:click={() => dispatch('deleteAsset', { assetId: asset.id })}
                >
                  ×
                </button>
              </div>
              <AssetPreview {asset} />
              {#if isVisualAsset(asset)}
                <div class="analysis-actions">
                  <button
                    type="button"
                    disabled={isAnalyzing(asset.id)}
                    on:click={() => dispatch('analyzeAsset', { assetId: asset.id })}
                  >
                    {#if isAnalyzing(asset.id)}
                      Analyzing...
                    {:else if asset.content}
                      Re-analyze image
                    {:else}
                      Analyze image
                    {/if}
                  </button>
                </div>
                {#if asset.content}
                  <div class="visual-analysis">
                    <span>Visual analysis</span>
                    <p>{asset.content}</p>
                  </div>
                {/if}
              {/if}
              {#if asset.description}
                <p>{asset.description}</p>
              {/if}
              {#if asset.path}
                <code>{asset.path}</code>
              {/if}
              {#if agents.length > 0}
                <div class="agent-attach-row">
                  {#each agents as agent (agent.id)}
                    <button
                      type="button"
                      disabled={isAttached(asset.id, agent.id)}
                      on:click={() => dispatch('attachAgent', { assetId: asset.id, instanceId: agent.id })}
                    >
                      {isAttached(asset.id, agent.id) ? 'Attached' : `Attach ${displayAgent(agent)}`}
                    </button>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}
  {/each}

  {#if assets.length === 0}
    <p class="empty-assets">No assets yet.</p>
  {/if}
</div>

<style>
  .asset-grid,
  .asset-group,
  .asset-cards {
    display: grid;
    gap: 10px;
  }

  .asset-cards {
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    align-items: start;
  }

  .asset-group-heading,
  .asset-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  h4,
  h5,
  p {
    margin: 0;
  }

  .asset-group-heading h4 {
    color: rgba(255, 255, 255, 0.82);
    font-size: 11px;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .asset-group-heading span,
  .asset-card-head span {
    color: rgba(255, 255, 255, 0.52);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .asset-card {
    display: grid;
    align-content: start;
    gap: 8px;
    min-height: 142px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 0, 0.28);
    padding: 10px;
  }

  .asset-card--visual {
    min-height: 280px;
  }

  .asset-card--text {
    grid-column: span 2;
    min-height: 240px;
  }

  .asset-card--compact {
    min-height: 116px;
  }

  .asset-card--text :global(.asset-preview) {
    min-height: 148px;
  }

  .asset-card--visual :global(.asset-preview) {
    min-height: 190px;
  }

  .asset-card h5 {
    margin-top: 3px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    letter-spacing: 0;
  }

  .asset-card p,
  .empty-assets {
    color: rgba(255, 255, 255, 0.58);
    font-size: 11px;
    line-height: 1.4;
  }

  .analysis-actions {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
  }

  .visual-analysis {
    display: grid;
    gap: 5px;
    border-left: 2px solid rgba(120, 255, 190, 0.58);
    background: rgba(120, 255, 190, 0.08);
    padding: 8px 9px;
  }

  .visual-analysis span {
    color: rgba(120, 255, 190, 0.78);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .visual-analysis p {
    color: rgba(255, 255, 255, 0.74);
  }

  code {
    color: rgba(255, 255, 255, 0.62);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    overflow-wrap: anywhere;
  }

  button {
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 0;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.84);
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    padding: 5px 8px;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .agent-attach-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
