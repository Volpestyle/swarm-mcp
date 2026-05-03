<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { useSvelteFlow } from '@xyflow/svelte';
  import type { ProjectBoundary as BoundaryGeometry, ProjectSpace } from '../lib/types';

  export let project: ProjectSpace;
  export let active = false;

  const dispatch = createEventDispatcher<{
    open: { project: ProjectSpace };
    geometryChange: { project: ProjectSpace; boundary: BoundaryGeometry };
    sync: { project: ProjectSpace };
  }>();

  const { getViewport } = useSvelteFlow();
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 240;
  type ResizeKind =
    | 'resize-n'
    | 'resize-e'
    | 'resize-s'
    | 'resize-w'
    | 'resize-nw'
    | 'resize-ne'
    | 'resize-sw'
    | 'resize-se';
  const resizeHandles: { kind: ResizeKind; label: string; className: string }[] = [
    { kind: 'resize-n', label: 'top edge', className: 'handle-n' },
    { kind: 'resize-e', label: 'right edge', className: 'handle-e' },
    { kind: 'resize-s', label: 'bottom edge', className: 'handle-s' },
    { kind: 'resize-w', label: 'left edge', className: 'handle-w' },
    { kind: 'resize-nw', label: 'top left', className: 'handle-nw' },
    { kind: 'resize-ne', label: 'top right', className: 'handle-ne' },
    { kind: 'resize-sw', label: 'bottom left', className: 'handle-sw' },
    { kind: 'resize-se', label: 'bottom right', className: 'handle-se' },
  ];
  const cornerAccents = ['nw', 'ne', 'sw', 'se'] as const;

  let draft: BoundaryGeometry = { ...project.boundary };
  let hoveredHandle: ResizeKind | null = null;
  let gesture: {
    kind: 'move' | ResizeKind;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    start: BoundaryGeometry;
  } | null = null;

  $: if (!gesture) {
    draft = { ...project.boundary };
  }
  $: projectAccent = normalizeColor(project.color);
  $: activeHandle = gesture?.kind ?? hoveredHandle;

  function normalizeColor(value: string): string {
    const trimmed = value.trim();
    const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    if ((hex.length === 3 || hex.length === 6) && /^[0-9a-fA-F]+$/.test(hex)) {
      return `#${hex.toLowerCase()}`;
    }
    return '#ffffff';
  }

  function openProject(): void {
    dispatch('open', { project });
  }

  function syncAgents(): void {
    dispatch('sync', { project });
  }

  function startGesture(event: PointerEvent, kind: 'move' | ResizeKind): void {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    gesture = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      start: { ...draft },
    };
  }

  function updateGesture(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const zoom = getViewport().zoom || 1;
    const dx = (event.clientX - gesture.startClientX) / zoom;
    const dy = (event.clientY - gesture.startClientY) / zoom;

    if (gesture.kind === 'move') {
      draft = {
        ...gesture.start,
        x: gesture.start.x + dx,
        y: gesture.start.y + dy,
      };
      return;
    }

    const resizeAxis = gesture.kind.replace('resize-', '');
    const west = resizeAxis.includes('w');
    const east = resizeAxis.includes('e');
    const north = resizeAxis.includes('n');
    const south = resizeAxis.includes('s');
    const nextWidth = west
      ? Math.max(MIN_WIDTH, gesture.start.width - dx)
      : east
        ? Math.max(MIN_WIDTH, gesture.start.width + dx)
        : gesture.start.width;
    const nextHeight = north
      ? Math.max(MIN_HEIGHT, gesture.start.height - dy)
      : south
        ? Math.max(MIN_HEIGHT, gesture.start.height + dy)
        : gesture.start.height;

    draft = {
      ...gesture.start,
      x: west ? gesture.start.x + (gesture.start.width - nextWidth) : gesture.start.x,
      y: north ? gesture.start.y + (gesture.start.height - nextHeight) : gesture.start.y,
      width: nextWidth,
      height: nextHeight,
    };
  }

  function endGesture(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    gesture = null;
    dispatch('geometryChange', { project, boundary: { ...draft } });
  }

  function handleEnter(kind: ResizeKind): void {
    hoveredHandle = kind;
  }

  function handleLeave(kind: ResizeKind): void {
    if (hoveredHandle === kind && gesture?.kind !== kind) {
      hoveredHandle = null;
    }
  }
</script>

<div
  class="project-boundary"
  class:active
  class:resizing={gesture !== null}
  data-active-handle={activeHandle ?? ''}
  style={`--project-color:${projectAccent}; --project-border:${projectAccent}; left:${draft.x}px; top:${draft.y}px; width:${draft.width}px; height:${draft.height}px;`}
>
  <div
    class="project-placard"
    role="button"
    tabindex="0"
    aria-label={`Move ${project.name} project canvas`}
    title="Drag to move project canvas"
    on:pointerdown={(event) => startGesture(event, 'move')}
    on:pointermove={updateGesture}
    on:pointerup={endGesture}
    on:pointercancel={endGesture}
  >
    <span class="project-avatar" aria-hidden="true">▣</span>
    <div class="project-identity-copy">
      <span class="project-eyebrow">Project Space</span>
      <strong title={project.name}>{project.name}</strong>
      <span class="project-root" title={project.root}>{project.root}</span>
    </div>
    <span class="project-color-dot" aria-label="Project color"></span>
    <button
      class="project-boundary-tool"
      type="button"
      aria-label={`Open ${project.name}`}
      title="Open project"
      on:pointerdown|stopPropagation
      on:click={openProject}
    >
      Open
    </button>
    <button
      class="project-boundary-tool project-boundary-tool--icon"
      type="button"
      aria-label={`Sync enclosed agents into ${project.name}`}
      title="Sync enclosed agents"
      on:pointerdown|stopPropagation
      on:click={syncAgents}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 0 1-15.5 6.2" />
        <path d="M3 12a9 9 0 0 1 15.5-6.2" />
        <path d="M18 2v4h-4" />
        <path d="M6 22v-4h4" />
      </svg>
    </button>
  </div>

  {#each cornerAccents as corner (corner)}
    <span class={`corner-accent corner-accent-${corner}`} aria-hidden="true"></span>
  {/each}

  {#each resizeHandles as handle (handle.kind)}
    <button
      class={`project-resize-handle ${handle.className}`}
      class:corner={handle.kind === 'resize-nw' || handle.kind === 'resize-ne' || handle.kind === 'resize-sw' || handle.kind === 'resize-se'}
      class:edge={handle.kind === 'resize-n' || handle.kind === 'resize-e' || handle.kind === 'resize-s' || handle.kind === 'resize-w'}
      class:hot={activeHandle === handle.kind}
      type="button"
      aria-label={`Resize ${project.name} boundary from ${handle.label}`}
      title="Resize boundary"
      on:pointerenter={() => handleEnter(handle.kind)}
      on:pointerleave={() => handleLeave(handle.kind)}
      on:pointerdown={(event) => startGesture(event, handle.kind)}
      on:pointermove={updateGesture}
      on:pointerup={endGesture}
      on:pointercancel={endGesture}
    ></button>
  {/each}
</div>

<style>
  .project-boundary {
    position: absolute;
    z-index: 0;
    box-sizing: border-box;
    pointer-events: none;
    border: 1px solid var(--project-border, #ffffff);
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--project-color, #ffffff) 16%, transparent) 1px, transparent 1px),
      linear-gradient(0deg, color-mix(in srgb, var(--project-color, #ffffff) 14%, transparent) 1px, transparent 1px),
      color-mix(in srgb, var(--project-color, #ffffff) 5%, transparent);
    background-size: 42px 42px;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color, #ffffff) 34%, transparent) inset,
      0 0 20px color-mix(in srgb, var(--project-color, #ffffff) 58%, transparent),
      0 0 62px color-mix(in srgb, var(--project-color, #ffffff) 24%, transparent);
    transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
  }

  .project-boundary.active {
    border-color: color-mix(in srgb, var(--project-color, #ffffff) 92%, white 8%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color, #ffffff) 44%, transparent) inset,
      0 0 28px color-mix(in srgb, var(--project-color, #ffffff) 72%, transparent),
      0 0 92px color-mix(in srgb, var(--project-color, #ffffff) 38%, transparent);
  }

  .project-boundary.resizing,
  .project-boundary:has(.project-resize-handle.hot) {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color, #ffffff) 52%, transparent) inset,
      0 0 32px color-mix(in srgb, var(--project-color, #ffffff) 82%, transparent),
      0 0 112px color-mix(in srgb, var(--project-color, #ffffff) 42%, transparent);
  }

  .corner-accent {
    position: absolute;
    width: 24px;
    height: 24px;
    border-color: color-mix(in srgb, var(--project-color, #ffffff) 92%, white 8%);
    pointer-events: none;
    filter: drop-shadow(0 0 8px color-mix(in srgb, var(--project-color, #ffffff) 64%, transparent));
    opacity: 0.9;
  }

  .corner-accent-nw {
    top: -2px;
    left: -2px;
    border-top: 1px solid;
    border-left: 1px solid;
  }

  .corner-accent-ne {
    top: -2px;
    right: -2px;
    border-top: 1px solid;
    border-right: 1px solid;
  }

  .corner-accent-sw {
    left: -2px;
    bottom: -2px;
    border-left: 1px solid;
    border-bottom: 1px solid;
  }

  .corner-accent-se {
    right: -2px;
    bottom: -2px;
    border-right: 1px solid;
    border-bottom: 1px solid;
  }

  .project-boundary[data-active-handle='resize-nw'] .corner-accent-nw,
  .project-boundary[data-active-handle='resize-ne'] .corner-accent-ne,
  .project-boundary[data-active-handle='resize-sw'] .corner-accent-sw,
  .project-boundary[data-active-handle='resize-se'] .corner-accent-se {
    width: 32px;
    height: 32px;
    border-color: #fff;
    filter: drop-shadow(0 0 14px color-mix(in srgb, var(--project-color, #ffffff) 86%, transparent));
  }

  .project-placard {
    position: absolute;
    left: 50%;
    top: -112px;
    transform: translateX(-50%);
    pointer-events: auto;
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) 14px auto auto;
    align-items: center;
    gap: 12px;
    width: min(620px, max(440px, calc(100% - 52px)));
    min-height: 86px;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 58%, rgba(255, 255, 255, 0.22));
    border-radius: 14px;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--project-color, #ffffff) 12%, transparent), transparent 46%),
      color-mix(in srgb, var(--node-header-bg, #181825) 90%, black 10%);
    color: rgba(255, 255, 255, 0.92);
    box-shadow:
      0 18px 36px rgba(0, 0, 0, 0.34),
      0 0 22px color-mix(in srgb, var(--project-color, #ffffff) 18%, transparent),
      inset 0 0 0 1px rgba(255, 255, 255, 0.035);
    backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    -webkit-backdrop-filter: blur(var(--surface-blur, 20px)) saturate(1.12);
    cursor: grab;
    user-select: none;
  }

  .project-placard:active {
    cursor: grabbing;
  }

  .project-placard::after {
    content: '';
    position: absolute;
    left: 88px;
    right: 88px;
    bottom: 9px;
    height: 1px;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--project-color, #ffffff) 34%, transparent), transparent);
  }

  .project-avatar {
    width: 56px;
    height: 56px;
    display: inline-grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 62%, rgba(255, 255, 255, 0.24));
    border-radius: 12px;
    background:
      radial-gradient(circle at 32% 24%, color-mix(in srgb, var(--project-color, #ffffff) 20%, transparent), transparent 44%),
      rgba(0, 0, 0, 0.62);
    color: color-mix(in srgb, var(--project-color, #ffffff) 86%, white 10%);
    font-size: 28px;
    line-height: 1;
    box-shadow:
      inset 0 0 16px color-mix(in srgb, var(--project-color, #ffffff) 18%, transparent),
      0 0 18px color-mix(in srgb, var(--project-color, #ffffff) 16%, transparent);
  }

  .project-identity-copy {
    min-width: 0;
    display: grid;
    gap: 5px;
  }

  .project-eyebrow {
    color: color-mix(in srgb, var(--project-color, #ffffff) 72%, rgba(255, 255, 255, 0.62));
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.14em;
    line-height: 1;
    text-transform: uppercase;
  }

  .project-identity-copy strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--node-title-fg, #e5e5e5);
    font-size: 19px;
    font-weight: 750;
    letter-spacing: -0.01em;
    line-height: 1.05;
  }

  .project-root {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.54);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10.5px;
  }

  .project-color-dot {
    width: 10px;
    height: 54px;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 78%, white 8%);
    border-radius: 999px;
    background: var(--project-color, #ffffff);
    box-shadow: 0 0 14px color-mix(in srgb, var(--project-color, #ffffff) 70%, transparent);
  }

  .project-boundary-tool {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    border: 1px solid color-mix(in srgb, var(--project-color, #ffffff) 42%, rgba(255, 255, 255, 0.24));
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.38);
    color: rgba(255, 255, 255, 0.86);
    cursor: pointer;
    font: inherit;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 0 10px;
    text-transform: uppercase;
  }

  .project-boundary-tool--icon {
    width: 30px;
    padding: 0;
  }

  .project-boundary-tool:hover,
  .project-resize-handle:hover {
    border-color: color-mix(in srgb, var(--project-color, #ffffff) 94%, white 6%);
    background: color-mix(in srgb, var(--project-color, #ffffff) 15%, black 85%);
  }

  .project-resize-handle {
    position: absolute;
    pointer-events: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .project-resize-handle.hot {
    opacity: 1;
  }

  .project-resize-handle.corner {
    width: 56px;
    height: 56px;
  }

  .project-resize-handle.corner::before {
    content: '';
    position: absolute;
    inset: 15px;
    border-color: color-mix(in srgb, var(--project-color, #ffffff) 92%, white 8%);
    filter: drop-shadow(0 0 12px color-mix(in srgb, var(--project-color, #ffffff) 72%, transparent));
    pointer-events: none;
  }

  .project-resize-handle.edge {
    background: color-mix(in srgb, var(--project-color, #ffffff) 10%, transparent);
  }

  .project-resize-handle.edge.hot {
    background: color-mix(in srgb, var(--project-color, #ffffff) 20%, transparent);
    box-shadow: 0 0 18px color-mix(in srgb, var(--project-color, #ffffff) 48%, transparent);
  }

  .handle-n {
    left: 34px;
    right: 34px;
    top: -12px;
    height: 24px;
    cursor: ns-resize;
  }

  .handle-e {
    top: 34px;
    right: -12px;
    bottom: 34px;
    width: 24px;
    cursor: ew-resize;
  }

  .handle-s {
    left: 34px;
    right: 34px;
    bottom: -12px;
    height: 24px;
    cursor: ns-resize;
  }

  .handle-w {
    top: 34px;
    left: -12px;
    bottom: 34px;
    width: 24px;
    cursor: ew-resize;
  }

  .handle-nw {
    left: -28px;
    top: -28px;
    cursor: nwse-resize;
  }

  .handle-ne {
    right: -28px;
    top: -28px;
    cursor: nesw-resize;
  }

  .handle-sw {
    left: -28px;
    bottom: -28px;
    cursor: nesw-resize;
  }

  .handle-se {
    right: -28px;
    bottom: -28px;
    cursor: nwse-resize;
  }

  .handle-nw::before {
    border-top: 1px solid;
    border-left: 1px solid;
  }

  .handle-ne::before {
    border-top: 1px solid;
    border-right: 1px solid;
  }

  .handle-sw::before {
    border-bottom: 1px solid;
    border-left: 1px solid;
  }

  .handle-se::before {
    border-bottom: 1px solid;
    border-right: 1px solid;
  }
</style>
