export type OperatorProofStepStatus = 'pending' | 'passed' | 'failed' | 'manual-needed';

export type OperatorProofStepId =
  | 'home-version-visible'
  | 'project-opened'
  | 'asset-primary-click-reflected'
  | 'report-mode-targeted'
  | 'report-next-reflected'
  | 'report-confirm-persisted'
  | 'agent-launch-visible'
  | 'agent-tracked-or-failed-visibly';

export type OperatorWorkflowProofStep = {
  id: OperatorProofStepId;
  label: string;
  status: OperatorProofStepStatus;
  screenshotPath: string | null;
  semanticBeforePath: string | null;
  semanticAfterPath: string | null;
  notes: string;
};

export type LaunchedAgentTrackingProof = {
  launchId: string;
  instanceId: string | null;
  ptyId: string | null;
  projectId: string;
  scope: string;
  status:
    | 'launching'
    | 'online'
    | 'stale'
    | 'failed'
    | 'not-attempted'
    | 'terminated'
    | 'orphaned'
    | 'headless-background';
  visibleInCanvas: boolean;
  visibleInAnalyze: boolean;
  visibleInResumeCenter: boolean;
  cleanupActionVisible: boolean;
};

export const OPERATOR_PROOF_STEP_ORDER: OperatorProofStepId[] = [
  'home-version-visible',
  'project-opened',
  'asset-primary-click-reflected',
  'report-mode-targeted',
  'report-next-reflected',
  'report-confirm-persisted',
  'agent-launch-visible',
  'agent-tracked-or-failed-visibly',
];

export function missingOperatorProofSteps(steps: OperatorWorkflowProofStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return OPERATOR_PROOF_STEP_ORDER.filter((id) => {
    const step = byId.get(id);
    return !step || step.status === 'pending' || step.status === 'failed';
  });
}

export function assertOperatorProofClassified(steps: OperatorWorkflowProofStep[]): void {
  const missing = missingOperatorProofSteps(steps);
  if (missing.length > 0) {
    throw new Error(`operator workflow proof missing required steps: ${missing.join(', ')}`);
  }
}

export function hasGhostAgent(proof: LaunchedAgentTrackingProof): boolean {
  if (proof.status === 'orphaned' || proof.status === 'headless-background') {
    return true;
  }
  if (proof.status === 'terminated') {
    return false;
  }
  if (proof.status === 'not-attempted') {
    return false;
  }
  if (proof.status === 'failed') {
    return !proof.cleanupActionVisible;
  }
  return !proof.visibleInCanvas && !proof.visibleInAnalyze && !proof.visibleInResumeCenter;
}

export function launchedAgentTrackingNotes(proof: LaunchedAgentTrackingProof): string {
  if (hasGhostAgent(proof)) {
    return 'launch produced an invisible or cleanup-less background agent';
  }
  if (proof.status === 'failed') {
    return 'launch failure is visible and has an operator cleanup action';
  }
  if (proof.status === 'not-attempted') {
    return 'native launch was not attempted by this proof run';
  }
  if (proof.status === 'terminated') {
    return 'launched agent was terminated cleanly';
  }
  return 'launched agent is represented on at least one operator surface';
}
