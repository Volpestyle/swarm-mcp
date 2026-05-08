import { describe, expect, test } from 'bun:test';
import {
  assertOperatorProofClassified,
  hasGhostAgent,
  launchedAgentTrackingNotes,
  missingOperatorProofSteps,
  type LaunchedAgentTrackingProof,
  type OperatorWorkflowProofStep,
} from './operatorWorkflowProof';

function step(id: OperatorWorkflowProofStep['id'], status: OperatorWorkflowProofStep['status']): OperatorWorkflowProofStep {
  return {
    id,
    label: id,
    status,
    screenshotPath: null,
    semanticBeforePath: null,
    semanticAfterPath: null,
    notes: '',
  };
}

describe('operator workflow proof', () => {
  test('requires every operator step to be passed or explicitly classified', () => {
    const steps: OperatorWorkflowProofStep[] = [
      step('home-version-visible', 'passed'),
      step('project-opened', 'passed'),
      step('asset-primary-click-reflected', 'manual-needed'),
      step('report-mode-targeted', 'passed'),
      step('report-next-reflected', 'passed'),
      step('report-confirm-persisted', 'passed'),
      step('agent-launch-visible', 'manual-needed'),
      step('agent-tracked-or-failed-visibly', 'manual-needed'),
    ];

    expect(missingOperatorProofSteps(steps)).toEqual([]);
    expect(() => assertOperatorProofClassified(steps)).not.toThrow();
  });

  test('fails pending, failed, or omitted workflow steps', () => {
    const steps: OperatorWorkflowProofStep[] = [
      step('home-version-visible', 'passed'),
      step('project-opened', 'pending'),
      step('asset-primary-click-reflected', 'failed'),
    ];

    expect(missingOperatorProofSteps(steps)).toContain('project-opened');
    expect(missingOperatorProofSteps(steps)).toContain('asset-primary-click-reflected');
    expect(missingOperatorProofSteps(steps)).toContain('report-mode-targeted');
    expect(() => assertOperatorProofClassified(steps)).toThrow('operator workflow proof missing required steps');
  });

  test('detects ghost agents when launches are invisible or cleanup-less', () => {
    const base: LaunchedAgentTrackingProof = {
      launchId: 'launch-1',
      instanceId: null,
      ptyId: null,
      projectId: 'project-1',
      scope: '/tmp/project',
      status: 'online',
      visibleInCanvas: false,
      visibleInAnalyze: false,
      visibleInResumeCenter: false,
      cleanupActionVisible: true,
    };

    expect(hasGhostAgent(base)).toBe(true);
    expect(hasGhostAgent({ ...base, visibleInCanvas: true })).toBe(false);
    expect(hasGhostAgent({ ...base, status: 'failed', cleanupActionVisible: true })).toBe(false);
    expect(hasGhostAgent({ ...base, status: 'failed', cleanupActionVisible: false })).toBe(true);
    expect(hasGhostAgent({ ...base, status: 'not-attempted', cleanupActionVisible: false })).toBe(false);
    expect(hasGhostAgent({ ...base, status: 'headless-background', visibleInCanvas: true })).toBe(true);
    expect(launchedAgentTrackingNotes({ ...base, status: 'failed', cleanupActionVisible: true })).toContain('visible');
    expect(launchedAgentTrackingNotes({ ...base, status: 'not-attempted' })).toContain('not attempted');
  });
});
