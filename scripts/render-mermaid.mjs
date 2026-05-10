#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagramsDir = join(repoRoot, "docs", "diagrams");
const scale = process.env.MERMAID_SCALE || "3";
const width = process.env.MERMAID_WIDTH || "2400";
const background = process.env.MERMAID_BACKGROUND || "white";

function mermaidCommand() {
  const local = join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mmdc.cmd" : "mmdc",
  );
  if (existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: "npx", prefix: ["--yes", "@mermaid-js/mermaid-cli"] };
}

function diagramInputs() {
  const requested = process.argv.slice(2);
  if (requested.length) {
    return requested.map((item) => resolve(repoRoot, item));
  }
  return readdirSync(diagramsDir)
    .filter((file) => extname(file) === ".mmd")
    .map((file) => join(diagramsDir, file));
}

const { cmd, prefix } = mermaidCommand();
const inputs = diagramInputs();

if (!inputs.length) {
  console.error(`No Mermaid diagrams found in ${diagramsDir}`);
  process.exit(1);
}

for (const input of inputs) {
  const output = input.replace(/\.mmd$/, ".png");
  const args = [
    ...prefix,
    "-i",
    input,
    "-o",
    output,
    "--scale",
    scale,
    "--width",
    width,
    "--backgroundColor",
    background,
  ];
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
