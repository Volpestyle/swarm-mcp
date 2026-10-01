import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join, basename, dirname, delimiter } from "node:path";

// Bun's script runner sets npm_execpath to its native binary, including for a
// nested `npm run`. Resolve actual npm instead of handing that binary to Node.
const candidates = [process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, "npm"))];
const npmCli = candidates.flatMap(path => {
  try { const real = realpathSync(path); return basename(real) === "npm-cli.js" ? [real] : []; }
  catch { return []; }
})[0];
assert.ok(npmCli, "npm CLI not found; install npm alongside Node or put npm on PATH");
mkdirSync(resolve("dist/test"), { recursive: true });
const sentinel = join(mkdtempSync(resolve("dist/test/package-exclusion-")), "must-not-ship.json");
writeFileSync(sentinel, JSON.stringify({ marker: "Generated local state must never ship" }));
const [pack] = JSON.parse(execFileSync(process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", windowsHide: true }));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const paths = new Set(pack.files.map(file => file.path));
assert.equal(pkg.bin["swarm-mcp"], pkg.bin["swarm-coordinator-mcp"], "Swarm commands must use one coordinator");
for (const retired of ["dist/cli.js", "dist/index.js", "sql/swarm_db_bootstrap.sql", "dist/legacy-guard-cli.js", "dist/coordination/migration-cli.js"])
  assert.ok(!paths.has(retired), `Retired implementation shipped: ${retired}`);
for (const path of paths) {
  assert.ok(path === "package.json" || path === "README.md" || path === "docs/runtime-embedding.md" || path === "LICENSE" || path === "skills/README.md" || path === "bun.lock" ||
    path.startsWith("skills/swarm-mcp/") ||
    (path.startsWith("dist/types/") && path.endsWith(".d.ts")) || (path.startsWith("dist/") && pkg.files.includes(path)), `Unexpected packaged path: ${path}`);
}
for (const path of pkg.files.filter(path => path.startsWith("dist/") && path.endsWith(".js")))
  assert.ok(paths.has(path), `Missing production build: ${path}`);
for (const path of Object.values(pkg.bin)) assert.ok(paths.has(path.replace(/^\.\//, "")), `Missing bin: ${path}`);
assert.ok(paths.has("skills/swarm-mcp/SKILL.md"), "Missing consumer skill");
assert.ok(paths.has("bun.lock"), "Missing frozen-install lockfile");
assert.ok(![...paths].some(path => path.includes("must-not-ship")), "Generated state leaked into package");
console.log(JSON.stringify({ name: pack.name, version: pack.version, files: paths.size, unpackedBytes: pack.unpackedSize,
  generatedFilesExcluded: true, productionEntriesPresent: true }, null, 2));
