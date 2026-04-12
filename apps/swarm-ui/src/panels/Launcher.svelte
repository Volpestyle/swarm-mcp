<!--
  Launcher.svelte — Agent/shell spawn controls

  - "Spawn Shell" button with cwd input
  - "Spawn Agent" section with role preset dropdown, working directory,
    scope, custom label, and launch button
  - Shows list of pending (unbound) PTY sessions with their tokens
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { onMount } from 'svelte';
  import type { RolePresetSummary } from '../lib/types';
  import {
    spawnAgent,
    spawnShell,
    getRolePresets,
    unboundPtySessions,
  } from '../stores/pty';

  // Form state
  let role: string = '';
  let workingDir: string = '';
  let scope: string = '';
  let label: string = '';
  let customCommand: string = '';
  let shellCwd: string = '';

  // Available presets
  let rolePresets: RolePresetSummary[] = [];
  let loading = false;
  let error: string | null = null;

  const dispatch = createEventDispatcher<{ settings: void }>();

  // Determine if we're using a custom command vs a preset
  $: isCustomRole = role === 'custom';

  onMount(async () => {
    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[Launcher] failed to load role presets:', err);
      // Fall back to hardcoded defaults
      rolePresets = [
        { role: 'planner', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'implementer', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'reviewer', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'researcher', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
      ];
    }
  });

  async function handleSpawnAgent() {
    if (!workingDir) {
      error = 'Working directory is required';
      return;
    }

    loading = true;
    error = null;

    try {
      await spawnAgent(
        isCustomRole ? null : role || null,
        workingDir,
        scope || undefined,
        label || undefined,
        isCustomRole ? customCommand || undefined : undefined,
      );
      // Reset form on success
      role = '';
      scope = '';
      label = '';
      customCommand = '';
    } catch (err) {
      error = `Failed to spawn agent: ${err}`;
      console.error('[Launcher] spawn error:', err);
    } finally {
      loading = false;
    }
  }

  async function handleSpawnShell() {
    const cwd = shellCwd || workingDir;
    if (!cwd) {
      error = 'Working directory is required for shell launch';
      return;
    }

    loading = true;
    error = null;

    try {
      await spawnShell(cwd);
      shellCwd = '';
    } catch (err) {
      error = `Failed to spawn shell: ${err}`;
      console.error('[Launcher] shell error:', err);
    } finally {
      loading = false;
    }
  }

  function openSettings() {
    dispatch('settings');
  }
</script>

<div class="launcher">
  <div class="launcher-header">
    <span class="launcher-title">Launch</span>
    <button type="button" class="launcher-settings-btn" on:click={openSettings}>
      Settings
    </button>
  </div>

  <div class="launcher-body">
    <!-- Shell spawn section -->
    <section>
      <div class="shell-row">
        <input
          type="text"
          class="input"
          placeholder="CWD for shell (defaults to working dir)"
          bind:value={shellCwd}
        />
        <button
          class="btn btn-secondary"
          on:click={handleSpawnShell}
          disabled={loading}
        >
          Shell
        </button>
      </div>
    </section>

    <!-- Agent spawn section -->
    <section>
      <h4>Spawn Agent</h4>

      <div class="form-group">
        <label for="role-select">Role</label>
        <select id="role-select" class="input" bind:value={role}>
          <option value="">-- Select role --</option>
          {#each rolePresets as preset (preset.role)}
            <option value={preset.role}>{preset.role}</option>
          {/each}
          <option value="custom">Custom command...</option>
        </select>
      </div>

      {#if isCustomRole}
        <div class="form-group">
          <label for="custom-cmd">Command</label>
          <input
            id="custom-cmd"
            type="text"
            class="input"
            placeholder="e.g., claude --model opus"
            bind:value={customCommand}
          />
        </div>
      {/if}

      <div class="form-group">
        <label for="working-dir">Working Directory</label>
        <input
          id="working-dir"
          type="text"
          class="input"
          placeholder="/path/to/project"
          bind:value={workingDir}
        />
      </div>

      <div class="form-group">
        <label for="scope-input">Scope <span class="optional">(optional)</span></label>
        <input
          id="scope-input"
          type="text"
          class="input"
          placeholder="Auto-detected if empty"
          bind:value={scope}
        />
      </div>

      <div class="form-group">
        <label for="label-input">Label Tokens <span class="optional">(optional)</span></label>
        <input
          id="label-input"
          type="text"
          class="input"
          placeholder="e.g., frontend:auth"
          bind:value={label}
        />
      </div>

      <button
        class="btn btn-primary"
        on:click={handleSpawnAgent}
        disabled={loading || (!role && !customCommand)}
      >
        {loading ? 'Launching...' : 'Launch Agent'}
      </button>

      {#if error}
        <div class="error-msg">{error}</div>
      {/if}
    </section>

    <!-- Pending PTY sessions -->
    {#if $unboundPtySessions.length > 0}
      <section>
        <h4>Pending ({$unboundPtySessions.length})</h4>
        <div class="pending-list">
          {#each $unboundPtySessions as pty (pty.id)}
            <div class="pending-item">
              <span class="status-dot pending"></span>
              <span class="pending-cmd">{pty.command}</span>
              {#if pty.launch_token}
                <span class="pending-token">{pty.launch_token}</span>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .launcher {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--node-border, #313244);
  }

  .launcher-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--node-border, #313244);
  }

  .launcher-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
  }

  .launcher-body {
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  h4 {
    font-size: 11px;
    font-weight: 600;
    color: #a6adc8;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0;
  }

  .shell-row {
    display: flex;
    gap: 6px;
  }

  .launcher-settings-btn {
    border: 1px solid var(--node-border, #313244);
    border-radius: 6px;
    padding: 5px 10px;
    background: var(--node-header-bg, #181825);
    color: #a6adc8;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .launcher-settings-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--terminal-fg, #c0caf5);
  }

  .shell-row .input {
    flex: 1;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .form-group label {
    font-size: 11px;
    font-weight: 500;
    color: #6c7086;
  }

  .optional {
    font-weight: 400;
    opacity: 0.6;
  }

  .input {
    width: 100%;
    padding: 5px 8px;
    background: var(--node-header-bg, #181825);
    border: 1px solid var(--node-border, #313244);
    border-radius: 4px;
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s ease;
    box-sizing: border-box;
  }

  .input:focus {
    border-color: var(--status-pending, #89b4fa);
  }

  select.input {
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236c7086'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 24px;
  }

  .btn {
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, opacity 0.15s ease;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--status-pending, #89b4fa);
    color: #1e1e2e;
  }

  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--status-pending, #89b4fa) 85%, white);
  }

  .btn-secondary {
    background: var(--node-border, #313244);
    color: var(--terminal-fg, #c0caf5);
    flex-shrink: 0;
  }

  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--node-border, #313244) 80%, white);
  }

  .error-msg {
    font-size: 11px;
    color: var(--edge-task-failed, #f38ba8);
    padding: 4px 0;
  }

  .pending-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pending-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 4px 0;
  }

  .pending-cmd {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a6adc8;
  }

  .pending-token {
    font-family: Menlo, Monaco, monospace;
    font-size: 10px;
    color: #6c7086;
    background: var(--node-header-bg, #181825);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* Reuse the status dot from terminal.css */
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.pending {
    background: var(--status-pending, #89b4fa);
    animation: pulse-dot 1.5s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
