<script lang="ts">
  import { Handle, NodeResizer, Position } from '@xyflow/svelte';
  import type { SwarmNodeData } from '../lib/types';
  import { formatTimestamp } from '../lib/time';

  export let id: string;
  export let data: SwarmNodeData;
  export let selected: boolean = false;

  $: context = data.browserContext;
  $: tabs = data.browserTabs ?? [];
  $: snapshots = data.browserSnapshots ?? [];
  $: activeTab = tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
  $: title = activeTab?.title?.trim() || 'Browser';
  $: url = activeTab?.url?.trim() || context?.startUrl || '';
  $: project = data.project;
  $: projectStyle = project ? '--browser-project-color:#35a7ff;' : '';

  function sideToPosition(side: string): Position {
    switch (side) {
      case 'top': return Position.Top;
      case 'right': return Position.Right;
      case 'bottom': return Position.Bottom;
      case 'left': return Position.Left;
      default: return Position.Right;
    }
  }
</script>

<div
  class="browser-node"
  class:selected
  class:project-attached={Boolean(project)}
  data-node-id={id}
  style={projectStyle}
>
  <NodeResizer
    minWidth={420}
    minHeight={300}
    isVisible={selected}
    lineClass="resize-line"
    handleClass="resize-handle"
  />

  {#each ['top', 'right', 'bottom', 'left'] as side (side)}
    <Handle id="t-{side}" type="target" position={sideToPosition(side)} />
    <Handle id="s-{side}" type="source" position={sideToPosition(side)} />
  {/each}

  <header class="browser-node-header">
    <div>
      <span>Browser</span>
      <strong title={title}>{title}</strong>
    </div>
    <div class="browser-node-badges">
      {#if project}
        <small title={`Visible to project: ${project.name}`}>Project</small>
      {/if}
      <em class:closed={context?.status !== 'open'}>{context?.status ?? 'unknown'}</em>
    </div>
  </header>

  <section class="browser-node-body">
    <div class="browser-url" title={url}>{url || 'about:blank'}</div>

    <div class="browser-node-grid">
      <div>
        <span>Tabs</span>
        <strong>{tabs.length}</strong>
      </div>
      <div>
        <span>Snapshots</span>
        <strong>{snapshots.length}</strong>
      </div>
      <div>
        <span>Port</span>
        <strong>{context?.port ?? '--'}</strong>
      </div>
    </div>

    <div class="browser-node-list">
      {#if tabs.length === 0}
        <p>No tabs indexed</p>
      {:else}
        {#each tabs.slice(0, 3) as tab (tab.tabId)}
          <div class="browser-row">
            <b>{tab.active ? 'active' : tab.tabType}</b>
            <span title={tab.url}>{tab.title || tab.url || 'Untitled tab'}</span>
          </div>
        {/each}
      {/if}
    </div>

    <footer>
      {#if snapshots[0]}
        <span title={snapshots[0].title}>{snapshots[0].elements.length} elements</span>
        <span>{formatTimestamp(snapshots[0].createdAt)}</span>
      {:else}
        <span>No snapshot captured</span>
      {/if}
    </footer>
  </section>
</div>

<style>
  .browser-node {
    width: 100%;
    height: 100%;
    min-width: 420px;
    min-height: 300px;
    border: 1px solid rgba(106, 216, 255, 0.42);
    border-radius: 8px;
    background:
      linear-gradient(180deg, rgba(4, 12, 18, 0.96), rgba(0, 0, 0, 0.92)),
      repeating-linear-gradient(90deg, rgba(106, 216, 255, 0.08) 0 1px, transparent 1px 28px);
    box-shadow: 0 0 0 1px rgba(106, 216, 255, 0.12), 0 16px 48px rgba(0, 0, 0, 0.45);
    color: rgba(238, 250, 255, 0.94);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }

  .browser-node.selected {
    border-color: rgba(255, 229, 138, 0.8);
    box-shadow: 0 0 0 1px rgba(255, 229, 138, 0.38), 0 0 38px rgba(255, 229, 138, 0.16);
  }

  .browser-node.project-attached {
    border-color: var(--browser-project-color, #35a7ff);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--browser-project-color, #35a7ff) 28%, transparent),
      0 0 34px color-mix(in srgb, var(--browser-project-color, #35a7ff) 38%, transparent),
      0 16px 48px rgba(0, 0, 0, 0.48);
  }

  .browser-node.project-attached.selected {
    border-color: color-mix(in srgb, var(--browser-project-color, #35a7ff) 82%, white 18%);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--browser-project-color, #35a7ff) 38%, transparent),
      0 0 44px color-mix(in srgb, var(--browser-project-color, #35a7ff) 52%, transparent),
      0 18px 52px rgba(0, 0, 0, 0.54);
  }

  .browser-node-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid rgba(106, 216, 255, 0.18);
    background: rgba(255, 255, 255, 0.025);
  }

  .browser-node-header div {
    min-width: 0;
    display: grid;
    gap: 5px;
  }

  .browser-node-header span,
  .browser-node-grid span,
  .browser-node-list b,
  footer {
    color: rgba(172, 207, 218, 0.72);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .browser-node-header strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
    letter-spacing: 0.02em;
  }

  .browser-node-badges {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .browser-node-badges small,
  .browser-node-header em {
    flex: 0 0 auto;
    border: 1px solid rgba(45, 255, 167, 0.38);
    color: rgba(105, 255, 196, 0.9);
    border-radius: 999px;
    padding: 5px 9px;
    font-size: 11px;
    font-style: normal;
    text-transform: uppercase;
  }

  .browser-node-badges small {
    border-color: color-mix(in srgb, var(--browser-project-color, #35a7ff) 62%, transparent);
    color: color-mix(in srgb, var(--browser-project-color, #35a7ff) 84%, white 16%);
    background: color-mix(in srgb, var(--browser-project-color, #35a7ff) 14%, transparent);
  }

  .browser-node-header em.closed {
    border-color: rgba(255, 107, 107, 0.34);
    color: rgba(255, 150, 150, 0.9);
  }

  .browser-node-body {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: 12px;
    padding: 14px 16px;
  }

  .browser-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid rgba(106, 216, 255, 0.16);
    border-radius: 6px;
    padding: 10px 11px;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(228, 248, 255, 0.88);
    font-size: 12px;
  }

  .browser-node-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .browser-node-grid div {
    border: 1px solid rgba(106, 216, 255, 0.14);
    border-radius: 6px;
    padding: 10px;
    background: rgba(255, 255, 255, 0.025);
    display: grid;
    gap: 5px;
  }

  .browser-node-grid strong {
    font-size: 18px;
    color: rgba(255, 255, 255, 0.92);
  }

  .browser-node-list {
    min-height: 0;
    display: grid;
    align-content: start;
    gap: 7px;
    overflow: hidden;
  }

  .browser-node-list p {
    margin: 0;
    color: rgba(172, 207, 218, 0.68);
    font-size: 12px;
  }

  .browser-row {
    min-width: 0;
    display: grid;
    grid-template-columns: 68px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 1px solid rgba(106, 216, 255, 0.1);
    border-radius: 6px;
    padding: 8px 9px;
    background: rgba(0, 0, 0, 0.22);
  }

  .browser-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-top: 1px solid rgba(106, 216, 255, 0.14);
    padding-top: 11px;
  }
</style>
