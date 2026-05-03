export type ProofPackStatus = 'pass' | 'warn' | 'fail';

export interface ProofPackProject {
  id: string;
  name: string;
  root: string;
  scope: string | null;
  color: string;
}

export interface ProofPackTaskRow {
  id: string;
  sourceTaskId: string | null;
  section: string;
  title: string;
  description: string;
  status: string;
  provider: string;
  role: string;
  assignee: string;
  listenerState: string;
  elapsed: string;
  lastActivity: string;
  result: string;
  files: string[];
  priority: number;
  selected: boolean;
  draft: boolean;
  launchStatus: string;
  launchPtyId: string;
  launchInstanceId: string;
  launchError: string;
}

export interface ProofPackAgent {
  id: string;
  label: string | null;
  status: string;
  directory: string;
  scope: string;
  heartbeat: number;
}

export interface ProofPackActivity {
  title: string;
  detail: string;
  meta: string;
  timestamp: number;
  kind: string;
}

export interface VisualElementSnapshot {
  selector: string;
  tag: string;
  role: string | null;
  label: string;
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visible: boolean;
}

export interface ScrollContainerSnapshot {
  selector: string;
  tag: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface VisualEvidence {
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  themeVariables: Record<string, string>;
  semanticSnapshot: VisualElementSnapshot[];
  scrollContainers: ScrollContainerSnapshot[];
}

export interface TaskBoardProofPackInput {
  surface: string;
  note?: string;
  project: ProofPackProject;
  taskRows: ProofPackTaskRow[];
  agents: ProofPackAgent[];
  activity: ProofPackActivity[];
  screenshot: unknown;
  visual: VisualEvidence;
  now?: number;
}

export function buildTaskBoardProofPack(input: TaskBoardProofPackInput) {
  const rows = input.taskRows;
  const agents = input.agents;
  const reviewSignals = buildReviewSignals(rows, input.screenshot);
  return {
    version: 1,
    kind: 'swarm-ui-proof-pack',
    generatedAtUnixMs: input.now ?? Date.now(),
    surface: input.surface,
    note: input.note?.trim() || null,
    project: input.project,
    taskBoard: {
      rowCount: rows.length,
      selectedCount: rows.filter((row) => row.selected).length,
      draftRowCount: rows.filter((row) => row.draft).length,
      liveRowCount: rows.filter((row) => !row.draft).length,
      statusCounts: countBy(rows, (row) => row.status),
      providerCounts: countBy(rows, (row) => row.provider),
      launchSummary: {
        launchedRows: rows.filter((row) => row.launchStatus === 'launched').length,
        launchingRows: rows.filter((row) => row.launchStatus === 'launching').length,
        failedRows: rows.filter((row) => row.launchStatus === 'failed').length,
        taskBoundRows: rows.filter((row) => Boolean(row.launchInstanceId || row.launchPtyId)).length,
      },
      rows: rows.map(compactTaskRow),
    },
    agents: {
      total: agents.length,
      online: agents.filter((agent) => agent.status === 'online').length,
      rows: agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        status: agent.status,
        directory: agent.directory,
        scope: agent.scope,
        heartbeat: agent.heartbeat,
      })),
    },
    activity: input.activity.slice(0, 12),
    evidence: {
      screenshot: input.screenshot,
      visual: input.visual,
    },
    reviewSignals,
    status: reviewSignals.some((signal) => signal.status === 'fail')
      ? 'fail'
      : reviewSignals.some((signal) => signal.status === 'warn')
        ? 'warn'
        : 'pass',
  };
}

export function collectVisualEvidence(root?: ParentNode & Node): VisualEvidence {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return emptyVisualEvidence();
  }

  const scopeRoot = root ?? document.body;
  const doc = scopeRoot.nodeType === 9 ? scopeRoot as Document : scopeRoot.ownerDocument ?? document;
  const view = doc.defaultView ?? window;
  const rootElement = doc.documentElement;
  const computed = view.getComputedStyle(rootElement);
  const semanticSnapshot: VisualElementSnapshot[] = [];
  const scrollContainers: ScrollContainerSnapshot[] = [];
  const walker = doc.createTreeWalker(scopeRoot, 1);

  let node: Node | null = walker.currentNode;
  while (node && semanticSnapshot.length < 80) {
    if (isElement(node)) {
      const element = node;
      const rect = element.getBoundingClientRect();
      const text = compactText(
        element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.textContent
          || '',
        160,
      );
      if (text || isInteractive(element)) {
        semanticSnapshot.push({
          selector: elementSelector(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || inferredRole(element),
          label: compactText(element.getAttribute('aria-label') || '', 100),
          text,
          bounds: roundRect(rect),
          visible: rect.width > 0 && rect.height > 0,
        });
      }

      if (scrollContainers.length < 32 && isScrollContainer(element)) {
        scrollContainers.push({
          selector: elementSelector(element),
          tag: element.tagName.toLowerCase(),
          bounds: roundRect(rect),
          scrollTop: Math.round(element.scrollTop),
          scrollLeft: Math.round(element.scrollLeft),
          scrollHeight: element.scrollHeight,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
        });
      }
    }
    node = walker.nextNode();
  }

  return {
    viewport: {
      width: view.innerWidth,
      height: view.innerHeight,
      devicePixelRatio: view.devicePixelRatio || 1,
    },
    themeVariables: collectThemeVariables(computed),
    semanticSnapshot,
    scrollContainers,
  };
}

function emptyVisualEvidence(): VisualEvidence {
  return {
    viewport: { width: 0, height: 0, devicePixelRatio: 1 },
    themeVariables: {},
    semanticSnapshot: [],
    scrollContainers: [],
  };
}

function buildReviewSignals(rows: ProofPackTaskRow[], screenshot: unknown) {
  const signals: Array<{
    id: string;
    status: ProofPackStatus;
    title: string;
    detail: string;
  }> = [];

  if (isUnsupportedScreenshot(screenshot)) {
    signals.push({
      id: 'screenshot-unavailable',
      status: 'warn',
      title: 'Native screenshot unavailable',
      detail: 'The proof pack captured semantic UI evidence, but the current Tauri runtime did not provide a window screenshot.',
    });
  }

  for (const row of rows) {
    if (row.launchStatus === 'failed') {
      signals.push({
        id: `launch-failed:${row.id}`,
        status: 'fail',
        title: 'Task launch failed',
        detail: `${row.title}: ${row.launchError || 'No launch error recorded.'}`,
      });
    }
    if (row.launchStatus === 'launched' && !row.launchInstanceId && !row.launchPtyId) {
      signals.push({
        id: `missing-launch-id:${row.id}`,
        status: 'fail',
        title: 'Launched row has no agent or PTY id',
        detail: `${row.title} says it launched, but the row did not retain task-bound process identity.`,
      });
    }
    if (row.selected && row.launchStatus === 'not_launched') {
      signals.push({
        id: `selected-not-launched:${row.id}`,
        status: 'warn',
        title: 'Selected row not launched',
        detail: `${row.title} is selected and still waiting for launch.`,
      });
    }
    if (row.provider === 'local' && row.selected) {
      signals.push({
        id: `local-provider-selected:${row.id}`,
        status: 'warn',
        title: 'Local shell cannot be task-bound',
        detail: `${row.title} is selected with the Local shell provider. Choose Codex, Claude, or opencode for task-bound launch.`,
      });
    }
  }

  if (signals.length === 0) {
    signals.push({
      id: 'task-board-proof-pack-clean',
      status: 'pass',
      title: 'Task Board evidence captured',
      detail: 'No row-level proof-pack warnings were detected.',
    });
  }

  return signals;
}

function compactTaskRow(row: ProofPackTaskRow) {
  return {
    id: row.id,
    sourceTaskId: row.sourceTaskId,
    section: row.section,
    title: row.title,
    description: compactText(row.description, 240),
    status: row.status,
    provider: row.provider,
    role: row.role,
    assignee: row.assignee,
    listenerState: row.listenerState,
    elapsed: row.elapsed,
    lastActivity: row.lastActivity,
    result: compactText(row.result, 320),
    files: row.files.slice(0, 12),
    priority: row.priority,
    selected: row.selected,
    draft: row.draft,
    launchStatus: row.launchStatus,
    launchPtyId: row.launchPtyId,
    launchInstanceId: row.launchInstanceId,
    launchError: row.launchError,
  };
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = keyFor(item) || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function isUnsupportedScreenshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as { ok?: unknown; error?: unknown };
  return maybe.ok === false && typeof maybe.error === 'string' && maybe.error.length > 0;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function isInteractive(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return ['button', 'input', 'select', 'textarea', 'a'].includes(tag) || Boolean(element.getAttribute('role'));
}

function inferredRole(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = element.getAttribute('type') || 'text';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'textbox';
  }
  return null;
}

function isScrollContainer(element: Element): element is HTMLElement {
  const maybe = element as HTMLElement;
  return maybe.scrollHeight > maybe.clientHeight + 2 || maybe.scrollWidth > maybe.clientWidth + 2;
}

function elementSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${cssSafe(element.id)}` : '';
  const classList = Array.from(element.classList).slice(0, 3).map((name) => `.${cssSafe(name)}`).join('');
  return `${tag}${id}${classList}`;
}

function cssSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function compactText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function roundRect(rect: DOMRect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function collectThemeVariables(computed: CSSStyleDeclaration): Record<string, string> {
  const variables: Record<string, string> = {};
  for (let index = 0; index < computed.length && Object.keys(variables).length < 80; index += 1) {
    const name = computed.item(index);
    if (!name.startsWith('--')) continue;
    const value = computed.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  return variables;
}
