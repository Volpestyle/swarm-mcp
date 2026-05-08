export interface BootstrapPromptInput {
  cwd: string;
  scope: string | null;
  role: string | null;
  label: string | null;
  bootstrapInstructions: string | null;
}

export function buildBootstrapPrompt(input: BootstrapPromptInput): string {
  const scopeFragment = input.scope ? ` and scope="${input.scope}"` : '';
  const labelFragment = input.label
    ? ` and label="${input.label.split('"').join('\\"')}"`
    : '';
  const base =
    `Use the provided swarm MCP register tool with directory="${input.cwd}"${scopeFragment}${labelFragment}. ` +
    'Then call whoami, list_instances, poll_messages, and list_tasks to verify registration only.';

  const toolBoundary =
    ' If the provided swarm MCP tools are unavailable or fail to start, report that in the terminal and wait for the operator; do not create an ad hoc fallback client, inspect the repo, or start work outside the swarm.';

  const standbyContract =
    ' After verification, broadcast a short [standby] message to the shared Conversation panel, then call wait_for_activity. ' +
    'Do not claim open tasks, inspect files, run tests, edit files, or coordinate work just because list_tasks shows available work. ' +
    'Treat messages from sender ids starting with operator: as operator chat, even when they were broadcast to multiple agents. ' +
    'If the operator asks a question, requests status, or talks conversationally, reply in the shared Conversation panel with a short broadcast. ' +
    'If an operator message sounds like an action item but is not clearly assigned as work, ask whether it should be treated as a work item, planning/design discussion, or conversation before starting. ' +
    'Only start code/repo work when you receive a direct operator message addressed to your instance id or a task assigned to your exact instance id. ' +
    'Peer broadcasts are awareness-only unless they explicitly name your instance id or role. For open/unassigned tasks, kv updates, or quiet timeouts, re-check state and return to standby.';

  const roleLine = input.role
    ? ` ${roleGuidance(input.role)}`
    : ' Treat this launch as operator-standby until directly assigned.';

  const extraInstructions = input.bootstrapInstructions?.trim();
  if (!extraInstructions) {
    return `${base}${toolBoundary}${roleLine}${standbyContract}`;
  }

  return `${base}${toolBoundary}${roleLine}${standbyContract}\nSaved launcher profile:\n${extraInstructions}`;
}

export function roleGuidance(role: string): string {
  const normalized = role.trim().toLowerCase();
  const title = role.trim() || 'agent';
  switch (normalized) {
    case 'planner':
      return 'You are the planner identity for this lane, but startup is standby-only until the operator directly assigns coordination work.';
    case 'implementer':
      return 'You are the implementer identity for this lane, but startup is standby-only until a task is assigned to your exact instance id.';
    case 'builder':
      return 'You are the builder identity for this lane, but startup is standby-only until build or fix work is assigned to your exact instance id.';
    case 'reviewer':
      return 'You are the reviewer identity for this lane, but startup is standby-only until a review task is assigned to your exact instance id.';
    case 'researcher':
      return 'You are the researcher identity for this lane, but startup is standby-only until a research request is sent directly to you.';
    case 'designer':
      return 'You are the designer identity for this lane, but startup is standby-only until design work is sent directly to you.';
    case 'operator':
      return 'You are the all-purpose operator identity for this lane, but startup is standby-only until launch, diagnostic, coordination, or general work is sent directly to you.';
    case 'architect':
      return 'You are the architect identity for this lane, but startup is standby-only until architecture work is sent directly to you.';
    case 'debugger':
      return 'You are the debugger identity for this lane, but startup is standby-only until a failure investigation is sent directly to you.';
    case 'qa':
      return 'You are the QA identity for this lane, but startup is standby-only until verification work is sent directly to you.';
    case 'scribe':
      return 'You are the scribe identity for this lane, but startup is standby-only until documentation work is sent directly to you.';
    default:
      return `You are the ${title} identity for this lane, but startup is standby-only until work is sent directly to you.`;
  }
}
