import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  diffSha256: createHash("sha256")
    .update(git("diff", "HEAD", "--"))
    .digest("hex"),
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
      (name.startsWith("coordination-") && name.endsWith(".test.ts")) ||
      name === "mcp-protocol.test.ts",
  )
  .sort()
  .map((name) => `./test/${name}`);
const commands = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "build"],
  ["bun", "test", ...tests],
  [
    process.env.PYTHON ?? "python",
    "-m",
    "unittest",
    "integrations.hermes.test_lifecycle",
    "integrations._shared.test_swarm_hook_core",
  ],
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
  diffSha256: createHash("sha256")
    .update(git("diff", "HEAD", "--"))
    .digest("hex"),
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
