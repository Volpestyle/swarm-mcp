<!--
  TerminalPane.svelte — View-only anchor for a PTY-backed terminal surface

  Ghostty ownership lives in `terminalSurface.ts`: one persistent surface per
  PTY, with a single live terminal instance that can move between graph nodes
  and the fullscreen workspace. This component only provides an anchor element
  and relays attach lifecycle events to its parent.
-->
<script lang="ts">
  import { onDestroy, onMount, createEventDispatcher } from 'svelte';
  import { getTerminalSurface } from '../lib/terminalSurface';
  import '../styles/terminal.css';

  export let ptyId: string;
  export let fontSize: number = 14;
  /** Bound back to the parent so outer chrome can measure / inspect the pane. */
  export let container: HTMLDivElement | null = null;

  const dispatch = createEventDispatcher<{
    exit: { code: number | null };
    ready: void;
    stable: void;
  }>();

  let mounted = false;
  let attachGeneration = 0;
  let attachedPtyId: string | null = null;
  let attachedContainer: HTMLDivElement | null = null;
  let releaseAttachment: (() => void) | null = null;
  let unsubscribeExit: (() => void) | null = null;
  let exitCode: number | null = null;

  onMount(() => {
    mounted = true;
  });

  onDestroy(() => {
    mounted = false;
    cleanupAttachment();
  });

  $: if (
    mounted &&
    container &&
    ptyId &&
    (ptyId !== attachedPtyId || container !== attachedContainer)
  ) {
    void attachSurface(ptyId, container);
  }

  async function attachSurface(
    nextPtyId: string,
    nextContainer: HTMLDivElement,
  ): Promise<void> {
    const generation = ++attachGeneration;

    cleanupAttachment();
    attachedPtyId = nextPtyId;
    attachedContainer = nextContainer;
    exitCode = null;

    const surface = getTerminalSurface(nextPtyId, { fontSize });
    unsubscribeExit = surface.exitCode.subscribe((code) => {
      const previous = exitCode;
      exitCode = code;
      if (code !== null && code !== previous) {
        dispatch('exit', { code });
      }
    });

    const attachment = surface.attach(nextContainer);
    releaseAttachment = attachment.release;

    try {
      await attachment.ready;
      if (!isCurrentAttachment(generation)) return;
      dispatch('ready');

      await attachment.stable;
      if (!isCurrentAttachment(generation)) return;
      dispatch('stable');
    } catch (err) {
      if (!isCurrentAttachment(generation)) return;
      console.error('[TerminalPane] failed to attach terminal surface:', err);
    }
  }

  function isCurrentAttachment(generation: number): boolean {
    return mounted && generation === attachGeneration;
  }

  function cleanupAttachment(): void {
    releaseAttachment?.();
    unsubscribeExit?.();
    releaseAttachment = null;
    unsubscribeExit = null;
    attachedPtyId = null;
    attachedContainer = null;
  }

  /** Focus the hidden input element ghostty forwards keystrokes through. */
  export function focus() {
    if (!ptyId) return;
    getTerminalSurface(ptyId, { fontSize }).focus();
  }
</script>

<div
  class="terminal-pane-anchor"
  bind:this={container}
>
  {#if exitCode !== null}
    <div class="exit-overlay">
      Process exited with code {exitCode}
    </div>
  {/if}
</div>

<style>
  .terminal-pane-anchor {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    position: relative;
  }

  .exit-overlay {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: var(--edge-task-cancelled, #6c7086);
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 11px;
    pointer-events: none;
    z-index: 5;
  }
</style>
