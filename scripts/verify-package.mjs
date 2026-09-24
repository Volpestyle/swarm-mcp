import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

// Run after build via npm run verify:package. npm supplies its actual CLI path;
// direct invocation also supports the normal sibling installation layout.
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
mkdirSync(resolve("dist/test"), { recursive: true });
const sentinel = join(mkdtempSync(resolve("dist/test/package-exclusion-")), "must-not-ship.json");
writeFileSync(sentinel, JSON.stringify({ marker: "Generated local state must never ship" }));
const [pack] = JSON.parse(execFileSync(process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", windowsHide: true }));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const paths = new Set(pack.files.map(file => file.path));
for (const path of paths) {
  assert.ok(path === "package.json" || path === "README.md" || path === "docs/runtime-embedding.md" || path === "LICENSE" || path === "skills/README.md" || path === "bun.lock" ||
    path.startsWith("sql/") || path.startsWith("skills/swarm-mcp/") ||
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
