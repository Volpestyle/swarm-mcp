<script lang="ts">
  import type { AreaCaptureDraft, AreaCaptureBounds } from '../lib/areaCapture';

  export let draft: AreaCaptureDraft;
  export let saving = false;
  export let status = '';
  export let onCancel: () => void;
  export let onConfirm: () => void | Promise<void>;
  export let onChange: (draft: AreaCaptureDraft) => void;

  type DragMode = 'move' | 'resize';
  type DragState = {
    pointerId: number;
    mode: DragMode;
    startX: number;
    startY: number;
    bounds: AreaCaptureBounds;
  };

  let drag: DragState | null = null;
  let reviewReady = false;

  $: cropStyle = `left:${draft.bounds.x}px; top:${draft.bounds.y}px; width:${draft.bounds.width}px; height:${draft.bounds.height}px;`;

  function updateBounds(bounds: AreaCaptureBounds): void {
    onChange({
      ...draft,
      bounds: {
        x: Math.max(8, Math.round(bounds.x)),
        y: Math.max(8, Math.round(bounds.y)),
        width: Math.max(160, Math.round(bounds.width)),
        height: Math.max(120, Math.round(bounds.height)),
      },
    });
  }

  function beginDrag(event: PointerEvent, mode: DragMode): void {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    drag = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      bounds: { ...draft.bounds },
    };
    target.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === 'move') {
      updateBounds({
        ...drag.bounds,
        x: drag.bounds.x + dx,
        y: drag.bounds.y + dy,
      });
      return;
    }
    updateBounds({
      ...drag.bounds,
      width: drag.bounds.width + dx,
      height: drag.bounds.height + dy,
    });
  }

  function endDrag(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    drag = null;
  }

  function updateNote(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    onChange({ ...draft, note: target.value });
  }

  function reviewSelection(): void {
    reviewReady = true;
  }
</script>

<div class="area-capture-overlay" data-testid="area-capture-overlay" role="dialog" aria-label="Report area capture">
  <div class="capture-shade capture-shade--top" style={`height:${draft.bounds.y}px`}></div>
  <div class="capture-shade capture-shade--left" style={`top:${draft.bounds.y}px; width:${draft.bounds.x}px; height:${draft.bounds.height}px`}></div>
  <div class="capture-shade capture-shade--right" style={`top:${draft.bounds.y}px; left:${draft.bounds.x + draft.bounds.width}px; height:${draft.bounds.height}px`}></div>
  <div class="capture-shade capture-shade--bottom" style={`top:${draft.bounds.y + draft.bounds.height}px`}></div>

  <div
    class="capture-box"
    style={cropStyle}
    data-testid="area-report-crop-rectangle"
    data-report-target="area-report-crop-rectangle"
    role="application"
    aria-label="Draggable report crop rectangle"
    on:pointerdown={(event) => beginDrag(event, 'move')}
    on:pointermove={moveDrag}
    on:pointerup={endDrag}
    on:pointercancel={endDrag}
  >
    <span class="capture-box-label">app-region-dom</span>
    <button
      type="button"
      class="capture-resize"
      aria-label="Resize report crop"
      on:pointerdown={(event) => beginDrag(event, 'resize')}
      on:pointermove={moveDrag}
      on:pointerup={endDrag}
      on:pointercancel={endDrag}
    ></button>
  </div>

  <aside class="capture-controls" data-testid="area-report-controls">
    <header>
      <span>Report Area</span>
      <strong>{draft.surfaceId ?? 'Canvas region'}</strong>
    </header>
    <textarea
      value={draft.note}
      rows="4"
      placeholder="What is wrong or worth remembering here?"
      on:input={updateNote}
    ></textarea>
    {#if reviewReady}
      <p data-testid="area-report-next-reflected">
        Selection ready. Confirm saves the crop metadata and learning sidecars.
      </p>
    {:else}
      <p>
        Majordomo stays visible for context. The overlay is excluded from the saved crop metadata.
      </p>
    {/if}
    {#if status}
      <p class="capture-status">{status}</p>
    {/if}
    <div class="capture-actions">
      <button type="button" disabled={saving} on:click={onCancel}>Cancel</button>
      {#if reviewReady}
        <button
          type="button"
          class="primary"
          disabled={saving}
          data-testid="area-report-confirm"
          on:click={onConfirm}
        >
          {saving ? 'Saving' : 'Confirm'}
        </button>
      {:else}
        <button
          type="button"
          class="primary"
          disabled={saving}
          data-testid="area-report-next"
          on:click={reviewSelection}
        >
          Next
        </button>
      {/if}
    </div>
  </aside>
</div>

<style>
  .area-capture-overlay {
    position: fixed;
    inset: 0;
    z-index: 130;
    pointer-events: auto;
    color: rgba(255, 247, 232, 0.94);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }

  .capture-shade {
    position: absolute;
    background: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(2px);
  }

  .capture-shade--top,
  .capture-shade--bottom {
    left: 0;
    right: 0;
  }

  .capture-shade--left {
    left: 0;
  }

  .capture-shade--right {
    right: 0;
  }

  .capture-box {
    position: absolute;
    border: 2px solid #ff3d52;
    border-radius: 8px;
    background: rgba(255, 61, 82, 0.06);
    box-shadow:
      0 0 0 9999px rgba(0, 0, 0, 0.08),
      0 0 26px rgba(255, 61, 82, 0.56),
      0 0 0 1px rgba(255, 255, 255, 0.22) inset;
    cursor: move;
    touch-action: none;
  }

  .capture-box-label {
    position: absolute;
    left: 10px;
    top: 10px;
    padding: 4px 7px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.58);
    color: rgba(255, 245, 224, 0.9);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .capture-resize {
    position: absolute;
    right: -8px;
    bottom: -8px;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.86);
    border-radius: 50%;
    background: #ff3d52;
    cursor: nwse-resize;
  }

  .capture-controls {
    position: absolute;
    right: 24px;
    bottom: 24px;
    width: min(360px, calc(100vw - 48px));
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid rgba(255, 199, 122, 0.34);
    border-radius: 8px;
    background: rgba(8, 9, 10, 0.9);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 22px 58px rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(18px);
  }

  .capture-controls header span {
    display: block;
    color: rgba(255, 199, 122, 0.72);
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .capture-controls header strong {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .capture-controls textarea {
    width: 100%;
    min-height: 88px;
    resize: vertical;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    padding: 9px;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    font: inherit;
    box-sizing: border-box;
  }

  .capture-controls p {
    margin: 0;
    color: rgba(255, 247, 232, 0.66);
    font-size: 11px;
    line-height: 1.4;
  }

  .capture-status {
    color: rgba(255, 199, 122, 0.92) !important;
  }

  .capture-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .capture-actions button {
    min-height: 34px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    font: inherit;
    font-size: 11px;
    font-weight: 850;
    cursor: pointer;
    text-transform: uppercase;
  }

  .capture-actions button.primary {
    border-color: rgba(255, 61, 82, 0.7);
    background: rgba(255, 61, 82, 0.22);
  }

  .capture-actions button:disabled {
    cursor: default;
    opacity: 0.58;
  }
</style>
