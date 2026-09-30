import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";
import { codexHookOverrides } from "./codex-launcher";
import {
  launchContext,
  launchOptionsHelp,
  parseLaunchArguments,
} from "./launch-cli-shared";

const usage = `Usage: swarm-codex [options] [-- <codex arguments>]

Enrolls a Codex session with the local coordinator, then runs Codex with the
swarm MCP server and session capability attached.

${launchOptionsHelp}
  --resume <id>        Re-enroll as the actor of an earlier swarm-codex launch
                       (pass Codex's own resume arguments after --)

Peer messages are delivered by pre-trusted lifecycle hooks when a turn starts
and after each tool call, as for Claude; an idle Codex still needs a prompt to
start a turn. The hooks exist only for this process: nothing is written to the
Codex configuration. The session is closed when Codex exits.`;

/** A TOML value for a Codex -c override; JSON strings and arrays are valid TOML. */
const toml = (value: unknown) => JSON.stringify(value);

/** Codex as [program, ...leading args]. On Windows npm installs a .cmd shim,
 * and cmd.exe would re-parse the TOML overrides, so run its script with Node. */
function codexCommand(nodePath: string): string[] {
  const configured = process.env.SWARM_CODEX_BIN;
  if (configured)
    return configured.endsWith(".js") ? [nodePath, configured] : [configured];
  if (process.platform !== "win32") return ["codex"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !existsSync(join(directory, "codex.cmd"))) continue;
    const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return [nodePath, script];
  }
  return ["codex.exe"];
}

async function main() {
  const { options, rest } = parseLaunchArguments(process.argv.slice(2), usage);
  const context = launchContext(options, ".codex");
  // Codex assigns its thread ID after start, so the launch ID stands in for it.
  const launchId = options.resume ?? randomUUID();
  const enrolled = await enrollRuntime({
    ...context,
    host: "codex",
    hostSessionId: launchId,
    incarnation: randomUUID(),
  });
  console.error(`swarm-codex: session ${launchId} actor ${enrolled.actor}`);
  // The capability travels in the environment, not the command line; Codex
  // forwards only the variables named in env_vars to the MCP server.
  const server = "mcp_servers.swarm";
  const overrides = [
    [`${server}.command`, context.nodePath],
    [`${server}.args`, [join(context.here, "mcp-cli.js")]],
    [`${server}.cwd`, context.here],
    [`${server}.env_vars`, Object.keys(enrolled.environment)],
    [`${server}.enabled`, true],
  ].flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
  try {
    overrides.push(
      ...codexHookOverrides(
        context.nodePath,
        join(context.here, "codex-hook-cli.js"),
      ),
    );
  } catch (error) {
    console.error(
      `swarm-codex: peer messages will not be delivered automatically (${error instanceof Error ? error.message : error}); read them with swarm_inbox`,
    );
  }
  const [program, ...leading] = codexCommand(context.nodePath);
  const child = spawn(program, [...leading, ...overrides, ...rest], {
    stdio: "inherit",
    env: { ...process.env, ...enrolled.environment },
    windowsHide: false,
  });
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  const close = async (code: number) => {
    try {
      const client = await CoordinationClient.connect(
        enrolled.environment.SWARM_COORDINATOR_ENDPOINT,
        enrolled.environment.SWARM_SESSION_CAPABILITY,
      );
      try {
        await client.request({
          op: "command",
          command: { id: randomUUID(), type: "session.close", payload: {} },
        });
      } finally {
        client.close();
      }
    } catch (error) {
      console.error(
        `swarm-codex: could not close session: ${error instanceof Error ? error.message : error}`,
      );
    }
    process.exit(code);
  };
  child.on("error", (error) => {
    console.error(`swarm-codex: could not start Codex: ${error.message}`);
    void close(127);
  });
  child.on("exit", (code, signal) => void close(code ?? (signal ? 1 : 0)));
}

main().catch((error) => {
  console.error(`swarm-codex: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
