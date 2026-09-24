import { gitDiffHash } from "./fixtures/source-state";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const output = join(
  resolve(process.argv[2] ?? "dist/verification/coordination"),
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const manifest = {
  startedAt: new Date().toISOString(),
  revision: git("rev-parse", "HEAD"),
  workingTree: git("status", "--porcelain"),
  diffSha256: gitDiffHash(),
  platform: process.platform,
  arch: process.arch,
  node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  bun: Bun.version,
  steps: [] as Array<{
    command: string[];
    exitCode: number;
    durationMs: number;
    log: string;
  }>,
};
const tests = readdirSync("test")
  .filter(
    (name) =>
      name.endsWith(".test.ts"),
  )
  .sort()
  .map((name) => `./test/${name}`);
const commands = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "build"],
  // Hosted runners can be several times slower than a workstation; keep the
  // per-test default at the suite's slowest explicit timeout instead of 5s.
  ["bun", "test", "--timeout", "30000", ...tests],
  [
    process.env.PYTHON ?? "python",
    "-m",
    "unittest",
    "integrations._shared.test_swarm_hook_core",
  ],
  ["bun", "scripts/measure-mcp-context.ts", "32", join(output, "context.json")],
  [process.env.PYTHON ?? "python", "scripts/verify-context-budget.py", join(output, "context.json")],
];
let failed = false;
for (const [index, command] of commands.entries()) {
  const log = `${index + 1}.log`,
    path = join(output, log),
    started = Date.now();
  writeFileSync(path, "");
  const executable =
    command[0] === "bun"
      ? process.execPath
      : (Bun.which(command[0]!) ?? command[0]!);
  const child = spawn(executable, command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => appendFileSync(path, chunk));
  child.stderr.on("data", (chunk) => appendFileSync(path, chunk));
  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      appendFileSync(path, String(error));
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  manifest.steps.push({
    command,
    exitCode,
    durationMs: Date.now() - started,
    log,
  });
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`${index + 1}/${commands.length}: exit ${exitCode}; ${path}`);
  if (exitCode !== 0) {
    failed = true;
    break;
  }
}
const finalSource = {
  revision: git("rev-parse", "HEAD"),
  workingTree: git("status", "--porcelain"),
  diffSha256: gitDiffHash(),
};
const sourceChanged =
  finalSource.revision !== manifest.revision ||
  finalSource.workingTree !== manifest.workingTree ||
  finalSource.diffSha256 !== manifest.diffSha256;
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      ...manifest,
      finishedAt: new Date().toISOString(),
      finalSource,
      sourceChanged,
    },
    null,
    2,
  ) + "\n",
);
if (sourceChanged)
  console.error(
    "Source changed during verification; rerun against a stable revision.",
  );
process.exitCode = failed || sourceChanged ? 1 : 0;
