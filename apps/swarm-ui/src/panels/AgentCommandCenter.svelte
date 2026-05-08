<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import openAiLogoUrl from '../assets/openai-old-logo.png';
  import type { AgentProfile, AgentProfileDraft, Instance, ProjectSpace, Task } from '../lib/types';
  import type { OverhaulSlice } from '../lib/mayFirstOverhaulPlan';
  import {
    EMPTY_AGENT_PROFILE_DRAFT,
    agentProfiles,
    selectedAgentProfileId,
  } from '../stores/agentProfiles';
  import {
    agentTeams,
    profilesToTeamDraft,
    selectedAgentTeamId,
  } from '../stores/teamProfiles';
  import {
    AGENT_ACCENT_CHOICES,
    AGENT_EMOJI_CHOICES,
    STANDARD_AGENT_ROLE_PRESETS,
    rolePresetForRole,
  } from '../lib/agentRolePresets';
  import {
    MAY_FIRST_ARCHIVED_PHASES,
    MAY_FIRST_MVP_SLICES,
    MAY_FIRST_NORTH_STAR_STEPS,
    MAY_FIRST_OVERHAUL_STAGES,
    MAY_FIRST_OVERHAUL_SUMMARY,
  } from '../lib/mayFirstOverhaulPlan';

  export let open = false;
  export let instances: Instance[] = [];
  export let tasks: Task[] = [];
  export let projects: ProjectSpace[] = [];

  type AgentTab = 'library' | 'overhaul' | 'customize' | 'roles' | 'teams' | 'hierarchy' | 'protocols' | 'tasks';
  type HierarchyProfile = AgentProfile | (AgentProfileDraft & { id?: string; updatedAt?: number });
  type OverhaulKanbanColumnId = 'done' | 'taking' | 'next' | 'follow-up';

  interface OverhaulKanbanItem {
    id: string;
    title: string;
    column: OverhaulKanbanColumnId;
    statusLabel: string;
    owner: string;
    summary: string;
    steps: string[];
    proof: string[];
  }

  const dispatch = createEventDispatcher<{
    close: void;
    launchProfile: { profileId: string };
  }>();

  const protocolTemplates = [
    {
      name: 'Scout then build',
      trigger: 'If a project opens with no task owner',
      chain: 'assign researcher -> publish finding -> builder claims scoped task',
    },
    {
      name: 'Review gate',
      trigger: 'If implementation task moves to done',
      chain: 'reviewer receives summary -> checks files -> planner approves next wave',
    },
    {
      name: 'Hotfix alarm',
      trigger: 'If bug annotation lands on a locked file',
      chain: 'freeze related edits -> notify orchestrator -> spawn focused fixer',
    },
  ];

  const doneOverhaulItems: OverhaulKanbanItem[] = [
    {
      id: 'authority-docs',
      title: 'Authority docs are current',
      column: 'done',
      statusLabel: 'done',
      owner: 'Codex App Mac',
      summary: 'May 1st plan, execution bootstrap, archive map, and status docs are now the product authority.',
      steps: [
        'May 2 project-first correction folded into the May 1st plan.',
        'Old Phase 4/5/6/7 roadmap archived as source material.',
        'Active path narrowed to Slice 0 through Slice 5.',
      ],
      proof: [
        'Agents > Overhaul reads from the May 1st authority data source.',
        'Home Agents section mirrors the same authority path.',
      ],
    },
    {
      id: 'agents-status-board',
      title: 'Agents status board is surfaced',
      column: 'done',
      statusLabel: 'done',
      owner: 'Codex App Mac',
      summary: 'Live Tasks now carries the May 1st overhaul work so the build lane is visible without manual narration.',
      steps: [
        'Show the overhaul as Kanban work.',
        'Mark implementation and proof rows with the OpenAI badge.',
        'Keep the real swarm DB task board below the overhaul board.',
      ],
      proof: [
        'Svelte check and production build pass.',
        'Browser smoke can open Agents > Live Tasks and see the board.',
      ],
    },
    {
      id: 'project-cockpit',
      title: 'Project Cockpit is useful on open',
      column: 'done',
      statusLabel: 'done',
      owner: 'Codex App Mac',
      summary: 'Opening a saved folder now lands in a cockpit with root, task lanes, agent status, and recent activity visible together.',
      steps: [
        'Add a Project Cockpit band to the project page.',
        'Show project-linked task lanes before full task editing lands.',
        'Summarize running and reconnectable agents plus recent project activity.',
      ],
      proof: [
        'Svelte check passes with the cockpit wiring.',
        'Browser smoke opens a project page and sees Project Cockpit, Task Board, Agents, and Recent Activity.',
      ],
    },
    {
      id: 'task-board-mvp',
      title: 'Task Board MVP is interactive',
      column: 'done',
      statusLabel: 'done',
      owner: 'Codex App Mac',
      summary: 'The project page now accepts pasted plans, turns them into editable task rows, supports grouping and selection, and shows a clear Launch N action.',
      steps: [
        'Add editable task rows with section, status, provider, role, assignee, listener, and result fields.',
        'Import Markdown headings and bullets into grouped task sections.',
        'Add multi-select plus a sticky assignment and Launch N action bar.',
      ],
      proof: [
        'Browser smoke imported three rows and showed Launch 3.',
        'Svelte check and production build pass.',
      ],
    },
    {
      id: 'task-bound-launch',
      title: 'Task Board launches task-bound agents',
      column: 'done',
      statusLabel: 'done',
      owner: 'Codex App Mac',
      summary: 'Launch N now routes selected task rows through the real spawnShell contract with project, task, provider, role, scope, agent, and PTY state recorded on each row.',
      steps: [
        'Map selected task rows to Codex, Claude, or opencode harness launches.',
        'Attach project/task/scope label tokens and task-bound bootstrap context.',
        'Show launched agent id, PTY id, listener state, and row result after spawn.',
      ],
      proof: [
        'Browser smoke launched three mocked Tauri spawn_shell rows and verified three unique task tokens.',
        'Svelte check, production build, and Tauri debug build pass.',
      ],
    },
  ];

  const kanbanColumnCopy: Record<OverhaulKanbanColumnId, { title: string; subtitle: string }> = {
    done: {
      title: 'Done',
      subtitle: 'Authority, Home, Project Cockpit, Task Board, and task-bound launch are complete.',
    },
    taking: {
      title: 'Codex Taking',
      subtitle: 'Work I am actively pulling out of chat and into app state.',
    },
    next: {
      title: 'Next Slices',
      subtitle: 'Ready once the visible board and smoke baseline are steady.',
    },
    'follow-up': {
      title: 'Safety Pass',
      subtitle: 'Regression cleanup before broader surfaces expand.',
    },
  };

  let activeTab: AgentTab = 'library';
  let draftName = '';
  let draftRole = 'orchestrator';
  let draftEmoji = '🧭';
  let draftAccent = '#00f060';
  let draftHarness = 'codex';
  let draftCommand = '';
  let draftMission = '';
  let draftPersona = '';
  let draftWorkingDir = '';
  let teamDraftName = 'Phase Team';
  let teamSelection: string[] = [];
  let message = '';

  $: selectedProfile = $agentProfiles.find((profile) => profile.id === $selectedAgentProfileId) ?? null;
  $: selectedTeam = $agentTeams.find((team) => team.id === $selectedAgentTeamId) ?? null;
  $: projectKey = projects.map((project) => ({
    id: project.id,
    name: project.name,
    color: project.color,
  }));
  $: taskRows = tasks.slice(0, 80).map((task) => ({
    task,
    project: projectForTask(task, projects),
    assignee: task.assignee ? instances.find((instance) => instance.id === task.assignee) ?? null : null,
  }));
  $: liveTaskCount = tasks.filter((task) => task.status === 'open' || task.status === 'claimed' || task.status === 'in_progress').length;
  $: liveAgentCount = instances.filter((instance) => instance.status === 'online').length;
  $: activeSliceCount = MAY_FIRST_MVP_SLICES.filter((slice) => slice.status === 'active').length;
  $: overhaulKanbanItems = [
    ...doneOverhaulItems,
    ...MAY_FIRST_MVP_SLICES.map(sliceToKanbanItem),
  ];
  $: visibleOverhaulWorkCount = overhaulKanbanItems.filter((item) => item.column === 'taking' || item.column === 'next').length;
  $: overhaulKanbanColumns = (['done', 'taking', 'next', 'follow-up'] as OverhaulKanbanColumnId[]).map((id) => ({
    id,
    ...kanbanColumnCopy[id],
    items: overhaulKanbanItems.filter((item) => item.column === id),
  }));
  $: hierarchyProfiles = selectedTeam
    ? selectedTeam.members.map((member) => profileFromTeamMember(member.profileId, member.profile))
    : $agentProfiles;

  function close(): void {
    dispatch('close');
  }

  function resetDraftFromProfile(profile: AgentProfile | null): void {
    const preset = rolePresetForRole(profile?.role || draftRole);
    draftName = profile?.name || '';
    draftRole = profile?.role || preset.role;
    draftEmoji = profile?.emoji || preset.emoji || '🧭';
    draftAccent = profile?.roleAccent || preset.accent || '#00f060';
    draftHarness = profile?.harness || 'codex';
    draftCommand = profile?.launchCommand || '';
    draftMission = profile?.mission || '';
    draftPersona = profile?.persona || '';
    draftWorkingDir = profile?.workingDirectory || '';
  }

  function applyRolePreset(role: string): void {
    const preset = rolePresetForRole(role);
    draftRole = preset.role;
    draftEmoji = preset.emoji;
    draftAccent = preset.accent;
  }

  function applyEmojiChoice(emoji: string): void {
    draftEmoji = emoji;
  }

  function applyAccentChoice(accent: string): void {
    draftAccent = accent;
  }

  function saveDraft(): void {
    try {
      const saved = agentProfiles.saveDraft({
        ...EMPTY_AGENT_PROFILE_DRAFT,
        name: draftName.trim() || `${draftRole} agent`,
        workingDirectory: draftWorkingDir.trim(),
        harness: draftHarness.trim(),
        role: draftRole.trim(),
        mission: draftMission.trim(),
        persona: draftPersona.trim(),
        launchCommand: draftCommand.trim(),
        emoji: draftEmoji.trim(),
        roleAccent: draftAccent.trim(),
        tierRank: selectedProfile?.tierRank || $agentProfiles.length + 1,
      }, selectedProfile?.id ?? null);
      selectedAgentProfileId.set(saved.id);
      message = `Saved ${saved.name}. New launches use the updated profile; already-running agents keep their current process state.`;
    } catch (err) {
      message = `Save failed: ${err}`;
    }
  }

  function handleTeamToggle(profileId: string): void {
    teamSelection = teamSelection.includes(profileId)
      ? teamSelection.filter((id) => id !== profileId)
      : [...teamSelection, profileId];
  }

  function saveTeam(): void {
    const selectedProfiles = $agentProfiles.filter((profile) => teamSelection.includes(profile.id));
    try {
      const team = agentTeams.saveDraft(profilesToTeamDraft(teamDraftName, selectedProfiles), null);
      selectedAgentTeamId.set(team.id);
      message = `Saved team ${team.name}. Launching it fresh still happens from Launch Deck.`;
      activeTab = 'hierarchy';
    } catch (err) {
      message = `Team save failed: ${err}`;
    }
  }

  function profileFromTeamMember(profileId: string | null, fallback: AgentProfileDraft): HierarchyProfile {
    const live = profileId ? $agentProfiles.find((profile) => profile.id === profileId) : null;
    return live ?? fallback;
  }

  function projectForTask(task: Task, projectList: ProjectSpace[]): ProjectSpace | null {
    const files = task.files ?? [];
    return projectList.find((project) => {
      const roots = [project.root, ...project.additionalRoots];
      return files.some((file) => roots.some((root) => file === root || file.startsWith(`${root}/`)));
    }) ?? null;
  }

  function statusIcon(status: string): string {
    switch (status) {
      case 'done': return '✓';
      case 'failed': return '!';
      case 'in_progress': return '↯';
      case 'blocked': return '⛔';
      case 'approval_required': return '?';
      case 'cancelled': return '×';
      default: return '•';
    }
  }

  function sliceToKanbanItem(slice: OverhaulSlice): OverhaulKanbanItem {
    const column = slice.status === 'done'
      ? 'done'
      : slice.status === 'active'
      ? 'taking'
      : slice.status === 'next'
        ? 'next'
        : 'follow-up';
    const statusLabel = slice.status === 'done'
      ? 'done'
      : slice.status === 'active'
      ? 'active slice'
      : slice.status === 'next'
        ? 'queued'
        : 'follow-up';
    const owner = slice.status === 'done'
      ? 'Codex App Mac'
      : slice.status === 'active'
      ? 'Codex App Mac'
      : slice.status === 'next'
        ? 'Next implementation lane'
        : 'Review lane';

    return {
      id: slice.id,
      title: `${slice.id}: ${slice.title}`,
      column,
      statusLabel,
      owner,
      summary: slice.goal,
      steps: slice.build,
      proof: slice.proof,
    };
  }
</script>

{#if open}
  <div class="agent-center">
    <button class="center-dismiss" type="button" aria-label="Close Agents" on:click={close}></button>
    <div class="center-shell" role="dialog" aria-modal="true" aria-label="Agents command center">
      <header class="center-header">
        <div>
          <p class="eyebrow">agents</p>
          <h2>Build the crew, then let the canvas breathe.</h2>
          <p>Saved personas, team hierarchy, live work, and protocol sketches live here instead of crowding Launch.</p>
        </div>
        <button class="close-btn" type="button" on:click={close} aria-label="Close Agents">×</button>
      </header>

      <nav class="center-tabs" aria-label="Agent sections">
        <button class:active={activeTab === 'library'} type="button" on:click={() => (activeTab = 'library')}>Library</button>
        <button class:active={activeTab === 'overhaul'} type="button" on:click={() => (activeTab = 'overhaul')}>Overhaul</button>
        <button class:active={activeTab === 'customize'} type="button" on:click={() => { resetDraftFromProfile(selectedProfile); activeTab = 'customize'; }}>Customize</button>
        <button class:active={activeTab === 'roles'} type="button" on:click={() => (activeTab = 'roles')}>Roles</button>
        <button class:active={activeTab === 'teams'} type="button" on:click={() => (activeTab = 'teams')}>Teams</button>
        <button class:active={activeTab === 'hierarchy'} type="button" on:click={() => (activeTab = 'hierarchy')}>Hierarchy</button>
        <button class:active={activeTab === 'protocols'} type="button" on:click={() => (activeTab = 'protocols')}>Protocols</button>
        <button class:active={activeTab === 'tasks'} type="button" on:click={() => (activeTab = 'tasks')}>Live Tasks</button>
      </nav>

      {#if message}
        <p class="center-message">{message}</p>
      {/if}

      {#if activeTab === 'library'}
        <div class="library-grid">
          {#each $agentProfiles as profile, index (profile.id)}
            <article class="agent-tile" style="--agent-color: {profile.roleAccent || rolePresetForRole(profile.role).accent}">
              <button class="agent-avatar" type="button" on:click={() => { selectedAgentProfileId.set(profile.id); resetDraftFromProfile(profile); activeTab = 'customize'; }}>
                {profile.emoji || rolePresetForRole(profile.role).emoji}
              </button>
              <div class="agent-copy">
                <span>#{index + 1} · {profile.harness || 'shell'}</span>
                <strong>{profile.name}</strong>
                <p>{profile.mission || profile.persona || 'No mission saved yet.'}</p>
              </div>
              <div class="tile-actions">
                <button type="button" on:click={() => { selectedAgentProfileId.set(profile.id); dispatch('launchProfile', { profileId: profile.id }); }}>Launch</button>
                <button type="button" on:click={() => { selectedAgentProfileId.set(profile.id); resetDraftFromProfile(profile); activeTab = 'customize'; }}>Edit</button>
              </div>
            </article>
          {/each}
          <article class="agent-tile agent-tile--new">
            <button class="agent-avatar" type="button" on:click={() => { resetDraftFromProfile(null); activeTab = 'customize'; }}>+</button>
            <div class="agent-copy">
              <span>new profile</span>
              <strong>Create Agent</strong>
              <p>Set command, role, emoji, accent, and launch personality.</p>
            </div>
          </article>
        </div>
      {:else if activeTab === 'overhaul'}
        <div class="overhaul-page">
          <section class="overhaul-hero">
            <div>
              <p class="eyebrow">active product authority</p>
              <h3>{MAY_FIRST_OVERHAUL_SUMMARY.name}</h3>
              <p>{MAY_FIRST_OVERHAUL_SUMMARY.correction}. The old phase roadmap is archived; this is the current app-build spine.</p>
            </div>
            <div class="overhaul-spine" aria-label="Current overhaul product spine">
              {#each MAY_FIRST_OVERHAUL_SUMMARY.authority.split(' -> ') as step, index (`spine-${step}`)}
                <span>{index + 1}. {step}</span>
              {/each}
            </div>
          </section>

          <section class="overhaul-metrics" aria-label="Overhaul status summary">
            <article>
              <span>active slices</span>
              <strong>{activeSliceCount}</strong>
              <p>Slice 5 is active now: review the MVP path and smoke real native launch behavior.</p>
            </article>
            <article>
              <span>live agents</span>
              <strong>{liveAgentCount}</strong>
              <p>Agents should show listener/task truth before the swarm grows.</p>
            </article>
            <article>
              <span>live tasks</span>
              <strong>{liveTaskCount + visibleOverhaulWorkCount}</strong>
              <p>Includes real swarm tasks plus the visible May 1st implementation lane.</p>
            </article>
          </section>

          <section class="overhaul-section">
            <div class="overhaul-section-title">
              <h3>MVP Slices</h3>
              <p>{MAY_FIRST_OVERHAUL_SUMMARY.activePath}</p>
            </div>
            <div class="slice-grid">
              {#each MAY_FIRST_MVP_SLICES as slice (slice.id)}
                <article class="slice-card slice-card--{slice.status}">
                  <div class="slice-card-head">
                    <span>{slice.id}</span>
                    <em>{slice.status}</em>
                  </div>
                  <strong>{slice.title}</strong>
                  <p>{slice.goal}</p>
                  <h4>Build</h4>
                  <ul>
                    {#each slice.build as item (item)}
                      <li>{item}</li>
                    {/each}
                  </ul>
                  <h4>Proof</h4>
                  <ul>
                    {#each slice.proof as item (item)}
                      <li>{item}</li>
                    {/each}
                  </ul>
                </article>
              {/each}
            </div>
          </section>

          <section class="overhaul-section">
            <div class="overhaul-section-title">
              <h3>Full Stage Map</h3>
              <p>Stages are logical product phases, not calendar estimates. Ship the MVP loop before the larger surfaces.</p>
            </div>
            <div class="stage-list">
              {#each MAY_FIRST_OVERHAUL_STAGES as stage (stage.id)}
                <details class="stage-row" open={stage.id === 'Stage 0' || stage.id === 'Stage 1' || stage.id === 'Stage 2'}>
                  <summary>
                    <span>{stage.id}</span>
                    <strong>{stage.title}</strong>
                    <em>{stage.purpose}</em>
                  </summary>
                  <div class="stage-body">
                    <ul>
                      {#each stage.work as item (item)}
                        <li>{item}</li>
                      {/each}
                    </ul>
                    <p><b>Proof:</b> {stage.proof}</p>
                  </div>
                </details>
              {/each}
            </div>
          </section>

          <section class="overhaul-section overhaul-two-up">
            <div>
              <div class="overhaul-section-title">
                <h3>North-Star Demo</h3>
                <p>The product promise in one operator-visible loop.</p>
              </div>
              <ol class="north-star-list">
                {#each MAY_FIRST_NORTH_STAR_STEPS as step, index (step)}
                  <li><span>{index + 1}</span>{step}</li>
                {/each}
              </ol>
            </div>

            <div>
              <div class="overhaul-section-title">
                <h3>Archive Map</h3>
                <p>{MAY_FIRST_OVERHAUL_SUMMARY.archiveRule}</p>
              </div>
              <div class="archive-list">
                {#each MAY_FIRST_ARCHIVED_PHASES as phase (phase.name)}
                  <article>
                    <strong>{phase.name}</strong>
                    <span>{phase.status}</span>
                    <p>{phase.useNow}</p>
                  </article>
                {/each}
              </div>
            </div>
          </section>
        </div>
      {:else if activeTab === 'customize'}
        <div class="customize-grid">
          <aside class="agent-preview" style="--agent-color: {draftAccent}">
            <div class="preview-avatar">{draftEmoji || '◇'}</div>
            <span>{draftHarness || 'shell'} · {draftRole || 'role'}</span>
            <strong>{draftName || 'Unnamed Agent'}</strong>
            <p>{draftMission || 'Mission text previews here.'}</p>
          </aside>

          <div class="form-panel">
            <div class="role-strip">
              {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                <button
                  type="button"
                  class:selected={draftRole === preset.role}
                  title={preset.description}
                  on:click={() => applyRolePreset(preset.role)}
                >
                  <span>{preset.emoji}</span>
                  <small>{preset.label}</small>
                </button>
              {/each}
            </div>

            <div class="form-grid">
              <label>Agent name<input bind:value={draftName} placeholder="Codex Orchestrator" /></label>
              <label>Harness<input bind:value={draftHarness} placeholder="codex" /></label>
              <label>Role
                <input bind:value={draftRole} placeholder="orchestrator" list="agents-page-role-choices" />
                <datalist id="agents-page-role-choices">
                  {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
                    <option value={preset.role}>{preset.label}</option>
                  {/each}
                </datalist>
              </label>
              <label>Emoji
                <input bind:value={draftEmoji} placeholder="🧭" list="agents-page-emoji-choices" />
                <datalist id="agents-page-emoji-choices">
                  {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                    <option value={emoji}></option>
                  {/each}
                </datalist>
              </label>
              <div class="emoji-choice-grid wide" aria-label="Emoji choices">
                {#each AGENT_EMOJI_CHOICES as emoji (emoji)}
                  <button type="button" class:selected={draftEmoji === emoji} on:click={() => applyEmojiChoice(emoji)}>
                    {emoji}
                  </button>
                {/each}
              </div>
              <label>LED edge color
                <input bind:value={draftAccent} placeholder="#00f060 or green" list="agents-page-accent-choices" />
                <datalist id="agents-page-accent-choices">
                  {#each AGENT_ACCENT_CHOICES as accent (accent)}
                    <option value={accent}></option>
                  {/each}
                </datalist>
              </label>
              <label>Launch command<input bind:value={draftCommand} placeholder="flux9" /></label>
              <label class="wide">Working directory<input bind:value={draftWorkingDir} placeholder="/Users/mathewfrazier/Desktop/project" /></label>
              <label class="wide">Mission<textarea bind:value={draftMission} rows="3" placeholder="What this agent owns."></textarea></label>
              <label class="wide">Persona<textarea bind:value={draftPersona} rows="3" placeholder="How this agent should behave."></textarea></label>
            </div>

            <div class="quick-choice-panel">
              <div>
                <span>Accent</span>
                <div>
                  {#each AGENT_ACCENT_CHOICES as accent (accent)}
                    <button type="button" style={`--agent-color:${accent};`} on:click={() => applyAccentChoice(accent)}>
                      <i></i>{accent}
                    </button>
                  {/each}
                </div>
              </div>
            </div>

            <div class="form-actions">
              <button type="button" on:click={saveDraft}>Save Agent</button>
            </div>
          </div>
        </div>
      {:else if activeTab === 'roles'}
        <div class="roles-page">
          <div class="roles-intro">
            <h3>Role Definitions</h3>
            <p>Roles are launch-label contracts. They set what the agent should own after it registers in the channel.</p>
          </div>
          <div class="role-definition-grid">
            {#each STANDARD_AGENT_ROLE_PRESETS as preset (preset.id)}
              <article class="role-definition-card" style="--agent-color: {preset.accent}">
                <div class="role-definition-title">
                  <span>{preset.emoji}</span>
                  <div>
                    <strong>{preset.label}</strong>
                    <code>role:{preset.role}</code>
                  </div>
                </div>
                <p>{preset.definition}</p>
                <dl>
                  <div>
                    <dt>Owns</dt>
                    <dd>{preset.owns}</dd>
                  </div>
                  <div>
                    <dt>Idle loop</dt>
                    <dd>{preset.idle}</dd>
                  </div>
                </dl>
              </article>
            {/each}
          </div>
        </div>
      {:else if activeTab === 'teams'}
        <div class="teams-grid">
          <section class="team-builder">
            <h3>Team Builder</h3>
            <label>Team name<input bind:value={teamDraftName} /></label>
            <div class="team-pick-list">
              {#each $agentProfiles as profile (profile.id)}
                <label class="team-pick">
                  <input type="checkbox" checked={teamSelection.includes(profile.id)} on:change={() => handleTeamToggle(profile.id)} />
                  <span>{profile.emoji || rolePresetForRole(profile.role).emoji}</span>
                  <strong>{profile.name}</strong>
                  <em>{profile.role || 'generalist'}</em>
                </label>
              {/each}
            </div>
            <button type="button" disabled={!teamDraftName.trim() || teamSelection.length === 0} on:click={saveTeam}>Save Team</button>
          </section>

          <section class="saved-teams">
            <h3>Saved Teams</h3>
            {#each $agentTeams as team (team.id)}
              <button class="team-row" type="button" on:click={() => { selectedAgentTeamId.set(team.id); activeTab = 'hierarchy'; }}>
                <strong>{team.name}</strong>
                <span>{team.members.length} positions</span>
              </button>
            {/each}
          </section>
        </div>
      {:else if activeTab === 'hierarchy'}
        <div class="hierarchy-page">
          <div class="hierarchy-root">
            <span>🧭</span>
            <strong>#1 Orchestrator</strong>
            <em>{selectedTeam?.name || 'Active command structure'}</em>
          </div>
          <div class="hierarchy-lanes">
            {#each hierarchyProfiles as profile, index (`${profile.id ?? profile.name}:${index}`)}
              <article class="hierarchy-card" style="--agent-color: {profile.roleAccent || rolePresetForRole(profile.role).accent}">
                <span>{profile.emoji || rolePresetForRole(profile.role).emoji}</span>
                <strong>#{index + 2} {profile.name}</strong>
                <em>{profile.role || 'specialist'}</em>
                <p>{profile.specialty || profile.mission || 'Position ready for assignment.'}</p>
              </article>
            {/each}
            <article class="hierarchy-card hierarchy-card--add">
              <span>+</span>
              <strong>Add position</strong>
              <em>saved through Customize</em>
              <p>Roles saved here affect future launches; live processes need a new session or direct prompt to adopt the change.</p>
            </article>
          </div>
        </div>
      {:else if activeTab === 'protocols'}
        <div class="protocol-grid">
          {#each protocolTemplates as protocol (protocol.name)}
            <article class="protocol-card">
              <span>if</span>
              <strong>{protocol.trigger}</strong>
              <em>then</em>
              <p>{protocol.chain}</p>
            </article>
          {/each}
          <article class="protocol-card protocol-card--draft">
            <span>draft</span>
            <strong>Custom chain event</strong>
            <p>Protocol persistence is staged here as UI structure. Runtime enforcement needs a backend rules pass before it should mutate live agents automatically.</p>
          </article>
        </div>
      {:else}
        <div class="tasks-page">
          <section class="overhaul-live-board" aria-label="May 1st overhaul Kanban">
            <div class="overhaul-live-header">
              <div>
                <p class="eyebrow">live overhaul tasks</p>
                <h3>{MAY_FIRST_OVERHAUL_SUMMARY.name}</h3>
                <p>{MAY_FIRST_OVERHAUL_SUMMARY.authority}. Codex App Mac is taking the first visible slices so this does not become a manual babysitting exercise.</p>
              </div>
              <div class="overhaul-live-status">
                <span><img src={openAiLogoUrl} alt="" aria-hidden="true" /> Codex App Mac</span>
                <strong>{visibleOverhaulWorkCount} active/next cards</strong>
                <code>{MAY_FIRST_OVERHAUL_SUMMARY.scope}</code>
              </div>
            </div>

            <div class="overhaul-kanban-grid">
              {#each overhaulKanbanColumns as column (column.id)}
                <section class="overhaul-kanban-column overhaul-kanban-column--{column.id}">
                  <header>
                    <h3>{column.title}</h3>
                    <p>{column.subtitle}</p>
                  </header>

                  {#each column.items as item (item.id)}
                    <article class="overhaul-task-card">
                      <div class="overhaul-task-meta">
                        <span class="openai-pill">
                          <img src={openAiLogoUrl} alt="" aria-hidden="true" />
                          {item.owner}
                        </span>
                        <em>{item.statusLabel}</em>
                      </div>
                      <strong>{item.title}</strong>
                      <p>{item.summary}</p>

                      <div class="implementation-list" aria-label={`${item.title} implementation steps`}>
                        {#each item.steps.slice(0, 4) as step (step)}
                          <span>
                            <img src={openAiLogoUrl} alt="" aria-hidden="true" />
                            {step}
                          </span>
                        {/each}
                      </div>

                      {#if item.proof.length > 0}
                        <div class="proof-row">
                          <img src={openAiLogoUrl} alt="" aria-hidden="true" />
                          <span>{item.proof[0]}</span>
                        </div>
                      {/if}
                    </article>
                  {/each}
                </section>
              {/each}
            </div>
          </section>

          <section class="swarm-task-board" aria-label="Swarm database tasks">
            <div class="swarm-task-heading">
              <div>
                <p class="eyebrow">swarm db tasks</p>
                <h3>Runtime Task Board</h3>
              </div>
              <span>{taskRows.length} rows from SQLite</span>
            </div>

          <div class="project-key">
            {#each projectKey as project (project.id)}
              <span style="--project-color: {project.color}"><i></i>{project.name}</span>
            {/each}
            {#if projectKey.length === 0}
              <span style="--project-color: #00f060"><i></i>unassigned</span>
            {/if}
          </div>
          <div class="kanban-grid">
            {#each ['open', 'claimed', 'in_progress', 'blocked', 'done'] as status (status)}
              <section class="kanban-column">
                <h3>{status.replace('_', ' ')}</h3>
                {#each taskRows.filter((row) => row.task.status === status) as row (row.task.id)}
                  <article class="task-card" style="--project-color: {row.project?.color ?? '#00f060'}">
                    <span>{statusIcon(row.task.status)}</span>
                    <strong>{row.task.title}</strong>
                    <p>{row.assignee?.label || row.assignee?.id.slice(0, 8) || 'unassigned'}</p>
                  </article>
                {/each}
              </section>
            {/each}
          </div>
          </section>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .agent-center {
    position: absolute;
    inset: 0;
    z-index: 72;
    display: grid;
    place-items: center;
    padding: 28px;
    background: rgba(0, 0, 0, 0.68);
    backdrop-filter: blur(14px) saturate(1.16);
  }

  .center-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
  }

  .center-shell {
    position: relative;
    z-index: 1;
    width: min(1240px, 96vw);
    height: min(840px, 91vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--node-border) 82%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--terminal-bg, #07090b) 95%, black);
    box-shadow: 0 30px 120px rgba(0, 0, 0, 0.72);
  }

  .center-header {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    padding: 22px 24px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
  }

  .center-header h2 {
    margin: 0;
    max-width: 18ch;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 34px;
    line-height: 0.98;
  }

  .center-header p {
    margin: 8px 0 0;
    max-width: 78ch;
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

  .close-btn,
  .center-tabs button,
  .tile-actions button,
  .form-actions button,
  .team-builder button,
  .team-row {
    font: inherit;
    cursor: pointer;
  }

  .close-btn {
    width: 36px;
    height: 36px;
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 8px;
    background: transparent;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 22px;
  }

  .center-tabs {
    display: flex;
    gap: 8px;
    padding: 12px 24px;
    border-bottom: 1px solid color-mix(in srgb, var(--node-border) 64%, transparent);
    overflow-x: auto;
  }

  .center-tabs button {
    border: 1px solid color-mix(in srgb, var(--node-border) 76%, transparent);
    border-radius: 8px;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    padding: 8px 12px;
  }

  .center-tabs button.active,
  .center-tabs button:hover {
    color: var(--terminal-fg, #d4d4d4);
    border-color: rgba(0, 240, 96, 0.58);
    background: rgba(0, 240, 96, 0.08);
  }

  .center-message {
    margin: 12px 24px 0;
    color: #00f060;
    font-size: 12px;
  }

  .library-grid,
  .customize-grid,
  .overhaul-page,
  .roles-page,
  .teams-grid,
  .hierarchy-page,
  .protocol-grid,
  .tasks-page {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px 24px 24px;
  }

  .library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
  }

  .roles-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .overhaul-page {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .overhaul-hero {
    display: grid;
    grid-template-columns: minmax(0, 0.95fr) minmax(280px, 0.75fr);
    gap: 16px;
    align-items: stretch;
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background:
      linear-gradient(135deg, rgba(0, 240, 96, 0.11), transparent 42%),
      color-mix(in srgb, var(--node-header-bg, #101318) 72%, transparent);
    padding: 18px;
  }

  .overhaul-hero h3,
  .overhaul-section-title h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
  }

  .overhaul-hero h3 {
    font-size: 30px;
    line-height: 1;
  }

  .overhaul-hero p,
  .overhaul-section-title p,
  .overhaul-metrics p,
  .slice-card p,
  .slice-card li,
  .stage-body li,
  .stage-body p,
  .archive-list p {
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-size: 12px;
    line-height: 1.5;
  }

  .overhaul-spine {
    display: grid;
    gap: 8px;
    align-content: center;
  }

  .overhaul-spine span {
    min-height: 34px;
    display: flex;
    align-items: center;
    border: 1px solid rgba(0, 240, 96, 0.32);
    border-left: 3px solid #00f060;
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.26);
    color: var(--terminal-fg, #d4d4d4);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    padding: 6px 10px;
  }

  .overhaul-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .overhaul-metrics article,
  .slice-card,
  .stage-row,
  .archive-list article {
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--node-header-bg, #101318) 70%, transparent);
  }

  .overhaul-metrics article {
    min-width: 0;
    padding: 14px;
  }

  .overhaul-metrics span,
  .slice-card-head span,
  .slice-card-head em,
  .slice-card h4,
  .stage-row summary span,
  .stage-row summary em,
  .archive-list span {
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-style: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .overhaul-metrics strong {
    display: block;
    margin-top: 5px;
    color: #00f060;
    font-size: 32px;
    line-height: 1;
  }

  .overhaul-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .overhaul-section-title {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 18px;
  }

  .overhaul-section-title p {
    max-width: 74ch;
    margin: 0;
  }

  .slice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
  }

  .slice-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 14px;
    border-left: 3px solid color-mix(in srgb, #00f060 68%, var(--node-border));
  }

  .slice-card--done {
    border-left-color: #00f060;
  }

  .slice-card--next {
    border-left-color: #35f2ff;
  }

  .slice-card--follow-up {
    border-left-color: #ffa94d;
  }

  .slice-card-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  .slice-card strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 16px;
  }

  .slice-card p,
  .slice-card ul,
  .stage-body ul {
    margin: 0;
  }

  .slice-card h4 {
    margin: 5px 0 0;
    color: #00f060;
  }

  .slice-card ul,
  .stage-body ul {
    padding-left: 18px;
  }

  .stage-list,
  .archive-list {
    display: grid;
    gap: 8px;
  }

  .stage-row {
    overflow: hidden;
  }

  .stage-row summary {
    display: grid;
    grid-template-columns: 76px minmax(180px, 0.6fr) minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    cursor: pointer;
    padding: 12px 14px;
  }

  .stage-row summary strong {
    color: var(--terminal-fg, #d4d4d4);
  }

  .stage-row summary em {
    text-transform: none;
    letter-spacing: 0;
  }

  .stage-body {
    display: grid;
    gap: 10px;
    padding: 0 14px 14px 100px;
  }

  .stage-body p b {
    color: var(--terminal-fg, #d4d4d4);
  }

  .overhaul-two-up {
    display: grid;
    grid-template-columns: minmax(0, 0.78fr) minmax(320px, 1fr);
    gap: 16px;
    align-items: start;
  }

  .overhaul-two-up > div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .north-star-list {
    display: grid;
    gap: 7px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .north-star-list li {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-height: 34px;
    border: 1px solid color-mix(in srgb, var(--node-border) 62%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.2);
    color: color-mix(in srgb, var(--terminal-fg) 76%, transparent);
    font-size: 12px;
    padding: 6px 9px;
  }

  .north-star-list span {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(0, 240, 96, 0.38);
    border-radius: 999px;
    color: #00f060;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
  }

  .archive-list article {
    padding: 12px;
    border-left: 3px solid color-mix(in srgb, #35f2ff 62%, var(--node-border));
  }

  .archive-list strong {
    display: block;
    color: var(--terminal-fg, #d4d4d4);
  }

  .archive-list span {
    display: block;
    margin: 4px 0 6px;
    color: #35f2ff;
  }

  .roles-intro {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: end;
  }

  .roles-intro h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 20px;
  }

  .roles-intro p {
    margin: 0;
    max-width: 68ch;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-size: 12px;
    line-height: 1.45;
  }

  .role-definition-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .role-definition-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-left: 3px solid var(--agent-color, #00f060);
  }

  .role-definition-title {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .role-definition-title > span {
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--agent-color, #00f060) 56%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--agent-color, #00f060) 10%, transparent);
    font-size: 23px;
  }

  .role-definition-title div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .role-definition-title strong {
    color: var(--terminal-fg, #d4d4d4);
  }

  .role-definition-title code,
  .role-definition-card dt {
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .role-definition-card p,
  .role-definition-card dd {
    margin: 0;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    font-size: 12px;
    line-height: 1.5;
  }

  .role-definition-card dl {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  .role-definition-card dt {
    margin-bottom: 3px;
    color: color-mix(in srgb, var(--agent-color, #00f060) 72%, var(--terminal-fg));
  }

  .agent-tile,
  .agent-preview,
  .form-panel,
  .role-definition-card,
  .team-builder,
  .saved-teams,
  .hierarchy-root,
  .hierarchy-card,
  .protocol-card,
  .kanban-column {
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--node-header-bg, #101318) 70%, transparent);
  }

  .agent-tile {
    min-width: 0;
    min-height: 188px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
    border-left: 3px solid var(--agent-color, #00f060);
  }

  .agent-avatar {
    width: 62px;
    height: 62px;
    border: 1px solid color-mix(in srgb, var(--agent-color, #00f060) 62%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--agent-color, #00f060) 12%, transparent);
    color: var(--terminal-fg, #d4d4d4);
    cursor: pointer;
    font-size: 30px;
    box-shadow: 0 0 24px color-mix(in srgb, var(--agent-color, #00f060) 22%, transparent);
  }

  .agent-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .agent-copy span,
  .agent-copy p,
  .hierarchy-card em,
  .task-card p,
  .project-key span {
    margin: 0;
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .agent-copy strong,
  .agent-preview strong,
  .hierarchy-root strong,
  .hierarchy-card strong,
  .protocol-card strong,
  .task-card strong,
  .team-row strong,
  .team-builder h3,
  .saved-teams h3,
  .kanban-column h3 {
    color: var(--terminal-fg, #d4d4d4);
  }

  .agent-copy p {
    line-height: 1.45;
    text-transform: none;
    letter-spacing: 0;
  }

  .tile-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
  }

  .tile-actions button,
  .form-actions button,
  .team-builder button {
    border: 1px solid rgba(0, 240, 96, 0.42);
    border-radius: 7px;
    background: rgba(0, 240, 96, 0.08);
    color: var(--terminal-fg, #d4d4d4);
    padding: 8px 11px;
  }

  .agent-tile--new {
    border-style: dashed;
  }

  .customize-grid,
  .teams-grid {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 16px;
  }

  .agent-preview {
    min-height: 360px;
    padding: 22px;
    border-left: 4px solid var(--agent-color, #00f060);
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 10px;
    box-shadow: inset 0 0 70px color-mix(in srgb, var(--agent-color, #00f060) 12%, transparent);
  }

  .preview-avatar {
    font-size: 64px;
  }

  .form-panel,
  .team-builder,
  .saved-teams {
    padding: 16px;
  }

  .role-strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 12px;
  }

  .role-strip button {
    min-width: 92px;
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background: transparent;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    cursor: pointer;
    padding: 10px;
  }

  .role-strip button.selected {
    border-color: rgba(0, 240, 96, 0.58);
    background: rgba(0, 240, 96, 0.08);
  }

  .role-strip span {
    display: block;
    font-size: 24px;
  }

  .role-strip small {
    display: block;
    margin-top: 5px;
  }

  .quick-choice-panel {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    margin-top: 12px;
  }

  .emoji-choice-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
    gap: 6px;
    max-height: 116px;
    overflow-y: auto;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--node-border) 62%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.18);
  }

  .emoji-choice-grid button {
    min-width: 0;
    min-height: 34px;
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.24);
    color: var(--terminal-fg, #d4d4d4);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }

  .emoji-choice-grid button:hover,
  .emoji-choice-grid button:focus-visible,
  .emoji-choice-grid button.selected {
    border-color: rgba(0, 240, 96, 0.62);
    box-shadow: 0 0 14px rgba(0, 240, 96, 0.18);
    outline: none;
  }

  .quick-choice-panel > div {
    border: 1px solid color-mix(in srgb, var(--node-border) 62%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.18);
    padding: 10px;
  }

  .quick-choice-panel span {
    display: block;
    margin-bottom: 8px;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .quick-choice-panel > div > div {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .quick-choice-panel button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    border: 1px solid color-mix(in srgb, var(--agent-color, #00f060) 48%, transparent);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.24);
    color: var(--terminal-fg, #d4d4d4);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 5px 8px;
  }

  .quick-choice-panel button:hover,
  .quick-choice-panel button:focus-visible {
    border-color: var(--agent-color, #00f060);
    box-shadow: 0 0 14px color-mix(in srgb, var(--agent-color, #00f060) 34%, transparent);
    outline: none;
  }

  .quick-choice-panel i {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--agent-color, #00f060);
    box-shadow: 0 0 8px var(--agent-color, #00f060);
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  label.wide {
    grid-column: 1 / -1;
  }

  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--node-border) 78%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.28);
    color: var(--terminal-fg, #d4d4d4);
    font: inherit;
    letter-spacing: 0;
    text-transform: none;
    padding: 9px 10px;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 14px;
  }

  .team-builder,
  .saved-teams {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .team-pick-list {
    display: grid;
    gap: 8px;
  }

  .team-pick,
  .team-row {
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.18);
    color: var(--terminal-fg, #d4d4d4);
    padding: 10px;
  }

  .team-pick {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: center;
  }

  .team-row {
    display: flex;
    justify-content: space-between;
    text-align: left;
  }

  .hierarchy-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
  }

  .hierarchy-root {
    min-width: min(520px, 100%);
    padding: 18px;
    text-align: center;
    border-color: rgba(0, 240, 96, 0.62);
    box-shadow: 0 0 40px rgba(0, 240, 96, 0.12);
  }

  .hierarchy-root span {
    display: block;
    font-size: 42px;
  }

  .hierarchy-root em {
    display: block;
    margin-top: 6px;
    color: color-mix(in srgb, var(--terminal-fg) 54%, transparent);
    font-style: normal;
  }

  .hierarchy-lanes,
  .protocol-grid,
  .kanban-grid {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }

  .hierarchy-card {
    min-height: 160px;
    padding: 14px;
    border-left: 3px solid var(--agent-color, #00f060);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hierarchy-card span {
    font-size: 28px;
  }

  .hierarchy-card p,
  .protocol-card p {
    margin: 0;
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-size: 12px;
    line-height: 1.45;
  }

  .hierarchy-card--add {
    border-style: dashed;
  }

  .protocol-card {
    min-height: 170px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .protocol-card span,
  .protocol-card em {
    color: #00f060;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-style: normal;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .tasks-page {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .overhaul-live-board,
  .swarm-task-board {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .overhaul-live-board {
    border: 1px solid color-mix(in srgb, var(--node-border) 74%, transparent);
    border-radius: 8px;
    background:
      linear-gradient(135deg, rgba(0, 240, 96, 0.1), transparent 38%),
      color-mix(in srgb, var(--node-header-bg, #101318) 72%, transparent);
    padding: 14px;
  }

  .overhaul-live-header,
  .swarm-task-heading {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
  }

  .overhaul-live-header h3,
  .swarm-task-heading h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
  }

  .overhaul-live-header p {
    max-width: 82ch;
    margin: 7px 0 0;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-size: 12px;
    line-height: 1.5;
  }

  .overhaul-live-status {
    min-width: 250px;
    display: grid;
    gap: 7px;
    justify-items: end;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    text-align: right;
    text-transform: uppercase;
  }

  .overhaul-live-status span,
  .openai-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .overhaul-live-status img,
  .openai-pill img,
  .implementation-list img,
  .proof-row img {
    width: 16px;
    height: 16px;
    object-fit: contain;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    padding: 2px;
    box-shadow: 0 0 14px rgba(0, 240, 96, 0.18);
  }

  .overhaul-live-status strong {
    color: #00f060;
    font-size: 13px;
    font-weight: 700;
  }

  .overhaul-live-status code {
    max-width: 320px;
    overflow-wrap: anywhere;
    color: color-mix(in srgb, var(--terminal-fg) 54%, transparent);
    font-size: 9px;
    text-transform: none;
  }

  .overhaul-kanban-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(230px, 1fr));
    gap: 12px;
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .overhaul-kanban-column {
    min-width: 230px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--node-border) 70%, transparent);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.22);
    padding: 10px;
  }

  .overhaul-kanban-column--done {
    border-top-color: rgba(0, 240, 96, 0.7);
  }

  .overhaul-kanban-column--taking {
    border-top-color: rgba(53, 242, 255, 0.72);
  }

  .overhaul-kanban-column--next {
    border-top-color: rgba(255, 210, 92, 0.72);
  }

  .overhaul-kanban-column--follow-up {
    border-top-color: rgba(255, 121, 198, 0.68);
  }

  .overhaul-kanban-column header h3 {
    margin: 0;
    color: var(--terminal-fg, #d4d4d4);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .overhaul-kanban-column header p {
    margin: 5px 0 0;
    color: color-mix(in srgb, var(--terminal-fg) 58%, transparent);
    font-size: 11px;
    line-height: 1.35;
  }

  .overhaul-task-card {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    border: 1px solid color-mix(in srgb, var(--node-border) 64%, transparent);
    border-left: 3px solid rgba(0, 240, 96, 0.72);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.28);
    padding: 10px;
  }

  .overhaul-kanban-column--taking .overhaul-task-card {
    border-left-color: #35f2ff;
  }

  .overhaul-kanban-column--next .overhaul-task-card {
    border-left-color: #ffd25c;
  }

  .overhaul-kanban-column--follow-up .overhaul-task-card {
    border-left-color: #ff79c6;
  }

  .overhaul-task-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
  }

  .openai-pill,
  .overhaul-task-meta em,
  .swarm-task-heading span {
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 9px;
    font-style: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .overhaul-task-meta em {
    flex: 0 0 auto;
  }

  .overhaul-task-card strong {
    color: var(--terminal-fg, #d4d4d4);
    font-size: 13px;
    line-height: 1.25;
  }

  .overhaul-task-card p {
    margin: 0;
    color: color-mix(in srgb, var(--terminal-fg) 66%, transparent);
    font-size: 11px;
    line-height: 1.42;
  }

  .implementation-list {
    display: grid;
    gap: 5px;
  }

  .implementation-list span,
  .proof-row {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    align-items: start;
    gap: 7px;
    color: color-mix(in srgb, var(--terminal-fg) 70%, transparent);
    font-size: 11px;
    line-height: 1.35;
  }

  .implementation-list img,
  .proof-row img {
    width: 14px;
    height: 14px;
    padding: 1px;
  }

  .proof-row {
    border-top: 1px solid color-mix(in srgb, var(--node-border) 50%, transparent);
    padding-top: 8px;
    color: color-mix(in srgb, #00f060 72%, var(--terminal-fg));
  }

  .project-key {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .project-key span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .project-key i {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--project-color, #00f060);
    box-shadow: 0 0 12px var(--project-color, #00f060);
  }

  .kanban-column {
    min-height: 320px;
    padding: 12px;
  }

  .kanban-column h3 {
    margin: 0 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
  }

  .task-card {
    border: 1px solid color-mix(in srgb, var(--project-color, #00f060) 46%, transparent);
    border-left: 3px solid var(--project-color, #00f060);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.28);
    padding: 10px;
    margin-bottom: 8px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 8px;
  }

  .task-card p {
    grid-column: 2;
  }

  :global([data-theme="tron-encom-os"]) .center-shell,
  :global([data-theme="tron-encom-os"]) .agent-tile,
  :global([data-theme="tron-encom-os"]) .agent-preview,
  :global([data-theme="tron-encom-os"]) .form-panel,
  :global([data-theme="tron-encom-os"]) .overhaul-hero,
  :global([data-theme="tron-encom-os"]) .overhaul-live-board,
  :global([data-theme="tron-encom-os"]) .overhaul-kanban-column,
  :global([data-theme="tron-encom-os"]) .overhaul-task-card,
  :global([data-theme="tron-encom-os"]) .overhaul-metrics article,
  :global([data-theme="tron-encom-os"]) .slice-card,
  :global([data-theme="tron-encom-os"]) .stage-row,
  :global([data-theme="tron-encom-os"]) .archive-list article,
  :global([data-theme="tron-encom-os"]) .team-builder,
  :global([data-theme="tron-encom-os"]) .saved-teams,
  :global([data-theme="tron-encom-os"]) .hierarchy-root,
  :global([data-theme="tron-encom-os"]) .hierarchy-card,
  :global([data-theme="tron-encom-os"]) .protocol-card,
  :global([data-theme="tron-encom-os"]) .kanban-column {
    border-radius: 0;
    background: var(--bg-panel, #05070a);
  }

  :global([data-theme="tron-encom-os"]) .center-tabs button,
  :global([data-theme="tron-encom-os"]) .close-btn,
  :global([data-theme="tron-encom-os"]) input,
  :global([data-theme="tron-encom-os"]) textarea,
  :global([data-theme="tron-encom-os"]) .tile-actions button,
  :global([data-theme="tron-encom-os"]) .form-actions button,
  :global([data-theme="tron-encom-os"]) .team-builder button,
  :global([data-theme="tron-encom-os"]) .quick-choice-panel button,
  :global([data-theme="tron-encom-os"]) .quick-choice-panel > div {
    border-radius: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  :global([data-theme="tron-encom-os"]) .eyebrow {
    color: #00f060;
    text-shadow: 0 0 12px rgba(0, 240, 96, 0.5);
  }

  @media (max-width: 920px) {
    .agent-center {
      padding: 14px;
    }

    .customize-grid,
    .teams-grid,
    .overhaul-hero,
    .overhaul-metrics,
    .overhaul-two-up,
    .form-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .overhaul-live-header,
    .swarm-task-heading {
      flex-direction: column;
    }

    .overhaul-live-status {
      justify-items: start;
      text-align: left;
    }

    .overhaul-section-title,
    .roles-intro {
      align-items: start;
      flex-direction: column;
    }

    .stage-row summary {
      grid-template-columns: minmax(0, 1fr);
    }

    .stage-body {
      padding: 0 14px 14px;
    }
  }
</style>
