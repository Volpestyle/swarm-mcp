<script lang="ts">
  import type { AgentCardMode } from '../lib/types';

  export let active: AgentCardMode = 'overview';
  export let hasTerminal = false;
  export let setMode: (mode: AgentCardMode) => void;

  const modes: AgentCardMode[] = ['overview', 'terminal', 'tasks', 'context', 'history'];
  const labels: Record<AgentCardMode, string> = {
    overview: 'Deck',
    terminal: 'Term',
    tasks: 'Tasks',
    context: 'Context',
    history: 'Pulse',
  };

  function disabled(mode: AgentCardMode): boolean {
    return mode === 'terminal' && !hasTerminal;
  }
</script>

<div class="agent-mode-tabs" role="tablist" aria-label="Agent views">
  {#each modes as mode (mode)}
    <button
      type="button"
      role="tab"
      class:active={active === mode}
      aria-selected={active === mode}
      disabled={disabled(mode)}
      on:click={() => setMode(mode)}
    >
      {labels[mode]}
    </button>
  {/each}
</div>
