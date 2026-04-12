<!--
  TaskEdge.svelte — Task handoff edge

  Solid line from requester node to assignee node.
  Color by status. Label shows truncated task title.
  Click selects the edge; inspector shows full task detail.
-->
<script lang="ts">
  import { EdgeLabel, getBezierPath, type Position } from '@xyflow/svelte';
  import type { TaskEdgeData, TaskStatus } from '../lib/types';

  export let id: string | undefined = undefined;
  export let sourceX = 0;
  export let sourceY = 0;
  export let targetX = 0;
  export let targetY = 0;
  export let sourcePosition: Position | undefined = undefined;
  export let targetPosition: Position | undefined = undefined;
  export let data: TaskEdgeData | undefined = undefined;
  export let selected: boolean = false;

  $: [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  $: taskStatus = data?.task?.status ?? 'open';
  $: taskTitle = data?.task?.title ?? '';
  $: truncatedTitle = taskTitle.length > 28
    ? taskTitle.slice(0, 28) + '...'
    : taskTitle;
  $: edgeColor = getStatusColor(taskStatus);

  function getStatusColor(status: TaskStatus): string {
    switch (status) {
      case 'open':
      case 'claimed':
        return 'var(--edge-task-open)';
      case 'in_progress':
        return 'var(--edge-task-in-progress)';
      case 'done':
        return 'var(--edge-task-done)';
      case 'failed':
        return 'var(--edge-task-failed)';
      case 'cancelled':
      case 'blocked':
        return 'var(--edge-task-cancelled)';
      case 'approval_required':
        return 'var(--edge-task-in-progress)';
      default:
        return 'var(--edge-task-open)';
    }
  }
</script>

<path
  data-edge-id={id}
  class="task-edge-path {taskStatus}"
  class:selected
  d={edgePath}
/>

<!-- Wider invisible hit area -->
<path
  d={edgePath}
  stroke="transparent"
  stroke-width="16"
  fill="none"
/>

<EdgeLabel x={labelX} y={labelY}>
  {#if truncatedTitle}
    <div
      style="transform: translate(-50%, -50%);
             font-size: 10px; color: {edgeColor}; background: var(--node-bg);
              padding: 1px 6px; border-radius: 4px; border: 1px solid var(--node-border);
              pointer-events: none; white-space: nowrap;"
    >
      {truncatedTitle}
    </div>
  {/if}
</EdgeLabel>
