<!--
  Launcher.svelte — Unified spawn controls

  Single form: working dir + harness + optional role + optional scope/label.

  - When a harness is picked, the backend pre-creates a swarm instance row
    and binds it to the PTY immediately, so the node renders draggable from
    the first paint.
  - When a role is also picked, the swarm label gets a `role:<role>` token.
    Role guidance comes from the explicit `swarm.register` response, not a
    hidden frontend prompt.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { RolePresetSummary } from '../lib/types';
  import {
    spawnShell,
    getRolePresets,
    unboundPtySessions,
  } from '../stores/pty';

  // Persisted last-used values so users don't retype the same cwd every
  // launch. Keys are namespaced for future settings.
  const STORAGE_KEY_CWD = 'swarm-ui.launcher.workingDir';
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

  // Form state — hydrated from localStorage on mount.
  let workingDir: string = loadStored(STORAGE_KEY_CWD);
  let scope: string = loadStored(STORAGE_KEY_SCOPE);
  let label: string = '';
  // Default harness to the user's last pick, or `claude` for first-run users
  // (so the spawned node comes up bound + draggable).
  let harness: string = loadStored(STORAGE_KEY_HARNESS) || 'claude';
  // Empty string in the UI means "generalist" (no role: token on the label).
  let role: string = loadStored(STORAGE_KEY_ROLE);

  const harnessOptions: { value: string; label: string }[] = [
    { value: '', label: 'Shell (no swarm identity)' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'opencode', label: 'opencode' },
  ];

  let rolePresets: RolePresetSummary[] = [];
  let loading = false;
  let error: string | null = null;

  $: launchDisabled = loading || !workingDir.trim();
  $: roleDisabled = !harness;

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
        { role: 'planner' },
        { role: 'implementer' },
        { role: 'reviewer' },
        { role: 'researcher' },
      ];
    }
  });

  async function handleLaunch() {
    const cwdError = validateCwd(workingDir, 'Working directory');
    if (cwdError) {
      error = cwdError;
      return;
    }

    loading = true;
    error = null;
    try {
      await spawnShell(workingDir.trim(), {
        harness: harness || undefined,
        // Without a harness there's no MCP server to adopt the role token,
        // so suppress role to avoid a confusing label on the orphan row.
        role: harness ? role || undefined : undefined,
        scope: scope.trim() || undefined,
        label: label.trim() || undefined,
      });

      saveStored(STORAGE_KEY_CWD, workingDir.trim());
      saveStored(STORAGE_KEY_HARNESS, harness);
      saveStored(STORAGE_KEY_ROLE, role);
      saveStored(STORAGE_KEY_SCOPE, scope.trim());
      // Label is intentionally one-shot — power users will set it per-launch.
      label = '';
    } catch (err) {
      error = `Failed to launch: ${err}`;
      console.error('[Launcher] spawn error:', err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="launcher">
  <div class="body">
    <section class="block">
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
          <label for="harness-select">Harness</label>
          <select id="harness-select" class="input" bind:value={harness}>
            {#each harnessOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="role-select">Role</label>
          <select
            id="role-select"
            class="input"
            bind:value={role}
            disabled={roleDisabled}
            title={roleDisabled ? 'Pick a harness first' : ''}
          >
            <option value="">—</option>
            {#each rolePresets as preset (preset.role)}
              <option value={preset.role}>{preset.role}</option>
            {/each}
          </select>
        </div>
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
          <p class="field-hint">
            Defaults to the repo root. Use a different scope only for a
            separate swarm; use label tokens like <code>team:frontend</code>
            to split frontend/backend inside one swarm.
          </p>
        </div>
        <div class="form-group">
          <label for="label-input">Label tokens</label>
          <input
            id="label-input"
            type="text"
            class="input"
            placeholder="team:frontend"
            bind:value={label}
          />
        </div>
      </div>

      <button
        class="btn btn-primary"
        on:click={handleLaunch}
        disabled={launchDisabled}
        title={launchDisabled && !workingDir.trim()
          ? 'Enter a working directory first'
          : ''}
      >
        {loading ? 'Launching…' : 'Launch'}
      </button>

      {#if harness && role}
        <p class="hint">
          Spawns a shell, auto-types <code>{harness}</code>, and pre-creates a
          swarm row labeled <code>role:{role}</code>. Role guidance arrives
          when the agent calls <code>register</code>.
        </p>
      {:else if harness}
        <p class="hint">
          Spawns a shell and auto-types <code>{harness}</code>. The harness
          adopts the pre-created swarm row on register.
        </p>
      {:else}
        <p class="hint">
          Plain shell with no swarm identity. Pick a harness for a registered,
          draggable node.
        </p>
      {/if}

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
    background: rgba(17, 17, 27, 0.22);
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
    background: rgba(17, 17, 27, 0.42);
  }

  .input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: #6c7086;
  }

  .field-hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.45;
    color: #585b70;
  }

  .hint code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    background: rgba(17, 17, 27, 0.30);
    padding: 1px 4px;
    border-radius: 3px;
    color: #cdd6f4;
  }

  .field-hint code {
    font-family: var(--font-mono);
    font-size: 10px;
    background: rgba(17, 17, 27, 0.30);
    padding: 1px 4px;
    border-radius: 3px;
    color: #cdd6f4;
  }

  select.input {
    cursor: pointer;
    appearance: none;
    padding-right: 22px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%236c7086'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
  }

  .btn {
    padding: 6px 12px;
    border: 1px solid rgba(108, 112, 134, 0.3);
    background: rgba(17, 17, 27, 0.22);
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
    background: rgba(17, 17, 27, 0.30);
    padding: 1px 5px;
    border-radius: 3px;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }

  .mono { font-family: var(--font-mono); }
</style>
