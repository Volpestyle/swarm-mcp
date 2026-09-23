// Verify every relative Markdown link in tracked .md files resolves to a file.
// Usage: node scripts/check-doc-links.mjs   (exit 1 on any broken link)
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

const files = execSync("git ls-files", { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((f) => f.endsWith(".md") && !f.startsWith("node_modules/"));
const link = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
let broken = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(link)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (!existsSync(resolved)) {
      broken++;
      console.log(`${file}: ${target}`);
    }
  }
}
console.log(`${files.length} files, ${broken} broken links`);
process.exit(broken ? 1 : 0);
