<!--
  ViewportFocus.svelte — Translate focus requests into xyflow viewport moves.

  Lives inside <SvelteFlow> so `useSvelteFlow()` resolves to the canvas
  instance. Subscribes to `focusRequest`; when a request lands, it polls for
  the target node (newly-spawned nodes enter the graph asynchronously on the
  next reactive rebuild), then calls fitView zoomed tight on that single
  node. Polling gives up after a short window so a spawn that never renders
  (scope mismatch, harness validation error, etc.) doesn't wedge the canvas.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useSvelteFlow } from '@xyflow/svelte';
  import { focusRequest } from '../lib/app/focus';

  const FIT_PADDING = 0.3;
  const FIT_MAX_ZOOM = 1.2;
  const FIT_DURATION_MS = 420;
  const POLL_INTERVAL_MS = 60;
  const POLL_TIMEOUT_MS = 2500;

  const { getNode, fitView } = useSvelteFlow();

  let currentToken: number | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let pollDeadline = 0;

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  async function tryFocus(nodeId: string): Promise<boolean> {
    const node = getNode(nodeId);
    if (!node) return false;
    await fitView({
      nodes: [{ id: nodeId }],
      padding: FIT_PADDING,
      maxZoom: FIT_MAX_ZOOM,
      duration: FIT_DURATION_MS,
    });
    return true;
  }

  const unsubscribe = focusRequest.subscribe((req) => {
    if (!req || req.token === currentToken) return;
    currentToken = req.token;

    stopPolling();
    const nodeId = req.nodeId;

    void tryFocus(nodeId).then((done) => {
      if (done) return;

      pollDeadline = Date.now() + POLL_TIMEOUT_MS;
      pollHandle = setInterval(() => {
        if (Date.now() > pollDeadline) {
          stopPolling();
          return;
        }
        void tryFocus(nodeId).then((resolved) => {
          if (resolved) stopPolling();
        });
      }, POLL_INTERVAL_MS);
    });
  });

  onDestroy(() => {
    stopPolling();
    unsubscribe();
  });
</script>
