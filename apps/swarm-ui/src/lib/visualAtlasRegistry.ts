import {
  SWARM_UI_FEATURE_SURFACES,
  featureControls,
  type FeatureControl,
  type FeatureSurface,
} from './featureMap';

export type AtlasCoverageStatus = FeatureControl['coverage'];

export type AtlasCoverageIssue = {
  controlId: string;
  surfaceId: string;
  label: string;
  status: AtlasCoverageStatus;
};

export type VisualAtlasSurfaceState = {
  id: string;
  label: string;
  surface: FeatureSurface;
  controls: FeatureControl[];
  screenshotName: string;
};

export function visualAtlasSurfaceStates(): VisualAtlasSurfaceState[] {
  return SWARM_UI_FEATURE_SURFACES.map((surface) => ({
    id: surface.id,
    label: surface.label,
    surface,
    controls: surface.controls,
    screenshotName: `${surface.id}.png`,
  }));
}

export function atlasCoverageIssues(
  surfaces: FeatureSurface[] = SWARM_UI_FEATURE_SURFACES,
): AtlasCoverageIssue[] {
  return surfaces.flatMap((surface) =>
    surface.controls
      .filter((control) => control.coverage === 'missing-coverage')
      .map((control) => ({
        controlId: control.id,
        surfaceId: surface.id,
        label: control.label,
        status: control.coverage,
      })),
  );
}

export function atlasCoverageOk(
  surfaces: FeatureSurface[] = SWARM_UI_FEATURE_SURFACES,
): boolean {
  return atlasCoverageIssues(surfaces).length === 0;
}

export function visualAtlasCoverageReport(
  surfaces: FeatureSurface[] = SWARM_UI_FEATURE_SURFACES,
) {
  const controls = surfaces.flatMap((surface) => surface.controls);
  const issues = atlasCoverageIssues(surfaces);
  return {
    ok: issues.length === 0,
    generatedAtUnixMs: Date.now(),
    surfaceCount: surfaces.length,
    controlCount: controls.length,
    statusCounts: countBy(controls, (control) => control.coverage),
    proofLevelCounts: countBy(controls, (control) => control.proofLevel),
    issues,
  };
}

export function visualAtlasFeatureMapExport() {
  return {
    generatedAtUnixMs: Date.now(),
    surfaces: SWARM_UI_FEATURE_SURFACES,
    controls: featureControls(),
  };
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
