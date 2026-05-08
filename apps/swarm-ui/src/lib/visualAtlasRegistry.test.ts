import { describe, expect, test } from 'bun:test';
import {
  atlasCoverageIssues,
  atlasCoverageOk,
  visualAtlasCoverageReport,
  visualAtlasSurfaceStates,
} from './visualAtlasRegistry';

describe('visual atlas coverage', () => {
  test('no registered control is missing coverage', () => {
    expect(atlasCoverageIssues()).toEqual([]);
    expect(atlasCoverageOk()).toBe(true);
  });

  test('surface states expose deterministic screenshot names', () => {
    const states = visualAtlasSurfaceStates();

    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.screenshotName).toBe(`${state.id}.png`);
      expect(state.controls.length).toBeGreaterThan(0);
    }
  });

  test('coverage report fails when a control is missing coverage', () => {
    const report = visualAtlasCoverageReport([
      {
        id: 'test-surface',
        label: 'Test surface',
        route: 'visual-atlas',
        expectedBehavior: 'test behavior',
        proofLevel: 'source-confirmed',
        controls: [
          {
            id: 'test.missing',
            surfaceId: 'test-surface',
            label: 'Missing coverage control',
            kind: 'button',
            testId: 'test-missing',
            reportTargetId: 'test-missing',
            expectedBehavior: 'should be covered',
            proofLevel: 'missing-coverage',
            coverage: 'missing-coverage',
            assetLike: false,
            clickability: 'primary-clickable',
            reportability: 'reportable',
            primaryAction: 'test',
            reportAction: 'capture-test',
          },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.controlId)).toEqual(['test.missing']);
  });
});
