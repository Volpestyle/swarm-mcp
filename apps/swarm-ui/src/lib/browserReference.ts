import type { BrowserContext, BrowserSnapshot, BrowserTab, ProjectAsset, ProjectSpace } from './types';

const REFERENCE_TEXT_LIMIT = 14_000;
const ELEMENT_LIMIT = 40;

export function browserReferenceAssetId(projectId: string, contextId: string): string {
  const clean = `${projectId}-${contextId}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `browser-ref-${clean || 'context'}`;
}

export function activeBrowserTab(tabs: BrowserTab[]): BrowserTab | null {
  return tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
}

export function latestBrowserSnapshot(snapshots: BrowserSnapshot[]): BrowserSnapshot | null {
  return [...snapshots].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

export function buildBrowserReferenceAsset(input: {
  project: ProjectSpace;
  context: BrowserContext;
  tabs: BrowserTab[];
  snapshots: BrowserSnapshot[];
  now?: number;
}): ProjectAsset {
  const snapshot = latestBrowserSnapshot(input.snapshots);
  const tab = activeBrowserTab(input.tabs);
  const title = snapshot?.title || tab?.title || tab?.url || input.context.startUrl || 'Browser reference';
  const url = snapshot?.url || tab?.url || input.context.startUrl || input.context.endpoint;
  const content = buildBrowserReferenceContent({
    project: input.project,
    context: input.context,
    tab,
    snapshot,
    title,
    url,
  });
  const now = input.now ?? Date.now();

  return {
    id: browserReferenceAssetId(input.project.id, input.context.id),
    projectId: input.project.id,
    kind: 'reference',
    title: `Browser: ${title}`.slice(0, 180),
    path: url,
    content,
    description: `Readable browser reference from ${url}`,
    createdAt: now,
    updatedAt: now,
  };
}

function buildBrowserReferenceContent(input: {
  project: ProjectSpace;
  context: BrowserContext;
  tab: BrowserTab | null;
  snapshot: BrowserSnapshot | null;
  title: string;
  url: string;
}): string {
  const lines = [
    '[project-browser-reference]',
    `Project: ${input.project.name}`,
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    `Browser context id: ${input.context.id}`,
    input.tab ? `Tab id: ${input.tab.tabId}` : 'Tab id: unavailable',
    input.snapshot ? `Captured at: ${new Date(input.snapshot.createdAt * 1000).toISOString()}` : 'Captured at: not captured',
    '',
    'How agents should use this:',
    '1. Treat this as intentional project context from the operator.',
    '2. Read this reference before doing external web searches or guessing.',
    '3. Use the text and structure below as the primary source for this attached tab.',
    '4. If this extract is insufficient, ask for a refresh or deeper browser capture.',
    '5. Do not assume you can control Chrome unless browser-control tools are available.',
  ];

  if (!input.snapshot) {
    lines.push('', 'Readable extract:', '- No text extract has been captured yet.');
    return lines.join('\n');
  }

  const elements = input.snapshot.elements
    .filter((element) => element.text.trim().length > 0)
    .slice(0, ELEMENT_LIMIT)
    .map((element) => {
      const label = element.role || element.tag || 'element';
      return `- ${label}: ${element.text.trim()}`;
    });
  const text = input.snapshot.text.trim().slice(0, REFERENCE_TEXT_LIMIT);
  const truncated = input.snapshot.text.trim().length > REFERENCE_TEXT_LIMIT
    ? '\n\n[extract truncated; request refresh/deeper capture if more detail is needed]'
    : '';

  lines.push(
    '',
    'Page structure:',
    elements.length ? elements.join('\n') : '- No prominent structure extracted.',
    '',
    'Readable extract:',
    text ? `${text}${truncated}` : '- No readable page text extracted.',
  );

  return lines.join('\n');
}
