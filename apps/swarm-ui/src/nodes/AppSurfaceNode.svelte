<script lang="ts">
  import { Handle, NodeResizer, Position } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import { formatTimestamp } from '../lib/time';
  import { openProjectAssetPath, updateProjectNoteAssetContent } from '../stores/projectAssets';

  export let id: string;
  export let data: SwarmNodeData;
  export let selected: boolean = false;

  $: surface = data.appSurface;
  $: documentSurface = surface?.document ?? null;

  let documentKey = '';
  let draftContent = '';
  let savedContent = '';
  let documentStatus = '';
  let documentError = '';
  let documentSaving = false;
  let documentOpening = false;

  $: if (documentSurface) {
    const nextKey = `${documentSurface.assetId}:${surface?.updatedAt ?? 0}`;
    if (nextKey !== documentKey) {
      documentKey = nextKey;
      draftContent = documentSurface.content ?? '';
      savedContent = draftContent;
      documentStatus = documentSurface.path ? 'Saved on disk' : 'No file path';
      documentError = '';
    }
  }

  function sideToPosition(side: string): Position {
    switch (side) {
      case 'top': return Position.Top;
      case 'right': return Position.Right;
      case 'bottom': return Position.Bottom;
      case 'left': return Position.Left;
      default: return Position.Right;
    }
  }

  function closeSurface(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!surface) return;
    window.dispatchEvent(new CustomEvent('swarm-app-surface-close', {
      detail: { surfaceId: surface.id, nodeId: id },
    }));
  }

  async function saveDocument(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!surface?.document || documentSaving) return;
    documentSaving = true;
    documentError = '';
    documentStatus = 'Saving...';
    try {
      const asset = await updateProjectNoteAssetContent(surface.document.assetId, draftContent);
      savedContent = draftContent;
      documentStatus = `Saved ${formatTimestamp(asset.updatedAt)}`;
      window.dispatchEvent(new CustomEvent('swarm-app-surface-document-saved', {
        detail: { surfaceId: surface.id, asset },
      }));
    } catch (err) {
      documentError = err instanceof Error ? err.message : String(err);
      documentStatus = '';
    } finally {
      documentSaving = false;
    }
  }

  async function openDocument(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!surface?.document || documentOpening) return;
    documentOpening = true;
    documentError = '';
    try {
      await openProjectAssetPath(surface.document.assetId);
      documentStatus = 'Opened file';
    } catch (err) {
      documentError = err instanceof Error ? err.message : String(err);
    } finally {
      documentOpening = false;
    }
  }
</script>

<div
  class="app-surface-node"
  class:selected
  class:document={Boolean(documentSurface)}
  data-node-id={id}
  data-testid={documentSurface ? 'canvas-note-document-surface' : 'canvas-app-surface'}
  data-report-target={documentSurface ? 'canvas-note-document-surface' : 'canvas-app-surface'}
>
  <NodeResizer
    minWidth={300}
    minHeight={190}
    isVisible={selected}
    lineClass="resize-line"
    handleClass="resize-handle"
  />

  {#each ['top', 'right', 'bottom', 'left'] as side (side)}
    <Handle id="t-{side}" type="target" position={sideToPosition(side)} />
    <Handle id="s-{side}" type="source" position={sideToPosition(side)} />
  {/each}

  <header>
    <span class="app-icon-wrap">
      {#if surface?.icon}
        <img src={surface.icon} alt="" />
      {/if}
    </span>
    <div>
      <span>{documentSurface ? 'Canvas Document' : 'Canvas App'}</span>
      <strong>{surface?.name ?? 'App'}</strong>
    </div>
    <button type="button" title="Remove canvas app surface" on:click={closeSurface}>
      x
    </button>
  </header>

  {#if documentSurface}
    <section class="document-panel" aria-label="Canvas document">
      <p>{surface?.detail ?? 'Canvas document.'}</p>
      <textarea
        class="document-editor nodrag nowheel"
        bind:value={draftContent}
        spellcheck="true"
        aria-label={`${documentSurface.title} content`}
        on:pointerdown|stopPropagation
        on:wheel|stopPropagation
      ></textarea>
      <div class="document-actions">
        <button type="button" disabled={documentSaving || draftContent === savedContent} on:click={saveDocument}>
          {documentSaving ? 'Saving...' : draftContent === savedContent ? 'Saved' : 'Save'}
        </button>
        <button type="button" disabled={documentOpening || !documentSurface.path} on:click={openDocument}>
          {documentOpening ? 'Opening...' : 'Open file'}
        </button>
      </div>
      {#if documentError}
        <p class="document-error">{documentError}</p>
      {:else}
        <p class="document-status">{documentStatus}</p>
      {/if}
      <footer>
        <span title={documentSurface.path ?? ''}>{documentSurface.path ?? 'workspace note'}</span>
        <span>{surface ? formatTimestamp(surface.updatedAt) : ''}</span>
      </footer>
    </section>
  {:else}
    <section>
      <p>{surface?.detail ?? 'Operator-visible app surface.'}</p>
      <div>
        <span>Status</span>
        <strong>{surface?.status ?? 'unknown'}</strong>
      </div>
      <footer>
        <span>{surface?.scope ?? 'local canvas'}</span>
        <span>{surface ? formatTimestamp(surface.updatedAt) : ''}</span>
      </footer>
    </section>
  {/if}
</div>

<style>
  .app-surface-node {
    width: 100%;
    height: 100%;
    min-width: 300px;
    min-height: 190px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 12px;
    background:
      linear-gradient(145deg, rgba(255, 255, 255, 0.13), rgba(255, 255, 255, 0.045)),
      rgba(10, 13, 18, 0.86);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 22px 48px rgba(0, 0, 0, 0.42),
      0 0 42px rgba(131, 166, 255, 0.14);
    color: rgba(242, 246, 252, 0.94);
    backdrop-filter: blur(18px);
    font-family: var(--font-ui, Inter, system-ui, sans-serif);
  }

  .app-surface-node.document {
    min-width: calc(300px + var(--tweak-note-surface-width, 0px));
    min-height: calc(190px + var(--tweak-note-surface-height, 0px));
  }

  .app-surface-node.selected {
    border-color: rgba(255, 255, 255, 0.58);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.22) inset,
      0 0 42px rgba(128, 169, 255, 0.34),
      0 24px 52px rgba(0, 0, 0, 0.5);
  }

  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }

  .app-icon-wrap {
    flex: 0 0 auto;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.1);
    box-shadow: 0 0 18px rgba(255, 255, 255, 0.1);
  }

  .app-icon-wrap img {
    width: 31px;
    height: 31px;
    object-fit: contain;
  }

  header div {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  header span,
  section span {
    color: rgba(196, 210, 224, 0.72);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  header strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 16px;
    letter-spacing: 0;
  }

  header button {
    margin-left: auto;
    width: 28px;
    height: 28px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.28);
    color: rgba(255, 255, 255, 0.78);
    cursor: pointer;
  }

  header button:hover {
    border-color: rgba(255, 130, 130, 0.72);
    color: rgba(255, 180, 180, 0.96);
  }

  section {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 10px;
    padding: 14px;
  }

  .document-panel {
    grid-template-rows: auto 1fr auto auto auto;
  }

  p {
    margin: 0;
    color: rgba(222, 232, 242, 0.78);
    font-size: 12px;
    line-height: 1.45;
  }

  section div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.18);
  }

  .document-editor {
    width: 100%;
    min-width: 0;
    min-height: 0;
    resize: none;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    padding: 10px;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(247, 250, 255, 0.92);
    font: 11px/1.48 'SF Mono', Monaco, 'Cascadia Code', monospace;
    outline: none;
  }

  .document-editor:focus {
    border-color: rgba(171, 205, 255, 0.58);
    box-shadow: 0 0 0 1px rgba(171, 205, 255, 0.18);
  }

  .document-actions {
    display: flex;
    justify-content: flex-start;
  }

  .document-actions button {
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    padding: 7px 10px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(248, 251, 255, 0.9);
    font-size: 11px;
    cursor: pointer;
  }

  .document-actions button:hover:not(:disabled) {
    border-color: rgba(176, 210, 255, 0.58);
    background: rgba(176, 210, 255, 0.16);
  }

  .document-actions button:disabled {
    cursor: default;
    opacity: 0.58;
  }

  .document-status,
  .document-error {
    font-size: 11px;
  }

  .document-status {
    color: rgba(187, 226, 190, 0.78);
  }

  .document-error {
    color: rgba(255, 173, 173, 0.88);
  }

  section div strong {
    font-size: 12px;
    text-transform: uppercase;
  }

  footer {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  footer span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
