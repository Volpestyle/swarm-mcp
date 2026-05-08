<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core';
  import type { ProjectAsset } from '../lib/types';

  export let asset: ProjectAsset;

  let imageFailed = false;
  let lastImageSrc = '';

  $: isImage = asset.kind === 'image' || asset.kind === 'screenshot';
  $: imageSrc = asset.path ? convertPreviewPath(asset.path) : '';
  $: if (imageSrc !== lastImageSrc) {
    lastImageSrc = imageSrc;
    imageFailed = false;
  }

  function convertPreviewPath(path: string): string {
    if (/^(https?:|asset:|data:|blob:)/i.test(path)) {
      return path;
    }
    return convertFileSrc(path);
  }
</script>

<div class="asset-preview" data-kind={asset.kind}>
  {#if isImage && asset.path && !imageFailed}
    <img src={imageSrc} alt={asset.title} on:error={() => (imageFailed = true)} />
  {:else if isImage && asset.path}
    <div class="asset-path">Preview unavailable: {asset.path}</div>
  {:else if asset.kind === 'note' || asset.kind === 'protocol'}
    <pre>{asset.content || asset.description || 'No text content yet.'}</pre>
  {:else}
    <div class="asset-path">{asset.path || asset.description || 'No path or reference yet.'}</div>
  {/if}
</div>

<style>
  .asset-preview {
    min-height: 74px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 0, 0.32);
    overflow: hidden;
  }

  img {
    display: block;
    width: 100%;
    max-height: 140px;
    object-fit: cover;
  }

  pre,
  .asset-path {
    margin: 0;
    padding: 10px;
    color: rgba(255, 255, 255, 0.72);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
