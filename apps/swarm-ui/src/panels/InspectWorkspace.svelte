<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Annotation, Lock, Message, ProjectSpace, Task, XYFlowEdge, XYFlowNode } from '../lib/types';
  import { annotations, instances, kvEntries, locks, messages, tasks } from '../stores/swarm';
  import { formatTimestamp } from '../lib/time';
  import Inspector from './Inspector.svelte';
  import darkFolderUrl from '../assets/dark-folder.png';
  import frazierCodeTronUrl from '../assets/fraziercode-tron-2.jpg';

  export let open = false;
  export let selectedNode: XYFlowNode | null = null;
  export let selectedEdge: XYFlowEdge | null = null;
  export let projects: ProjectSpace[] = [];

  type InspectTab = 'selection' | 'search' | 'files' | 'art' | 'notes';

  type SearchResult = {
    id: string;
    type: string;
    title: string;
    detail: string;
    meta: string;
  };

  type FileResult = {
    id: string;
    path: string;
    source: string;
    color: string;
  };

  const dispatch = createEventDispatcher<{ close: void }>();

  let activeTab: InspectTab = 'selection';
  let query = '';

  $: instanceList = Array.from($instances.values());
  $: taskList = Array.from($tasks.values());
  $: fileResults = buildFileResults(taskList, projects);
  $: noteResults = projects.filter((project) => project.notes.trim().length > 0);
  $: searchResults = buildSearchResults(
    query,
    instanceList,
    taskList,
    $messages,
    $locks,
    $annotations,
  );

  function close(): void {
    dispatch('close');
  }

  function matches(value: string | null | undefined, needle: string): boolean {
    if (!needle) return true;
    return (value ?? '').toLowerCase().includes(needle);
  }

  function buildSearchResults(
    rawQuery: string,
    liveInstances: typeof instanceList,
    liveTasks: Task[],
    liveMessages: Message[],
    liveLocks: Lock[],
    liveAnnotations: Annotation[],
  ): SearchResult[] {
    const needle = rawQuery.trim().toLowerCase();
    const results: SearchResult[] = [];

    for (const instance of liveInstances) {
      if (!matches(`${instance.id} ${instance.label ?? ''} ${instance.directory} ${instance.scope}`, needle)) continue;
      results.push({
        id: `instance:${instance.id}`,
        type: 'agent',
        title: instance.label || instance.id.slice(0, 8),
        detail: instance.directory,
        meta: `${instance.status} · ${instance.scope}`,
      });
    }

    for (const task of liveTasks) {
      if (!matches(`${task.title} ${task.description ?? ''} ${(task.files ?? []).join(' ')} ${task.status}`, needle)) continue;
      results.push({
        id: `task:${task.id}`,
        type: 'task',
        title: task.title,
        detail: task.description || (task.files ?? []).join(', ') || 'No detail',
        meta: `${task.status} · ${task.scope}`,
      });
    }

    for (const message of liveMessages.slice(0, 80)) {
      if (!matches(`${message.content} ${message.sender} ${message.recipient ?? ''}`, needle)) continue;
      results.push({
        id: `message:${message.id}`,
        type: 'message',
        title: message.recipient ? 'Direct message' : 'Broadcast',
        detail: message.content,
        meta: formatTimestamp(message.created_at),
      });
    }

    for (const lock of liveLocks) {
      if (!matches(`${lock.file} ${lock.instance_id}`, needle)) continue;
      results.push({
        id: `lock:${lock.file}:${lock.instance_id}`,
        type: 'lock',
        title: lock.file,
        detail: `Locked by ${lock.instance_id.slice(0, 8)}`,
        meta: lock.scope,
      });
    }

    for (const annotation of liveAnnotations) {
      if (!matches(`${annotation.file} ${annotation.content} ${annotation.type}`, needle)) continue;
      results.push({
        id: `annotation:${annotation.id}`,
        type: annotation.type,
        title: annotation.file,
        detail: annotation.content,
        meta: annotation.scope,
      });
    }

    return results.slice(0, 96);
  }

  function buildFileResults(liveTasks: Task[], projectList: ProjectSpace[]): FileResult[] {
    const out = new Map<string, FileResult>();
    for (const project of projectList) {
      out.set(project.root, {
        id: `project-root:${project.id}`,
        path: project.root,
        source: `${project.name} root`,
        color: project.color,
      });
      for (const root of project.additionalRoots) {
        out.set(root, {
          id: `project-root:${project.id}:${root}`,
          path: root,
          source: `${project.name} extra root`,
          color: project.color,
        });
      }
    }

    for (const task of liveTasks) {
      for (const file of task.files ?? []) {
        if (out.has(file)) continue;
        out.set(file, {
          id: `task-file:${task.id}:${file}`,
          path: file,
          source: task.title,
          color: '#00f060',
        });
      }
    }
    return [...out.values()].slice(0, 120);
  }
</script>

{#if open}
  <div class="inspect-workspace">
    <button class="workspace-dismiss" type="button" aria-label="Close Inspect" on:click={close}></button>
    <div class="workspace-shell" role="dialog" aria-modal="true" aria-label="Inspect workspace">
      <header class="workspace-header">
        <div>
          <p class="eyebrow">inspect</p>
          <h2>Search the swarm surface.</h2>
          <p>Selection detail, live coordination rows, project notes, file paths, and visual references stay in one wide page.</p>
        </div>
        <button class="close-btn" type="button" on:click={close} aria-label="Close Inspect">×</button>
      </header>

      <nav class="workspace-tabs" aria-label="Inspect sections">
        <button class:active={activeTab === 'selection'} type="button" on:click={() => (activeTab = 'selection')}>Selection</button>
        <button class:active={activeTab === 'search'} type="button" on:click={() => (activeTab = 'search')}>Search</button>
        <button class:active={activeTab === 'files'} type="button" on:click={() => (activeTab = 'files')}>Files</button>
        <button class:active={activeTab === 'art'} type="button" on:click={() => (activeTab = 'art')}>Art Preview</button>
        <button class:active={activeTab === 'notes'} type="button" on:click={() => (activeTab = 'notes')}>Notes</button>
      </nav>

      {#if activeTab === 'selection'}
        <div class="selection-grid">
          <div class="selection-panel">
            <Inspector {selectedNode} {selectedEdge} />
          </div>
          <aside class="context-panel">
            <h3>Context Pulse</h3>
            <div class="metric-grid">
              <div><strong>{instanceList.length}</strong><span>agents</span></div>
              <div><strong>{taskList.length}</strong><span>tasks</span></div>
              <div><strong>{$messages.length}</strong><span>messages</span></div>
              <div><strong>{$kvEntries.length}</strong><span>kv rows</span></div>
            </div>
            <p>
              Clicking a node or edge on the graph now lands here instead of compressing detail into the small overlay.
            </p>
          </aside>
        </div>
      {:else if activeTab === 'search'}
        <div class="search-page">
          <input class="search-input" bind:value={query} placeholder="Search agents, tasks, files, messages, locks, notes..." />
          <div class="result-grid">
            {#each searchResults as result (result.id)}
              <article class="result-card">
                <span>{result.type}</span>
                <strong>{result.title}</strong>
                <p>{result.detail}</p>
                <em>{result.meta}</em>
              </article>
            {/each}
            {#if searchResults.length === 0}
              <article class="empty-card">
                <strong>No matches</strong>
                <p>Try a task title, file path, scope, agent label, or message phrase.</p>
              </article>
            {/if}
          </div>
        </div>
      {:else if activeTab === 'files'}
        <div class="file-grid">
          {#each fileResults as file (file.id)}
            <article class="file-card" style="--project-color: {file.color}">
              <img src={darkFolderUrl} alt="" />
              <div>
                <strong>{file.path}</strong>
                <span>{file.source}</span>
              </div>
            </article>
          {/each}
          {#if fileResults.length === 0}
            <article class="empty-card"><strong>No files yet</strong><p>Project roots and task files will collect here.</p></article>
          {/if}
        </div>
      {:else if activeTab === 'art'}
        <div class="art-grid">
          <article class="art-card art-card--hero">
            <img src={frazierCodeTronUrl} alt="FrazierCode Agentic Tron concept art" />
            <div>
              <strong>FrazierCode [Agentic]</strong>
              <span>Branch concept preview</span>
            </div>
          </article>
          <article class="art-card">
            <img src={darkFolderUrl} alt="Dark project folder preview" />
            <div><strong>Project folder tile</strong><span>Workspace Kit preview asset</span></div>
          </article>
        </div>
      {:else}
        <div class="note-grid">
          {#each noteResults as project (project.id)}
            <article class="note-card" style="--project-color: {project.color}">
              <span>{project.name}</span>
              <p>{project.notes}</p>
            </article>
          {/each}
          {#if noteResults.length === 0}
            <article class="empty-card"><strong>No saved notes</strong><p>Project notes will preview here once a Project Space carries context.</p></article>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .inspect-workspace {
    position: absolute;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    padding: 28px;
    background: rgba(0, 0, 0, 0.66);
    backdrop-filter: blur(12px) saturate(1.1);
  }

  .workspace-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
  }

  .workspace-shell {
    position: relative;
    z-index: 1;
    width: min(1220px, 96vw);
    height: min(820px, 90vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--node-border) 82%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--terminal-bg, #080a0d) 94%, black);
    box-shadow: 0 30px 110px rgba(0, 0, 0, 0.68);
  }

  .workspace-header {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    padding: 20px 22px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
  }

  .workspace-header h2 {
    margin: 0;
    max-width: 16ch;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 34px;
    line-height: 0.98;
  }

  .workspace-header p {
    margin: 8px 0 0;
    max-width: 74ch;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-size: 12px;
  }

  .eyebrow {
    margin: 0 0 8px;
    color: #00f060;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .close-btn {
    width: 36px;
    height: 36px;
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 8px;
    background: transparent;
    color: var(--terminal-fg, #d4d4d4);
    cursor: pointer;
    font-size: 22px;
  }

  .workspace-tabs {
    display: flex;
    gap: 8px;
    padding: 12px 22px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 64%, transparent);
    overflow-x: auto;
  }

  .workspace-tabs button {
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 8px;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    cursor: pointer;
    font: inherit;
    padding: 8px 12px;
  }

  .workspace-tabs button.active,
  .workspace-tabs button:hover {
    color: var(--terminal-fg, #d4d4d4);
    border-color: rgba(0, 240, 96, 0.58);
    background: rgba(0, 240, 96, 0.08);
  }

  .selection-grid,
  .search-page,
  .file-grid,
  .art-grid,
  .note-grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px 22px 22px;
  }

  .selection-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: 16px;
  }

  .selection-panel,
  .context-panel,
  .result-card,
  .file-card,
  .art-card,
  .note-card,
  .empty-card {
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--node-header-bg, #101318) 70%, transparent);
  }

  .selection-panel {
    min-height: 0;
    overflow: hidden;
    display: flex;
  }

  .context-panel {
    padding: 16px;
  }

  .context-panel h3,
  .empty-card strong {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
  }

  .context-panel p,
  .result-card p,
  .empty-card p,
  .note-card p {
    margin: 0;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-size: 12px;
    line-height: 1.5;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 14px 0;
  }

  .metric-grid div {
    border: 1px solid rgba(0, 240, 96, 0.22);
    border-radius: 8px;
    padding: 10px;
  }

  .metric-grid strong {
    display: block;
    color: #00f060;
    font-size: 20px;
  }

  .metric-grid span,
  .result-card span,
  .result-card em,
  .file-card span,
  .art-card span,
  .note-card span {
    color: color-mix(in srgb, var(--terminal-fg) 54%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-style: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .search-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .search-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(0, 240, 96, 0.36);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.38);
    color: var(--terminal-fg, #d4d4d4);
    font: inherit;
    padding: 12px 14px;
    outline: none;
  }

  .result-grid,
  .file-grid,
  .art-grid,
  .note-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
  }

  .result-card,
  .file-card,
  .art-card,
  .note-card,
  .empty-card {
    min-width: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .result-card strong,
  .file-card strong,
  .art-card strong {
    color: var(--terminal-fg, #d4d4d4);
    overflow-wrap: anywhere;
  }

  .file-card {
    border-left: 3px solid var(--project-color, #00f060);
    flex-direction: row;
    align-items: center;
  }

  .file-card img {
    width: 42px;
    height: 42px;
    object-fit: cover;
    background: #000;
  }

  .file-card div,
  .art-card div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .art-card img {
    width: 100%;
    height: 180px;
    object-fit: cover;
    background: #000;
  }

  .art-card--hero {
    grid-column: span 2;
  }

  .note-card {
    border-left: 3px solid var(--project-color, #00f060);
  }

  :global([data-theme="tron-encom-os"]) .workspace-shell,
  :global([data-theme="tron-encom-os"]) .selection-panel,
  :global([data-theme="tron-encom-os"]) .context-panel,
  :global([data-theme="tron-encom-os"]) .result-card,
  :global([data-theme="tron-encom-os"]) .file-card,
  :global([data-theme="tron-encom-os"]) .art-card,
  :global([data-theme="tron-encom-os"]) .note-card,
  :global([data-theme="tron-encom-os"]) .empty-card {
    border-radius: 0;
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background: var(--bg-panel, #05070a);
  }

  :global([data-theme="tron-encom-os"]) .workspace-tabs button,
  :global([data-theme="tron-encom-os"]) .close-btn,
  :global([data-theme="tron-encom-os"]) .search-input {
    border-radius: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .eyebrow,
  :global([data-theme="tron-encom-os"]) .metric-grid strong {
    color: #00f060;
    text-shadow: 0 0 12px rgba(0, 240, 96, 0.5);
  }

  @media (max-width: 900px) {
    .inspect-workspace {
      padding: 14px;
    }

    .selection-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .art-card--hero {
      grid-column: auto;
    }
  }
</style>
