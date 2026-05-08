import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  BrowserBridge,
  launchManagedBrowser,
  stopManagedBrowser,
} from "./browser";
import {
  SWARM_UI_FEATURE_SURFACES,
  type FeatureSurface,
} from "../apps/swarm-ui/src/lib/featureMap";
import {
  visualAtlasCoverageReport,
  visualAtlasFeatureMapExport,
  visualAtlasSurfaceStates,
} from "../apps/swarm-ui/src/lib/visualAtlasRegistry";

export type VisualAtlasCliIntent = {
  group: "ui";
  command: "visual-atlas";
  out: string;
};

export type VisualAtlasRunOptions = {
  out: string;
  json?: boolean;
  skipBrowser?: boolean;
  silent?: boolean;
  port?: number;
};

type VisualAtlasBrowserEvidence = {
  surfaceId: string;
  screenshotPath: string;
  semanticPath: string;
};

const DEFAULT_ATLAS_PORT = 1420;
const LOCAL_HOST = "127.0.0.1";

export function parseVisualAtlasCliArgs(argv: string[]): VisualAtlasCliIntent {
  const tokens = argv[0] === "swarm-mcp" ? argv.slice(1) : argv.slice();
  const [group, command, ...rest] = tokens;
  if (group !== "ui" || command !== "visual-atlas") {
    throw new Error("Expected: swarm-mcp ui visual-atlas --out <path>");
  }

  let out = "";
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === "--out") {
      out = rest[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown visual atlas flag: ${token}`);
  }

  if (!out.trim()) {
    throw new Error("ui visual-atlas requires --out <path>");
  }

  return {
    group: "ui",
    command: "visual-atlas",
    out,
  };
}

export function visualAtlasCoverageReportForSurfaces(surfaces: FeatureSurface[]) {
  return visualAtlasCoverageReport(surfaces);
}

export function assertVisualAtlasCoverage(report: { ok: boolean }) {
  if (!report.ok) {
    throw new Error("visual atlas failed: missing coverage");
  }
}

export async function runVisualAtlasCli(options: VisualAtlasRunOptions) {
  if (!options.out.trim()) {
    throw new Error("ui visual-atlas requires --out <path>");
  }

  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });

  const featureMap = visualAtlasFeatureMapExport();
  const coverage = visualAtlasCoverageReport(SWARM_UI_FEATURE_SURFACES);
  await writeJson(join(outDir, "feature-map.json"), featureMap);
  await writeJson(join(outDir, "coverage.json"), coverage);

  assertVisualAtlasCoverage(coverage);

  const browserEvidence = options.skipBrowser
    ? []
    : await captureVisualAtlasBrowserEvidence({
      outDir,
      port: options.port ?? DEFAULT_ATLAS_PORT,
    });
  const index = buildVisualAtlasIndex({
    outDir,
    coverage,
    browserEvidence,
    skippedBrowser: Boolean(options.skipBrowser),
  });
  await writeFile(join(outDir, "index.md"), index);

  const result = {
    ok: true,
    out: outDir,
    featureMap: join(outDir, "feature-map.json"),
    coverage: join(outDir, "coverage.json"),
    index: join(outDir, "index.md"),
    screenshots: browserEvidence.map((entry) => entry.screenshotPath),
    semanticSnapshots: browserEvidence.map((entry) => entry.semanticPath),
  };

  if (options.silent) {
    return result;
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`visual atlas wrote ${outDir}`);
    console.log(`coverage: ${coverage.ok ? "pass" : "fail"}`);
    console.log(`screenshots: ${browserEvidence.length}`);
  }
  return result;
}

async function captureVisualAtlasBrowserEvidence(input: {
  outDir: string;
  port: number;
}): Promise<VisualAtlasBrowserEvidence[]> {
  const server = await ensureViteServer(input.port);
  const browser = await launchManagedBrowser({
    id: `visual-atlas-${Date.now().toString(36)}`,
    url: atlasUrl(input.port),
    headless: true,
    profileDir: join(input.outDir, ".chrome-profile"),
  });
  const bridge = new BrowserBridge(browser.endpoint);
  const evidence: VisualAtlasBrowserEvidence[] = [];

  try {
    await settle();
    await captureOneSurface({
      bridge,
      port: input.port,
      surfaceId: "all",
      screenshotPath: join(input.outDir, "visual-atlas-all.png"),
      semanticPath: join(input.outDir, "visual-atlas-all.semantic.json"),
    });
    for (const state of visualAtlasSurfaceStates()) {
      const screenshotPath = join(input.outDir, state.screenshotName);
      const semanticPath = join(input.outDir, `${state.id}.semantic.json`);
      await captureOneSurface({
        bridge,
        port: input.port,
        surfaceId: state.id,
        screenshotPath,
        semanticPath,
      });
      evidence.push({
        surfaceId: state.id,
        screenshotPath,
        semanticPath,
      });
    }
    return evidence;
  } finally {
    const profileDir = join(input.outDir, ".chrome-profile");
    stopManagedBrowser(browser);
    await cleanupProfileDir(profileDir);
    if (server.started && server.process) {
      await stopProcessTree(server.process);
    }
  }
}

async function captureOneSurface(input: {
  bridge: BrowserBridge;
  port: number;
  surfaceId: string;
  screenshotPath: string;
  semanticPath: string;
}) {
  const url = input.surfaceId === "all"
    ? atlasUrl(input.port)
    : `${atlasUrl(input.port)}&surface=${encodeURIComponent(input.surfaceId)}`;
  await input.bridge.navigate(url);
  await settle();
  const screenshotPath = await input.bridge.captureScreenshot({ out: input.screenshotPath });
  const proofSnapshot = await waitForVisualAtlasProofSnapshot(input.bridge, input.surfaceId);
  const semanticSnapshot = await input.bridge.snapshot({
    maxElements: 200,
    maxTextLength: 32_000,
  });
  await writeJson(input.semanticPath, {
    url,
    proofSnapshot,
    semanticSnapshot,
    screenshotPath,
  });
}

async function waitForVisualAtlasProofSnapshot(
  bridge: BrowserBridge,
  surfaceId: string,
): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  let lastValue: unknown = null;
  while (Date.now() < deadline) {
    lastValue = await bridge.evaluate(
      "window.__SWARM_UI_PROOF__?.snapshot ? window.__SWARM_UI_PROOF__.snapshot() : null",
    );
    if (isVisualAtlasProofSnapshot(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  throw new Error(`visual atlas proof API unavailable or stale for ${surfaceId}: ${JSON.stringify(lastValue)}`);
}

export async function ensureViteServer(port: number): Promise<{
  started: boolean;
  process: ChildProcessWithoutNullStreams | null;
}> {
  if (await serverResponds(port)) {
    return {
      started: false,
      process: null,
    };
  }

  const cwd = resolve("apps/swarm-ui");
  const child = spawn("bun", ["run", "dev", "--", "--host", LOCAL_HOST, "--port", String(port)], {
    cwd,
    env: process.env,
    detached: true,
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);

  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await serverResponds(port)) {
        return { started: true, process: child };
      }
    } catch (err) {
      lastError = err;
    }
    if (child.exitCode !== null) {
      throw new Error(`Vite dev server exited before ready: ${child.exitCode}`);
    }
    await sleep(250);
  }

  await stopProcessTree(child);
  throw new Error(`Timed out waiting for Vite visual atlas server: ${String(lastError)}`);
}

export async function stopProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  const done = waitForExit(child);

  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();

  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }

  await Promise.race([done, sleep(1_500)]);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([done, sleep(500)]);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function serverResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(atlasUrl(port), {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function atlasUrl(port: number): string {
  return `http://${LOCAL_HOST}:${port}/?visual-atlas=1`;
}

async function settle(): Promise<void> {
  await sleep(700);
}

export async function cleanupProfileDir(profileDir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await rm(profileDir, { recursive: true, force: true });
    if (!existsSync(profileDir)) {
      return;
    }
    await sleep(350);
  }
}

function isVisualAtlasProofSnapshot(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    (value as { mode?: unknown }).mode === "visual-atlas";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function buildVisualAtlasIndex(input: {
  outDir: string;
  coverage: ReturnType<typeof visualAtlasCoverageReport>;
  browserEvidence: VisualAtlasBrowserEvidence[];
  skippedBrowser: boolean;
}): string {
  const screenshotLines = input.browserEvidence.length
    ? input.browserEvidence
      .map((entry) => `- ${entry.surfaceId}: ${relative(input.outDir, entry.screenshotPath)}; semantic ${relative(input.outDir, entry.semanticPath)}`)
      .join("\n")
    : "- none";
  return [
    "# swarm-ui Visual Atlas",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Coverage: ${input.coverage.ok ? "pass" : "fail"}`,
    `Surfaces: ${input.coverage.surfaceCount}`,
    `Controls: ${input.coverage.controlCount}`,
    `Browser proof: ${input.skippedBrowser ? "skipped" : "headless Chrome/CDP"}`,
    "",
    "## Artifacts",
    "",
    "- feature-map.json",
    "- coverage.json",
    "- visual-atlas-all.png",
    "- visual-atlas-all.semantic.json",
    "",
    "## Surface Screenshots",
    "",
    screenshotLines,
    "",
  ].join("\n");
}

function relative(root: string, path: string): string {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function chromeAvailable(): boolean {
  return existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
}
