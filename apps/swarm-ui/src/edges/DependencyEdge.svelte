<!--
  DependencyEdge.svelte — Task dependency edge

  Dotted line from dependency task's assignee to dependent task's assignee.
  Gray when dependency is not done (blocked), green when satisfied.
  No label by default; tooltip shows dependency task title on hover.
-->
<script lang="ts">
  import { EdgeLabel, getBezierPath, type Position } from '@xyflow/svelte';
  import type { DependencyEdgeData } from '../lib/types';
  import { getTask } from '../stores/swarm';

  export let id: string | undefined = undefined;
  export let sourceX = 0;
  export let sourceY = 0;
  export let targetX = 0;
  export let targetY = 0;
  export let sourcePosition: Position | undefined = undefined;
  export let targetPosition: Position | undefined = undefined;
  export let data: DependencyEdgeData | undefined = undefined;
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

  $: satisfied = data?.satisfied ?? false;
  $: stateClass = satisfied ? 'satisfied' : 'blocked';

  // Resolve dependency task title for tooltip
  $: depTask = data?.dependencyTaskId ? getTask(data.dependencyTaskId) : undefined;
  $: tooltipText = depTask?.title ?? data?.dependencyTaskId ?? '';
</script>

<g
  on:mouseenter={() => (hovering = true)}
  on:mouseleave={() => (hovering = false)}
  role="graphics-object"
>
  <path
    data-edge-id={id}
    class="dependency-edge-path {stateClass}"
    class:selected
    d={edgePath}
  />

  <!-- Wider invisible hit area -->
  <path
    d={edgePath}
    stroke="transparent"
    stroke-width="14"
    fill="none"
  />
</g>

<EdgeLabel x={labelX} y={labelY}>
  {#if hovering && tooltipText}
    <div class="edge-tooltip">
      {satisfied ? 'Done' : 'Blocked'}: {tooltipText}
    </div>
  {/if}
</EdgeLabel>
