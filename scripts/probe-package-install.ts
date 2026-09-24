import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const output = resolve(process.argv[2] ?? "dist/verification/package-install.json");
const root = mkdtempSync(join(tmpdir(), "swarm-package-install-"));
const node = Bun.which("node")!;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run verify:install so npm supplies its CLI path");
const report: Record<string, unknown> = { root, startedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() };
async function run(cmd: string[], cwd: string, log: string) {
  const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(root, log), stdout + stderr);
  if (code) throw new Error(`${log}: exit ${code}: ${stderr || stdout}`);
  return stdout;
}
try {
  const [pack] = JSON.parse(await run([node, npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", root], process.cwd(), "pack.log"));
  const tarball = join(root, pack.filename);
  report.tarballSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  report.files = pack.files.map((file: { path: string }) => file.path);
  await run(["tar", "-xzf", tarball, "-C", root], process.cwd(), "extract.log");
  const directory = join(root, "package"), lockBefore = readFileSync(join(directory, "bun.lock"));
  await run([process.execPath, "install", "--production", "--frozen-lockfile"], directory, "install.log");
  if (!readFileSync(join(directory, "bun.lock")).equals(lockBefore)) throw new Error("Frozen install changed lockfile");
  const state = join(root, "state"); mkdirSync(state);
  report.probe = JSON.parse(await run([node, resolve("scripts/fixtures/package-install-probe.mjs"), directory, state], directory, "probe.log"));
  report.lockfileUnchanged = true; report.ok = true;
} catch (error) { report.ok = false; report.error = String(error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); writeFileSync(output, JSON.stringify(report, null, 2) + "\n"); console.log(output); }
