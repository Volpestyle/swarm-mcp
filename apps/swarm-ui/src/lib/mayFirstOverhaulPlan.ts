export interface OverhaulSlice {
  id: string;
  title: string;
  status: 'done' | 'active' | 'next' | 'follow-up';
  goal: string;
  build: string[];
  proof: string[];
}

export interface OverhaulStage {
  id: string;
  title: string;
  purpose: string;
  work: string[];
  proof: string;
}

export interface ArchivedPhase {
  name: string;
  status: string;
  useNow: string;
}

export const MAY_FIRST_OVERHAUL_SUMMARY = {
  name: 'May 1st Overhaul',
  correction: 'May 2 project-first UX correction is folded in',
  authority: 'Open Project -> Project Cockpit -> Task Board -> task-bound agents -> listener/task status',
  activePath: 'Slice 0 through Slice 8C are complete on the local dev surface. Slice 7D native app-restart survivor proof passed. Slice 8D native background-control proof is accepted with installed click/reopen and notifications tracked as follow-up.',
  archiveRule: 'Old Phase 4/5/6/7 plans are archived source material, not active task authority.',
  repo: '/Users/mathewfrazier/Desktop/swarm-mcp-lab',
  scope: '/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
};

export const MAY_FIRST_MVP_SLICES: OverhaulSlice[] = [
  {
    id: 'Slice 0',
    title: 'Baseline and existing UI smoke',
    status: 'done',
    goal: 'Know which old surfaces are usable before editing.',
    build: [
      'Smoke Home, Project, Launch, Terminal, and Asset surfaces.',
      'Record reusable behavior from archived Phase 4/5/6.',
      'Record broken surfaces that should be ignored or replaced.',
    ],
    proof: [
      '`cd apps/swarm-ui && bun run check` passed.',
      '`cd apps/swarm-ui && bun run build` passed with the existing chunk-size warning.',
      '`cd apps/swarm-ui && bunx tauri build --debug --no-bundle` passed.',
      'Browser smoke covered Home, Launch, Project/Workspace Kit, Agents/Live Tasks, and Asset/Media entry points.',
    ],
  },
  {
    id: 'Slice 1',
    title: 'Authority and Home simplification',
    status: 'done',
    goal: 'The app starts with a clear choice instead of old phase clutter.',
    build: [
      'Home primary actions: Open Project, Start From Plan, Resume Running Agents.',
      'Move launch/profile/config details behind a secondary path.',
      'Hide raw directory/scope/channel decisions from first-run flow.',
      'Route selected or opened project into Project Cockpit.',
    ],
    proof: [
      'Home first viewport shows Open Project, Start From Plan, and Resume Running Agents.',
      'Advanced Launch remains reachable as a secondary path.',
      'Start From Plan routes to the May 1st plan surface.',
      'Open Project uses the native directory picker when available and falls back to project creation.',
      'Tauri debug build confirms the native dialog import path compiles.',
    ],
  },
  {
    id: 'Slice 2',
    title: 'Project Cockpit MVP',
    status: 'done',
    goal: 'Opening any folder lands in a useful project workspace.',
    build: [
      'Project summary section.',
      'Task Board placeholder connected to project.',
      'Running/reconnectable agents summary.',
      'Recent activity summary.',
      'Use "project context, not sandbox" copy only where needed.',
    ],
    proof: [
      'Open a repo and see root, tasks, agents, and activity without drawing a boundary.',
      'Internal channel/scope appears only as diagnostic metadata.',
      'Project Cockpit shows project root, task lanes, running/reconnectable agents, and recent activity in one surface.',
      '`cd apps/swarm-ui && bun run check` passed.',
    ],
  },
  {
    id: 'Slice 3',
    title: 'Task Board MVP',
    status: 'done',
    goal: 'Tasks become the main launch surface.',
    build: [
      'Add and edit tasks.',
      'Paste plan text into task rows.',
      'Section grouping and multi-select.',
      'Provider and role assignment fields.',
      'Sticky selected-task action bar.',
    ],
    proof: [
      'Paste the north-star plan text and turn it into editable tasks.',
      'Select three tasks and see a clear Launch 3 action.',
      'Task Board rows support sections, editable fields, status, provider, role, assignee/listener metadata, and result summaries.',
      '`cd apps/swarm-ui && bun run check` passed.',
    ],
  },
  {
    id: 'Slice 4',
    title: 'Launch selected task-bound agents',
    status: 'done',
    goal: 'Launch selected tasks into real task-bound agent sessions.',
    build: [
      'Use the existing spawnShell path with Codex, Claude, or opencode providers.',
      'Bind task id, agent id, project id/root, internal channel/scope, provider, role, and launch command.',
      'Show task-bound tile placement on canvas.',
      'Show basic listener/task status in rows.',
    ],
    proof: [
      'Browser smoke launched three selected rows through mocked Tauri spawn_shell calls.',
      'Each task row shows assigned provider/role, listener state, elapsed time, last activity, result, agent id, and PTY id.',
      '`cd apps/swarm-ui && bun run check` passed.',
      '`cd apps/swarm-ui && bun run build` passed with the existing chunk-size warning.',
      '`cd apps/swarm-ui && bunx tauri build --debug --no-bundle` passed.',
    ],
  },
  {
    id: 'Slice 5',
    title: 'Review and regression pass',
    status: 'done',
    goal: 'Make the first loop safe before adding new surfaces.',
    build: [
      'Add a Task Board proof-pack capture for semantic UI evidence, review notes, row state, agent state, activity, and honest screenshot status.',
      'Add `swarm-mcp ui proof-pack` as the queued CLI sidecar for artifact capture.',
      'Fix broken text fit and confusing launch copy.',
      'Fix stale task/agent state.',
      'Add missing retry/reassign affordance.',
      'Remove happy-path scope/channel decisions.',
    ],
    proof: [
      'Project Task Board can write a `swarm-ui-proof-pack` JSON artifact with task rows, agents, activity, visual evidence, and review signals.',
      '`swarm-mcp ui proof-pack --wait 0 --json` queues the same artifact family from CLI for later UI-worker capture.',
      'Browser smoke verified Home -> saved project -> Task Board -> Launch 3 -> Capture proof pack with normal clicks.',
      'Native smoke verified swarm-ui worker spawn -> app-owned Codex PTY -> adopted instance -> standby broadcast -> wait loop.',
      'Native click-through attempted; screenshot proof works, but automated clicks are blocked until macOS Accessibility is enabled for the active desktop controller or the checklist is run manually.',
      'Retry/reassign polish landed: rows derive stale state from live instance data, expose Retry/Reassign/Reset, and proof packs capture computed stale listener evidence.',
      'Slice 5E accepted the safety pass on browser visual proof plus native worker evidence, and sidelined 5C native click automation for an end-of-overhaul Accessibility revisit.',
      'Slice 5E fixed the Task Board action bar so it no longer overlaps task rows during proof capture.',
      'Opening a saved project now exits Home before Project Page controls need clicks.',
      'Run human-visible Project Task Board native click-through near the end when desktop Accessibility/screen capture is available.',
      'Update manual QA with pass/fail cues.',
    ],
  },
  {
    id: 'Slice 6',
    title: 'Review/Ship surface',
    status: 'done',
    goal: 'Turn completed agent work into reviewable engineering output.',
    build: [
      'Project Page Review / Ship section with changed files grouped by task/agent.',
      'Commit-message suggestions generated from task titles, results, reported files, tests, and unresolved risks.',
      'Reviewer handoff text and direct reviewer-agent send action when an online reviewer/opencode agent is attached to the project.',
      'Task result summaries, unresolved risks, and explicit no-auto-commit posture visible before shipping.',
    ],
    proof: [
      '`apps/swarm-ui/src/lib/reviewShip.ts` builds structured Review/Ship summaries from project tasks, locks, and attached agents.',
      '`bun test apps/swarm-ui/src/lib/reviewShip.test.ts` passed.',
      '`cd apps/swarm-ui && bun run check` passed with 0 Svelte errors and 0 warnings.',
      '`cd apps/swarm-ui && bun run build` passed with the existing Vite warnings only.',
      'Browser visual smoke covers Review / Ship on desktop and narrow widths.',
    ],
  },
  {
    id: 'Slice 7A',
    title: 'Stale row reconciliation',
    status: 'done',
    goal: 'Make cleanup truth immediate when instance rows disappear or were already gone.',
    build: [
      'Add tested local reconciliation for removed instance rows.',
      'Optimistically remove cleaned-up instances, locks, queued recipient messages, and active task assignments from Svelte stores.',
      'Treat backend "instance not found" cleanup races as local success for deregister, force-remove, and kill paths.',
      'Let status-bar kill-all reconcile visible phantom rows when the backend reports no skipped protected targets.',
    ],
    proof: [
      '`apps/swarm-ui/src/lib/swarmReconcile.ts` mirrors backend deregister cleanup locally.',
      '`bun test apps/swarm-ui/src/lib/swarmReconcile.test.ts apps/swarm-ui/src/lib/ptyCatalog.test.ts` passed.',
      '`cd apps/swarm-ui && bun run check` passed with 0 Svelte errors and 0 warnings.',
      '`cd apps/swarm-ui && bun run build` passed with the existing Vite warnings only.',
    ],
  },
  {
    id: 'Slice 7B',
    title: 'Launch preflight diagnostics',
    status: 'done',
    goal: 'Block obvious bad launches before a terminal opens silently and fails.',
    build: [
      'Add a shared launch-command preflight helper with shell-word parsing, command/provider mismatch checks, and command summary copy.',
      'Add a Tauri `ui_preflight_launch_command` IPC command that resolves the executable through the login shell using the same interactive shell posture as Codex launch scripts.',
      'Run preflight before Advanced Launch, saved Agent Profile launch, Team Launch, Task Board launch, and the shared `spawnShell` contract.',
      'Show Task Board row-level preflight states and launch-blocking messages before spawning.',
    ],
    proof: [
      '`apps/swarm-ui/src/lib/launchPreflight.ts` parses launch commands and fallback-checks browser/dev surfaces.',
      '`ui_preflight_launch_command` reports login shell, PATH preview, executable resolution, diagnostics, warnings, and blocker text.',
      '`bun test apps/swarm-ui/src/lib/launchPreflight.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts apps/swarm-ui/src/lib/codexLaunchCommand.test.ts` passed.',
      '`cargo test -p swarm-ui launch_preflight_` passed.',
      '`cd apps/swarm-ui && bun run check` passed with 0 Svelte errors and 0 warnings.',
      '`cd apps/swarm-ui && bun run build` passed with the existing Vite warnings only.',
      '`cd apps/swarm-ui && bunx tauri build --debug --no-bundle` passed and built the debug binary.',
    ],
  },
  {
    id: 'Slice 7C',
    title: 'Command trust posture visibility',
    status: 'done',
    goal: 'Make full-access/bypass commands visible at the launch decision point instead of hidden in aliases.',
    build: [
      'Classify `flux`, `flux9`, dangerous bypass flags, skip-permission flags, and no-sandbox style commands as full-access posture.',
      'Add full-access warnings into the launch preflight review and team preflight summaries.',
      'Show Task Board rows as `preflight full access` when the resolved launch command is dangerous but valid.',
      'Keep project-first Task Board launch modal-free unless a row has a hard preflight blocker.',
    ],
    proof: [
      'Launcher preflight review now includes `Preflight` and `Trust posture` lines.',
      'Full-access posture appears as an explicit incongruency before Advanced Launch or Team Launch proceeds.',
      'Task Board rows capture preflight success/failure in visible listener/result state and row launch errors.',
      '`bun test apps/swarm-ui/src/lib/launchPreflight.test.ts apps/swarm-ui/src/lib/launcherConfig.test.ts` covers posture and warning behavior.',
    ],
  },
  {
    id: 'Slice 7D',
    title: 'App-restart survivor and rescue loop',
    status: 'done',
    goal: 'If swarm-ui is killed while agents are running, explicit survivors remain alive and the relaunched app surfaces them without making the user hunt.',
    build: [
      'Launch one bounded task/background agent, then kill or quit `swarm-ui` while the agent is idle in `wait_for_activity`.',
      'Verify the agent process and swarm identity survive with the same project, scope, cwd, task/background labels, and policy tokens.',
      'Relaunch `swarm-ui` and show the survivor in Resume Center / running agents with status, purpose, timeout/idle policy, and cleanup controls.',
      'Provide visible rescue actions: reconnect when possible, open in Terminal/Ghostty, copy attach/resume command, suspend, and kill.',
      'Confirm workspace switching, stale cleanup, and orphan cleanup do not hide or incorrectly delete the survivor.',
    ],
    proof: [
      'Command `#28` spawned survivor instance `f912ba8f` with PTY `84629a59`; command `#29` launched the guarded standby Codex prompt.',
      'Event `#966` adopted MCP pid `7158`, and event `#967` shows the agent waiting.',
      'After killing only `swarm-ui` pid `6685`, SQLite and process evidence showed the same survivor alive.',
      'After relaunch, command `#31` addressed the survivor by instance id, closed PTY `84629a59`, deregistered `f912ba8f`, and terminated pid `7158`.',
      'Human-visible installed-app click/screenshot proof remains tied to the Slice 5C Accessibility/TCC revisit.',
    ],
  },
  {
    id: 'Slice 8A',
    title: 'Post-session improvement review',
    status: 'done',
    goal: 'Let the user capture what worked, what confused them, what broke, and what should improve next from the project surface.',
    build: [
      'Add a Project Page Post-Session Improvement section with Worked, Confusing, Broke, Improve Next, and follow-up prompt fields.',
      'Save the review as a project-local note asset with current task and agent state.',
      'Optionally convert the review into an editable Task Board improvement row.',
    ],
    proof: [
      '`apps/swarm-ui/src/lib/postSessionImprovement.ts` builds the project note and task seed.',
      '`bun test apps/swarm-ui/src/lib/postSessionImprovement.test.ts` covers review note and task-seed behavior.',
    ],
  },
  {
    id: 'Slice 8B',
    title: 'Bounded background improvement launch',
    status: 'done',
    goal: 'Allow opt-in background improvement work without turning it into mystery autonomous work.',
    build: [
      'Require explicit background-work opt-in, project cwd, internal channel, provider, role, trust posture, timeout, idle policy, and follow-up prompt.',
      'Launch through the existing `spawnShell` path with background-work owner/project/run labels and a guardrailed bootstrap prompt.',
      'Use an in-app confirmation before launching, with full-access posture called out when selected.',
    ],
    proof: [
      'Background launch label includes `owner:background-work`, project, run id, timeout, trust, and Slice 8 tokens.',
      'Bootstrap prompt forbids commit, push, deletion, history rewrite, and destructive cleanup without explicit approval.',
      '`bun test apps/swarm-ui/src/lib/postSessionImprovement.test.ts` covers validation, label, prompt, and safety copy.',
    ],
  },
  {
    id: 'Slice 8C',
    title: 'Background Resume Center',
    status: 'done',
    goal: 'Make background-work runs visible and controllable from the same project surface that launched them.',
    build: [
      'Derive project-linked background runs from live agent labels, scope, and directory.',
      'Show status, provider, role, timeout, and internal scope in a Project Page Resume Center.',
      'Add Suspend and Kill controls; Suspend asks the agent to report status then enter `wait_for_activity`, while Kill uses the destructive kill/deregister path.',
    ],
    proof: [
      '`backgroundRunsForProject()` derives Resume Center rows from live instance labels.',
      'Suspend sends a direct operator control message; Kill uses `killInstance()` behind an in-app confirmation.',
      '`bun test apps/swarm-ui/src/lib/postSessionImprovement.test.ts` covers background run derivation.',
    ],
  },
  {
    id: 'Slice 8D',
    title: 'Background work acceptance and notifier follow-up',
    status: 'follow-up',
    goal: 'Prove the post-session/background-work loop in the installed app and decide what needs actual enforcement beyond prompt policy.',
    build: [
      'Native worker acceptance proved bounded background launch, adoption, suspend-message delivery, and kill/deregister cleanup.',
      '`swarm-mcp ui kill --target <instance>` now drives the native bound-instance kill path for acceptance sweeps.',
      'Human-visible installed click-through still needs save review, create task, close/reopen, and Resume Center screenshot truth.',
      'Timeout/idle policy stays prompt-level for MVP; app-enforced timers and native notifications are post-MVP follow-up.',
    ],
    proof: [
      'Commands `#19`/`#20` spawned and prompted `bg-8d-native`; event `#920` adopted the row.',
      'Message `#308` was read; events `#924`-`#926` show suspend delivery through `wait_for_activity`.',
      'Command `#27` closed PTY `7fe78ef1`, deregistered `f8956e86`, and terminated pid `96058`; follow-up process search found no 8D smoke process.',
      'Notification/timer enforcement is explicitly documented as post-MVP and limited to completed, failed, approval needed, stale, or timed out background statuses.',
    ],
  },
];

export const MAY_FIRST_OVERHAUL_STAGES: OverhaulStage[] = [
  {
    id: 'Stage 0',
    title: 'Freeze the new product spine',
    purpose: 'Stop scattered expansion and align the repo around the visible loop.',
    work: ['Make May 1st docs the authority.', 'Fold in the May 2 UX correction.', 'Archive older phase docs where they conflict.'],
    proof: 'A new agent can read the handoff and know the next product loop.',
  },
  {
    id: 'Stage 1',
    title: 'Home and Project Cockpit simplification',
    purpose: 'Make startup project-agnostic and non-cluttered.',
    work: ['Reduce Home to three primary actions.', 'Make Project Cockpit the main surface after opening a folder.', 'Make boundaries optional.'],
    proof: 'Open any folder and land in a useful cockpit with no boundary drawing required.',
  },
  {
    id: 'Stage 2',
    title: 'Plan/Task Board as main launch surface',
    purpose: 'Close the biggest visible workflow gap using real swarm task semantics.',
    work: ['Build task board around real tasks.', 'Add multi-select and assignment sheet.', 'Launch selected tasks into real agents.'],
    proof: 'Select three tasks, launch three agents, and watch each bind to a tile independently.',
  },
  {
    id: 'Stage 3',
    title: 'Agent session persistence and Resume Center',
    purpose: 'Make persistence and cleanup trustworthy.',
    work: ['Inventory DB instances, PTYs, daemon sessions, and OS processes.', 'Add reconnect/suspend/kill/clear actions.', 'Add app-quit choices for live agents.'],
    proof: 'Close/reopen app, reconnect, and kill stale work without orphaning processes.',
  },
  {
    id: 'Stage 4',
    title: 'Context Composer and project-agnostic intake',
    purpose: 'Make project context and agent-readable data easy to pass around.',
    work: ['Composer for files, terminal output, browser snapshots, assets, and notes.', 'Start From Plan import.', 'Persist plan/task artifacts under project workspace.'],
    proof: 'Paste a plan, generate tasks, attach context, and launch selected agents.',
  },
  {
    id: 'Stage 5',
    title: 'Visual polish and operational layout',
    purpose: 'Make the app premium, readable, and calm under real work.',
    work: ['Standardize layout hierarchy.', 'Reduce nested panels.', 'Add meaningful state glow and auto-layout modes.'],
    proof: 'Desktop QA shows no overlap and status is readable at a glance.',
  },
  {
    id: 'Stage 6',
    title: 'Review/Ship surface',
    purpose: 'Turn parallel agent output into understandable engineering output.',
    work: ['Group changed files by task/agent.', 'Generate commit-message suggestions.', 'Add reviewer-agent handoff.'],
    proof: 'After task completion, the user sees what changed, why, and suggested commit text.',
  },
  {
    id: 'Stage 7',
    title: 'Reliability and trust finish',
    purpose: 'Make the product safe enough for daily use.',
    work: ['PATH/login-shell diagnostics.', 'Dangerous posture visibility.', 'Stale-node reconciliation and batch cleanup.'],
    proof: 'North-star demo survives restart, stale cleanup, and workspace switch.',
  },
  {
    id: 'Stage 8',
    title: 'Post-session improvement and background work',
    purpose: 'Capture friction and optionally launch bounded improvement work.',
    work: ['End-of-session review.', 'Project-local improvement tasks.', 'Opt-in bounded background-work agent.'],
    proof: 'Background work is visible, killable, suspendable, timed, and tied to a specific task.',
  },
  {
    id: 'Stage 9',
    title: 'Grand Architect / Majordomo and dynamic team evolution',
    purpose: 'Make team behavior visible, teachable, and provider-agnostic.',
    work: ['Coordinator role preset.', 'Team-state panel.', 'Auditable role-change proposals.'],
    proof: 'Majordomo proposes assignments and a role change with visible approval state.',
  },
  {
    id: 'Stage 10',
    title: 'Viewer and professional left rail',
    purpose: 'Add polished navigation and first-class artifact inspection.',
    work: ['Persistent left rail.', 'Viewer for docs, media, images, web snapshots, and terminal snippets.', 'Attach artifacts to tasks or agents.'],
    proof: 'Open and attach project artifacts from Viewer with accurate rail badges.',
  },
];

export const MAY_FIRST_ARCHIVED_PHASES: ArchivedPhase[] = [
  {
    name: 'Phase 0 - Lab baseline and team execution',
    status: 'Complete',
    useNow: 'Reference for setup and swarm execution conventions.',
  },
  {
    name: 'Phase 1 - Launch productization',
    status: 'Complete',
    useNow: 'Reference launch/profile implementation details only.',
  },
  {
    name: 'Phase 2 - Acceleration tooling',
    status: 'Complete',
    useNow: 'Reference CLI/UI commands and export/screenshot contracts.',
  },
  {
    name: 'Post-Phase-2 listener-health sync',
    status: 'Complete baseline',
    useNow: 'Preserve listener-health proof and use for regressions.',
  },
  {
    name: 'Phase 3 - Agent Identity Overhaul',
    status: 'Complete and closed',
    useNow: 'Preserve terminal-first baseline, Agent Deck, ownership cleanup, and role/emoji customization.',
  },
  {
    name: 'Phase 4 - Project Spaces',
    status: 'Archived; implemented, QA pending',
    useNow: 'Mine for Project Cockpit data/types without forcing boundary-first UX.',
  },
  {
    name: 'Phase 5 - Assets and Multimodal Context',
    status: 'Archived; implemented, QA pending',
    useNow: 'Mine for Viewer/context/asset implementation; do not continue as main lane.',
  },
  {
    name: 'Phase 6 - Startup Branding and Credit',
    status: 'Archived source material',
    useNow: 'Pull useful Home work into Stage 1 only.',
  },
  {
    name: 'Phase 7 - Themes and Protocol Views',
    status: 'Archived/gated',
    useNow: 'Defer until the task-board loop works.',
  },
];

export const MAY_FIRST_NORTH_STAR_STEPS = [
  'Open a local repo.',
  'See Project Cockpit.',
  'Start From Plan.',
  'Convert plan text into tasks.',
  'Select three tasks.',
  'Assign providers and roles.',
  'Launch task-bound agents.',
  'Watch listener state, task state, elapsed time, and latest activity.',
  'Review changed files, task results, risks, and commit-message suggestions.',
  'Resume, kill, or archive remaining work from a clear recovery surface.',
];
