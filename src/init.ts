import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "swarm";
const SKILLS = ["swarm-mcp"];

type InitOptions = {
  dir: string;
  force: boolean;
  skills: boolean;
};

function parse(args: string[]): InitOptions {
  const opts: InitOptions = {
    dir: process.cwd(),
    force: false,
    skills: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--no-skills") opts.skills = false;
    else if (arg === "--dir") {
      const next = args[++i];
      if (!next) throw new Error("--dir requires a path argument");
      opts.dir = resolve(next);
    } else {
      throw new Error(`Unknown init flag: ${arg}`);
    }
  }

  return opts;
}

function packageRoot() {
  // dist/init.js → ../ = package root. Works in dev (src/init.ts via tsx)
  // and in the published package (node_modules/swarm-mcp/dist/init.js).
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeMcpConfig(dir: string) {
  const configPath = join(dir, ".mcp.json");
  const entry = {
    command: "npx",
    args: ["-y", "swarm-mcp"],
  };

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(
        `Existing ${configPath} is not valid JSON. Fix or remove it and retry.`,
      );
    }
  }

  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return configPath;
}

function copyEntries(
  source: string,
  dest: string,
  names: string[],
  force: boolean,
) {
  if (!existsSync(source)) return [];

  ensureDir(dest);
  const copied: string[] = [];

  for (const name of names) {
    const from = join(source, name);
    const to = join(dest, name);

    if (!existsSync(from)) continue;
    if (existsSync(to) && !force) {
      console.warn(`  skipped (exists): ${to}  — pass --force to overwrite`);
      continue;
    }

    cpSync(from, to, { recursive: true, force: true });
    copied.push(to);
  }

  return copied;
}

export async function runInit(args: string[]) {
  const opts = parse(args);
  ensureDir(opts.dir);

  const pkgRoot = packageRoot();

  console.log(`Installing swarm-mcp into ${opts.dir}`);
  const configPath = writeMcpConfig(opts.dir);
  console.log(`  wrote ${configPath}`);

  if (opts.skills) {
    const skillsSource = join(pkgRoot, "skills");
    const skillsDest = join(opts.dir, ".claude", "skills");
    const wrote = copyEntries(skillsSource, skillsDest, SKILLS, opts.force);
    for (const path of wrote) console.log(`  wrote ${path}`);
  }

  console.log(`
Done. Restart your coding-agent host to pick up .mcp.json.
After restart, invoke \`/swarm-mcp\` or call the swarm \`register\` tool to join the swarm.
`);
}
