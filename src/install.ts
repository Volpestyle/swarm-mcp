import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "swarm";
const SKILL_NAME = "swarm-mcp";

export type HostId = "claude-code" | "codex" | "opencode" | "cursor";

type ConfigFormat = "json-claude" | "json-opencode" | "json-cursor" | "toml-codex";

type HostDef = {
  id: HostId;
  label: string;
  configPath: string;
  configFormat: ConfigFormat;
  skillRoot: string | null;
};

const HOME = homedir();

const HOSTS: HostDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    configPath: join(HOME, ".claude.json"),
    configFormat: "json-claude",
    skillRoot: join(HOME, ".claude", "skills"),
  },
  {
    id: "codex",
    label: "Codex",
    configPath: join(HOME, ".codex", "config.toml"),
    configFormat: "toml-codex",
    skillRoot: join(HOME, ".codex", "skills"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    configPath: join(HOME, ".config", "opencode", "opencode.json"),
    configFormat: "json-opencode",
    skillRoot: join(HOME, ".config", "opencode", "skills"),
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: join(HOME, ".cursor", "mcp.json"),
    configFormat: "json-cursor",
    skillRoot: null,
  },
];

const HOST_BY_ID = new Map<HostId, HostDef>(HOSTS.map((h) => [h.id, h]));

export type InstallOptions = {
  hosts: HostId[];
  withSkill: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
};

type InstallStep = {
  action: "wrote" | "updated" | "skipped" | "symlinked" | "would_write" | "would_symlink";
  path: string;
  note?: string;
};

type HostResult = {
  host: HostId;
  config_path: string;
  skill_path: string | null;
  steps: InstallStep[];
};

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON. Fix or remove it and retry. (${err instanceof Error ? err.message : err})`,
    );
  }
}

function writeJson(path: string, obj: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function setJsonClaude(path: string, force: boolean): InstallStep {
  const entry = { command: "swarm-mcp", args: [] as string[] };
  let cfg: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(path)) {
    cfg = readJson(path);
    existed = true;
  }
  const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
  const has = SERVER_NAME in servers;
  if (has && !force) {
    return { action: "skipped", path, note: "swarm entry already present (use --force to overwrite)" };
  }
  servers[SERVER_NAME] = entry;
  cfg.mcpServers = servers;
  writeJson(path, cfg);
  return { action: existed ? "updated" : "wrote", path };
}

function setJsonOpenCode(path: string, force: boolean): InstallStep {
  const entry = {
    type: "local" as const,
    command: ["swarm-mcp"] as string[],
    enabled: true,
  };
  let cfg: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(path)) {
    cfg = readJson(path);
    existed = true;
  }
  const mcp = (cfg.mcp as Record<string, unknown> | undefined) ?? {};
  const has = SERVER_NAME in mcp;
  if (has && !force) {
    return { action: "skipped", path, note: "swarm entry already present (use --force to overwrite)" };
  }
  mcp[SERVER_NAME] = entry;
  cfg.mcp = mcp;
  writeJson(path, cfg);
  return { action: existed ? "updated" : "wrote", path };
}

function setJsonCursor(path: string, force: boolean): InstallStep {
  const entry = { command: "swarm-mcp", args: [] as string[] };
  let cfg: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(path)) {
    cfg = readJson(path);
    existed = true;
  }
  const servers = (cfg.mcpServers as Record<string, unknown> | undefined) ?? {};
  const has = SERVER_NAME in servers;
  if (has && !force) {
    return { action: "skipped", path, note: "swarm entry already present (use --force to overwrite)" };
  }
  servers[SERVER_NAME] = entry;
  cfg.mcpServers = servers;
  writeJson(path, cfg);
  return { action: existed ? "updated" : "wrote", path };
}

const CODEX_BLOCK = `[mcp_servers.swarm]
command = "swarm-mcp"
args = []
`;

function setTomlCodex(path: string, force: boolean): InstallStep {
  let existing = "";
  let existed = false;
  if (existsSync(path)) {
    existing = readFileSync(path, "utf8");
    existed = true;
  }

  // Look for an existing [mcp_servers.swarm] block. Naive line scan; codex's
  // config is hand-edited so this matches the format users actually have.
  const hasBlock = /\n?\[mcp_servers\.swarm\]\s/.test(`\n${existing}`);
  if (hasBlock && !force) {
    return {
      action: "skipped",
      path,
      note: "[mcp_servers.swarm] already present (use --force to rewrite)",
    };
  }

  let next: string;
  if (hasBlock) {
    // Replace existing block up to next [section] or EOF.
    next = existing.replace(
      /(^|\n)\[mcp_servers\.swarm\][\s\S]*?(?=\n\[|\n*$)/,
      `\n${CODEX_BLOCK.trimEnd()}\n`,
    );
  } else {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const prefix = existing.length === 0 ? "" : "\n";
    next = `${existing}${sep}${prefix}${CODEX_BLOCK}`;
  }

  ensureDir(dirname(path));
  writeFileSync(path, next);
  return { action: existed ? "updated" : "wrote", path };
}

function writeHostConfig(host: HostDef, force: boolean, dryRun: boolean): InstallStep {
  if (dryRun) {
    return { action: "would_write", path: host.configPath, note: host.configFormat };
  }
  switch (host.configFormat) {
    case "json-claude":
      return setJsonClaude(host.configPath, force);
    case "json-opencode":
      return setJsonOpenCode(host.configPath, force);
    case "json-cursor":
      return setJsonCursor(host.configPath, force);
    case "toml-codex":
      return setTomlCodex(host.configPath, force);
  }
}

function symlinkSkill(target: string, linkPath: string, force: boolean, dryRun: boolean): InstallStep {
  if (dryRun) {
    return { action: "would_symlink", path: linkPath, note: `→ ${target}` };
  }
  ensureDir(dirname(linkPath));
  if (existsSync(linkPath) || isDanglingSymlink(linkPath)) {
    try {
      const current = lstatSync(linkPath);
      if (current.isSymbolicLink()) {
        const dest = readlinkSync(linkPath);
        const resolved = resolve(dirname(linkPath), dest);
        if (resolved === target) {
          return { action: "skipped", path: linkPath, note: "symlink already points to the bundled skill" };
        }
      }
    } catch {
      /* fall through to overwrite */
    }
    if (!force) {
      return {
        action: "skipped",
        path: linkPath,
        note: "exists and is not the bundled skill (use --force to overwrite)",
      };
    }
    try {
      unlinkSync(linkPath);
    } catch (err) {
      throw new Error(
        `Cannot remove ${linkPath} before symlinking: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  symlinkSync(target, linkPath);
  return { action: "symlinked", path: linkPath, note: `→ ${target}` };
}

function isDanglingSymlink(path: string): boolean {
  try {
    const s = lstatSync(path);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

function parse(args: string[]): InstallOptions {
  const opts: InstallOptions = {
    hosts: [],
    withSkill: true,
    force: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host") {
      const next = args[++i];
      if (!next) throw new Error("--host requires a value");
      for (const item of next.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (item === "all") {
          for (const h of HOSTS) opts.hosts.push(h.id);
          continue;
        }
        if (!HOST_BY_ID.has(item as HostId)) {
          throw new Error(
            `Unknown host '${item}'. Known: ${HOSTS.map((h) => h.id).join(", ")}, all`,
          );
        }
        opts.hosts.push(item as HostId);
      }
    } else if (arg === "--no-skill" || arg === "--no-skills") {
      opts.withSkill = false;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printInstallHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown install flag: ${arg}`);
    }
  }

  if (opts.hosts.length === 0) {
    opts.hosts = autodetectHosts();
  }
  // Dedupe, preserve order
  opts.hosts = Array.from(new Set(opts.hosts));
  return opts;
}

function autodetectHosts(): HostId[] {
  const found: HostId[] = [];
  for (const host of HOSTS) {
    if (existsSync(host.configPath) || (host.skillRoot && existsSync(host.skillRoot))) {
      found.push(host.id);
    }
  }
  if (found.length === 0) {
    // No signals at all — default to writing claude-code (most common host).
    return ["claude-code"];
  }
  return found;
}

function printInstallHelp() {
  console.log(`swarm-mcp install — wire the swarm MCP server into your coding-agent hosts

Usage:
  swarm-mcp install [--host <name>[,<name>...]] [--no-skill] [--force] [--dry-run] [--json]

Hosts (--host):
  claude-code   ~/.claude.json + ~/.claude/skills/swarm-mcp
  codex         ~/.codex/config.toml + ~/.codex/skills/swarm-mcp
  opencode      ~/.config/opencode/opencode.json + ~/.config/opencode/skills/swarm-mcp
  cursor        ~/.cursor/mcp.json (no skill surface)
  all           all of the above

Flags:
  --no-skill    Skip the skill symlink (config only).
  --force       Overwrite an existing swarm entry / non-matching skill symlink.
  --dry-run     Print the actions that would run; do not modify anything.
  --json        Machine-readable summary.

If --host is omitted, install runs for every host whose config or skill root
already exists on disk (auto-detected). If nothing is detected, defaults to
claude-code.

After install, restart the host to pick up the new MCP server, then run
'swarm-mcp doctor' to verify.`);
}

export function runInstall(args: string[]) {
  const opts = parse(args);
  const pkgRoot = packageRoot();
  const skillSource = join(pkgRoot, "skills", SKILL_NAME);
  const hasBundledSkill = existsSync(skillSource);

  const results: HostResult[] = [];
  for (const id of opts.hosts) {
    const host = HOST_BY_ID.get(id)!;
    const steps: InstallStep[] = [];
    steps.push(writeHostConfig(host, opts.force, opts.dryRun));
    let skillPath: string | null = null;
    if (opts.withSkill && host.skillRoot) {
      skillPath = join(host.skillRoot, SKILL_NAME);
      if (!hasBundledSkill) {
        steps.push({
          action: "skipped",
          path: skillPath,
          note: `bundled skill not found at ${skillSource}; install via package or clone`,
        });
      } else {
        steps.push(symlinkSkill(skillSource, skillPath, opts.force, opts.dryRun));
      }
    }
    results.push({
      host: id,
      config_path: host.configPath,
      skill_path: skillPath,
      steps,
    });
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        { dry_run: opts.dryRun, with_skill: opts.withSkill, results },
        null,
        2,
      ),
    );
    return;
  }

  const heading = opts.dryRun
    ? "swarm-mcp install (dry run) — would change:"
    : "swarm-mcp install — changes:";
  console.log(heading);
  for (const result of results) {
    const host = HOST_BY_ID.get(result.host)!;
    console.log(`\n  ${host.label} (${result.host})`);
    for (const step of result.steps) {
      const note = step.note ? `  — ${step.note}` : "";
      console.log(`    [${step.action.padEnd(14)}] ${step.path}${note}`);
    }
  }

  if (!opts.dryRun) {
    console.log("\nRestart your host(s), then run 'swarm-mcp doctor' to verify.");
  }
}
