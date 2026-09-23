import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareClaudeLaunch } from "./claude-launcher";

const usage = `Usage: swarm-claude [options] [-- <claude arguments>]

Enrolls this Claude session with the local coordinator, then runs Claude with
the swarm MCP server, lifecycle hooks and session capability attached.

  --profile <name>     Coordination profile (default: default)
  --label <text>       Session label shown to peers
  --resume <uuid>      Resume this Claude session instead of starting a new one
  --state-dir <path>   Private launcher state (default: ~/.swarm-mcp/coordinator,
                       or SWARM_STATE_DIR)

Scope is the main checkout of the current git repository, so every worktree of
one repository shares a swarm. Outside git, the current directory is used.`;

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

/** Worktree root and the main checkout that owns it. */
function repositoryRoots(directory: string) {
  const fileRoot = git(directory, ["rev-parse", "--show-toplevel"]);
  const common = git(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!fileRoot || !common) return { fileRoot: directory, projectRoot: directory };
  return { fileRoot: resolve(fileRoot), projectRoot: dirname(resolve(common)) };
}

function parse(argv: string[]) {
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

async function main() {
  const { options, rest } = parse(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const directory = process.cwd();
  const { fileRoot, projectRoot } = repositoryRoots(directory);
  const installedSkill = join(homedir(), ".claude", "skills", "swarm-mcp", "SKILL.md");
  const skillPath =
    process.env.SWARM_SKILL_PATH ?? (existsSync(installedSkill) ? installedSkill : undefined);
  const hostSessionId = options.resume ?? randomUUID();
  const prepared = await prepareClaudeLaunch({
    stateDirectory:
      options["state-dir"] ??
      process.env.SWARM_STATE_DIR ??
      join(homedir(), ".swarm-mcp", "coordinator"),
    nodePath: process.execPath,
    ownerPath: join(here, "owner-cli.js"),
    hookPath: join(here, "claude-hook-cli.js"),
    identity: {
      projectRoot,
      profile: options.profile ?? "default",
      directory,
      fileRoot,
    },
    hostSessionId,
    incarnation: randomUUID(),
    label: options.label,
    skillPath,
    resume: Boolean(options.resume),
  });
  // stderr keeps this out of `claude -p` output; resume with --resume <session>.
  console.error(`swarm-claude: session ${hostSessionId} actor ${prepared.actor}`);
  const child = spawn(
    process.env.SWARM_CLAUDE_BIN ?? "claude",
    [...prepared.arguments, ...rest],
    {
      stdio: "inherit",
      env: { ...process.env, ...prepared.environment },
      windowsHide: false,
    },
  );
  // The console delivers Ctrl+C to Claude directly, where it interrupts a turn;
  // exiting here would return the shell prompt while Claude still runs.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`swarm-claude: could not start Claude: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch((error) => {
  console.error(`swarm-claude: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
