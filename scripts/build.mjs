import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

execFileSync(process.execPath, ["scripts/generate-protocol-types.mjs"], { stdio: "inherit" });
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
for (const path of [...files("src"), ...files("sql"), "package.json", "bun.lock", "scripts/build.mjs"].sort())
  hash.update(path + "\0").update(readFileSync(path)).update("\0");
let revision = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
await build({ entryPoints: entries, bundle: true, platform: "node", format: "esm", target: "node22",
  outdir: "dist", packages: "external", loader: { ".sql": "text" }, banner: { js: "#!/usr/bin/env node" },
  define: { SWARM_BUILD: JSON.stringify({ revision, sourceDigest: hash.digest("hex"), packageVersion: pkg.version,
    sdkVersion: pkg.dependencies["@modelcontextprotocol/server"] }) }, logLevel: "info" });
