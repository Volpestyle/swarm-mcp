<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AgentProfile } from '../lib/types';
  import { agentProfiles, selectedAgentProfileId } from '../stores/agentProfiles';
  import { harnessAliases } from '../stores/harnessAliases';
  import { formatScopeLabel } from '../stores/startup';
  import { STANDARD_AGENT_ROLE_PRESETS, rolePresetForRole } from '../lib/agentRolePresets';

  const dispatch = createEventDispatcher<{
    launchProfile: { profileId: string };
  }>();

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  function commandPreview(profile: AgentProfile): string {
    if (!profile.harness) return '$SHELL';
    const alias = $harnessAliases[profile.harness as keyof typeof $harnessAliases] ?? profile.harness;
    return profile.launchCommand || alias;
  }

  function formatUpdatedAt(value: number): string {
    return dateFormatter.format(new Date(value));
  }

  function useProfile(profile: AgentProfile): void {
    selectedAgentProfileId.set(profile.id);
    dispatch('launchProfile', { profileId: profile.id });
  }

  function deleteProfile(profile: AgentProfile): void {
    agentProfiles.deleteProfile(profile.id);
    if ($selectedAgentProfileId === profile.id) {
      selectedAgentProfileId.set('');
    }
  }

  function detailValue(value: string, fallback: string): string {
    return value.trim() || fallback;
  }

  function scopeValue(profile: AgentProfile): string {
    if (!profile.scope.trim()) return 'Follow current canvas channel';
    return profile.scope.includes('#fresh-')
      ? `${formatScopeLabel(profile.scope)} · ${profile.scope}`
      : profile.scope;
  }
</script>

<div class="agent-library">
  <section class="role-reference" aria-label="Role definitions">
    <div class="role-reference-heading">
      <h3>Role Definitions</h3>
      <p>Saved agents use these launch-label contracts after registration.</p>
    </div>
    <div class="role-reference-grid">
      {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
        <article class="role-reference-card" style="--agent-color: {preset.accent}">
          <span>{preset.emoji}</span>
          <strong>{preset.label}</strong>
          <code>role:{preset.role}</code>
          <p>{preset.definition}</p>
        </article>
      {/each}
    </div>
  </section>

  {#if $agentProfiles.length === 0}
    <article class="empty-card">
      <h3>No saved agents yet</h3>
      <p>Save a launcher profile once and it will appear here with persona, mission, context, memory, and permission posture.</p>
    </article>
  {:else}
    <div class="stack-list">
      {#each $agentProfiles as profile (profile.id)}
        <article class="agent-card" class:selected={$selectedAgentProfileId === profile.id}>
          <div class="agent-card-header">
            <div class="agent-title">
              <div class="title-row">
                <h3>{profile.name}</h3>
                {#if $selectedAgentProfileId === profile.id}
                  <span class="status-chip pending">current</span>
                {/if}
              </div>
              <div class="pill-row">
                <span class="meta-pill">{profile.harness || 'shell'}</span>
                {#if profile.role}
                  <span class="meta-pill" title={rolePresetForRole(profile.role).description}>
                    {rolePresetForRole(profile.role).label} ({profile.role})
                  </span>
                {/if}
                {#if profile.nodeName}
                  <span class="meta-pill">node:{profile.nodeName}</span>
                {/if}
                {#if profile.label}
                  <span class="meta-pill" title={profile.label}>label:{profile.label}</span>
                {/if}
              </div>
            </div>

            <div class="card-actions">
              <span class="updated-at">Updated {formatUpdatedAt(profile.updatedAt)}</span>
              <button class="primary-btn" type="button" on:click={() => useProfile(profile)}>
                Open in Launch
              </button>
              <button class="ghost-btn danger" type="button" on:click={() => deleteProfile(profile)}>
                Delete
              </button>
            </div>
          </div>

          <div class="detail-grid">
            <div class="detail-block">
              <span class="detail-label">Working dir</span>
              <code class="mono detail-code">{detailValue(profile.workingDirectory, 'Not set')}</code>
            </div>
            <div class="detail-block">
              <span class="detail-label">Channel</span>
              <p class="detail-text">{scopeValue(profile)}</p>
            </div>
            <div class="detail-block">
              <span class="detail-label">Launch command</span>
              <code class="mono detail-code">{commandPreview(profile)}</code>
            </div>
            <div class="detail-block">
              <span class="detail-label">Permissions</span>
              <p class="detail-text">{detailValue(profile.permissions, 'No permission posture saved')}</p>
            </div>
          </div>

          <div class="copy-grid">
            <div class="copy-block">
              <span class="detail-label">Mission</span>
              <p>{detailValue(profile.mission, 'No mission saved')}</p>
            </div>
            <div class="copy-block">
              <span class="detail-label">Persona</span>
              <p>{detailValue(profile.persona, 'No persona saved')}</p>
            </div>
            <div class="copy-block">
              <span class="detail-label">Specialty</span>
              <p>{detailValue(profile.specialty, 'No specialty saved')}</p>
            </div>
            <div class="copy-block">
              <span class="detail-label">Skills</span>
              <p>{detailValue(profile.skills, 'No skills saved')}</p>
            </div>
            <div class="copy-block">
              <span class="detail-label">Context</span>
              <p>{detailValue(profile.context, 'No look-back guidance saved')}</p>
            </div>
            <div class="copy-block">
              <span class="detail-label">Memory</span>
              <p>{detailValue(profile.memory, 'No carry-forward notes saved')}</p>
            </div>
            <div class="copy-block copy-block--wide">
              <span class="detail-label">Custom instructions</span>
              <p>{detailValue(profile.customInstructions, 'No custom instructions saved')}</p>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .agent-library,
  .stack-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .role-reference {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .role-reference-heading {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 16px;
  }

  .role-reference-heading h3,
  .role-reference-heading p {
    margin: 0;
  }

  .role-reference-heading h3 {
    color: var(--terminal-fg, #d4d4d4);
  }

  .role-reference-heading p {
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-size: 12px;
  }

  .role-reference-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 10px;
  }

  .role-reference-card {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px 9px;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--agent-color, #00f060) 38%, var(--node-border));
    border-left-width: 3px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--agent-color, #00f060) 7%, var(--node-bg));
    padding: 10px;
  }

  .role-reference-card > span {
    grid-row: span 2;
    font-size: 24px;
  }

  .role-reference-card strong {
    color: var(--terminal-fg, #d4d4d4);
  }

  .role-reference-card code {
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-size: 10px;
  }

  .role-reference-card p {
    grid-column: 1 / -1;
    margin: 3px 0 0;
    color: color-mix(in srgb, var(--terminal-fg) 70%, transparent);
    font-size: 12px;
    line-height: 1.45;
  }

  .agent-card,
  .empty-card {
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 20px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 46%),
      color-mix(in srgb, var(--node-header-bg) 74%, transparent);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .agent-card.selected {
    border-color: color-mix(in srgb, var(--status-pending) 44%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--status-pending) 20%, transparent);
  }

  .empty-card h3,
  .agent-card h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
  }

  .empty-card p,
  .copy-block p,
  .detail-text {
    margin: 0;
    line-height: 1.6;
    color: color-mix(in srgb, var(--terminal-fg) 70%, transparent);
  }

  .agent-card-header,
  .agent-title,
  .card-actions {
    display: flex;
    gap: 12px;
  }

  .agent-card-header {
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .agent-title,
  .card-actions {
    flex-direction: column;
  }

  .title-row,
  .pill-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .updated-at,
  .detail-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--terminal-fg) 56%, transparent);
  }

  .card-actions {
    align-items: flex-end;
  }

  .detail-grid,
  .copy-grid {
    display: grid;
    gap: 12px;
  }

  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .copy-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .detail-block,
  .copy-block {
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--node-border) 64%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--node-bg) 82%, transparent);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .copy-block--wide {
    grid-column: 1 / -1;
  }

  .detail-code,
  .detail-text {
    word-break: break-word;
  }

  .primary-btn,
  .ghost-btn {
    font: inherit;
    border-radius: 12px;
    padding: 10px 14px;
    cursor: pointer;
    transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
  }

  .primary-btn {
    border: 1px solid color-mix(in srgb, var(--status-pending) 44%, transparent);
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--status-pending) 22%, transparent),
      color-mix(in srgb, var(--badge-planner) 14%, transparent)
    );
    color: var(--terminal-fg, #d4d4d4);
  }

  .ghost-btn {
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    background: color-mix(in srgb, var(--node-bg) 78%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 82%, transparent);
  }

  .primary-btn:hover,
  .ghost-btn:hover {
    transform: translateY(-1px);
  }

  .ghost-btn.danger {
    border-color: color-mix(in srgb, var(--edge-task-failed) 32%, transparent);
    color: color-mix(in srgb, var(--edge-task-failed) 84%, white 4%);
  }

  .status-chip,
  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 999px;
    padding: 7px 10px;
    font-size: 11px;
    letter-spacing: 0.03em;
  }

  .status-chip {
    border: 1px solid color-mix(in srgb, var(--status-pending) 34%, transparent);
    background: color-mix(in srgb, var(--status-pending) 12%, transparent);
    color: var(--terminal-fg, #d4d4d4);
  }

  .status-chip.pending {
    color: color-mix(in srgb, var(--status-pending) 88%, white 8%);
  }

  .meta-pill {
    border: 1px solid color-mix(in srgb, var(--node-border) 64%, transparent);
    background: color-mix(in srgb, var(--node-bg) 78%, transparent);
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    max-width: 100%;
    word-break: break-word;
  }

  /* ── Tron Encom OS overrides ────────────────────────────────────────── */
  :global([data-theme="tron-encom-os"]) .agent-card,
  :global([data-theme="tron-encom-os"]) .empty-card {
    border-radius: 0;
    border-color: var(--led-line, rgba(255, 255, 255, 0.5));
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 30%),
      var(--bg-panel, #06090d);
    box-shadow:
      0 0 0 1px var(--led-halo, rgba(255, 255, 255, 0.08)),
      var(--glow-soft, 0 0 12px rgba(255, 255, 255, 0.06));
  }

  :global([data-theme="tron-encom-os"]) .agent-card.selected {
    border-color: var(--accent, #f5f7fa);
    box-shadow:
      0 0 0 1px var(--led-halo-bright, rgba(255, 255, 255, 0.16)),
      var(--glow, 0 0 18px rgba(255, 255, 255, 0.12));
  }

  :global([data-theme="tron-encom-os"]) .agent-card h3,
  :global([data-theme="tron-encom-os"]) .empty-card h3 {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--fg-primary, #f5f7fa);
  }

  :global([data-theme="tron-encom-os"]) .empty-card p,
  :global([data-theme="tron-encom-os"]) .copy-block p,
  :global([data-theme="tron-encom-os"]) .detail-text,
  :global([data-theme="tron-encom-os"]) .detail-code {
    color: var(--fg-secondary, #a4afbb);
  }

  :global([data-theme="tron-encom-os"]) .updated-at,
  :global([data-theme="tron-encom-os"]) .detail-label {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    letter-spacing: 0.18em;
    color: var(--fg-secondary, #8a94a0);
  }

  :global([data-theme="tron-encom-os"]) .detail-block,
  :global([data-theme="tron-encom-os"]) .copy-block {
    border-radius: 0;
    border-color: var(--led-line-soft, rgba(255, 255, 255, 0.18));
    background: var(--bg-elevated, #090d12);
  }

  :global([data-theme="tron-encom-os"]) .primary-btn,
  :global([data-theme="tron-encom-os"]) .ghost-btn {
    border-radius: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    background: var(--bg-base, #000);
    color: var(--fg-primary, #f5f7fa);
    border-color: var(--led-line, rgba(255, 255, 255, 0.5));
  }

  :global([data-theme="tron-encom-os"]) .primary-btn {
    box-shadow: var(--glow-soft, 0 0 12px rgba(255, 255, 255, 0.06));
  }

  :global([data-theme="tron-encom-os"]) .ghost-btn.danger {
    border-color: var(--c-red, #ff6b6b);
    color: var(--c-red, #ff6b6b);
  }

  :global([data-theme="tron-encom-os"]) .primary-btn:hover,
  :global([data-theme="tron-encom-os"]) .ghost-btn:hover {
    box-shadow: var(--glow, 0 0 18px rgba(255, 255, 255, 0.12));
  }

  :global([data-theme="tron-encom-os"]) .status-chip,
  :global([data-theme="tron-encom-os"]) .meta-pill {
    border-radius: 0;
    padding: 6px 9px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    background: var(--bg-base, #000);
    border-color: var(--led-line-soft, rgba(255, 255, 255, 0.18));
    color: var(--fg-secondary, #a4afbb);
  }

  :global([data-theme="tron-encom-os"]) .status-chip {
    color: var(--fg-primary, #f5f7fa);
    border-color: var(--led-line, rgba(255, 255, 255, 0.5));
  }

  @media (max-width: 980px) {
    .detail-grid,
    .copy-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .card-actions {
      align-items: stretch;
    }
  }
</style>
