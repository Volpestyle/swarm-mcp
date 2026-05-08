export type AreaCaptureTargetKind =
  | 'control'
  | 'surface'
  | 'agent-card'
  | 'pty'
  | 'majordomo'
  | 'canvas-region';

export type AreaCaptureBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AreaCaptureDraft = {
  id: string;
  sessionId: string;
  dateKey: string;
  surfaceId: string | null;
  testId: string | null;
  featureId: string | null;
  targetKind: AreaCaptureTargetKind;
  instanceId: string | null;
  ptyId: string | null;
  captureLimitations: string[];
  bounds: AreaCaptureBounds;
  majordomoExpandedBeforeCapture: boolean;
  targetIsMajordomo: boolean;
  overlayIncludedInFinalCrop: false;
  note: string;
};

export type AreaCaptureProof = {
  dataUrl: string;
  proofLevel: 'app-region-dom' | 'app-region-partial';
  warnings: string[];
};

export type AreaCaptureMetadata = {
  kind: 'swarm-ui-area-capture';
  draft: AreaCaptureDraft;
  proofLevel: AreaCaptureProof['proofLevel'];
  warnings: string[];
  writtenAt: string;
};

export const LEARNING_EVOLUTION_ROOT =
  '/Users/mathewfrazier/Desktop/9889-new-times/workspace/Experiental Learning Evolution';

export function areaCaptureSessionDir(dateKey: string, sessionId: string): string {
  return `area-captures/${dateKey}/session-${sessionId}`;
}

export function areaCaptureBaseName(index: number, label: string): string {
  const number = String(Math.max(1, Math.round(index))).padStart(3, '0');
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'capture';
  return `${number}-${slug}`;
}

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createAreaCaptureDraft(input: Partial<AreaCaptureDraft> = {}): AreaCaptureDraft {
  const sessionId = input.sessionId ?? `local-${Date.now().toString(36)}`;
  return {
    id: input.id ?? `capture-${Date.now().toString(36)}`,
    sessionId,
    dateKey: input.dateKey ?? localDateKey(),
    surfaceId: input.surfaceId ?? null,
    testId: input.testId ?? null,
    featureId: input.featureId ?? null,
    targetKind: input.targetKind ?? 'canvas-region',
    instanceId: input.instanceId ?? null,
    ptyId: input.ptyId ?? null,
    captureLimitations: input.captureLimitations ?? [
      'app-region-dom captures DOM/semantic evidence without OS Screen Recording permission',
    ],
    bounds: input.bounds ?? { x: 120, y: 120, width: 520, height: 320 },
    majordomoExpandedBeforeCapture: input.majordomoExpandedBeforeCapture ?? true,
    targetIsMajordomo: input.targetIsMajordomo ?? false,
    overlayIncludedInFinalCrop: false,
    note: input.note ?? '',
  };
}

export function isPngDataUrl(value: string): boolean {
  return /^data:image\/png;base64,[a-z0-9+/=\s]+$/i.test(value.trim());
}

export function buildAreaCaptureMetadata(
  draft: AreaCaptureDraft,
  proof: Pick<AreaCaptureProof, 'proofLevel' | 'warnings'>,
  writtenAt = new Date().toISOString(),
): AreaCaptureMetadata {
  return {
    kind: 'swarm-ui-area-capture',
    draft,
    proofLevel: proof.proofLevel,
    warnings: proof.warnings,
    writtenAt,
  };
}

export function buildAreaCaptureMarkdown(input: {
  draft: AreaCaptureDraft;
  proof: Pick<AreaCaptureProof, 'proofLevel' | 'warnings'>;
  pngFileName: string;
  jsonFileName: string;
}): string {
  const lines = [
    `# Area Capture ${input.draft.id}`,
    '',
    `Surface: ${input.draft.surfaceId ?? 'unknown'}`,
    `Feature: ${input.draft.featureId ?? 'unknown'}`,
    `Target: ${input.draft.targetKind}`,
    `Proof level: ${input.proof.proofLevel}`,
    `PNG: ${input.pngFileName}`,
    `JSON: ${input.jsonFileName}`,
    '',
    '## Operator Note',
    '',
    input.draft.note.trim() || '_No note provided._',
    '',
    '## Bounds',
    '',
    `x=${Math.round(input.draft.bounds.x)} y=${Math.round(input.draft.bounds.y)} width=${Math.round(input.draft.bounds.width)} height=${Math.round(input.draft.bounds.height)}`,
    '',
    '## Limitations',
    '',
    ...[
      ...input.draft.captureLimitations,
      ...input.proof.warnings,
    ].map((warning) => `- ${warning}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
