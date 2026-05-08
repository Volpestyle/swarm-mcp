<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SwarmNodeData } from '../lib/types';
  import { agentIdentityFromLabel } from '../lib/agentIdentity';
  import { buildAgentActivitySummary } from '../lib/agentActivity';
  import { agentProviderChoiceForHarness, providerLogoForProvider } from '../lib/agentProviders';
  import { defaultPersonaForRole } from '../lib/persona';
  import {
    EMPTY_AGENT_PROFILE_DRAFT,
    agentProfiles,
    agentRuntimeProfiles,
    selectedAgentProfileId,
  } from '../stores/agentProfiles';
  import { systemLoadSnapshot } from '../stores/systemLoadStore';

  export let data: SwarmNodeData;
  export let hasTerminal = false;

  const dispatch = createEventDispatcher<{
    detail: void;
    terminal: void;
    stop: void;
  }>();

  $: instanceId = data.instance?.id ?? null;
  $: runtimeProfile = instanceId ? $agentRuntimeProfiles[instanceId] ?? null : null;
  $: identity = agentIdentityFromLabel(data.instance?.label ?? null);
  $: role = runtimeProfile?.role || identity.role || data.agentDisplay.role;
  $: name = runtimeProfile?.name || identity.name || data.agentDisplay.name;
  $: persona = runtimeProfile?.persona || identity.persona || defaultPersonaForRole(role);
  $: provider = identity.provider || data.agentDisplay.provider;
  $: providerLogo = providerLogoForProvider(provider || data.ptySession?.command || null);
  $: mission = runtimeProfile?.mission || identity.mission || data.agentDisplay.mission;
  $: permissions = runtimeProfile?.permissions || identity.permissions || data.agentDisplay.permissions;
  $: runtimeLabel = data.ptySession?.command || data.instance?.label || 'No terminal attached';
  $: scopeLabel = formatScope(data.instance?.scope ?? '');
  $: runtimeShort = formatRuntime(runtimeLabel);
  $: permissionShort = summarizePermissions(permissions, runtimeLabel);
  $: activity = buildAgentActivitySummary(data, $systemLoadSnapshot);
  $: queueCount = data.assignedTasks.length + data.requestedTasks.length;
  $: activeTasks = data.assignedTasks.filter((task) =>
    task.status === 'claimed' || task.status === 'in_progress',
  ).length;
  $: stopLabel = data.status === 'stale' ? 'Clear' : 'Stop';
  let saveMessage = '';

  function formatScope(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return 'No scope';
    const [path, channel] = trimmed.split('#');
    const folder = path.split('/').filter(Boolean).pop() ?? path;
    return channel ? `${folder}#${channel}` : folder;
  }

  function formatRuntime(value: string): string {
    const first = value.trim().split(/\s+/)[0] ?? '';
    if (!first) return 'No terminal';
    return first.replace(/^.*\//, '');
  }

  function summarizePermissions(value: string, command: string): string {
    const lower = `${value} ${command}`.toLowerCase();
    if (lower.includes('flux') || lower.includes('bypass') || lower.includes('dangerously')) return 'Full Access';
    if (lower.includes('read')) return 'Read Only';
    return value || 'Review';
  }

  function inferHarness(): string {
    const providerChoice = agentProviderChoiceForHarness(provider);
    if (providerChoice) return providerChoice.harness;
    const command = data.ptySession?.command?.trim().toLowerCase() ?? '';
    const commandBase = command.split(/\s+/)[0] ?? '';
    return agentProviderChoiceForHarness(commandBase)?.harness ?? '';
  }

  function saveRunningAgent(): void {
    const harness = inferHarness();
    const command = data.ptySession?.command?.trim() ?? '';
    const launchCommand = command && command !== harness ? command : '';
    const saved = agentProfiles.saveDraft({
      ...EMPTY_AGENT_PROFILE_DRAFT,
      name: name || data.displayName || `${role || 'agent'} profile`,
      workingDirectory: data.instance?.directory ?? data.ptySession?.cwd ?? '',
      harness,
      role: role || '',
      scope: data.instance?.scope ?? '',
      nodeName: identity.name || data.displayName || '',
      label: data.instance?.label ?? '',
      mission: mission || '',
      persona: runtimeProfile?.persona || identity.persona || '',
      skills: runtimeProfile?.skills || identity.skills || '',
      permissions,
      launchCommand,
      emoji: persona || '',
      roleAccent: data.project?.color ?? '',
      tierRank: 0,
    }, null);
    selectedAgentProfileId.set(saved.id);
    saveMessage = `Saved ${saved.name}`;
  }

  function sparklinePoints(values: number[]): string {
    if (values.length === 0) return '';
    return values.map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
      const y = 32 - (Math.max(0, Math.min(100, value)) / 100) * 30;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }
</script>

<section class="agent-overview agent-live-summary">
  <div class="agent-command-card agent-summary-card">
    <div class="agent-portrait">
      <span class="agent-avatar" aria-hidden="true">
        {#if providerLogo}
          <img src={providerLogo} alt="" />
        {:else}
          {persona}
        {/if}
      </span>
      <span class="agent-provider-tag">{provider || 'local'}</span>
    </div>

    <div class="agent-title-block">
      <span class="agent-eyebrow">Live Summary / {role || 'generalist'}</span>
      <h3>{name}</h3>
      <p>{mission || activity.title}</p>
      <div class="agent-signal-row">
        <span class="signal-pill {data.status}">{data.status}</span>
        <span class="signal-pill listener">{data.listenerHealth.label}</span>
        {#if data.unreadMessages > 0}
          <span class="signal-pill unread">{data.unreadMessages} unread</span>
        {/if}
      </div>
      {#if saveMessage}
        <span class="agent-save-message">{saveMessage}</span>
      {/if}
    </div>

    <div class="agent-card-actions">
      <button type="button" title="Open work detail" on:click={() => dispatch('detail')}>Detail</button>
      <button type="button" title={hasTerminal ? 'Open terminal' : 'Open work view'} on:click={() => dispatch('terminal')}>
        {hasTerminal ? 'Terminal' : 'Workspace'}
      </button>
      <button type="button" class="danger" title={`${stopLabel} this agent`} on:click={() => dispatch('stop')}>
        {stopLabel}
      </button>
    </div>
  </div>

  <div class="agent-work-panel agent-activity-panel">
    <span class="work-folder-pulse" title={activity.icon.label} aria-label={activity.icon.label}>
      <img src={activity.icon.src} alt="" />
    </span>
    <div class="work-copy">
      <span class="agent-eyebrow">{activity.icon.label}</span>
      <h4 title={activity.title}>{activity.title}</h4>
      <p title={activity.detail}>
        {activity.detail}
        <span>{activity.path || 'Honest V1 telemetry'}</span>
      </p>
    </div>
    <div class="work-step-panel usage-panel">
      <span>{activity.effort}%</span>
      <strong>work effort</strong>
      <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={sparklinePoints(activity.effortSparkline)} />
      </svg>
    </div>
  </div>

  <div class="agent-icon-usage-row">
    <div class="activity-icon-stack" aria-label="Active context icons">
      {#each activity.iconStack as icon (icon.kind)}
        <span title={icon.label}><img src={icon.src} alt="" /></span>
      {/each}
    </div>
    <span class="usage-chip" title={activity.usageExact ? 'Exact local usage attribution' : 'Estimated or unavailable usage'}>
      {activity.tokenLabel} · {activity.costLabel}
    </span>
    <button type="button" class="agent-save-button inline-save" title="Save this running agent as a reusable profile" on:click={saveRunningAgent}>
      Save
    </button>
  </div>

  <div class="agent-brief-rail">
    <span title={data.instance?.scope || 'No swarm scope'}>
      <em>Scope</em>
      <strong>{scopeLabel}</strong>
    </span>
    <span title={runtimeLabel}>
      <em>Runtime</em>
      <strong>{runtimeShort}</strong>
    </span>
    <span title={permissions || 'Default permission posture'}>
      <em>Access</em>
      <strong>{permissionShort}</strong>
    </span>
    <span title={`${queueCount} queued, ${activeTasks} active, ${data.locks.length} locks`}>
      <em>Queue</em>
      <strong>{queueCount}/{activeTasks}</strong>
    </span>
  </div>
</section>
