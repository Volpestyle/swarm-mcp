import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(directory: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

/** Worktree root and the main checkout that owns it, so every worktree of one
 * repository shares a swarm. Outside git, the directory stands for both. */
export function repositoryRoots(directory: string) {
  const fileRoot = git(directory, ["rev-parse", "--show-toplevel"]);
  const common = git(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!fileRoot || !common) return { fileRoot: directory, projectRoot: directory };
  return { fileRoot: resolve(fileRoot), projectRoot: dirname(resolve(common)) };
}

export const launchOptionsHelp = `  --profile <name>     Coordination profile (default: default)
  --label <text>       Session label shown to peers
  --state-dir <path>   Private launcher state (default: ~/.swarm-mcp/coordinator,
                       or SWARM_STATE_DIR)`;

export function parseLaunchArguments(argv: string[], usage: string) {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  const options: Record<string, string> = {};
  for (let i = 0; i < own.length; i++) {
    const flag = own[i];
    if (flag === "-h" || flag === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (!["--profile", "--label", "--resume", "--state-dir"].includes(flag))
      throw new Error(`Unknown option ${flag}\n\n${usage}`);
    const value = own[++i];
    if (!value) throw new Error(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  return { options, rest };
}

/** Launcher inputs common to every host, resolved from the current directory
 * and the built files next to this module. */
export function launchContext(options: Record<string, string>, skillHome: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const directory = process.cwd();
  const installedSkill = join(homedir(), skillHome, "skills", "swarm-mcp", "SKILL.md");
  return {
    here,
    stateDirectory:
      options["state-dir"] ??
      process.env.SWARM_STATE_DIR ??
      join(homedir(), ".swarm-mcp", "coordinator"),
    nodePath: process.execPath,
    ownerPath: join(here, "owner-cli.js"),
    identity: {
      ...repositoryRoots(directory),
      profile: options.profile ?? "default",
      directory,
    },
    label: options.label,
    skillPath:
      process.env.SWARM_SKILL_PATH ??
      (existsSync(installedSkill) ? installedSkill : undefined),
  };
}
