import { describe, expect, it } from 'bun:test';
import {
  assetDialogOptionsForKind,
  assetDraftFromPickedPath,
  firstDialogSelection,
} from './assetIntake';

describe('assetDraftFromPickedPath', () => {
  it('creates an image draft from a picked file path', () => {
    const draft = assetDraftFromPickedPath('/Users/mathewfrazier/Desktop/Hero Ref.png', 'image');

    expect(draft).toEqual({
      kind: 'image',
      title: 'Hero Ref',
      path: '/Users/mathewfrazier/Desktop/Hero Ref.png',
      content: null,
      description: '',
    });
  });

  it('creates a folder draft from a picked directory path', () => {
    const draft = assetDraftFromPickedPath('/Users/mathewfrazier/Desktop/Project Assets', 'folder');

    expect(draft?.title).toBe('Project Assets');
    expect(draft?.kind).toBe('folder');
  });

  it('rejects unsupported image extensions before save', () => {
    expect(assetDraftFromPickedPath('/tmp/reference.txt', 'image')).toBeNull();
  });

  it('rejects unsupported note and protocol extensions before save', () => {
    expect(assetDraftFromPickedPath('/tmp/protocol.pdf', 'protocol')).toBeNull();
    expect(assetDraftFromPickedPath('/tmp/notes.docx', 'note')).toBeNull();
  });

  it('creates note drafts from rich text files', () => {
    const draft = assetDraftFromPickedPath('/tmp/field-notes.rtf', 'note');

    expect(draft?.kind).toBe('note');
    expect(draft?.title).toBe('field-notes');
    expect(draft?.path).toBe('/tmp/field-notes.rtf');
  });
});

describe('firstDialogSelection', () => {
  it('normalizes dialog cancellation and multi-select responses', () => {
    expect(firstDialogSelection(null)).toBeNull();
    expect(firstDialogSelection('/tmp/hero.png')).toBe('/tmp/hero.png');
    expect(firstDialogSelection(['/tmp/hero.png', '/tmp/other.png'])).toBe('/tmp/hero.png');
  });
});

describe('assetDialogOptionsForKind', () => {
  it('uses directory selection for folder assets', () => {
    expect(assetDialogOptionsForKind('folder')).toMatchObject({ directory: true, multiple: false });
  });

  it('uses image filters for visual assets', () => {
    expect(assetDialogOptionsForKind('screenshot').filters?.[0]?.extensions).toContain('png');
  });
});
