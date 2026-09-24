import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entries = pkg.files.filter(path => path.startsWith("dist/") && path.endsWith(".js"))
  .map(path => path.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(path) : [path];
  });
}
const hash = createHash("sha256");
for (const path of [...files("src"), "package.json", "bun.lock", "scripts/build.mjs"].sort())
  hash.update(path + "\0").update(readFileSync(path)).update("\0");
let revision = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
await build({ entryPoints: entries, bundle: true, platform: "node", format: "esm", target: "node22",
  outdir: "dist", packages: "external", banner: { js: "#!/usr/bin/env node" },
  define: { SWARM_BUILD: JSON.stringify({ revision, sourceDigest: hash.digest("hex"), packageVersion: pkg.version,
    sdkVersion: pkg.dependencies["@modelcontextprotocol/server"] }) }, logLevel: "info" });

rmSync("dist/types", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.runtime.json"], { stdio: "inherit" });
for (const path of files("dist/types").filter(path => path.endsWith(".d.ts"))) {
  writeFileSync(path, readFileSync(path, "utf8").replace(/(from \"|import\(\")(\.\.?\/[^\"]+)(\")/g, (_, before, specifier, after) => before + (specifier.endsWith(".js") ? specifier : specifier + ".js") + after));
}
