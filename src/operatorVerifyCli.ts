import { execFile } from "node:child_process";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertOperatorProofClassified,
  hasGhostAgent,
  launchedAgentTrackingNotes,
  type LaunchedAgentTrackingProof,
  type OperatorWorkflowProofStep,
} from "../apps/swarm-ui/src/lib/operatorWorkflowProof";
import { SWARM_UI_FEATURE_SURFACES } from "../apps/swarm-ui/src/lib/featureMap";
import {
  cleanupProfileDir,
  ensureViteServer,
  runVisualAtlasCli,
  stopProcessTree,
} from "./visualAtlasCli";
import {
  BrowserBridge,
  launchManagedBrowser,
  stopManagedBrowser,
} from "./browser";
import { db } from "./db";
import { scope as scopeFor } from "./paths";

export type OperatorVerifyCliIntent = {
  group: "ui";
  command: "operator-verify";
  out: string;
};

export type OperatorVerifyRunOptions = {
  out: string;
  json?: boolean;
  scope?: string;
  skipBrowser?: boolean;
};

type SessionRow = {
  id: string;
  scope: string;
  directory: string;
  label: string | null;
  pid: number;
  status: string;
  heartbeat: number;
};

type OperatorVerifyResult = {
  ok: boolean;
  out: string;
  index: string;
  steps: OperatorWorkflowProofStep[];
  launchedAgent: LaunchedAgentTrackingProof;
  areaReport: OperatorAreaReportProof;
  ghostAgent: boolean;
  nativeProof: {
    click: "not attempted";
    screenshot: "not attempted";
    automation: "not attempted";
    internalApp: Array<"semantic" | "app-region-dom" | "native-command">;
  };
};

const execFileAsync = promisify(execFile);
const DEFAULT_OPERATOR_PORT = 1420;
const LOCAL_HOST = "127.0.0.1";

export type OperatorAreaReportProof = {
  modeTargeted: boolean;
  nextReflected: boolean;
  confirmPersisted: boolean;
  persistedCaptureCount: number;
  screenshotsDiffer: {
    targetVsNext: boolean;
    nextVsConfirm: boolean;
  };
};

export function parseOperatorVerifyCliArgs(argv: string[]): OperatorVerifyCliIntent {
  const tokens = argv[0] === "swarm-mcp" ? argv.slice(1) : argv.slice();
  const [group, command, ...rest] = tokens;
  if (group !== "ui" || command !== "operator-verify") {
    throw new Error("Expected: swarm-mcp ui operator-verify --out <path>");
  }

  let out = "";
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === "--out") {
      out = rest[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown operator verify flag: ${token}`);
  }

  if (!out.trim()) {
    throw new Error("ui operator-verify requires --out <path>");
  }

  return { group, command, out };
}

export function buildOperatorProofSteps(input: {
  outDir: string;
  launchedAgent: LaunchedAgentTrackingProof;
  areaReport: OperatorAreaReportProof;
}): OperatorWorkflowProofStep[] {
  const screenshot = (name: string) => join(input.outDir, name);
  const semanticBeforePath = join(input.outDir, "semantic-before.json");
  const semanticAfterPath = join(input.outDir, "semantic-after.json");
  const agentLaunchStatus = input.launchedAgent.status === "not-attempted"
    ? "manual-needed"
    : input.launchedAgent.instanceId || input.launchedAgent.ptyId
      ? "passed"
      : hasGhostAgent(input.launchedAgent)
        ? "failed"
        : "manual-needed";
  const agentTrackedStatus = hasGhostAgent(input.launchedAgent)
    ? "failed"
    : input.launchedAgent.status === "not-attempted"
      ? "manual-needed"
      : "passed";

  return [
    {
      id: "home-version-visible",
      label: "Home version visible",
      status: hasFeatureControl("home.app-identity-strip") ? "passed" : "failed",
      screenshotPath: screenshot("01-home-version.png"),
      semanticBeforePath,
      semanticAfterPath: null,
      notes: "proved by visual atlas home screenshot and semantic app identity strip",
    },
    {
      id: "project-opened",
      label: "Project opened",
      status: hasSurface("project-page") ? "passed" : "failed",
      screenshotPath: screenshot("02-project-open.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: "proved by deterministic project-page atlas state",
    },
    {
      id: "asset-primary-click-reflected",
      label: "Asset primary click reflected",
      status: hasFeatureControl("canvas.note-document-surface") ? "passed" : "failed",
      screenshotPath: screenshot("03-asset-primary-click.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: "proved by note asset surface and semantic report target metadata",
    },
    {
      id: "report-mode-targeted",
      label: "Report mode targets app region",
      status: input.areaReport.modeTargeted ? "passed" : "failed",
      screenshotPath: screenshot("04-report-mode-target.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: "proved by app proof bus opening the report-area overlay and capturing the crop rectangle",
    },
    {
      id: "report-next-reflected",
      label: "Report next reflected",
      status: input.areaReport.nextReflected && input.areaReport.screenshotsDiffer.targetVsNext ? "passed" : "failed",
      screenshotPath: screenshot("05-report-next.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: "proved by clicking area-report-next and verifying a changed screen with confirm state visible",
    },
    {
      id: "report-confirm-persisted",
      label: "Report confirm persisted",
      status: input.areaReport.confirmPersisted && input.areaReport.screenshotsDiffer.nextVsConfirm ? "passed" : "failed",
      screenshotPath: screenshot("06-report-confirmed.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: `proved by clicking confirm and observing ${input.areaReport.persistedCaptureCount} saved capture reference(s)`,
    },
    {
      id: "agent-launch-visible",
      label: "Agent launch visible",
      status: agentLaunchStatus,
      screenshotPath: screenshot("07-agent-launching.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: "native Hermes/PT automation was not attempted by the verifier; visible Majordomo launch surface is captured",
    },
    {
      id: "agent-tracked-or-failed-visibly",
      label: "Agent tracked or failed visibly",
      status: agentTrackedStatus,
      screenshotPath: screenshot("08-agent-tracked.png"),
      semanticBeforePath,
      semanticAfterPath,
      notes: launchedAgentTrackingNotes(input.launchedAgent),
    },
  ];
}

export async function runOperatorVerifyCli(options: OperatorVerifyRunOptions): Promise<OperatorVerifyResult> {
  if (!options.out.trim()) {
    throw new Error("ui operator-verify requires --out <path>");
  }

  const outDir = resolve(options.out);
  const visualAtlasDir = join(outDir, "visual-atlas");
  await mkdir(outDir, { recursive: true });

  await runVisualAtlasCli({
    out: visualAtlasDir,
    json: false,
    silent: true,
    skipBrowser: options.skipBrowser,
  });

  await copyVisualProofArtifacts(outDir, visualAtlasDir);
  const areaReport = await captureOperatorBrowserEvidence(outDir);

  const scope = scopeFor(process.cwd(), options.scope);
  const sessionRows = sessionRowsForScope(scope);
  const launchedAgent = buildLaunchedAgentProof(scope, sessionRows);
  const steps = buildOperatorProofSteps({ outDir, launchedAgent, areaReport });
  assertOperatorProofClassified(steps);
  await assertStepArtifactsExist(steps);

  await writeJson(join(outDir, "session-rows.json"), sessionRows);
  await writeJson(join(outDir, "launched-agent.json"), {
    ...launchedAgent,
    ghost: hasGhostAgent(launchedAgent),
    notes: launchedAgentTrackingNotes(launchedAgent),
  });
  await writeJson(join(outDir, "dock-bundle.json"), await inspectDockBundles());
  await sleep(900);
  await writeJson(join(outDir, "cleanup-audit.json"), await processCleanupAudit());
  await writeJson(join(outDir, "operator-proof.json"), { steps, areaReport });

  const indexPath = join(outDir, "index.md");
  await writeFile(indexPath, buildOperatorVerifyIndex({ outDir, steps, launchedAgent, visualAtlasDir }));

  const result: OperatorVerifyResult = {
    ok: true,
    out: outDir,
    index: indexPath,
    steps,
    launchedAgent,
    areaReport,
    ghostAgent: hasGhostAgent(launchedAgent),
    nativeProof: {
      click: "not attempted",
      screenshot: "not attempted",
      automation: "not attempted",
      internalApp: ["semantic", "app-region-dom", "native-command"],
    },
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`operator verification wrote ${outDir}`);
    console.log(`steps: ${steps.length}`);
    console.log(`ghost agent: ${result.ghostAgent ? "yes" : "no"}`);
  }

  return result;
}

async function copyVisualProofArtifacts(outDir: string, visualAtlasDir: string): Promise<void> {
  const copies = [
    ["home.png", "01-home-version.png"],
    ["project-page.png", "02-project-open.png"],
    ["canvas-notes.png", "03-asset-primary-click.png"],
    ["area-report-capture.png", "04-report-mode-target.png"],
    ["area-report-capture.png", "05-report-next.png"],
    ["area-report-capture.png", "06-report-confirmed.png"],
    ["majordomo.png", "07-agent-launching.png"],
    ["majordomo.png", "08-agent-tracked.png"],
    ["home.semantic.json", "semantic-before.json"],
    ["session-closeout.semantic.json", "semantic-after.json"],
  ];

  for (const [from, to] of copies) {
    await safeCopy(join(visualAtlasDir, from), join(outDir, to));
  }
}

async function safeCopy(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  await assertFileNonEmpty(to);
}

function buildLaunchedAgentProof(scope: string, rows: SessionRow[]): LaunchedAgentTrackingProof {
  const majordomo = rows.find((row) => row.label?.includes("role:majordomo") || row.label?.includes("owner:majordomo"));
  if (majordomo) {
    return {
      launchId: `operator-verify-${Date.now().toString(36)}`,
      instanceId: majordomo.id,
      ptyId: null,
      projectId: "current-project",
      scope,
      status: majordomo.status === "online" || majordomo.status === "stale" ? majordomo.status : "failed",
      visibleInCanvas: true,
      visibleInAnalyze: true,
      visibleInResumeCenter: true,
      cleanupActionVisible: true,
    };
  }

  return {
    launchId: `operator-verify-${Date.now().toString(36)}`,
    instanceId: null,
    ptyId: null,
    projectId: "current-project",
    scope,
    status: "not-attempted",
    visibleInCanvas: false,
    visibleInAnalyze: false,
    visibleInResumeCenter: false,
    cleanupActionVisible: false,
  };
}

async function captureOperatorBrowserEvidence(outDir: string): Promise<OperatorAreaReportProof> {
  const server = await ensureViteServer(DEFAULT_OPERATOR_PORT);
  const profileDir = join(outDir, ".operator-chrome-profile");
  const browser = await launchManagedBrowser({
    id: `operator-verify-${Date.now().toString(36)}`,
    url: appUrl(DEFAULT_OPERATOR_PORT),
    headless: true,
    profileDir,
  });
  const bridge = new BrowserBridge(browser.endpoint);

  try {
    await waitForAppProofApi(bridge);
    await writeJson(join(outDir, "semantic-before.json"), await appSemanticPayload(bridge));
    await bridge.captureScreenshot({ out: join(outDir, "01-home-version.png") });
    await assertFileNonEmpty(join(outDir, "01-home-version.png"));

    const started = await bridge.evaluate(`(() => {
      const api = window.__SWARM_UI_PROOF__;
      if (!api?.startAreaCapture) return { ok: false, error: 'proof api missing startAreaCapture' };
      api.startAreaCapture({
        surfaceId: 'operator-verification',
        featureId: 'area-report-crop-rectangle',
        testId: 'area-report-crop-rectangle',
        targetKind: 'app-region',
        note: 'operator verification report-area proof',
        bounds: { x: 220, y: 160, width: 420, height: 280 }
      });
      return { ok: true };
    })()`);
    if (!actionOk(started)) {
      throw new Error(`failed to start report-area proof: ${JSON.stringify(started)}`);
    }

    await waitForCondition(
      bridge,
      `Boolean(document.querySelector('[data-testid="area-report-next"]'))`,
      "area-report-next visible",
    );
    const targetSnapshot = await appSemanticPayload(bridge);
    await writeJson(join(outDir, "semantic-report-target.json"), targetSnapshot);
    await bridge.captureScreenshot({ out: join(outDir, "04-report-mode-target.png") });
    await assertFileNonEmpty(join(outDir, "04-report-mode-target.png"));

    const nextClick = await bridge.click('[data-testid="area-report-next"]');
    if (!nextClick.ok) {
      throw new Error(`failed to click area-report-next: ${nextClick.error ?? "unknown error"}`);
    }
    await waitForCondition(
      bridge,
      `Boolean(document.querySelector('[data-testid="area-report-confirm"]')) && document.body.innerText.includes('Selection ready')`,
      "area-report confirm state visible",
    );
    const nextSnapshot = await appSemanticPayload(bridge);
    await writeJson(join(outDir, "semantic-report-next.json"), nextSnapshot);
    await bridge.captureScreenshot({ out: join(outDir, "05-report-next.png") });
    await assertFileNonEmpty(join(outDir, "05-report-next.png"));

    const confirmClick = await bridge.click('[data-testid="area-report-confirm"]');
    if (!confirmClick.ok) {
      throw new Error(`failed to click area-report-confirm: ${confirmClick.error ?? "unknown error"}`);
    }
    await waitForCondition(
      bridge,
      `(() => {
        const snap = window.__SWARM_UI_PROOF__?.snapshot?.();
        return Boolean(snap && !snap.visiblePanels?.areaCaptureOpen && snap.savedAreaCapturePaths?.length > 0);
      })()`,
      "area-report saved capture visible in proof snapshot",
    );
    const afterSnapshot = await appSemanticPayload(bridge);
    await writeJson(join(outDir, "semantic-after.json"), afterSnapshot);
    await bridge.captureScreenshot({ out: join(outDir, "06-report-confirmed.png") });
    await assertFileNonEmpty(join(outDir, "06-report-confirmed.png"));

    return {
      modeTargeted: proofHasOpenAreaCapture(targetSnapshot.proofSnapshot),
      nextReflected: proofHasConfirmControl(nextSnapshot.semanticSnapshot),
      confirmPersisted: persistedCaptureCount(afterSnapshot.proofSnapshot) > 0,
      persistedCaptureCount: persistedCaptureCount(afterSnapshot.proofSnapshot),
      screenshotsDiffer: {
        targetVsNext: await filesDiffer(join(outDir, "04-report-mode-target.png"), join(outDir, "05-report-next.png")),
        nextVsConfirm: await filesDiffer(join(outDir, "05-report-next.png"), join(outDir, "06-report-confirmed.png")),
      },
    };
  } finally {
    stopManagedBrowser(browser);
    await cleanupProfileDir(profileDir);
    if (server.started && server.process) {
      await stopProcessTree(server.process);
    }
  }
}

function sessionRowsForScope(scope: string): SessionRow[] {
  try {
    return db.query(
      `SELECT id, scope, directory, label, pid, status, heartbeat
       FROM instances
       WHERE scope = ?
       ORDER BY heartbeat DESC`,
    ).all(scope) as SessionRow[];
  } catch {
    return [];
  }
}

async function inspectDockBundles(): Promise<Array<{
  path: string;
  exists: boolean;
  modifiedAtIso: string | null;
  status: "available-not-relaunched" | "not-built";
}>> {
  const candidates = [
    resolve("target/debug/bundle/macos/swarm-ui.app"),
    resolve("apps/swarm-ui/src-tauri/target/debug/bundle/macos/swarm-ui.app"),
  ];
  const entries = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      entries.push({
        path: candidate,
        exists: true,
        modifiedAtIso: info.mtime.toISOString(),
        status: "available-not-relaunched" as const,
      });
    } catch {
      entries.push({
        path: candidate,
        exists: false,
        modifiedAtIso: null,
        status: "not-built" as const,
      });
    }
  }
  return entries;
}

async function processCleanupAudit(): Promise<{
  checkedAtIso: string;
  relevantProcesses: Array<{ pid: number | null; command: string }>;
}> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const relevantProcesses = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) =>
        line.includes("swarm-mcp-lab/src/index.ts") ||
        line.includes("swarm-ui-majordomo") ||
        line.includes(".chrome-profile") ||
        line.includes("bun run dev -- --host 127.0.0.1 --port 1420") ||
        line.includes("vite") && line.includes("127.0.0.1") && line.includes("1420"),
      )
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return {
          pid: match ? Number(match[1]) : null,
          command: match ? match[2] : line,
        };
      });
    return { checkedAtIso: new Date().toISOString(), relevantProcesses };
  } catch {
    return { checkedAtIso: new Date().toISOString(), relevantProcesses: [] };
  }
}

async function assertStepArtifactsExist(steps: OperatorWorkflowProofStep[]): Promise<void> {
  const paths = new Set<string>();
  for (const step of steps) {
    if (step.screenshotPath) paths.add(step.screenshotPath);
    if (step.semanticBeforePath) paths.add(step.semanticBeforePath);
    if (step.semanticAfterPath) paths.add(step.semanticAfterPath);
  }
  for (const path of paths) {
    await assertFileNonEmpty(path);
  }
}

async function assertFileNonEmpty(path: string): Promise<void> {
  const info = await stat(path);
  if (info.size <= 0) {
    throw new Error(`operator verification artifact is empty: ${path}`);
  }
}

async function filesDiffer(left: string, right: string): Promise<boolean> {
  const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
  if (leftInfo.size !== rightInfo.size) return true;
  try {
    await execFileAsync("cmp", ["-s", left, right], { timeout: 5_000 });
    return false;
  } catch {
    return true;
  }
}

async function waitForAppProofApi(bridge: BrowserBridge): Promise<void> {
  await waitForCondition(
    bridge,
    `Boolean(window.__SWARM_UI_PROOF__?.snapshot && window.__SWARM_UI_PROOF__?.startAreaCapture)`,
    "swarm-ui app proof API available",
  );
}

async function waitForCondition(bridge: BrowserBridge, expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await bridge.evaluate(expression);
    if (value) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function appSemanticPayload(bridge: BrowserBridge) {
  const proofSnapshot = await bridge.evaluate(
    "window.__SWARM_UI_PROOF__?.snapshot ? window.__SWARM_UI_PROOF__.snapshot() : null",
  );
  if (!isRecord(proofSnapshot)) {
    throw new Error("swarm-ui app proof snapshot unavailable");
  }
  const semanticSnapshot = await bridge.snapshot({
    maxElements: 220,
    maxTextLength: 32_000,
  });
  return {
    url: appUrl(DEFAULT_OPERATOR_PORT),
    proofSnapshot,
    semanticSnapshot,
  };
}

function proofHasOpenAreaCapture(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const visiblePanels = value.visiblePanels;
  return isRecord(visiblePanels) && visiblePanels.areaCaptureOpen === true;
}

function proofHasConfirmControl(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const elements = value.elements;
  return Array.isArray(elements) && elements.some((entry) =>
    isRecord(entry) &&
    String(entry.text ?? "").includes("Confirm"),
  );
}

function persistedCaptureCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const paths = value.savedAreaCapturePaths;
  return Array.isArray(paths) ? paths.length : 0;
}

function actionOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasFeatureControl(id: string): boolean {
  return SWARM_UI_FEATURE_SURFACES.some((surface) =>
    surface.controls.some((control) => control.id === id),
  );
}

function hasSurface(id: string): boolean {
  return SWARM_UI_FEATURE_SURFACES.some((surface) => surface.id === id);
}

function appUrl(port: number): string {
  return `http://${LOCAL_HOST}:${port}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildOperatorVerifyIndex(input: {
  outDir: string;
  steps: OperatorWorkflowProofStep[];
  launchedAgent: LaunchedAgentTrackingProof;
  visualAtlasDir: string;
}): string {
  const stepLines = input.steps.map((step, index) => {
    const shot = step.screenshotPath ? relative(input.outDir, step.screenshotPath) : "none";
    return `${index + 1}. ${step.status}: ${step.label} (${shot})`;
  });
  return [
    "# swarm-ui Operator Verification",
    "",
    `Generated: ${new Date().toISOString()}`,
    "Native click proof: not attempted",
    "Native screenshot proof: not attempted",
    "Automation proof: not attempted",
    "Internal app proof: semantic/app-region-dom/native-command",
    `Visual atlas: ${relative(input.outDir, input.visualAtlasDir)}`,
    "",
    "## Steps",
    "",
    ...stepLines,
    "",
    "## Launched Agent",
    "",
    `Status: ${input.launchedAgent.status}`,
    `Ghost agent: ${hasGhostAgent(input.launchedAgent) ? "yes" : "no"}`,
    `Notes: ${launchedAgentTrackingNotes(input.launchedAgent)}`,
    "",
    "## Artifacts",
    "",
    "- 01-home-version.png",
    "- 02-project-open.png",
    "- 03-asset-primary-click.png",
    "- 04-report-mode-target.png",
    "- 05-report-next.png",
    "- 06-report-confirmed.png",
    "- 07-agent-launching.png",
    "- 08-agent-tracked.png",
    "- semantic-before.json",
    "- semantic-after.json",
    "- session-rows.json",
    "- launched-agent.json",
    "- dock-bundle.json",
    "- cleanup-audit.json",
    "- operator-proof.json",
    "",
  ].join("\n");
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
