import { describe, expect, test } from 'bun:test';
import { SWARM_UI_FEATURE_SURFACES, featureControls, featureMapSummary } from './featureMap';

describe('feature map', () => {
  test('surface and control ids are unique', () => {
    const ids = new Set<string>();
    for (const surface of SWARM_UI_FEATURE_SURFACES) {
      expect(ids.has(surface.id)).toBe(false);
      ids.add(surface.id);
      for (const control of surface.controls) {
        expect(ids.has(control.id)).toBe(false);
        ids.add(control.id);
      }
    }
  });

  test('visible controls carry test ids and expected behavior', () => {
    for (const surface of SWARM_UI_FEATURE_SURFACES) {
      expect(surface.expectedBehavior.trim().length).toBeGreaterThan(0);
      for (const control of surface.controls) {
        expect(control.surfaceId).toBe(surface.id);
        expect(control.testId.trim().length).toBeGreaterThan(0);
        expect(control.reportTargetId.trim().length).toBeGreaterThan(0);
        expect(control.expectedBehavior.trim().length).toBeGreaterThan(0);
        expect(control.reportAction.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('asset-like controls declare clickability and reportability', () => {
    const assetControls = featureControls().filter((control) => control.assetLike);

    expect(assetControls.some((control) => control.clickability === 'primary-clickable')).toBe(true);
    expect(assetControls.some((control) => control.clickability === 'disabled')).toBe(true);
    expect(assetControls.some((control) => control.clickability === 'selectable-only')).toBe(true);
    for (const control of assetControls) {
      expect(control.reportability).not.toBe('exempt');
      if (control.clickability === 'disabled') {
        expect(control.primaryAction).toBeNull();
      }
    }
  });

  test('summary matches the registered feature map', () => {
    expect(featureMapSummary()).toEqual({
      surfaces: SWARM_UI_FEATURE_SURFACES.length,
      controls: featureControls().length,
      assetLikeControls: featureControls().filter((control) => control.assetLike).length,
      reportableControls: featureControls().filter((control) => control.reportability !== 'exempt').length,
    });
  });
});
