import { describe, expect, it } from 'bun:test';
import {
  normalizeAssetAttachment,
  normalizeProjectInventory,
  normalizeProjectAsset,
  projectFileBubbleFolders,
  projectFileBubbleItems,
  projectInventoryDisplay,
  projectInventoryDirectChildren,
  projectAssetRefreshSummary,
  removeAssetAttachmentsForAsset,
} from './projectAssets';

describe('normalizeProjectAsset', () => {
  it('normalizes an image asset', () => {
    const asset = normalizeProjectAsset({
      id: ' asset-1 ',
      projectId: ' project-1 ',
      kind: 'image',
      title: ' FrazierCode Tron reference ',
      path: ' /Users/mathewfrazier/Desktop/FrazierCode Tron 2.jpg ',
      description: ' Startup hero visual reference ',
      createdAt: 100,
      updatedAt: 200,
    });

    expect(asset?.id).toBe('asset-1');
    expect(asset?.projectId).toBe('project-1');
    expect(asset?.kind).toBe('image');
    expect(asset?.title).toContain('Tron');
    expect(asset?.path).toBe('/Users/mathewfrazier/Desktop/FrazierCode Tron 2.jpg');
    expect(asset?.content).toBeNull();
    expect(asset?.description).toBe('Startup hero visual reference');
    expect(asset?.createdAt).toBe(100);
    expect(asset?.updatedAt).toBe(200);
  });

  it('rejects invalid assets', () => {
    expect(normalizeProjectAsset({ id: 'asset-1', projectId: 'project-1', title: 'Missing kind' })).toBeNull();
    expect(normalizeProjectAsset({ id: 'asset-1', kind: 'image', title: 'Missing project' })).toBeNull();
    expect(normalizeProjectAsset({ projectId: 'project-1', kind: 'image', title: 'Missing id' })).toBeNull();
    expect(normalizeProjectAsset({ id: 'asset-1', projectId: 'project-1', kind: 'video' as never, title: 'Wrong kind' })).toBeNull();
  });
});

describe('normalizeAssetAttachment', () => {
  it('normalizes an agent attachment', () => {
    const attachment = normalizeAssetAttachment({
      assetId: ' asset-1 ',
      targetType: 'agent',
      targetId: ' instance-1 ',
      attachedAt: 300,
    });

    expect(attachment).toEqual({
      assetId: 'asset-1',
      targetType: 'agent',
      targetId: 'instance-1',
      attachedAt: 300,
    });
  });
});

describe('removeAssetAttachmentsForAsset', () => {
  it('only removes attachments for the deleted asset', () => {
    const remaining = removeAssetAttachmentsForAsset([
      { assetId: 'asset-1', targetType: 'agent', targetId: 'agent-1', attachedAt: 1 },
      { assetId: 'asset-2', targetType: 'agent', targetId: 'agent-2', attachedAt: 2 },
    ], 'asset-1');

    expect(remaining).toEqual([
      { assetId: 'asset-2', targetType: 'agent', targetId: 'agent-2', attachedAt: 2 },
    ]);
  });
});

describe('projectAssetRefreshSummary', () => {
  it('reports imported assets and scanned roots', () => {
    expect(projectAssetRefreshSummary({ importedCount: 2, scannedRoots: ['/tmp/project'] }))
      .toBe('Imported 2 project assets from 1 scanned root.');
  });

  it('reports zero-import refreshes with scanned root count', () => {
    expect(projectAssetRefreshSummary({ importedCount: 0, scannedRoots: ['/tmp/project', '/tmp/assets'] }))
      .toBe('No new project assets found. Scanned 2 roots.');
  });
});

describe('normalizeProjectInventory', () => {
  it('normalizes root inventory entries from the backend catalog', () => {
    const entries = normalizeProjectInventory([
      {
        projectId: ' project-1 ',
        root: ' /tmp/project ',
        path: ' /tmp/project/references ',
        name: ' references ',
        entryType: 'folder',
        category: 'folder',
        extension: '',
        sizeBytes: null,
        modifiedAt: 10,
      },
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/notes.rtf',
        name: 'notes.rtf',
        entryType: 'file',
        category: 'richText',
        extension: 'rtf',
        sizeBytes: 320,
        modifiedAt: 20,
      },
    ]);

    expect(entries.map((entry) => entry.name)).toEqual(['references', 'notes.rtf']);
    expect(entries[1].category).toBe('richText');
  });
});

describe('projectInventoryDisplay', () => {
  it('lists every item when the project root has eight or fewer entries', () => {
    const display = projectInventoryDisplay([
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/assets',
        name: 'assets',
        entryType: 'folder',
        category: 'folder',
        extension: '',
        sizeBytes: null,
        modifiedAt: 1,
      },
    ]);

    expect(display.mode).toBe('list');
    expect(display.items?.[0]?.name).toBe('assets');
  });

  it('groups larger project roots by category', () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      projectId: 'project-1',
      root: '/tmp/project',
      path: `/tmp/project/image-${index}.png`,
      name: `image-${index}.png`,
      entryType: 'file' as const,
      category: 'image',
      extension: 'png',
      sizeBytes: 10,
      modifiedAt: index,
    }));

    const display = projectInventoryDisplay(entries);

    expect(display.mode).toBe('grouped');
    expect(display.groups).toEqual([{ category: 'image', label: 'Images', count: 9 }]);
  });
});

describe('projectInventoryDirectChildren', () => {
  it('returns only the immediate contents for an opened folder', () => {
    const entries = normalizeProjectInventory([
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/encom',
        name: 'encom',
        entryType: 'folder',
        category: 'folder',
        extension: '',
        sizeBytes: null,
        modifiedAt: 1,
      },
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/encom/reference.png',
        name: 'reference.png',
        entryType: 'file',
        category: 'image',
        extension: 'png',
        sizeBytes: 100,
        modifiedAt: 2,
      },
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/encom/deep/hidden.png',
        name: 'hidden.png',
        entryType: 'file',
        category: 'image',
        extension: 'png',
        sizeBytes: 100,
        modifiedAt: 3,
      },
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/loose.txt',
        name: 'loose.txt',
        entryType: 'file',
        category: 'text',
        extension: 'txt',
        sizeBytes: 20,
        modifiedAt: 4,
      },
    ]);

    expect(projectInventoryDirectChildren(entries, '/tmp/project/encom').map((entry) => entry.name))
      .toEqual(['reference.png']);
  });
});

describe('projectFileBubbleFolders', () => {
  it('keeps the project root first and adds linked assets for external files', () => {
    const roots = ['/tmp/project'];
    const entries = normalizeProjectInventory([
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/encom',
        name: 'encom',
        entryType: 'folder',
        category: 'folder',
        extension: '',
        sizeBytes: null,
        modifiedAt: 1,
      },
    ]);
    const assets = normalizeProjectAsset({
      id: 'asset-external',
      projectId: 'project-1',
      kind: 'image',
      title: 'External Logo',
      path: '/tmp/elsewhere/logo.jpeg',
    });

    const folders = projectFileBubbleFolders(roots, entries, assets ? [assets] : []);

    expect(folders.map((folder) => folder.name)).toEqual(['project', 'encom', 'Linked Assets']);
    expect(folders[0].source).toBe('root');
    expect(folders[2].source).toBe('linked');
  });
});

describe('projectFileBubbleItems', () => {
  it('shows immediate root contents and linked external assets in their virtual folder', () => {
    const entries = normalizeProjectInventory([
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/encom',
        name: 'encom',
        entryType: 'folder',
        category: 'folder',
        extension: '',
        sizeBytes: null,
        modifiedAt: 1,
      },
      {
        projectId: 'project-1',
        root: '/tmp/project',
        path: '/tmp/project/cover.jpeg',
        name: 'cover.jpeg',
        entryType: 'file',
        category: 'image',
        extension: 'jpeg',
        sizeBytes: 100,
        modifiedAt: 2,
      },
    ]);
    const external = normalizeProjectAsset({
      id: 'asset-external',
      projectId: 'project-1',
      kind: 'image',
      title: 'External Logo',
      path: '/tmp/elsewhere/logo.jpeg',
    });

    expect(projectFileBubbleItems('/tmp/project', entries, external ? [external] : [], ['/tmp/project'])
      .map((item) => item.name))
      .toEqual(['encom', 'cover.jpeg']);

    expect(projectFileBubbleItems('virtual:linked-assets', entries, external ? [external] : [], ['/tmp/project'])
      .map((item) => item.name))
      .toEqual(['External Logo']);
  });
});
