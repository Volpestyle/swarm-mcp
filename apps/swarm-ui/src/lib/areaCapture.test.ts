import { describe, expect, test } from 'bun:test';
import {
  areaCaptureBaseName,
  areaCaptureSessionDir,
  buildAreaCaptureMarkdown,
  buildAreaCaptureMetadata,
  createAreaCaptureDraft,
  isPngDataUrl,
} from './areaCapture';

describe('area capture paths', () => {
  test('uses dated session folders', () => {
    expect(areaCaptureSessionDir('2026-05-08', 'abc')).toBe('area-captures/2026-05-08/session-abc');
  });

  test('creates stable numbered capture names', () => {
    expect(areaCaptureBaseName(1, 'Majordomo Button')).toBe('001-majordomo-button');
    expect(areaCaptureBaseName(12, '???')).toBe('012-capture');
  });
});

describe('area capture payloads', () => {
  test('metadata preserves proof limitations and excludes overlay from crop', () => {
    const draft = createAreaCaptureDraft({
      id: 'cap-1',
      surfaceId: 'majordomo',
      featureId: 'majordomo.ask-button',
      targetKind: 'majordomo',
      note: 'Button looks wrong.',
    });
    const metadata = buildAreaCaptureMetadata(draft, {
      proofLevel: 'app-region-dom',
      warnings: ['native pixels not captured'],
    }, '2026-05-08T12:00:00.000Z');

    expect(metadata.kind).toBe('swarm-ui-area-capture');
    expect(metadata.draft.overlayIncludedInFinalCrop).toBe(false);
    expect(metadata.draft.captureLimitations.length).toBeGreaterThan(0);
    expect(metadata.warnings).toContain('native pixels not captured');
  });

  test('markdown links png/json sidecars and operator note', () => {
    const draft = createAreaCaptureDraft({ id: 'cap-2', note: 'This button is too quiet.' });
    const markdown = buildAreaCaptureMarkdown({
      draft,
      proof: { proofLevel: 'app-region-dom', warnings: [] },
      pngFileName: '001-button.png',
      jsonFileName: '001-button.json',
    });

    expect(markdown).toContain('PNG: 001-button.png');
    expect(markdown).toContain('JSON: 001-button.json');
    expect(markdown).toContain('This button is too quiet.');
  });

  test('validates png data urls only', () => {
    expect(isPngDataUrl('data:image/png;base64,aGVsbG8=')).toBe(true);
    expect(isPngDataUrl('data:image/jpeg;base64,aGVsbG8=')).toBe(false);
  });
});
