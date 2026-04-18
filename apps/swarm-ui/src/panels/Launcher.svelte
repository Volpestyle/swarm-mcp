<!--
  Launcher.svelte — Agent/shell spawn controls

  - Quick shell launch (cwd + harness) at the top
  - Agent spawn form (role, cwd, scope, label)
  - Pending PTY sessions list appears when unbound sessions exist
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { RolePresetSummary } from '../lib/types';
  import {
    spawnAgent,
    spawnShell,
    getRolePresets,
    unboundPtySessions,
  } from '../stores/pty';

  // Persisted last-used values. A fresh swarm-ui window has no useful
  // default for cwd — best we can do is remember what the user launched
  // with last time. Keys are namespaced so future settings can live next
  // to them.
  const STORAGE_KEY_SHELL_CWD = 'swarm-ui.launcher.shellCwd';
  const STORAGE_KEY_AGENT_CWD = 'swarm-ui.launcher.workingDir';
  const STORAGE_KEY_HARNESS = 'swarm-ui.launcher.harness';
  const STORAGE_KEY_ROLE = 'swarm-ui.launcher.role';
  const STORAGE_KEY_SCOPE = 'swarm-ui.launcher.scope';

  function loadStored(key: string): string {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(key) ?? '';
  }

  function saveStored(key: string, value: string): void {
    if (typeof localStorage === 'undefined') return;
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  }

  // Form state — hydrated from localStorage on mount so users don't retype
  // the same cwd every launch.
  let role: string = loadStored(STORAGE_KEY_ROLE);
  let workingDir: string = loadStored(STORAGE_KEY_AGENT_CWD);
  let scope: string = loadStored(STORAGE_KEY_SCOPE);
  let label: string = '';
  let customCommand: string = '';
  let shellCwd: string = loadStored(STORAGE_KEY_SHELL_CWD);
  // Default harness to whatever the user last picked, falling back to
  // `claude` so first-run users get a swarm-aware shell (which goes through
  // the adoption flow and comes up bound + draggable).
  let shellHarness: string = loadStored(STORAGE_KEY_HARNESS) || 'claude';

  const shellHarnessOptions: { value: string; label: string }[] = [
    { value: '', label: 'Shell' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'opencode', label: 'opencode' },
  ];

  let rolePresets: RolePresetSummary[] = [];
  let loading = false;
  let error: string | null = null;

  $: isCustomRole = role === 'custom';
  $: effectiveShellCwd = shellCwd.trim() || workingDir.trim();
  $: shellRunDisabled = loading || !effectiveShellCwd;
  $: agentLaunchDisabled =
    loading ||
    !workingDir.trim() ||
    (!role && !customCommand.trim()) ||
    (isCustomRole && !customCommand.trim());

  function validateCwd(value: string, context: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return `${context} is required`;
    if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) {
      return `${context} must be an absolute path`;
    }
    return null;
  }

  onMount(async () => {
    try {
      rolePresets = await getRolePresets();
    } catch (err) {
      console.warn('[Launcher] failed to load role presets:', err);
      rolePresets = [
        { role: 'planner', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'implementer', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'reviewer', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
        { role: 'researcher', command: 'opencode', args: [], default_label_tokens: 'provider:opencode' },
      ];
    }

    // If no role was persisted, default to the first preset so the Launch
    // button isn't disabled on first render.
    if (!role && rolePresets.length > 0) {
      role = rolePresets[0].role;
    }
  });

  async function handleSpawnAgent() {
    const cwdError = validateCwd(workingDir, 'Working directory');
    if (cwdError) {
      error = cwdError;
      return;
    }
    if (isCustomRole && !customCommand.trim()) {
      error = 'Custom command is required';
      return;
    }

    loading = true;
    error = null;
    try {
      await spawnAgent(
        isCustomRole ? null : role || null,
        workingDir.trim(),
        scope.trim() || undefined,
        label.trim() || undefined,
        isCustomRole ? customCommand.trim() || undefined : undefined,
      );
      // Persist the cwd/role/scope so the next launch doesn't require
      // re-entering them. Label is intentionally one-shot.
      saveStored(STORAGE_KEY_AGENT_CWD, workingDir.trim());
      saveStored(STORAGE_KEY_ROLE, isCustomRole ? '' : role);
      saveStored(STORAGE_KEY_SCOPE, scope.trim());
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
    const cwd = effectiveShellCwd;
    const cwdError = validateCwd(cwd, 'Working directory');
    if (cwdError) {
      error = cwdError;
      return;
    }

    loading = true;
    error = null;
    try {
      await spawnShell(cwd, shellHarness || undefined);
      saveStored(STORAGE_KEY_SHELL_CWD, shellCwd.trim());
      saveStored(STORAGE_KEY_HARNESS, shellHarness);
    } catch (err) {
      error = `Failed to spawn shell: ${err}`;
      console.error('[Launcher] shell error:', err);
    } finally {
      loading = false;
    }
  }

</script>

<div class="launcher">
  <div class="body">
    <!-- Quick shell launch -->
    <section class="block">
      <div class="shell-row">
        <input
          type="text"
          class="input"
          class:invalid={shellCwd.length > 0 && !effectiveShellCwd}
          placeholder={workingDir ? `defaults to ${workingDir}` : 'cwd (/abs/path)'}
          bind:value={shellCwd}
        />
        <select
          class="input harness"
          bind:value={shellHarness}
          aria-label="Shell harness"
        >
          {#each shellHarnessOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        <button
          class="btn"
          on:click={handleSpawnShell}
          disabled={shellRunDisabled}
          title={shellRunDisabled && !effectiveShellCwd
            ? 'Enter a working directory first'
            : ''}
        >
          {shellHarness ? 'Run' : 'Sh'}
        </button>
      </div>
      {#if shellHarness}
        <p class="hint">
          Pre-creates a swarm instance and binds it to the shell — the
          harness adopts it on register and the node comes up draggable.
        </p>
      {:else}
        <p class="hint">
          Plain shell has no swarm identity. Pick a harness to launch with
          adoption.
        </p>
      {/if}
    </section>

    <div class="divider"></div>

    <!-- Agent spawn -->
    <section class="block">
      <h4>Spawn agent</h4>

      <div class="form-group">
        <label for="role-select">Role</label>
        <select id="role-select" class="input" bind:value={role}>
          <option value="">Select a role</option>
          {#each rolePresets as preset (preset.role)}
            <option value={preset.role}>{preset.role}</option>
          {/each}
          <option value="custom">Custom command…</option>
        </select>
      </div>

      {#if isCustomRole}
        <div class="form-group">
          <label for="custom-cmd">Command</label>
          <input
            id="custom-cmd"
            type="text"
            class="input mono"
            placeholder="claude --model opus"
            bind:value={customCommand}
          />
        </div>
      {/if}

      <div class="form-group">
        <label for="working-dir">Working dir</label>
        <input
          id="working-dir"
          type="text"
          class="input mono"
          placeholder="/path/to/project"
          bind:value={workingDir}
        />
      </div>

      <div class="form-grid-2">
        <div class="form-group">
          <label for="scope-input">Scope</label>
          <input
            id="scope-input"
            type="text"
            class="input"
            placeholder="auto"
            bind:value={scope}
          />
        </div>
        <div class="form-group">
          <label for="label-input">Label</label>
          <input
            id="label-input"
            type="text"
            class="input"
            placeholder="frontend:auth"
            bind:value={label}
          />
        </div>
      </div>

      <button
        class="btn btn-primary"
        on:click={handleSpawnAgent}
        disabled={agentLaunchDisabled}
        title={agentLaunchDisabled && !workingDir.trim()
          ? 'Enter a working directory first'
          : ''}
      >
        {loading ? 'Launching…' : 'Launch agent'}
      </button>

      {#if error}
        <div class="error">{error}</div>
      {/if}
    </section>

    {#if $unboundPtySessions.length > 0}
      <div class="divider"></div>

      <section class="block">
        <h4>
          <span>Pending</span>
          <span class="count">{$unboundPtySessions.length}</span>
        </h4>
        <div class="pending-list">
          {#each $unboundPtySessions as pty (pty.id)}
            <div class="pending-item">
              <span class="pending-dot"></span>
              <span class="pending-cmd mono">{pty.command}</span>
              {#if pty.launch_token}
                <span class="pending-token mono">{pty.launch_token}</span>
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
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* --- Body ---------------------------------------------------- */

  .body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  h4 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: #a6adc8;
    letter-spacing: 0.02em;
  }

  .count {
    font-size: 10px;
    font-weight: 500;
    color: #6c7086;
    font-variant-numeric: tabular-nums;
  }

  .divider {
    height: 1px;
    background: rgba(108, 112, 134, 0.18);
    margin: 2px 0;
  }

  /* --- Form ---------------------------------------------------- */

  .shell-row {
    display: flex;
    gap: 6px;
  }

  .shell-row .input { flex: 1; min-width: 0; }
  .shell-row .harness { flex: 0 0 80px; }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .form-group label {
    font-size: 11px;
    font-weight: 500;
    color: #6c7086;
  }

  .form-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .input {
    width: 100%;
    padding: 6px 8px;
    background: rgba(17, 17, 27, 0.55);
    border: 1px solid rgba(108, 112, 134, 0.25);
    border-radius: 4px;
    color: var(--terminal-fg, #c0caf5);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.12s ease, background 0.12s ease;
    box-sizing: border-box;
    line-height: 1.4;
  }

  .input.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }

  .input::placeholder {
    color: #585b70;
  }

  .input:focus {
    border-color: rgba(137, 180, 250, 0.6);
    background: rgba(17, 17, 27, 0.8);
  }

  .input.invalid {
    border-color: rgba(243, 139, 168, 0.45);
  }

  .hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: #6c7086;
  }

  select.input {
    cursor: pointer;
    appearance: none;
    padding-right: 22px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236c7086'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
  }

  /* --- Buttons ------------------------------------------------- */

  .btn {
    padding: 6px 12px;
    border: 1px solid rgba(108, 112, 134, 0.3);
    background: rgba(17, 17, 27, 0.55);
    color: var(--terminal-fg, #c0caf5);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease;
  }

  .btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(108, 112, 134, 0.55);
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-primary {
    background: rgba(137, 180, 250, 0.12);
    border-color: rgba(137, 180, 250, 0.4);
    color: #89b4fa;
  }

  .btn-primary:hover:not(:disabled) {
    background: rgba(137, 180, 250, 0.2);
    border-color: rgba(137, 180, 250, 0.7);
  }

  /* --- Errors / pending --------------------------------------- */

  .error {
    font-size: 11px;
    color: var(--edge-task-failed, #f38ba8);
    padding: 2px 0;
  }

  .pending-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pending-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
  }

  .pending-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-pending, #89b4fa);
    animation: pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }

  .pending-cmd {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a6adc8;
  }

  .pending-token {
    font-size: 10px;
    color: #6c7086;
    background: rgba(17, 17, 27, 0.6);
    padding: 1px 5px;
    border-radius: 3px;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }

  .mono { font-family: var(--font-mono); }
</style>
