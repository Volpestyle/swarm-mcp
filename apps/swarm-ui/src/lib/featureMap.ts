export type ProofLevel =
  | 'source-confirmed'
  | 'unit-tested'
  | 'build-tested'
  | 'browser-visual'
  | 'native-shell'
  | 'human-needed'
  | 'defect'
  | 'missing-coverage';

export type CoverageKind =
  | 'screenshot-covered'
  | 'semantic-covered'
  | 'native-only-manual'
  | 'hidden-debug-exempt'
  | 'missing-coverage';

export type Clickability =
  | 'primary-clickable'
  | 'selectable-only'
  | 'noninteractive'
  | 'disabled'
  | 'decorative';

export type Reportability =
  | 'reportable'
  | 'reportable-in-feedback-mode'
  | 'context-menu-only'
  | 'native-only-manual'
  | 'exempt';

export type FeatureControlKind =
  | 'button'
  | 'input'
  | 'toggle'
  | 'tab'
  | 'menuitem'
  | 'icon-button'
  | 'canvas-affordance'
  | 'panel'
  | 'document';

export type FeatureRoute =
  | 'home'
  | 'canvas'
  | 'project'
  | 'settings'
  | 'modal'
  | 'right-rail'
  | 'visual-atlas';

export type FeatureControl = {
  id: string;
  surfaceId: string;
  label: string;
  kind: FeatureControlKind;
  testId: string;
  reportTargetId: string;
  expectedBehavior: string;
  proofLevel: ProofLevel;
  coverage: CoverageKind;
  assetLike: boolean;
  clickability: Clickability;
  reportability: Reportability;
  primaryAction: string | null;
  reportAction: string;
  exemptionReason?: string;
};

export type FeatureSurface = {
  id: string;
  label: string;
  route: FeatureRoute;
  expectedBehavior: string;
  proofLevel: ProofLevel;
  controls: FeatureControl[];
};

const reportMode = 'start-report-area-for-this-control';

export const SWARM_UI_FEATURE_SURFACES: FeatureSurface[] = [
  {
    id: 'home',
    label: 'Home command deck',
    route: 'home',
    expectedBehavior: 'opens the project-first command deck with app identity, launch, settings, and learning entrypoints',
    proofLevel: 'browser-visual',
    controls: [
      {
        id: 'home.app-identity-strip',
        surfaceId: 'home',
        label: 'Home app identity strip',
        kind: 'panel',
        testId: 'home-app-identity-strip',
        reportTargetId: 'home-app-identity-strip',
        expectedBehavior: 'shows app variant, version, run kind, runpath, and Dock/bundle status in the first Home viewport',
        proofLevel: 'browser-visual',
        coverage: 'screenshot-covered',
        assetLike: false,
        clickability: 'noninteractive',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: null,
        reportAction: reportMode,
      },
      {
        id: 'home.open-project',
        surfaceId: 'home',
        label: 'Open Project',
        kind: 'button',
        testId: 'home-open-project',
        reportTargetId: 'home-open-project',
        expectedBehavior: 'opens or creates a project workspace before launching task-bound agents',
        proofLevel: 'source-confirmed',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-project-picker',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'workspace-kit',
    label: 'Workspace Kit',
    route: 'canvas',
    expectedBehavior: 'opens project files, notes, media, plan docs, browser references, and resource lanes from the canvas top strip',
    proofLevel: 'source-confirmed',
    controls: [
      {
        id: 'workspace.project-lane',
        surfaceId: 'workspace-kit',
        label: 'Projects lane',
        kind: 'tab',
        testId: 'workspace-project-lane',
        reportTargetId: 'workspace-project-lane',
        expectedBehavior: 'shows project spaces and lets the operator switch or create project roots',
        proofLevel: 'source-confirmed',
        coverage: 'semantic-covered',
        assetLike: true,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-projects-lane',
        reportAction: 'capture-projects-lane-region',
      },
      {
        id: 'project.disabled-skill-lane',
        surfaceId: 'workspace-kit',
        label: '/skills disabled resource lane',
        kind: 'button',
        testId: 'workspace-skill-lane-disabled',
        reportTargetId: 'workspace-skill-lane-disabled',
        expectedBehavior: 'shows unavailable state without navigating',
        proofLevel: 'source-confirmed',
        coverage: 'semantic-covered',
        assetLike: true,
        clickability: 'disabled',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: null,
        reportAction: 'capture-disabled-resource-lane',
      },
    ],
  },
  {
    id: 'canvas',
    label: 'Canvas graph',
    route: 'canvas',
    expectedBehavior: 'renders project boundaries, agent nodes, browser nodes, app surfaces, and animated coordination edges',
    proofLevel: 'browser-visual',
    controls: [
      {
        id: 'canvas.quick-menu',
        surfaceId: 'canvas',
        label: 'Canvas quick menu',
        kind: 'canvas-affordance',
        testId: 'canvas-quick-menu',
        reportTargetId: 'canvas-quick-menu',
        expectedBehavior: 'opens launch, browser, note, plan, workspace, and inspect actions from the canvas background',
        proofLevel: 'source-confirmed',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-canvas-quick-menu',
        reportAction: reportMode,
      },
      {
        id: 'canvas.agent-terminal-card',
        surfaceId: 'canvas',
        label: 'Agent terminal card',
        kind: 'panel',
        testId: 'canvas-agent-terminal-card',
        reportTargetId: 'canvas-agent-terminal-card',
        expectedBehavior: 'keeps terminal interaction native while exposing report capture through feedback mode or node chrome',
        proofLevel: 'source-confirmed',
        coverage: 'semantic-covered',
        assetLike: true,
        clickability: 'selectable-only',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'select-agent-terminal-card',
        reportAction: 'capture-terminal-card-region',
      },
    ],
  },
  {
    id: 'canvas-notes',
    label: 'Canvas notes',
    route: 'canvas',
    expectedBehavior: 'creates visible markdown-backed document surfaces on the canvas',
    proofLevel: 'browser-visual',
    controls: [
      {
        id: 'canvas.note-rail-button',
        surfaceId: 'canvas-notes',
        label: 'Note rail button',
        kind: 'icon-button',
        testId: 'canvas-note-rail-button',
        reportTargetId: 'canvas-note-rail-button',
        expectedBehavior: 'creates a markdown note asset and opens it as a canvas document',
        proofLevel: 'browser-visual',
        coverage: 'screenshot-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'create-canvas-note',
        reportAction: reportMode,
      },
      {
        id: 'canvas.note-document-surface',
        surfaceId: 'canvas-notes',
        label: 'Canvas Document note surface',
        kind: 'document',
        testId: 'canvas-note-document-surface',
        reportTargetId: 'canvas-note-document-surface',
        expectedBehavior: 'opens as an editable canvas document surface and saves to a markdown file',
        proofLevel: 'browser-visual',
        coverage: 'screenshot-covered',
        assetLike: true,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-or-focus-note-document',
        reportAction: 'capture-note-document-region',
      },
    ],
  },
  {
    id: 'majordomo',
    label: 'Majordomo assistant',
    route: 'right-rail',
    expectedBehavior: 'hosts feature-aware guidance and binds to a visible runtime Majordomo agent when available',
    proofLevel: 'source-confirmed',
    controls: [
      {
        id: 'majordomo.ask-button',
        surfaceId: 'majordomo',
        label: 'Ask Majordomo',
        kind: 'button',
        testId: 'majordomo-ask-button',
        reportTargetId: 'majordomo-ask-button',
        expectedBehavior: 'opens the chief-contact surface for feature questions, workflow proposals, and slippage checks',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-ask-majordomo',
        reportAction: reportMode,
      },
      {
        id: 'majordomo.contact-input',
        surfaceId: 'majordomo',
        label: 'Majordomo idea dump input',
        kind: 'input',
        testId: 'majordomo-contact-input',
        reportTargetId: 'majordomo-contact-input',
        expectedBehavior: 'accepts messy operator text and structures it into ask, clarify, workflow, or slippage notes',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'type-majordomo-idea-dump',
        reportAction: reportMode,
      },
      {
        id: 'majordomo.runtime-status',
        surfaceId: 'majordomo',
        label: 'Runtime Majordomo status',
        kind: 'panel',
        testId: 'majordomo-runtime-status',
        reportTargetId: 'majordomo-runtime-status',
        expectedBehavior: 'shows offline, launching, online, stale, blocked, or cleanup state for the visible runtime assistant',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'noninteractive',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: null,
        reportAction: reportMode,
      },
      {
        id: 'majordomo.start-runtime',
        surfaceId: 'majordomo',
        label: 'Start Majordomo runtime',
        kind: 'button',
        testId: 'majordomo-start-runtime',
        reportTargetId: 'majordomo-start-runtime',
        expectedBehavior: 'launches or binds a visible Hermes-backed role:majordomo PTY with model, provider, source tag, timeout, and cleanup metadata',
        proofLevel: 'unit-tested',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'start-visible-hermes-majordomo',
        reportAction: reportMode,
      },
      {
        id: 'majordomo.tweak-apply',
        surfaceId: 'majordomo',
        label: 'Apply live runtime tweak',
        kind: 'button',
        testId: 'majordomo-tweak-apply',
        reportTargetId: 'majordomo-tweak-apply',
        expectedBehavior: 'parses a Majordomo tweak command and applies it through runtime CSS variables without writing source until accepted',
        proofLevel: 'unit-tested',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'apply-runtime-tweak',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'project-page',
    label: 'Project Page / Cockpit',
    route: 'project',
    expectedBehavior: 'shows project notes, linked agents, linked tasks, activity, assets, review state, and closeout actions',
    proofLevel: 'source-confirmed',
    controls: [
      {
        id: 'project.task-board-tab',
        surfaceId: 'project-page',
        label: 'Task Board section',
        kind: 'tab',
        testId: 'project-task-board-section',
        reportTargetId: 'project-task-board-section',
        expectedBehavior: 'opens the plan-to-task board for grouped task rows and task-bound launch',
        proofLevel: 'browser-visual',
        coverage: 'screenshot-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'open-task-board-section',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'task-board',
    label: 'Task Board',
    route: 'project',
    expectedBehavior: 'imports plan rows, edits provider/role/status, launches selected agents, and displays launch diagnostics',
    proofLevel: 'browser-visual',
    controls: [
      {
        id: 'task-board.launch-selected',
        surfaceId: 'task-board',
        label: 'Launch selected task rows',
        kind: 'button',
        testId: 'task-board-launch-selected',
        reportTargetId: 'task-board-launch-selected',
        expectedBehavior: 'launches selected task-bound agents and records PTY/instance/listener state per row',
        proofLevel: 'browser-visual',
        coverage: 'screenshot-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'launch-selected-task-rows',
        reportAction: reportMode,
      },
      {
        id: 'task-board.stale-diagnostic-row',
        surfaceId: 'task-board',
        label: 'Stale launch diagnostic row',
        kind: 'panel',
        testId: 'task-board-stale-diagnostic-row',
        reportTargetId: 'task-board-stale-diagnostic-row',
        expectedBehavior: 'shows missing, stale, or offline launch diagnostics and exports the same state into proof packs',
        proofLevel: 'unit-tested',
        coverage: 'semantic-covered',
        assetLike: true,
        clickability: 'selectable-only',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'select-task-row',
        reportAction: 'capture-task-row-diagnostic',
      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    route: 'settings',
    expectedBehavior: 'edits theme, launch defaults, diagnostics, browser helpers, and runtime preferences',
    proofLevel: 'source-confirmed',
    controls: [
      {
        id: 'settings.harness-aliases',
        surfaceId: 'settings',
        label: 'Harness command aliases',
        kind: 'input',
        testId: 'settings-harness-aliases',
        reportTargetId: 'settings-harness-aliases',
        expectedBehavior: 'stores and resolves launch aliases such as codex, claude, hermes, and openclaw',
        proofLevel: 'unit-tested',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'edit-harness-alias',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'proof-pack',
    label: 'Proof pack',
    route: 'project',
    expectedBehavior: 'writes semantic task-board evidence, visual metadata, screenshot status, and review signals',
    proofLevel: 'unit-tested',
    controls: [
      {
        id: 'proof-pack.capture-button',
        surfaceId: 'proof-pack',
        label: 'Capture proof pack',
        kind: 'button',
        testId: 'proof-pack-capture-button',
        reportTargetId: 'proof-pack-capture-button',
        expectedBehavior: 'writes a proof-pack artifact with task rows, agents, activity, visual evidence, and honest screenshot status',
        proofLevel: 'unit-tested',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'capture-proof-pack',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'area-report-capture',
    label: 'Area report capture',
    route: 'modal',
    expectedBehavior: 'lets the operator select an app region, confirm the crop, and save screenshot plus learning sidecars',
    proofLevel: 'defect',
    controls: [
      {
        id: 'area-report.start',
        surfaceId: 'area-report-capture',
        label: 'Start report-area mode',
        kind: 'button',
        testId: 'area-report-start',
        reportTargetId: 'area-report-start',
        expectedBehavior: 'enters feedback mode and opens the app-internal report-area overlay without macOS click automation',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'start-report-area-mode',
        reportAction: reportMode,
      },
      {
        id: 'area-report.crop-rectangle',
        surfaceId: 'area-report-capture',
        label: 'Report-area crop rectangle',
        kind: 'canvas-affordance',
        testId: 'area-report-crop-rectangle',
        reportTargetId: 'area-report-crop-rectangle',
        expectedBehavior: 'drags and resizes the selected app-region crop before confirmation',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: true,
        clickability: 'selectable-only',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'adjust-report-area-crop',
        reportAction: 'capture-report-area-overlay',
      },
      {
        id: 'area-report.next',
        surfaceId: 'area-report-capture',
        label: 'Review selected area',
        kind: 'button',
        testId: 'area-report-next',
        reportTargetId: 'area-report-next',
        expectedBehavior: 'moves from crop targeting into the confirmation step without saving yet',
        proofLevel: 'browser-visual',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'review-report-area-crop',
        reportAction: reportMode,
      },
      {
        id: 'area-report.confirm',
        surfaceId: 'area-report-capture',
        label: 'Confirm report-area capture',
        kind: 'button',
        testId: 'area-report-confirm',
        reportTargetId: 'area-report-confirm',
        expectedBehavior: 'saves the selected region image, markdown sidecar, JSON sidecar, and closeout context',
        proofLevel: 'native-shell',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'primary-clickable',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: 'confirm-report-area-capture',
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'session-closeout',
    label: 'Session closeout survey',
    route: 'modal',
    expectedBehavior: 'writes app identity, trigger, captured areas, fallback questions, visual atlas path, and Majordomo cleanup state into dated learning folders',
    proofLevel: 'native-shell',
    controls: [
      {
        id: 'session-closeout.packet',
        surfaceId: 'session-closeout',
        label: 'Closeout survey packet',
        kind: 'panel',
        testId: 'session-closeout-packet',
        reportTargetId: 'session-closeout-packet',
        expectedBehavior: 'persists closeout-survey.md and closeout-survey.json without blocking app quit or project close',
        proofLevel: 'native-shell',
        coverage: 'semantic-covered',
        assetLike: false,
        clickability: 'noninteractive',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: null,
        reportAction: reportMode,
      },
    ],
  },
  {
    id: 'visual-atlas',
    label: 'Visual Atlas',
    route: 'visual-atlas',
    expectedBehavior: 'renders every registered feature/control in deterministic proof states and fails on missing coverage',
    proofLevel: 'unit-tested',
    controls: [
      {
        id: 'visual-atlas.surface-card',
        surfaceId: 'visual-atlas',
        label: 'Atlas surface card',
        kind: 'panel',
        testId: 'visual-atlas-surface-card',
        reportTargetId: 'visual-atlas-surface-card',
        expectedBehavior: 'renders a deterministic representative card for each registered surface and its controls',
        proofLevel: 'unit-tested',
        coverage: 'screenshot-covered',
        assetLike: false,
        clickability: 'noninteractive',
        reportability: 'reportable-in-feedback-mode',
        primaryAction: null,
        reportAction: 'capture-visual-atlas-card',
      },
      {
        id: 'visual-atlas.decorative-grid',
        surfaceId: 'visual-atlas',
        label: 'Decorative atlas grid background',
        kind: 'panel',
        testId: 'visual-atlas-decorative-grid',
        reportTargetId: 'visual-atlas-decorative-grid',
        expectedBehavior: 'provides visual grid context only and is explicitly exempt from report capture',
        proofLevel: 'source-confirmed',
        coverage: 'hidden-debug-exempt',
        assetLike: false,
        clickability: 'decorative',
        reportability: 'exempt',
        primaryAction: null,
        reportAction: 'none',
        exemptionReason: 'Decorative proof-mode background, not an operator control.',
      },
    ],
  },
];

export function featureControls(): FeatureControl[] {
  return SWARM_UI_FEATURE_SURFACES.flatMap((surface) => surface.controls);
}

export function featureMapSummary() {
  const controls = featureControls();
  return {
    surfaces: SWARM_UI_FEATURE_SURFACES.length,
    controls: controls.length,
    assetLikeControls: controls.filter((control) => control.assetLike).length,
    reportableControls: controls.filter((control) => control.reportability !== 'exempt').length,
  };
}
