import { describe, expect, it } from 'bun:test';
import { buildBrowserReferenceAsset, browserReferenceAssetId } from './browserReference';
import type { BrowserContext, BrowserSnapshot, BrowserTab, ProjectSpace } from './types';

const project: ProjectSpace = {
  id: 'project-alpha',
  name: 'Alpha',
  root: '/tmp/alpha',
  color: '#35a7ff',
  additionalRoots: [],
  notes: '',
  scope: '/tmp/alpha',
  boundary: { x: 0, y: 0, width: 600, height: 400 },
  createdAt: 1,
  updatedAt: 1,
};

const context: BrowserContext = {
  scope: '/tmp/alpha',
  id: 'ctx-1',
  ownerInstanceId: null,
  endpoint: 'http://127.0.0.1:9222',
  host: '127.0.0.1',
  port: 9222,
  profileDir: '/tmp/profile',
  pid: 123,
  startUrl: 'https://example.com',
  status: 'open',
  createdAt: 1,
  updatedAt: 1,
};

const tab: BrowserTab = {
  scope: '/tmp/alpha',
  contextId: 'ctx-1',
  tabId: 'tab-1',
  tabType: 'page',
  url: 'https://example.com/reference',
  title: 'Reference Page',
  active: true,
  updatedAt: 2,
};

const snapshot: BrowserSnapshot = {
  id: 'snap-1',
  scope: '/tmp/alpha',
  contextId: 'ctx-1',
  tabId: 'tab-1',
  url: 'https://example.com/reference',
  title: 'Reference Page',
  text: 'This page explains the structure the project should follow.',
  elements: [
    { tag: 'h1', role: null, text: 'Reference Page', selector: 'h1' },
    { tag: 'a', role: 'link', text: 'Design system', selector: 'a' },
  ],
  screenshotPath: null,
  createdBy: null,
  createdAt: 1_777_000_000,
};

describe('browserReferenceAssetId', () => {
  it('builds deterministic project-scoped ids', () => {
    expect(browserReferenceAssetId('Project Alpha', 'CTX 1')).toBe('browser-ref-project-alpha-ctx-1');
  });
});

describe('buildBrowserReferenceAsset', () => {
  it('turns an attached tab snapshot into a model-readable reference asset', () => {
    const asset = buildBrowserReferenceAsset({
      project,
      context,
      tabs: [tab],
      snapshots: [snapshot],
      now: 42,
    });

    expect(asset.kind).toBe('reference');
    expect(asset.projectId).toBe('project-alpha');
    expect(asset.title).toBe('Browser: Reference Page');
    expect(asset.path).toBe('https://example.com/reference');
    expect(asset.content).toContain('[project-browser-reference]');
    expect(asset.content).toContain('Read this reference before doing external web searches');
    expect(asset.content).toContain('Page structure:');
    expect(asset.content).toContain('- link: Design system');
    expect(asset.content).toContain('This page explains the structure');
    expect(asset.createdAt).toBe(42);
    expect(asset.updatedAt).toBe(42);
  });

  it('still creates a useful reference when no readable snapshot exists yet', () => {
    const asset = buildBrowserReferenceAsset({
      project,
      context,
      tabs: [tab],
      snapshots: [],
      now: 42,
    });

    expect(asset.path).toBe('https://example.com/reference');
    expect(asset.content).toContain('No text extract has been captured yet');
    expect(asset.content).toContain('ask for a refresh or deeper browser capture');
  });
});
