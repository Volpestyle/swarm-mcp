<script lang="ts">
  import type { SwarmNodeData } from '../lib/types';
  import { agentIdentityFromLabel } from '../lib/agentIdentity';
  import { defaultPersonaForRole } from '../lib/persona';
  import { agentRuntimeProfiles } from '../stores/agentProfiles';

  export let data: SwarmNodeData;

  $: instanceId = data.instance?.id ?? null;
  $: runtimeProfile = instanceId ? $agentRuntimeProfiles[instanceId] ?? null : null;
  $: identity = agentIdentityFromLabel(data.instance?.label ?? null);
  $: role = runtimeProfile?.role || identity.role || data.agentDisplay.role;
  $: name = runtimeProfile?.name || identity.name || data.agentDisplay.name;
  $: persona = runtimeProfile?.persona || identity.persona || defaultPersonaForRole(role);
  $: provider = identity.provider || data.agentDisplay.provider;
  $: mission = runtimeProfile?.mission || identity.mission || data.agentDisplay.mission;
  $: permissions = runtimeProfile?.permissions || identity.permissions || data.agentDisplay.permissions;
  $: runtimeLabel = data.ptySession?.command || data.instance?.label || 'No terminal attached';
  $: scopeLabel = formatScope(data.instance?.scope ?? '');
  $: runtimeShort = formatRuntime(runtimeLabel);
  $: permissionShort = summarizePermissions(permissions);
  $: activeTask = data.assignedTasks.find((task) =>
    task.status === 'in_progress' || task.status === 'claimed',
  ) ?? data.assignedTasks.find((task) => task.status === 'open') ?? null;
  $: activeTasks = data.assignedTasks.filter((task) =>
    task.status === 'claimed' || task.status === 'in_progress',
  ).length;
  $: currentWorkPath = activeTask?.files?.[0] || data.locks[0]?.file || data.instance?.directory || data.ptySession?.cwd || '';
  $: currentWorkName = formatWorkName(currentWorkPath);
  $: currentWorkFolder = formatWorkFolder(currentWorkPath);
  $: currentWorkTitle = activeTask?.title || 'No assigned task active';
  $: currentWorkStep = derivePlanStep(activeTask?.title, activeTask?.description);
  $: currentWorkStatus = activeTask?.status || data.listenerHealth.label;
  $: queueCount = data.assignedTasks.length + data.requestedTasks.length;

  function formatWorkName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return 'Idle';
    const parts = trimmed.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : trimmed;
  }

  function formatWorkFolder(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return 'Waiting for task context';
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length <= 1) return trimmed;
    return parts.slice(-2, -1)[0] || parts[0];
  }

  function derivePlanStep(title: string | null | undefined, description: string | null | undefined): string {
    const source = `${title ?? ''} ${description ?? ''}`;
    const match = source.match(/\b(?:step|part|phase)\s*#?\s*(\d+)\b/i);
    return match ? `Step ${match[1]}` : 'No formal step';
  }

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

  function summarizePermissions(value: string): string {
    const lower = value.toLowerCase();
    if (lower.includes('full')) return 'Full access';
    if (lower.includes('read')) return 'Read only';
    return value || 'Default';
  }
</script>

<section class="agent-overview">
  <div class="agent-command-card">
    <div class="agent-portrait">
      <span class="agent-avatar" aria-hidden="true">{persona}</span>
      <span class="agent-provider-tag">{provider || 'local'}</span>
    </div>

    <div class="agent-title-block">
      <span class="agent-eyebrow">Agent Deck / {role || 'generalist'}</span>
      <h3>{name}</h3>
      <p>{mission || 'No mission set'}</p>
      <div class="agent-signal-row">
        <span class="signal-pill {data.status}">{data.status}</span>
        <span class="signal-pill listener">{data.listenerHealth.label}</span>
        {#if data.unreadMessages > 0}
          <span class="signal-pill unread">{data.unreadMessages} unread</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="agent-work-panel">
    <div class="work-copy">
      <span class="agent-eyebrow">{activeTask ? 'Current Work' : 'Standby'}</span>
      <h4 title={currentWorkTitle}>{currentWorkTitle}</h4>
      <p title={currentWorkPath}>
        {currentWorkName}
        <span>{currentWorkFolder}</span>
      </p>
    </div>

    <div class="work-step-panel">
      <span>{activeTask ? currentWorkStep : 'Ready'}</span>
      <strong>{currentWorkStatus}</strong>
    </div>
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
