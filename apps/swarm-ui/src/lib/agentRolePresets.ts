export interface AgentRolePreset {
  id: string;
  label: string;
  role: string;
  emoji: string;
  accent: string;
  description: string;
  definition: string;
  owns: string;
  idle: string;
}

export const STANDARD_AGENT_ROLE_PRESETS: AgentRolePreset[] = [
  {
    id: 'planner',
    label: 'Planner',
    role: 'planner',
    emoji: '🦉',
    accent: 'cyan',
    description: 'Plans work, assigns tasks, and keeps agents synchronized.',
    definition: 'Decomposes the operator goal into tasks, assigns owners, tracks blockers, and decides when the swarm is done.',
    owns: 'Task graph, priority, sequencing, planner ownership, and final coordination calls.',
    idle: 'Waits for task/message/KV changes and reacts to completions, failures, or new operator direction.',
  },
  {
    id: 'implementer',
    label: 'Implementer',
    role: 'implementer',
    emoji: '🛠️',
    accent: 'green',
    description: 'Claims tasks, edits code, and reports concrete results.',
    definition: 'Claims implementation or fix tasks, edits files, runs focused verification, and reports changed files plus test status.',
    owns: 'Scoped code changes, file locks while editing, progress updates, and handoff-ready implementation notes.',
    idle: 'Waits for open matching tasks, assigned messages, or planner follow-up.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    role: 'reviewer',
    emoji: '🔍',
    accent: 'amber',
    description: 'Reviews diffs, calls out risks, and verifies behavior.',
    definition: 'Inspects completed work for regressions, missing tests, unsafe assumptions, and mismatch with the task contract.',
    owns: 'Review findings, approval or rejection of review tasks, and follow-up fix requests.',
    idle: 'Waits for review tasks, completed implementation notices, or direct risk checks.',
  },
  {
    id: 'researcher',
    label: 'Researcher',
    role: 'researcher',
    emoji: '🧭',
    accent: 'blue',
    description: 'Investigates context, docs, files, and evidence before action.',
    definition: 'Finds facts before the builders move: repo archaeology, docs, command evidence, constraints, and uncertainty mapping.',
    owns: 'Read-only findings, evidence links, annotations, and recommended next actions.',
    idle: 'Waits for research tasks, unclear claims, or requests to verify context.',
  },
  {
    id: 'designer',
    label: 'Designer',
    role: 'designer',
    emoji: '🎨',
    accent: 'rose',
    description: 'Owns product feel, layout, visual hierarchy, and polish.',
    definition: 'Shapes UI experience, interaction clarity, hierarchy, visual polish, and user-facing copy for product surfaces.',
    owns: 'Design recommendations, UI acceptance notes, and visual/interaction quality checks.',
    idle: 'Waits for UI tasks, screenshot review, or product-direction prompts.',
  },
  {
    id: 'operator',
    label: 'Operator',
    role: 'operator',
    emoji: '🚀',
    accent: 'white',
    description: 'Runs commands, coordinates process state, and handles launch operations.',
    definition: 'Handles the operational layer: launch commands, process state, environment setup, channel hygiene, and manual-control tasks.',
    owns: 'Shell execution, process cleanup, app/server restarts, channel setup, and status checks.',
    idle: 'Waits for launch, recovery, diagnostics, or coordination commands from the operator/planner.',
  },
  {
    id: 'architect',
    label: 'Architect',
    role: 'architect',
    emoji: '🏗️',
    accent: 'violet',
    description: 'Shapes system boundaries and long-lived technical direction.',
    definition: 'Defines technical structure, module boundaries, contracts, migration approach, and tradeoffs before broad changes land.',
    owns: 'Architecture notes, interface decisions, risk boundaries, and multi-phase implementation shape.',
    idle: 'Waits for design/contract questions, cross-module changes, or planner requests for direction.',
  },
  {
    id: 'debugger',
    label: 'Debugger',
    role: 'debugger',
    emoji: '🧰',
    accent: 'red',
    description: 'Reproduces failures and narrows root cause before fixing.',
    definition: 'Reproduces bugs, isolates root cause, captures failing evidence, and proposes the smallest reliable fix path.',
    owns: 'Repro steps, logs, narrowed cause, and fix recommendations or focused bug patches.',
    idle: 'Waits for failing tests, runtime errors, confusing behavior, or direct bug reports.',
  },
  {
    id: 'qa',
    label: 'QA',
    role: 'qa',
    emoji: '✅',
    accent: 'lime',
    description: 'Runs manual and automated verification with visible pass/fail cues.',
    definition: 'Verifies completed work through tests, smoke paths, screenshots, and clear pass/fail evidence.',
    owns: 'Verification matrix, manual QA notes, test output, and residual risk callouts.',
    idle: 'Waits for features ready to verify, release checks, or regression sweeps.',
  },
  {
    id: 'scribe',
    label: 'Scribe',
    role: 'scribe',
    emoji: '📝',
    accent: 'silver',
    description: 'Turns work into docs, handoffs, plans, and release notes.',
    definition: 'Captures decisions, summarizes status, writes handoffs, updates docs, and keeps team memory readable.',
    owns: 'Docs, changelogs, handoff prompts, status summaries, and operator-readable notes.',
    idle: 'Waits for milestones, handoff requests, doc tasks, or plan updates.',
  },
];

export const AGENT_EMOJI_CHOICES = [
  '🦉',
  '🛠️',
  '🔍',
  '🧭',
  '🎨',
  '🚀',
  '🏗️',
  '🧰',
  '✅',
  '📝',
  '💡',
  '🧪',
  '📡',
  '🛰️',
  '🧑‍💻',
  '👩‍💻',
  '👨‍💻',
  '🤖',
  '🧠',
  '📚',
  '📋',
  '🗂️',
  '🔐',
  '🧩',
  '🎯',
  '⚡️',
  '🌙',
  '☀️',
  '⭐️',
  '🔥',
  '💎',
];

export const AGENT_ACCENT_CHOICES = [
  'green',
  'red',
  'cyan',
  'amber',
  'blue',
  'rose',
  'violet',
  'lime',
  'gold',
  'orange',
  'white',
  'silver',
  '#00f060',
  '#ff3a4c',
  '#35f2ff',
  '#ffa94d',
  '#f5b342',
  '#b86bff',
  '#c6ff3d',
  '#ffffff',
];

export function rolePresetForRole(role: string): AgentRolePreset {
  const normalized = role.trim().toLowerCase();
  return STANDARD_AGENT_ROLE_PRESETS.find((preset) => preset.role === normalized)
    ?? STANDARD_AGENT_ROLE_PRESETS.find((preset) => preset.role === 'operator')
    ?? STANDARD_AGENT_ROLE_PRESETS[0];
}
