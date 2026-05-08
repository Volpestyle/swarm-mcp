<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import { activeScope, events, instances, messages, tasks } from '../stores/swarm';
  import { bindings, broadcastOperatorMessage, closePty, killInstance, ptySessions, spawnShell } from '../stores/pty';
  import { timestampToMillis } from '../lib/time';
  import {
    buildMajordomoBootstrapInstructions,
    buildMajordomoRuntimeLabel,
    defaultHermesMajordomoRuntime,
    majordomoClarificationChoices,
    resolveMajordomoRuntime,
    structureMajordomoIdeaDump,
  } from '../lib/majordomoRuntime';
  import type { ProjectSpace } from '../lib/types';
  import caduceusUrl from '../assets/app-icons/caduceus.jpg';

  type ArchitectTab = 'oversight' | 'contact' | 'runtime' | 'broadcast' | 'debugger' | 'host';
  type HostDragStart = {
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  };

  const PYRAMID_MODEL_PATH = '/Users/mathewfrazier/Desktop/AgenticFab/PyramidAIHost.usdz';
  const CADUCEUS_MODEL_PATH = '/Users/mathewfrazier/Desktop/9889-new-times/caduceus.jpg';
  const HOST_DRAG_LIMIT_X = 44;
  const HOST_DRAG_LIMIT_Y = 34;
  const SOURCE_ROOT = '/Users/mathewfrazier/Desktop/swarm-mcp-lab';

  export let activeProject: ProjectSpace | null = null;
  export let runtimeTweakStatus = '';
  export let onRuntimeTweak: (command: string) => string = () => '';
  export let onStartAreaCapture: () => void = () => undefined;
  export let autoStart = false;
  export let collapsed = true;

  let activeTab: ArchitectTab = 'oversight';
  let broadcastText = '';
  let statusText = '';
  let sending = false;
  let dragX = 0;
  let dragY = 0;
  let dragStart: HostDragStart | null = null;
  let modelPath = PYRAMID_MODEL_PATH;
  let modelPathDraft = PYRAMID_MODEL_PATH;
  let modelStatus = 'PyramidAIHost.usdz is selected.';
  let runtimeLaunching = false;
  let runtimeStopping = false;
  let runtimeMessage = '';
  let runtimeTimeoutMinutes = 45;
  let hermesModel = '';
  let hermesProvider = '';
  let contactText = '';
  let contactStatus = '';
  let tweakText = '/tweak move majordomo button right 12';

  $: agentList = [...$instances.values()];
  $: taskList = [...$tasks.values()];
  $: messageList = $messages;
  $: onlineAgents = agentList.filter((agent) => agent.status === 'online' && agent.adopted !== false);
  $: adoptingAgents = agentList.filter((agent) => agent.adopted === false);
  $: activeTasks = taskList.filter((task) => task.status === 'claimed' || task.status === 'in_progress');
  $: blockedTasks = taskList.filter((task) => task.status === 'blocked' || task.status === 'approval_required');
  $: idleAgents = onlineAgents.filter((agent) =>
    !activeTasks.some((task) => task.assignee === agent.id),
  );
  $: unreadMessages = messageList.filter((message) => !message.read).length;
  $: recentMessages = [...messageList].slice(-5).reverse();
  $: recentEvents = $events.slice(-5).reverse();
  $: runtime = defaultHermesMajordomoRuntime({
    model: hermesModel,
    provider: hermesProvider,
  });
  $: runtimeMatch = resolveMajordomoRuntime({
    instances: agentList,
    ptySessions: [...$ptySessions.values()],
    bindings: $bindings.resolved,
    project: activeProject,
    launchRequested: runtimeLaunching,
  });
  $: runtimeInstance = runtimeMatch.instance;
  $: runtimePty = runtimeMatch.pty;
  $: runtimeState = runtimeStopping ? 'stopping' : runtimeMatch.state;
  $: modelSrc = resolveModelSrc(modelPath);
  $: modelIsImage = /\.(png|jpe?g|webp|gif)$/i.test(modelPath.trim());
  $: caduceusStageSrc = modelIsImage && modelSrc ? modelSrc : caduceusUrl;
  $: hostYaw = clamp(-8 + dragX * 0.32, -22, 10);
  $: hostPitch = clamp(-9 - dragY * 0.18, -16, -3);
  $: hostLift = Math.max(0, -dragY * 0.12);

  const tabs: Array<{ id: ArchitectTab; label: string }> = [
    { id: 'oversight', label: 'Oversight' },
    { id: 'contact', label: 'Ask' },
    { id: 'runtime', label: 'Runtime' },
    { id: 'broadcast', label: 'Broadcast' },
    { id: 'debugger', label: 'Debugger' },
    { id: 'host', label: '3D Host' },
  ];

  function shortId(value: string | null | undefined): string {
    return value ? value.slice(0, 8) : 'none';
  }

  function formatAgo(value: number): string {
    const millis = timestampToMillis(value);
    if (millis === null) return 'unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - millis) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  async function sendBroadcast(): Promise<void> {
    const scope = $activeScope?.trim();
    const content = broadcastText.trim();
    if (!scope) {
      statusText = 'No active channel selected.';
      return;
    }
    if (!content) {
      statusText = 'Write the chief architect note first.';
      return;
    }

    sending = true;
    statusText = '';
    try {
      const count = await broadcastOperatorMessage(scope, `[majordomo] ${content}`);
      statusText = count === 0
        ? 'No agents received the broadcast.'
        : `Broadcast delivered to ${count} agent${count === 1 ? '' : 's'}.`;
      broadcastText = '';
    } catch (err) {
      statusText = `Broadcast failed: ${err}`;
    } finally {
      sending = false;
    }
  }

  function fallbackRuntimeProject(): ProjectSpace {
    const cwd = ($activeScope ?? SOURCE_ROOT).split('#')[0] || SOURCE_ROOT;
    return {
      id: 'lab-canvas',
      name: 'Lab Canvas',
      root: cwd,
      color: '#ffd44f',
      additionalRoots: [],
      notes: 'Fallback Majordomo runtime project.',
      scope: $activeScope ?? cwd,
      boundary: { x: 0, y: 0, width: 1, height: 1 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async function startMajordomoRuntime(): Promise<void> {
    if (runtimeLaunching || runtimeInstance) return;
    const project = activeProject ?? fallbackRuntimeProject();
    runtimeLaunching = true;
    runtimeMessage = '';
    try {
      const label = buildMajordomoRuntimeLabel(project, runtimeTimeoutMinutes);
      const result = await spawnShell(project.root, {
        harness: 'hermes',
        harnessCommand: runtime.command,
        role: 'majordomo',
        scope: project.scope ?? project.root,
        label,
        name: 'majordomo',
        bootstrapInstructions: buildMajordomoBootstrapInstructions({
          sourceRoot: SOURCE_ROOT,
          project,
        }),
      });
      runtimeMessage = `Majordomo launch requested: ${result.instance_id ?? result.pty_id}`;
    } catch (err) {
      runtimeMessage = `Majordomo launch blocked: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      runtimeLaunching = false;
    }
  }

  async function stopMajordomoRuntime(): Promise<void> {
    if (runtimeStopping) return;
    runtimeStopping = true;
    runtimeMessage = '';
    try {
      if (runtimePty) {
        await closePty(runtimePty.id);
        runtimeMessage = `Stopped Majordomo PTY ${shortId(runtimePty.id)}.`;
      } else if (runtimeInstance) {
        await killInstance(runtimeInstance.id);
        runtimeMessage = `Killed Majordomo instance ${shortId(runtimeInstance.id)}.`;
      } else {
        runtimeMessage = 'No visible Majordomo runtime to stop.';
      }
    } catch (err) {
      runtimeMessage = `Stop failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      runtimeStopping = false;
    }
  }

  async function submitContact(kind: 'ask' | 'clarify' | 'slippage'): Promise<void> {
    const content = contactText.trim();
    if (!content) {
      contactStatus = 'Write the Majordomo note first.';
      return;
    }
    const structured = structureMajordomoIdeaDump(content);
    const choices = kind === 'clarify' ? majordomoClarificationChoices(content) : [];
    const note = [
      `[majordomo-${kind}]`,
      ...structured.map((entry) => `- ${entry}`),
      choices.length ? `Choices: ${choices.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    contactStatus = choices.length
      ? `Clarify Will: ${choices.join(' / ')}`
      : `Structured ${structured.length} note${structured.length === 1 ? '' : 's'}.`;
    if ($activeScope) {
      await broadcastOperatorMessage($activeScope, note).catch((err) => {
        contactStatus = `Structured locally; broadcast failed: ${err}`;
      });
    }
  }

  function applyTweak(): void {
    const result = onRuntimeTweak(tweakText);
    if (result) {
      contactStatus = result;
    }
  }

  onMount(() => {
    if (!autoStart) return;
    const timer = window.setTimeout(() => {
      if (!runtimeInstance && !runtimeLaunching) {
        void startMajordomoRuntime();
      }
    }, 900);
    return () => window.clearTimeout(timer);
  });

  function beginDrag(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    event.preventDefault();
    event.stopPropagation();
    dragStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: dragX,
      originY: dragY,
    };
    target.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragX = clamp(dragStart.originX + event.clientX - dragStart.x, -HOST_DRAG_LIMIT_X, HOST_DRAG_LIMIT_X);
    dragY = clamp(dragStart.originY + event.clientY - dragStart.y, -HOST_DRAG_LIMIT_Y, HOST_DRAG_LIMIT_Y);
  }

  function endDrag(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    event.stopPropagation();
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    dragStart = null;
  }

  function resetHostPose(): void {
    dragX = 0;
    dragY = 0;
  }

  function applyModelPath(): void {
    const next = modelPathDraft.trim() || PYRAMID_MODEL_PATH;
    const nextIsImage = /\.(png|jpe?g|webp|gif)$/i.test(next);
    modelPath = next;
    modelPathDraft = next;
    modelStatus = nextIsImage
      ? 'Image host selected. It will rotate on the caduceus stage.'
      : '3D model path selected. Tauri will try to load it when available.';
  }

  function useCaduceusModel(): void {
    modelPathDraft = CADUCEUS_MODEL_PATH;
    modelPath = CADUCEUS_MODEL_PATH;
    modelStatus = 'Caduceus host selected. It rotates in the Grand Architect stage.';
  }

  function resolveModelSrc(path: string): string {
    const tauriInternals = typeof window === 'undefined'
      ? null
      : (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!tauriInternals) return '';
    try {
      return convertFileSrc(path);
    } catch {
      return '';
    }
  }
</script>

<aside class="majordomo-panel" class:collapsed aria-label="Majordomo Grand Architect">
  <button
    type="button"
    class="majordomo-collapsed"
    class:hidden={!collapsed}
    on:click={() => (collapsed = false)}
    aria-label="Open Majordomo Grand Architect"
  >
    <span class="majordomo-sigil" aria-hidden="true">
      <span class="majordomo-eye">👁️</span>
    </span>
    <span class="majordomo-collapsed-copy">Grand Architect</span>
    <strong>{onlineAgents.length}</strong>
  </button>

  {#if !collapsed}
    <div class="majordomo-card">
      <header class="majordomo-header">
        <div class="majordomo-title">
          <span class="majordomo-mark" aria-hidden="true">👁️</span>
          <div>
            <span>Majordomo</span>
            <strong>Grand Architect</strong>
          </div>
        </div>
        <button class="majordomo-collapse" type="button" on:click={() => (collapsed = true)} aria-label="Collapse Majordomo">×</button>
      </header>

      <nav class="majordomo-tabs" aria-label="Majordomo tabs">
        {#each tabs as tab (tab.id)}
          <button
            type="button"
            class:active={activeTab === tab.id}
            on:click={() => (activeTab = tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </nav>

      {#if activeTab === 'oversight'}
        <section class="majordomo-body">
          <div class="runtime-pill" data-testid="majordomo-runtime-status" data-report-target="majordomo-runtime-status">
            <span>Runtime</span>
            <strong>{runtimeState}</strong>
            <em>{runtime.sourceTag}</em>
          </div>
          <div class="majordomo-metrics">
            <span><em>Online</em><strong>{onlineAgents.length}</strong></span>
            <span><em>Active</em><strong>{activeTasks.length}</strong></span>
            <span><em>Blocked</em><strong>{blockedTasks.length}</strong></span>
            <span><em>Unread</em><strong>{unreadMessages}</strong></span>
          </div>
          <div class="majordomo-list">
            {#each onlineAgents.slice(0, 6) as agent (agent.id)}
              <article>
                <strong>{agent.label ?? shortId(agent.id)}</strong>
                <span>{shortId(agent.id)} · {agent.status} · {formatAgo(agent.heartbeat)} ago</span>
              </article>
            {/each}
            {#if onlineAgents.length === 0}
              <p>No online agents in this channel.</p>
            {/if}
          </div>
        </section>
      {:else if activeTab === 'contact'}
        <section class="majordomo-body">
          <label for="majordomo-contact">Ask Majordomo / Clarify Will</label>
          <textarea
            id="majordomo-contact"
            data-testid="majordomo-contact-input"
            bind:value={contactText}
            rows="5"
            placeholder="Dump the messy idea here. Majordomo will structure it and offer next choices."
          ></textarea>
          <div class="majordomo-button-row">
            <button
              type="button"
              data-testid="majordomo-ask-button"
              data-report-target="majordomo-ask-button"
              on:click={() => submitContact('ask')}
            >
              Ask
            </button>
            <button type="button" on:click={() => submitContact('clarify')}>
              Clarify Will
            </button>
            <button type="button" on:click={onStartAreaCapture}>
              Report Area
            </button>
          </div>
          <label for="majordomo-tweak">Live tweak command</label>
          <div class="majordomo-tweak-row">
            <input id="majordomo-tweak" class="majordomo-input" bind:value={tweakText} spellcheck="false" />
            <button type="button" data-testid="majordomo-tweak-apply" on:click={applyTweak}>Apply</button>
          </div>
          {#if contactStatus || runtimeTweakStatus}
            <p class="majordomo-status">{contactStatus || runtimeTweakStatus}</p>
          {/if}
        </section>
      {:else if activeTab === 'runtime'}
        <section class="majordomo-body">
          <div class="runtime-card" data-testid="majordomo-runtime-status" data-report-target="majordomo-runtime-status">
            <span>Hermes-backed role:majordomo</span>
            <strong>{runtimeState}</strong>
            <p>Source {runtime.sourceTag} · cleanup {runtime.cleanupPolicy}</p>
            <p>Instance {runtimeInstance ? shortId(runtimeInstance.id) : 'none'} · PTY {runtimePty ? shortId(runtimePty.id) : 'none'}</p>
          </div>
          <div class="runtime-fields">
            <label for="majordomo-model">Model</label>
            <input id="majordomo-model" class="majordomo-input" bind:value={hermesModel} placeholder="optional" spellcheck="false" />
            <label for="majordomo-provider">Provider</label>
            <input id="majordomo-provider" class="majordomo-input" bind:value={hermesProvider} placeholder="optional" spellcheck="false" />
            <label for="majordomo-timeout">Timeout minutes</label>
            <input id="majordomo-timeout" class="majordomo-input" type="number" min="1" max="240" bind:value={runtimeTimeoutMinutes} />
          </div>
          <p class="runtime-command">{runtime.command}</p>
          <div class="majordomo-button-row">
            <button
              type="button"
              data-testid="majordomo-start-runtime"
              disabled={runtimeLaunching || Boolean(runtimeInstance)}
              on:click={startMajordomoRuntime}
            >
              {runtimeLaunching ? 'Launching...' : runtimeInstance ? 'Bound' : 'Start Majordomo'}
            </button>
            <button type="button" disabled={runtimeStopping || (!runtimeInstance && !runtimePty)} on:click={stopMajordomoRuntime}>
              {runtimeStopping ? 'Stopping...' : 'Stop'}
            </button>
          </div>
          {#if runtimeMessage}
            <p class="majordomo-status">{runtimeMessage}</p>
          {/if}
        </section>
      {:else if activeTab === 'broadcast'}
        <section class="majordomo-body">
          <label for="majordomo-broadcast">Broadcast to current channel</label>
          <textarea
            id="majordomo-broadcast"
            bind:value={broadcastText}
            rows="4"
            placeholder="Architect note for every agent..."
          ></textarea>
          <button type="button" disabled={sending} on:click={sendBroadcast}>
            {sending ? 'Sending...' : 'Broadcast'}
          </button>
          {#if statusText}
            <p class="majordomo-status">{statusText}</p>
          {/if}
          <div class="majordomo-feed">
            {#each recentMessages as message (message.id)}
              <article>
                <span>{shortId(message.sender)} → {message.recipient ? shortId(message.recipient) : 'all'}</span>
                <p>{message.content}</p>
              </article>
            {/each}
          </div>
        </section>
      {:else if activeTab === 'debugger'}
        <section class="majordomo-body">
          <div class="majordomo-list">
            <article>
              <strong>Idle but online</strong>
              <span>{idleAgents.length} agent{idleAgents.length === 1 ? '' : 's'} without active assigned work.</span>
            </article>
            <article>
              <strong>Blocked work</strong>
              <span>{blockedTasks.length} task{blockedTasks.length === 1 ? '' : 's'} need planner/operator attention.</span>
            </article>
            <article>
              <strong>Adopting placeholders</strong>
              <span>{adoptingAgents.length} node{adoptingAgents.length === 1 ? '' : 's'} waiting for register adoption.</span>
            </article>
          </div>
          <div class="majordomo-feed">
            {#each recentEvents as event (event.id)}
              <article>
                <span>{event.type} · {formatAgo(event.created_at)} ago</span>
                <p>{event.subject ?? event.actor ?? 'system event'}</p>
              </article>
            {/each}
          </div>
        </section>
      {:else}
        <section class="majordomo-body majordomo-host">
          <div class="majordomo-model-controls">
            <label for="majordomo-model-path">Host model path</label>
            <input id="majordomo-model-path" class="majordomo-input" bind:value={modelPathDraft} spellcheck="false" />
            <div>
              <button type="button" on:click={applyModelPath}>Load model</button>
              <button type="button" on:click={useCaduceusModel}>Use caduceus</button>
            </div>
          </div>
          <div
            class="pyramid-stage"
            style={`--drag-x:${dragX}px; --drag-y:${dragY}px; --host-yaw:${hostYaw}deg; --host-pitch:${hostPitch}deg; --host-lift:${hostLift}px;`}
            role="application"
            aria-label="Draggable Pyramid AI Host"
            on:pointerdown={beginDrag}
            on:pointermove={moveDrag}
            on:pointerup={endDrag}
            on:pointercancel={endDrag}
            on:dblclick={resetHostPose}
          >
            {#if modelSrc && !modelIsImage}
              <model class="pyramid-usdz" src={modelSrc} aria-label="Pyramid AI Host USDZ source"></model>
            {/if}
            <div class="caduceus-stage" aria-hidden="true">
              <img src={caduceusStageSrc} alt="" />
            </div>
            <div class="pyramid-fallback" aria-hidden="true">
              <div class="pyramid-orbit"></div>
              <div class="pyramid-floor"></div>
              <div class="pyramid-rig">
                <div class="pyramid-host">
                  <div class="pyramid-side pyramid-side--back"></div>
                  <div class="pyramid-side pyramid-side--left"></div>
                  <div class="pyramid-side pyramid-side--right"></div>
                  <div class="pyramid-side pyramid-side--front">
                    <i></i><i></i><b></b><span></span>
                  </div>
                  <div class="pyramid-base"></div>
                  <div class="pyramid-pivot"></div>
                </div>
              </div>
            </div>
          </div>
          <p class="majordomo-status">{modelStatus}</p>
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .majordomo-panel {
    position: absolute;
    top: 74px;
    right: 118px;
    z-index: 86;
    color: rgba(238, 250, 255, 0.92);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    pointer-events: auto;
  }

  .majordomo-collapsed {
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(106, 216, 255, 0.35);
    border-radius: 8px;
    background:
      radial-gradient(circle at 28% 8%, rgba(0, 240, 96, 0.28), transparent 52%),
      radial-gradient(circle at 78% 18%, rgba(230, 207, 142, 0.2), transparent 50%),
      rgba(0, 0, 0, 0.84);
    color: rgba(238, 250, 255, 0.94);
    box-shadow:
      0 0 0 1px rgba(230, 207, 142, 0.1) inset,
      0 0 24px rgba(0, 240, 96, 0.16),
      0 14px 34px rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }

  .majordomo-collapsed.hidden {
    display: none;
  }

  .majordomo-collapsed span {
    font-size: 22px;
    line-height: 1;
  }

  .majordomo-collapsed strong {
    font-size: 10px;
    letter-spacing: 0.08em;
  }

  .majordomo-card {
    width: 344px;
    max-height: min(620px, calc(100vh - 148px));
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 8px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 24%),
      rgba(0, 0, 0, 0.9);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 20px 52px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    backdrop-filter: blur(22px) saturate(1.16);
    -webkit-backdrop-filter: blur(22px) saturate(1.16);
  }

  .majordomo-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }

  .majordomo-header span,
  .majordomo-metrics em,
  .majordomo-list span,
  .majordomo-feed span,
  .majordomo-body label {
    color: rgba(238, 250, 255, 0.52);
    font-size: 9.5px;
    font-style: normal;
    font-weight: 850;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .majordomo-header strong {
    display: block;
    margin-top: 3px;
    font-size: 14px;
    letter-spacing: 0;
  }

  .majordomo-header button,
  .majordomo-tabs button,
  .majordomo-body button {
    border: 1px solid rgba(106, 216, 255, 0.24);
    border-radius: 5px;
    background: rgba(106, 216, 255, 0.08);
    color: rgba(238, 250, 255, 0.88);
    cursor: pointer;
  }

  .majordomo-header button {
    width: 28px;
    height: 28px;
  }

  .majordomo-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .majordomo-tabs button {
    height: 28px;
    font-size: 9px;
    font-weight: 850;
  }

  .majordomo-tabs button.active {
    border-color: rgba(106, 216, 255, 0.58);
    background: rgba(106, 216, 255, 0.18);
  }

  .majordomo-body {
    min-height: 0;
    padding: 10px;
    display: grid;
    gap: 10px;
    overflow: auto;
  }

  .majordomo-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }

  .majordomo-metrics span,
  .majordomo-list article,
  .majordomo-feed article {
    min-width: 0;
    padding: 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.045);
  }

  .majordomo-metrics strong,
  .majordomo-list strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }

  .majordomo-list,
  .majordomo-feed {
    display: grid;
    gap: 7px;
  }

  .majordomo-list p,
  .majordomo-feed p,
  .majordomo-status {
    margin: 0;
    color: rgba(238, 250, 255, 0.7);
    font-size: 11px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .majordomo-body textarea {
    width: 100%;
    resize: vertical;
    min-height: 86px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 7px;
    padding: 9px;
    background: rgba(0, 0, 0, 0.34);
    color: rgba(238, 250, 255, 0.9);
    font: inherit;
  }

  .majordomo-body > button {
    height: 34px;
    font-weight: 850;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .majordomo-host {
    place-items: center;
  }

  .pyramid-stage {
    width: 230px;
    height: 220px;
    position: relative;
    display: grid;
    place-items: center;
    cursor: grab;
    perspective: 720px;
    transform: translate(var(--drag-x), var(--drag-y));
    touch-action: none;
  }

  .pyramid-stage:active {
    cursor: grabbing;
  }

  .pyramid-usdz {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    z-index: 2;
  }

  .pyramid-fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 1;
  }

  .pyramid-host {
    width: 128px;
    height: 158px;
    position: relative;
    transform-style: preserve-3d;
    transform-origin: 50% 96%;
    animation: majordomo-pivot 6s ease-in-out infinite;
  }

  .pyramid-side {
    position: absolute;
    left: 14px;
    top: 8px;
    width: 100px;
    height: 120px;
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    border: 1px solid rgba(106, 216, 255, 0.28);
    background: linear-gradient(165deg, rgba(106, 216, 255, 0.92), rgba(15, 26, 38, 0.96));
    transform-origin: 50% 100%;
  }

  .pyramid-side--front {
    transform: rotateX(0deg) translateZ(22px);
  }

  .pyramid-side--back {
    opacity: 0.5;
    transform: rotateY(180deg) translateZ(22px);
  }

  .pyramid-side--left {
    opacity: 0.78;
    transform: rotateY(-90deg) translateZ(50px);
  }

  .pyramid-side--right {
    opacity: 0.78;
    transform: rotateY(90deg) translateZ(50px);
  }

  .pyramid-side--front i {
    position: absolute;
    top: 64px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.86);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.36);
  }

  .pyramid-side--front i:first-child {
    left: 35px;
  }

  .pyramid-side--front i:nth-child(2) {
    right: 35px;
  }

  .pyramid-side--front b {
    position: absolute;
    left: 42px;
    top: 84px;
    width: 18px;
    height: 7px;
    border-bottom: 2px solid rgba(0, 0, 0, 0.78);
    border-radius: 50%;
  }

  .pyramid-base {
    position: absolute;
    left: 31px;
    bottom: 0;
    width: 66px;
    height: 66px;
    border: 1px solid rgba(106, 216, 255, 0.34);
    background: rgba(7, 18, 26, 0.9);
    transform: rotateX(86deg);
    transform-origin: 50% 50%;
  }

  .pyramid-pivot {
    position: absolute;
    left: 61px;
    bottom: 24px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e8fbff;
    box-shadow: 0 0 12px rgba(106, 216, 255, 0.8);
  }

  @keyframes majordomo-pivot {
    0%, 100% { transform: rotateX(-10deg) rotateY(-16deg); }
    50% { transform: rotateX(-10deg) rotateY(16deg); }
  }

	  .majordomo-panel {
	    --majordomo-ink: rgba(255, 244, 204, 0.96);
	    --majordomo-muted: rgba(208, 158, 72, 0.72);
	    --majordomo-cyan: #d9a23a;
	    --majordomo-green: #ffd44f;
	    --majordomo-amber: #b96e2c;
	    --majordomo-red: var(--edge-task-failed, #f38ba8);
	    --majordomo-glass: rgba(12, 13, 13, 0.82);
    position: fixed;
    top: max(42px, env(safe-area-inset-top));
    right: max(104px, env(safe-area-inset-right));
    z-index: 94;
    color: var(--majordomo-ink);
    pointer-events: none;
    transform: translate(var(--tweak-majordomo-button-x, 0px), var(--tweak-majordomo-button-y, 0px));
  }

  .majordomo-collapsed,
  .majordomo-card {
    pointer-events: auto;
  }

	  .majordomo-collapsed {
	    position: relative;
	    width: 190px;
	    height: 46px;
	    grid-template-columns: 34px minmax(0, 1fr) 22px;
	    gap: 8px;
	    padding: 0 10px;
	    border-color: color-mix(in srgb, var(--majordomo-green) 58%, transparent);
	    border-radius: 8px;
	    background:
	      linear-gradient(90deg, color-mix(in srgb, var(--majordomo-amber) 20%, transparent), transparent 22%, transparent 78%, color-mix(in srgb, var(--majordomo-amber) 18%, transparent)),
	      rgba(12, 13, 13, 0.76);
	    box-shadow:
	      0 0 0 1px color-mix(in srgb, var(--majordomo-green) 14%, transparent) inset,
	      0 0 28px color-mix(in srgb, var(--majordomo-green) 22%, transparent),
	      0 18px 50px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    transition:
      border-color 0.16s ease,
      box-shadow 0.16s ease,
      transform 0.16s ease;
  }

  .majordomo-collapsed::before,
  .majordomo-collapsed::after {
    content: "";
    position: absolute;
    pointer-events: none;
  }

	  .majordomo-collapsed::before {
	    inset: 0 11px;
	    border-top: 1px solid color-mix(in srgb, var(--majordomo-green) 74%, transparent);
	    border-bottom: 1px solid color-mix(in srgb, var(--majordomo-amber) 48%, transparent);
	    border-radius: 7px;
	    box-shadow:
	      -10px 0 0 -9px color-mix(in srgb, var(--majordomo-green) 78%, transparent),
	      10px 0 0 -9px color-mix(in srgb, var(--majordomo-green) 78%, transparent);
	  }

	  .majordomo-collapsed::after {
	    left: 16px;
	    right: 16px;
	    top: 7px;
	    height: 1px;
	    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--majordomo-green) 86%, transparent), transparent);
	    opacity: 0.8;
	  }

  .majordomo-collapsed:hover {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 88%, white 12%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--majordomo-cyan) 24%, transparent) inset,
      0 0 34px color-mix(in srgb, var(--majordomo-cyan) 46%, transparent),
      0 22px 54px rgba(0, 0, 0, 0.58);
    transform: translateY(-1px);
  }

	  .majordomo-sigil {
	    position: relative;
	    z-index: 1;
	    width: 28px;
	    height: 28px;
    display: grid;
    place-items: center;
    line-height: 1;
	    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--majordomo-green) 70%, transparent));
	  }

	  .majordomo-eye {
	    display: block;
	    font-size: 21px;
	    line-height: 1;
	  }

	  .majordomo-collapsed .majordomo-collapsed-copy {
	    position: relative;
	    z-index: 1;
	    overflow: hidden;
	    color: var(--majordomo-green);
	    font-size: 11px;
	    font-weight: 800;
	    letter-spacing: 0.08em;
	    text-transform: uppercase;
	    text-overflow: ellipsis;
	    white-space: nowrap;
	    text-shadow: 0 0 12px color-mix(in srgb, var(--majordomo-green) 54%, transparent);
	  }

	  .majordomo-collapsed strong {
	    position: relative;
	    right: auto;
	    bottom: auto;
	    z-index: 1;
    min-width: 17px;
    height: 17px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--majordomo-green) 68%, transparent);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.64);
    color: var(--majordomo-green);
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0;
  }

  .majordomo-card {
    position: relative;
    width: min(382px, calc(100vw - 28px));
    max-height: calc(100vh - 36px);
    border-color: color-mix(in srgb, var(--majordomo-cyan) 46%, rgba(255, 255, 255, 0.16));
    background:
      radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--majordomo-cyan) 28%, transparent), transparent 38%),
      radial-gradient(circle at 0% 70%, color-mix(in srgb, var(--majordomo-red) 12%, transparent), transparent 46%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 24%),
      var(--majordomo-glass);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--majordomo-cyan) 12%, transparent) inset,
      0 0 34px color-mix(in srgb, var(--majordomo-cyan) 22%, transparent),
      0 26px 72px rgba(0, 0, 0, 0.62);
    clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
  }

  .majordomo-card::before,
  .majordomo-card::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .majordomo-card::before {
    background:
      linear-gradient(color-mix(in srgb, var(--majordomo-cyan) 13%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--majordomo-cyan) 10%, transparent) 1px, transparent 1px);
    background-size: 28px 28px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.72), transparent 72%);
    opacity: 0.54;
  }

  .majordomo-card::after {
    inset: 1px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
  }

  .majordomo-header,
  .majordomo-tabs,
  .majordomo-body {
    position: relative;
    z-index: 1;
  }

  .majordomo-header {
    padding: 12px 12px 11px;
    border-bottom-color: color-mix(in srgb, var(--majordomo-cyan) 24%, transparent);
  }

  .majordomo-title {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .majordomo-mark {
    position: relative;
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--majordomo-cyan) 56%, transparent);
    border-radius: 6px;
    font-size: 20px;
    line-height: 1;
    background:
      radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--majordomo-green) 26%, transparent), transparent 60%),
      rgba(0, 0, 0, 0.36);
    box-shadow: inset 0 0 16px color-mix(in srgb, var(--majordomo-cyan) 18%, transparent);
  }

  .majordomo-header span,
  .majordomo-metrics em,
  .majordomo-list span,
  .majordomo-feed span,
  .majordomo-body label {
    color: var(--majordomo-muted);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0;
  }

  .majordomo-header strong {
    overflow: hidden;
    color: var(--majordomo-ink);
    font-size: 15px;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .majordomo-header button,
  .majordomo-tabs button,
  .majordomo-body button {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 28%, transparent);
    background: color-mix(in srgb, var(--majordomo-cyan) 10%, rgba(0, 0, 0, 0.4));
    color: color-mix(in srgb, var(--majordomo-ink) 92%, var(--majordomo-cyan) 8%);
    font-family: inherit;
    letter-spacing: 0;
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease,
      color 0.15s ease;
  }

  .majordomo-header button:hover,
  .majordomo-tabs button:hover,
  .majordomo-body button:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 64%, white 10%);
    background: color-mix(in srgb, var(--majordomo-cyan) 18%, rgba(0, 0, 0, 0.42));
    box-shadow: 0 0 14px color-mix(in srgb, var(--majordomo-cyan) 22%, transparent);
  }

  .majordomo-tabs {
    border-bottom-color: color-mix(in srgb, var(--majordomo-cyan) 18%, transparent);
  }

  .majordomo-tabs button {
    min-width: 0;
    height: 30px;
    padding: 0 4px;
    overflow: hidden;
    font-size: 10px;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .majordomo-tabs button.active {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 76%, white 12%);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--majordomo-cyan) 24%, transparent), transparent),
      rgba(0, 0, 0, 0.44);
    color: #ffffff;
    box-shadow:
      inset 0 -1px 0 color-mix(in srgb, var(--majordomo-green) 42%, transparent),
      0 0 18px color-mix(in srgb, var(--majordomo-cyan) 20%, transparent);
  }

  .majordomo-body {
    padding: 11px;
  }

  .majordomo-metrics span,
  .majordomo-list article,
  .majordomo-feed article {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 17%, rgba(255, 255, 255, 0.1));
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.055), transparent 48%),
      rgba(0, 0, 0, 0.24);
    box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.018);
  }

  .majordomo-metrics strong,
  .majordomo-list strong {
    color: #ffffff;
    letter-spacing: 0;
  }

  .majordomo-metrics span:nth-child(1) strong {
    color: var(--majordomo-green);
  }

  .majordomo-metrics span:nth-child(3) strong {
    color: var(--majordomo-amber);
  }

  .majordomo-metrics span:nth-child(4) strong {
    color: var(--majordomo-cyan);
  }

  .majordomo-list p,
  .majordomo-feed p,
  .majordomo-status {
    color: color-mix(in srgb, var(--majordomo-ink) 74%, transparent);
  }

  .majordomo-body textarea {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 22%, rgba(255, 255, 255, 0.1));
    background: rgba(0, 0, 0, 0.38);
    color: var(--majordomo-ink);
    outline: none;
  }

  .majordomo-body textarea:focus {
    border-color: color-mix(in srgb, var(--majordomo-cyan) 66%, white 8%);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--majordomo-cyan) 18%, transparent);
  }

  .majordomo-body > button {
    letter-spacing: 0;
  }

  .majordomo-body > button:disabled {
    cursor: wait;
    opacity: 0.64;
  }

	  .majordomo-host {
	    gap: 8px;
	  }

	  .majordomo-model-controls {
	    display: grid;
	    gap: 7px;
	    border: 1px solid color-mix(in srgb, var(--majordomo-green) 22%, transparent);
	    border-radius: 8px;
	    background: rgba(0, 0, 0, 0.2);
	    padding: 8px;
	  }

	  .majordomo-model-controls div {
	    display: flex;
	    gap: 7px;
	    flex-wrap: wrap;
	  }

	  .majordomo-input {
	    width: 100%;
	    box-sizing: border-box;
	    border: 1px solid color-mix(in srgb, var(--majordomo-green) 24%, rgba(255, 255, 255, 0.1));
	    border-radius: 7px;
	    background: rgba(0, 0, 0, 0.42);
	    color: var(--majordomo-ink);
	    font: inherit;
	    font-size: 10px;
	    padding: 7px 8px;
	    outline: none;
	  }

	  .majordomo-input:focus {
	    border-color: color-mix(in srgb, var(--majordomo-green) 68%, white 8%);
	    box-shadow: 0 0 0 2px color-mix(in srgb, var(--majordomo-green) 14%, transparent);
	  }

  .majordomo-button-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
  }

  .majordomo-button-row button,
  .majordomo-tweak-row button {
    min-height: 32px;
    font-size: 9.5px;
    font-weight: 850;
    text-transform: uppercase;
  }

  .majordomo-button-row button:disabled,
  .majordomo-tweak-row button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .majordomo-tweak-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 74px;
    gap: 7px;
  }

  .runtime-pill,
  .runtime-card {
    min-width: 0;
    padding: 9px;
    border: 1px solid color-mix(in srgb, var(--majordomo-green) 34%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, var(--majordomo-green) 9%, transparent);
  }

  .runtime-pill {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 5px 8px;
    align-items: center;
  }

  .runtime-pill span,
  .runtime-card span {
    color: var(--majordomo-muted);
    font-size: 9.5px;
    font-weight: 850;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .runtime-pill strong,
  .runtime-card strong {
    color: var(--majordomo-green);
    font-size: 13px;
    text-transform: uppercase;
  }

  .runtime-pill em {
    grid-column: 1 / -1;
    overflow: hidden;
    color: rgba(255, 244, 204, 0.62);
    font-size: 10px;
    font-style: normal;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .runtime-card p,
  .runtime-command {
    margin: 5px 0 0;
    color: rgba(255, 244, 204, 0.68);
    font-size: 10px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .runtime-fields {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 7px;
    align-items: center;
  }

	  .pyramid-stage {
    --drag-x: 0px;
    --drag-y: 0px;
    --host-yaw: -8deg;
    --host-pitch: -9deg;
    --host-lift: 0px;
    width: min(318px, 100%);
    height: 276px;
    perspective: 820px;
    transform: none;
    border: 1px solid color-mix(in srgb, var(--majordomo-cyan) 20%, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background:
      radial-gradient(circle at 50% 44%, color-mix(in srgb, var(--majordomo-cyan) 22%, transparent), transparent 38%),
      radial-gradient(circle at 50% 78%, color-mix(in srgb, var(--majordomo-green) 16%, transparent), transparent 30%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(0, 0, 0, 0.24)),
      rgba(0, 0, 0, 0.3);
    box-shadow:
      inset 0 0 42px rgba(0, 0, 0, 0.42),
      inset 0 0 0 1px rgba(255, 255, 255, 0.04);
    user-select: none;
	    overflow: hidden;
	  }

	  .caduceus-stage {
	    position: absolute;
	    left: 50%;
	    top: 34px;
	    z-index: 3;
	    width: 132px;
	    height: 156px;
	    transform:
	      translate3d(calc(-50% + var(--drag-x)), calc(var(--drag-y) - var(--host-lift)), 36px)
	      rotateX(var(--host-pitch))
	      rotateY(calc(var(--host-yaw) + 180deg));
	    transform-style: preserve-3d;
	    animation: caduceus-rotate 9s linear infinite;
	    filter:
	      drop-shadow(0 0 12px color-mix(in srgb, var(--majordomo-green) 58%, transparent))
	      drop-shadow(0 22px 22px rgba(0, 0, 0, 0.48));
	    pointer-events: none;
	  }

	  .caduceus-stage img {
	    width: 100%;
	    height: 100%;
	    border-radius: 8px;
	    object-fit: contain;
	    mix-blend-mode: screen;
	    opacity: 0.92;
	  }

  .pyramid-stage:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--majordomo-cyan) 76%, white 10%);
    outline-offset: 2px;
  }

  .pyramid-usdz {
    inset: 12px;
    opacity: 0.2;
    pointer-events: none;
    z-index: 1;
    filter: drop-shadow(0 0 24px color-mix(in srgb, var(--majordomo-cyan) 32%, transparent));
  }

  .pyramid-fallback {
    z-index: 2;
    pointer-events: none;
  }

  .pyramid-orbit,
  .pyramid-floor {
    position: absolute;
    left: 50%;
    pointer-events: none;
  }

  .pyramid-orbit {
    top: 24px;
    width: 226px;
    height: 226px;
    border: 1px solid color-mix(in srgb, var(--majordomo-cyan) 20%, transparent);
    border-radius: 50%;
    transform: translateX(-50%) rotateX(66deg);
    box-shadow:
      inset 0 0 22px color-mix(in srgb, var(--majordomo-cyan) 18%, transparent),
      0 0 24px color-mix(in srgb, var(--majordomo-cyan) 14%, transparent);
  }

  .pyramid-orbit::before,
  .pyramid-orbit::after {
    content: "";
    position: absolute;
    inset: 22px;
    border-radius: 50%;
    border: 1px dashed color-mix(in srgb, var(--majordomo-green) 34%, transparent);
  }

  .pyramid-orbit::after {
    inset: 51px;
    border-style: solid;
    border-color: color-mix(in srgb, var(--majordomo-amber) 24%, transparent);
    animation: majordomo-spin 9s linear infinite reverse;
  }

  .pyramid-floor {
    bottom: 34px;
    width: 214px;
    height: 66px;
    border: 1px solid color-mix(in srgb, var(--majordomo-cyan) 18%, transparent);
    border-radius: 50%;
    background:
      radial-gradient(ellipse at center, color-mix(in srgb, var(--majordomo-cyan) 16%, transparent), transparent 58%),
      repeating-linear-gradient(90deg, transparent 0 13px, color-mix(in srgb, var(--majordomo-cyan) 16%, transparent) 14px 15px);
    transform: translateX(-50%);
    filter: blur(0.1px);
  }

  .pyramid-rig {
    position: absolute;
    left: 50%;
    bottom: 53px;
    width: 176px;
    height: 176px;
    transform:
      translate3d(calc(-50% + var(--drag-x)), calc(var(--drag-y) - var(--host-lift)), 0)
      rotateX(var(--host-pitch))
      rotateY(var(--host-yaw));
    transform-origin: 50% 100%;
    transform-style: preserve-3d;
    transition: transform 0.08s linear;
  }

  .pyramid-host {
    width: 176px;
    height: 176px;
    transform-origin: 50% 100%;
    animation: majordomo-host-pulse 3.8s ease-in-out infinite;
    filter:
      drop-shadow(0 0 18px color-mix(in srgb, var(--majordomo-cyan) 52%, transparent))
      drop-shadow(0 26px 22px rgba(0, 0, 0, 0.52));
  }

  .pyramid-side {
    left: 27px;
    top: 10px;
    width: 122px;
    height: 138px;
    border-color: color-mix(in srgb, var(--majordomo-cyan) 38%, transparent);
    background:
      linear-gradient(150deg, rgba(255, 255, 255, 0.72), color-mix(in srgb, var(--majordomo-cyan) 74%, rgba(15, 26, 38, 0.92)) 48%, rgba(3, 9, 16, 0.98)),
      linear-gradient(90deg, transparent, color-mix(in srgb, var(--majordomo-green) 18%, transparent));
    box-shadow: inset 0 -28px 40px rgba(0, 0, 0, 0.34);
    backface-visibility: hidden;
  }

  .pyramid-side--front {
    z-index: 4;
    border-color: color-mix(in srgb, var(--majordomo-cyan) 76%, white 10%);
    background:
      linear-gradient(150deg, rgba(255, 255, 255, 0.84), color-mix(in srgb, var(--majordomo-cyan) 82%, rgba(15, 26, 38, 0.96)) 48%, rgba(2, 6, 11, 0.98)),
      repeating-linear-gradient(180deg, transparent 0 13px, color-mix(in srgb, var(--majordomo-cyan) 10%, transparent) 14px 15px);
    transform: translateZ(43px) rotateX(-2deg);
  }

  .pyramid-side--back {
    opacity: 0.42;
    transform: rotateY(180deg) translateZ(43px);
  }

  .pyramid-side--left {
    opacity: 0.68;
    background: linear-gradient(160deg, color-mix(in srgb, var(--majordomo-cyan) 42%, transparent), rgba(2, 6, 12, 0.96));
    transform: rotateY(-64deg) translateZ(38px) translateX(-26px);
  }

  .pyramid-side--right {
    opacity: 0.76;
    background: linear-gradient(205deg, color-mix(in srgb, var(--majordomo-amber) 32%, transparent), color-mix(in srgb, var(--majordomo-cyan) 46%, transparent), rgba(2, 7, 13, 0.98));
    transform: rotateY(64deg) translateZ(38px) translateX(26px);
  }

  .pyramid-side--front i {
    top: 73px;
    width: 10px;
    height: 10px;
    border: 1px solid color-mix(in srgb, var(--majordomo-green) 58%, transparent);
    box-shadow:
      0 0 0 2px rgba(255, 255, 255, 0.1),
      0 0 12px color-mix(in srgb, var(--majordomo-green) 70%, transparent);
  }

  .pyramid-side--front i:first-child {
    left: 42px;
  }

  .pyramid-side--front i:nth-child(2) {
    right: 42px;
  }

  .pyramid-side--front b {
    left: 50%;
    top: 96px;
    width: 28px;
    height: 8px;
    transform: translateX(-50%);
  }

  .pyramid-side--front span {
    position: absolute;
    left: 50%;
    top: 36px;
    width: 1px;
    height: 82px;
    background: linear-gradient(transparent, rgba(255, 255, 255, 0.5), transparent);
    transform: translateX(-50%);
  }

  .pyramid-base {
    left: 50%;
    bottom: 5px;
    width: 92px;
    height: 92px;
    border-color: color-mix(in srgb, var(--majordomo-cyan) 46%, transparent);
    background:
      radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--majordomo-green) 14%, transparent), transparent 60%),
      rgba(4, 13, 20, 0.96);
    transform: translateX(-50%) rotateX(78deg) translateZ(-26px);
    box-shadow:
      inset 0 0 18px color-mix(in srgb, var(--majordomo-cyan) 16%, transparent),
      0 0 16px color-mix(in srgb, var(--majordomo-cyan) 16%, transparent);
  }

  .pyramid-pivot {
    left: 50%;
    bottom: 15px;
    width: 12px;
    height: 12px;
    border: 1px solid rgba(255, 255, 255, 0.78);
    background: color-mix(in srgb, var(--majordomo-amber) 66%, #ffffff 34%);
    box-shadow:
      0 0 0 6px color-mix(in srgb, var(--majordomo-amber) 12%, transparent),
      0 0 18px color-mix(in srgb, var(--majordomo-amber) 74%, transparent);
    transform: translateX(-50%) translateZ(4px);
  }

  :global([data-theme="tron-encom-os"]) .majordomo-panel {
    --majordomo-ink: var(--fg-primary, #ffffff);
    --majordomo-muted: var(--fg-secondary, rgba(255, 255, 255, 0.68));
    --majordomo-cyan: var(--led-line-x, #ffffff);
    --majordomo-glass: color-mix(in srgb, var(--bg-base, #000000) 88%, transparent);
  }

  :global([data-theme="tron-encom-os"]) .majordomo-card,
  :global([data-theme="tron-encom-os"]) .majordomo-collapsed,
  :global([data-theme="tron-encom-os"]) .pyramid-stage,
  :global([data-theme="tron-encom-os"]) .majordomo-metrics span,
  :global([data-theme="tron-encom-os"]) .majordomo-list article,
  :global([data-theme="tron-encom-os"]) .majordomo-feed article {
    border-radius: 0;
  }

  :global([data-theme="liquid-glass-warm"]) .majordomo-panel {
    --majordomo-cyan: #ffc56f;
    --majordomo-green: #ffe0a8;
    --majordomo-amber: #ff9a43;
    --majordomo-red: #ff6f91;
    --majordomo-glass: rgba(20, 10, 4, 0.64);
  }

  :global([data-theme="liquid-glass-cool"]) .majordomo-panel,
  :global([data-theme="liquid-glass-warm"]) .majordomo-panel {
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
  }

  @keyframes majordomo-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes caduceus-rotate {
    from {
      transform:
        translate3d(calc(-50% + var(--drag-x)), calc(var(--drag-y) - var(--host-lift)), 36px)
        rotateX(var(--host-pitch))
        rotateY(calc(var(--host-yaw) + 0deg));
    }
    to {
      transform:
        translate3d(calc(-50% + var(--drag-x)), calc(var(--drag-y) - var(--host-lift)), 36px)
        rotateX(var(--host-pitch))
        rotateY(calc(var(--host-yaw) + 360deg));
    }
  }

  @keyframes majordomo-host-pulse {
    0%, 100% {
      filter:
        drop-shadow(0 0 18px color-mix(in srgb, var(--majordomo-cyan) 52%, transparent))
        drop-shadow(0 26px 22px rgba(0, 0, 0, 0.52));
    }
    50% {
      filter:
        drop-shadow(0 0 26px color-mix(in srgb, var(--majordomo-cyan) 70%, transparent))
        drop-shadow(0 30px 24px rgba(0, 0, 0, 0.58));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .majordomo-collapsed::after,
    .caduceus-stage,
    .pyramid-orbit::after,
    .pyramid-host {
      animation: none;
    }
  }

  @media (max-width: 540px) {
    .majordomo-panel {
      top: 10px;
      right: 10px;
    }

    .majordomo-card {
      width: calc(100vw - 20px);
    }

    .pyramid-stage {
      height: 246px;
    }
  }
</style>
