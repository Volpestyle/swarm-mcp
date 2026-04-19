<!--
  ConnectionEdge.svelte — Unified edge between two instances

  One visual edge per unordered pair, carrying messages, shared tasks, and
  dependencies. A "key" pill-group at the midpoint shows which relationship
  types are present with counts; selecting the edge opens the Inspector
  with per-type sections (and per-type delete actions).

  Base line: dashed blue, speed driven by message recency, dims when stale.
  Packets: one SVG circle per newly-appended message, traveling along the
  bezier via RAF + SVGPathElement.getPointAtLength. Packets route forward
  or reverse along the same curve based on the message direction.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    EdgeLabel,
    getBezierPath,
    useInternalNode,
    type Position,
  } from '@xyflow/svelte';
  import type { ConnectionEdgeData, Event, Task } from '../lib/types';
  import { getFloatingEdgeParams } from '../lib/floatingEdge';
  import { isSystemMessage } from '../lib/messages';
  import { timestampToMillis } from '../lib/time';
  import { onEventAppended, onMessageAppended } from '../stores/swarm';

  export let id: string | undefined = undefined;
  export let source: string;
  export let target: string;
  export let sourceX = 0;
  export let sourceY = 0;
  export let targetX = 0;
  export let targetY = 0;
  export let sourcePosition: Position | undefined = undefined;
  export let targetPosition: Position | undefined = undefined;
  export let data: ConnectionEdgeData | undefined = undefined;
  export let selected: boolean = false;

  let hovering = false;
  let pathEl: SVGPathElement | null = null;

  const sourceInternal = useInternalNode(source);
  const targetInternal = useInternalNode(target);

  // Reactivity note: `sourceInternal.current` is a rune-backed accessor whose
  // tracked reads don't always propagate through a Svelte 5 legacy `$:` block.
  // XYFlow already streams fresh sourceX/sourceY/targetX/targetY on every
  // drag frame, so we reference those props inside the computation — that
  // gives Svelte the dependency edges it needs to re-run this statement on
  // every node move and recompute the floating anchors in sync with the drag.
  $: floating = (() => {
    // Listed so Svelte's reactivity tracker picks them up.
    void sourceX;
    void sourceY;
    void targetX;
    void targetY;
    return getFloatingEdgeParams(
      sourceInternal.current,
      targetInternal.current,
    );
  })();
  $: [edgePath, labelX, labelY] = getBezierPath({
    sourceX: floating?.sourceX ?? sourceX,
    sourceY: floating?.sourceY ?? sourceY,
    sourcePosition: floating?.sourcePosition ?? sourcePosition,
    targetX: floating?.targetX ?? targetX,
    targetY: floating?.targetY ?? targetY,
    targetPosition: floating?.targetPosition ?? targetPosition,
  });

  // -------------------------------------------------------------------
  // Derived summary of what this edge carries
  // -------------------------------------------------------------------

  $: sourceInstanceId = data?.sourceInstanceId ?? null;
  $: targetInstanceId = data?.targetInstanceId ?? null;
  $: messages = data?.messages ?? [];
  $: tasks = data?.tasks ?? [];
  $: deps = data?.deps ?? [];
  $: lastMessage = messages[0] ?? null;

  $: messageCount = messages.length;
  $: taskCount = tasks.length;
  $: depCount = deps.length;

  $: taskSeverity = worstTaskStatus(tasks);
  $: depSeverity = deps.some((d) => !d.satisfied) ? 'blocked' : 'satisfied';

  function worstTaskStatus(list: Task[]): 'failed' | 'active' | 'done' | 'none' {
    if (list.length === 0) return 'none';
    let hasActive = false;
    let hasDone = false;
    for (const t of list) {
      if (t.status === 'failed') return 'failed';
      if (t.status === 'in_progress' || t.status === 'claimed' || t.status === 'open' || t.status === 'blocked' || t.status === 'approval_required') {
        hasActive = true;
      } else if (t.status === 'done') {
        hasDone = true;
      }
    }
    if (hasActive) return 'active';
    if (hasDone) return 'done';
    return 'none';
  }

  // -------------------------------------------------------------------
  // Recency-driven base line animation
  // -------------------------------------------------------------------

  let now = Date.now();
  const clockTick = setInterval(() => (now = Date.now()), 15_000);

  $: ageMs = (() => {
    const ms = timestampToMillis(lastMessage?.created_at);
    return ms === null ? Infinity : now - ms;
  })();

  $: stale = ageMs >= 10 * 60 * 1000 && messageCount > 0;
  $: animationSeconds = ageMs < 10 * 1000 ? 0.35 : ageMs < 60 * 1000 ? 0.8 : 1.8;
  $: isActive = ageMs < 10 * 1000;

  // -------------------------------------------------------------------
  // Packet spawn queue + RAF motion
  // -------------------------------------------------------------------

  const PACKET_DURATION_MS = 700;
  const MAX_IN_FLIGHT = 6;
  const STAGGER_MS = 120;

  interface Packet {
    key: string;
    startMs: number;
    cx: number;
    cy: number;
    /** true: travel source→target (0→1); false: target→source (1→0) */
    forward: boolean;
    /** [auto]/[signal:*]/sender=system — colored neutral grey, not blue. */
    system: boolean;
  }

  let packets: Packet[] = [];
  const waiting: Array<{ msgId: number; forward: boolean; system: boolean }> = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let rafId: number | null = null;
  let counter = 0;

  // Real-time pulse triggered by audit-log message events. Decays via the
  // CSS transition on `.message-edge-path.pulsing`. We bump a token per
  // pulse so consecutive bursts retrigger the transition correctly.
  let pulsing = false;
  let pulseClearTimer: ReturnType<typeof setTimeout> | null = null;
  const PULSE_DECAY_MS = 1200;

  function advance(ts: number): void {
    if (!pathEl || packets.length === 0) {
      rafId = null;
      return;
    }

    const totalLength = pathEl.getTotalLength();
    const next: Packet[] = [];

    for (const p of packets) {
      const t = (ts - p.startMs) / PACKET_DURATION_MS;
      if (t >= 1) continue;

      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const along = p.forward ? eased : 1 - eased;
      const pt = pathEl.getPointAtLength(along * totalLength);
      next.push({ ...p, cx: pt.x, cy: pt.y });
    }

    packets = next;

    if (packets.length > 0) {
      rafId = requestAnimationFrame(advance);
    } else {
      rafId = null;
    }
  }

  function spawnPacket(msgId: number, forward: boolean, system: boolean): void {
    if (!pathEl) return;
    const key = `${msgId}-${++counter}`;
    const start = performance.now();
    const total = pathEl.getTotalLength();
    const origin = pathEl.getPointAtLength(forward ? 0 : total);
    packets = [
      ...packets,
      { key, startMs: start, cx: origin.x, cy: origin.y, forward, system },
    ];
    if (rafId === null) rafId = requestAnimationFrame(advance);
  }

  function enqueuePacket(msgId: number, forward: boolean, system: boolean): void {
    if (packets.length < MAX_IN_FLIGHT) {
      spawnPacket(msgId, forward, system);
      return;
    }
    waiting.push({ msgId, forward, system });
    if (!drainTimer) scheduleDrain();
  }

  function scheduleDrain(): void {
    drainTimer = setTimeout(() => {
      drainTimer = null;
      while (waiting.length > 0 && packets.length < MAX_IN_FLIGHT) {
        const next = waiting.shift();
        if (next !== undefined) spawnPacket(next.msgId, next.forward, next.system);
      }
      if (waiting.length > 0) scheduleDrain();
    }, STAGGER_MS);
  }

  onMount(() => {
    unsubscribe = onMessageAppended((msg) => {
      if (!sourceInstanceId || !targetInstanceId) return;
      const sys = isSystemMessage(msg);
      if (msg.sender === sourceInstanceId && msg.recipient === targetInstanceId) {
        enqueuePacket(msg.id, true, sys);
      } else if (
        msg.sender === targetInstanceId &&
        msg.recipient === sourceInstanceId
      ) {
        enqueuePacket(msg.id, false, sys);
      }
    });

    unsubscribeEvents = onEventAppended((evt) => {
      if (!sourceInstanceId || !targetInstanceId) return;
      if (!shouldFlash(evt, sourceInstanceId, targetInstanceId)) return;
      triggerPulse();
    });
  });

  onDestroy(() => {
    unsubscribe?.();
    unsubscribeEvents?.();
    if (drainTimer) clearTimeout(drainTimer);
    if (pulseClearTimer) clearTimeout(pulseClearTimer);
    if (rafId !== null) cancelAnimationFrame(rafId);
    clearInterval(clockTick);
  });

  function shouldFlash(evt: Event, src: string, tgt: string): boolean {
    if (evt.actor !== src && evt.actor !== tgt) return false;
    if (evt.type === 'message.broadcast') return true;
    if (evt.type === 'message.sent') {
      return evt.subject === src || evt.subject === tgt;
    }
    return false;
  }

  function triggerPulse(): void {
    // Force a re-trigger: drop, then re-set on the next microtask so the
    // CSS transition replays even if pulses arrive back-to-back.
    pulsing = false;
    if (pulseClearTimer) clearTimeout(pulseClearTimer);
    queueMicrotask(() => {
      pulsing = true;
      pulseClearTimer = setTimeout(() => {
        pulsing = false;
      }, PULSE_DECAY_MS);
    });
  }

  $: messagePreview = lastMessage?.content
    ? lastMessage.content.slice(0, 80) + (lastMessage.content.length > 80 ? '...' : '')
    : '';
</script>

<g
  on:mouseenter={() => (hovering = true)}
  on:mouseleave={() => (hovering = false)}
  role="graphics-object"
>
  <path
    bind:this={pathEl}
    data-edge-id={id}
    class="message-edge-path"
    class:active={isActive}
    class:stale
    class:pulsing
    style="animation-duration: {animationSeconds}s"
    d={edgePath}
  />

  <!-- Wider invisible hit area for hover/select -->
  <path d={edgePath} stroke="transparent" stroke-width="16" fill="none" />

  {#each packets as packet (packet.key)}
    <circle
      class="message-packet"
      class:system={packet.system}
      r="4"
      cx={packet.cx}
      cy={packet.cy}
    />
  {/each}
</g>

<EdgeLabel x={labelX} y={labelY}>
  <div class="connection-key" class:selected>
    {#if messageCount > 0}
      <span class="chip msg" title="{messageCount} message{messageCount === 1 ? '' : 's'}">
        <span class="chip-letter">M</span>
        <span class="chip-count">{messageCount}</span>
      </span>
    {/if}
    {#if taskCount > 0}
      <span class="chip task {taskSeverity}" title="{taskCount} task{taskCount === 1 ? '' : 's'}">
        <span class="chip-letter">T</span>
        <span class="chip-count">{taskCount}</span>
      </span>
    {/if}
    {#if depCount > 0}
      <span class="chip dep {depSeverity}" title="{depCount} dependenc{depCount === 1 ? 'y' : 'ies'}">
        <span class="chip-letter">D</span>
        <span class="chip-count">{depCount}</span>
      </span>
    {/if}
  </div>

  {#if hovering && messagePreview}
    <div class="edge-tooltip">
      <span style="opacity: 0.6; margin-right: 4px;">{messageCount}x</span>
      {messagePreview}
    </div>
  {/if}
</EdgeLabel>

<style>
  /* XYFlow's EdgeLabel wrapper paints a default white pill background and
     padding. We don't want that — the chips style themselves. */
  :global(.svelte-flow__edge-label) {
    background: transparent !important;
    padding: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }

  .connection-key {
    display: flex;
    gap: 4px;
    padding: 2px;
    pointer-events: all;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border-radius: 6px;
    background: var(--node-header-bg, #181825);
    border: 1px solid var(--node-border, #313244);
    color: var(--terminal-fg, #c0caf5);
  }

  .connection-key.selected .chip {
    border-color: var(--node-border-selected, #89b4fa);
  }

  .chip-letter {
    opacity: 0.55;
    letter-spacing: 0.04em;
  }

  .chip-count {
    font-weight: 700;
  }

  .chip.msg {
    color: var(--edge-message, #89b4fa);
  }

  .chip.task.failed {
    color: var(--edge-task-failed, #f38ba8);
  }
  .chip.task.active {
    color: var(--edge-task-in-progress, #f9e2af);
  }
  .chip.task.done {
    color: var(--edge-task-done, #a6e3a1);
  }
  .chip.task.none {
    color: var(--edge-task-open, #cdd6f4);
  }

  .chip.dep.blocked {
    color: var(--edge-dep-blocked, #6c7086);
  }
  .chip.dep.satisfied {
    color: var(--edge-dep-satisfied, #a6e3a1);
  }
</style>
