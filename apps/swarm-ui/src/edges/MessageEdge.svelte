<!--
  MessageEdge.svelte — Message communication edge

  Animated dashed blue line between communicating nodes.
  Animation speed proportional to message recency (faster = more recent).
  Hover shows tooltip with truncated last message content.
-->
<script lang="ts">
  import { EdgeLabel, getBezierPath, type Position } from '@xyflow/svelte';
  import type { MessageEdgeData } from '../lib/types';
  import { isRecentTimestamp } from '../lib/time';

  export let id: string | undefined = undefined;
  export let sourceX = 0;
  export let sourceY = 0;
  export let targetX = 0;
  export let targetY = 0;
  export let sourcePosition: Position | undefined = undefined;
  export let targetPosition: Position | undefined = undefined;
  export let data: MessageEdgeData | undefined = undefined;
  export let selected: boolean = false;

  let hovering = false;

  $: [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Determine if messages are recent (within last 60 seconds)
  $: isActive = isRecentTimestamp(data?.lastMessage?.created_at, 60_000);
  $: messagePreview = data?.lastMessage?.content
    ? data.lastMessage.content.slice(0, 80) + (data.lastMessage.content.length > 80 ? '...' : '')
    : '';
</script>

<g
  on:mouseenter={() => (hovering = true)}
  on:mouseleave={() => (hovering = false)}
  role="graphics-object"
>
  <path
    data-edge-id={id}
    class="message-edge-path"
    class:active={isActive}
    d={edgePath}
  />

  <!-- Wider invisible hit area for hover -->
  <path
    d={edgePath}
    stroke="transparent"
    stroke-width="16"
    fill="none"
  />
</g>

<EdgeLabel x={labelX} y={labelY}>
  {#if hovering && messagePreview}
    <div class="edge-tooltip">
      <span style="opacity: 0.6; margin-right: 4px;">{data?.messageCount}x</span>
      {messagePreview}
    </div>
  {/if}

  {#if selected && data?.messageCount}
    <div
      style="transform: translateY(-8px);
             font-size: 10px; color: var(--edge-message); background: var(--node-bg); 
             padding: 1px 6px; border-radius: 4px; border: 1px solid var(--node-border);"
    >
      {data.messageCount} message{data.messageCount !== 1 ? 's' : ''}
    </div>
  {/if}
</EdgeLabel>
