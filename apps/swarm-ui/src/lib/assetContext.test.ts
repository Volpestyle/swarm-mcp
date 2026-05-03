import { describe, expect, it } from 'bun:test';
import { buildAssetContextBlock, buildAssetDirectMessage } from './assetContext';
import type { ProjectAsset } from './types';

describe('buildAssetContextBlock', () => {
  it('builds a concise asset context block for agent injection', () => {
    const block = buildAssetContextBlock([
      asset({
        id: 'asset-1',
        kind: 'image',
        title: 'Hero reference',
        path: '/tmp/hero.png',
        description: 'Use as startup mood reference',
      }),
    ]);

    expect(block).toContain('Hero reference');
    expect(block).toContain('/tmp/hero.png');
    expect(block).toContain('Use as startup mood reference');
  });

  it('includes note content without requiring a file path', () => {
    const block = buildAssetContextBlock([
      asset({
        id: 'asset-2',
        kind: 'note',
        title: 'Launch constraints',
        path: null,
        content: 'Keep project attachment separate from filesystem permissions.',
      }),
    ]);

    expect(block).toContain('[note] Launch constraints');
    expect(block).toContain('Keep project attachment separate');
  });

  it('labels analyzed image content as visual analysis for agent context', () => {
    const block = buildAssetContextBlock([
      asset({
        id: 'asset-vision',
        kind: 'image',
        title: 'Launch UI Screenshot',
        path: '/tmp/launch.png',
        content: 'The screenshot shows a dark launch screen with an empty terminal panel.',
      }),
    ]);

    expect(block).toContain('Visual analysis: The screenshot shows a dark launch screen');
    expect(block).not.toContain('Notes: The screenshot shows');
  });

  it('builds a direct asset-context message for an attached agent', () => {
    const message = buildAssetDirectMessage('9889 New Times', [
      asset({
        id: 'asset-2',
        kind: 'note',
        title: 'Launch constraints',
        content: 'Stand by and listen after reading.',
      }),
    ]);

    expect(message).toContain('[asset-context] 9889 New Times');
    expect(message).toContain('Project assets:');
    expect(message).toContain('Stand by and listen after reading.');
    expect(message).toContain('poll messages/tasks');
  });
});

function asset(overrides: Partial<ProjectAsset>): ProjectAsset {
  return {
    id: 'asset',
    projectId: 'project-1',
    kind: 'image',
    title: 'Asset',
    path: null,
    content: null,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
