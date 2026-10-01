import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { prepareClaudeLaunch } from "./claude-launcher";
import {
  launchContext,
  launchOptionsHelp,
  parseLaunchArguments,
} from "./launch-cli-shared";

const usage = `Usage: swarm-claude [options] [-- <claude arguments>]

Enrolls this Claude session with the local coordinator, then runs Claude with
the swarm MCP server, lifecycle hooks and session capability attached.

${launchOptionsHelp}
  --resume <uuid>      Resume this Claude session instead of starting a new one

Scope is the main checkout of the current git repository, so every worktree of
one repository shares a swarm. Outside git, the current directory is used.`;

async function main() {
  const { options, rest } = parseLaunchArguments(process.argv.slice(2), usage);
  const context = launchContext(options, ".claude");
  const hostSessionId = options.resume ?? randomUUID();
  const prepared = await prepareClaudeLaunch({
    ...context,
    hookPath: join(context.here, "claude-hook-cli.js"),
    hostSessionId,
    incarnation: randomUUID(),
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
