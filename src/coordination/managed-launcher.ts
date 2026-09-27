import { dirname, join } from "node:path";
import { enrollRuntime } from "./runtime-launcher";
import { prepareClaudeLaunch } from "./claude-launcher";

export type ManagedHarness = "claude-code" | "codex" | "pi";

/** Per-launch configuration only. Never writes a user's harness configuration. */
export async function prepareManagedLaunch(options: Parameters<typeof prepareClaudeLaunch>[0] & {
  harness: ManagedHarness;
  model?: string;
}) {
  if (options.harness === "claude-code") {
    const launch = await prepareClaudeLaunch(options);
    return { ...launch, arguments: [...launch.arguments, ...(options.model ? ["--model", options.model] : [])] };
  }
  if (options.mcpServers && Object.hasOwn(options.mcpServers, "swarm"))
    throw new Error("The swarm MCP server is reserved for the enrolled runtime");
  const enrolled = await enrollRuntime({ ...options, host: options.harness });
  const here = dirname(options.hookPath);
  if (options.harness === "pi") return {
    ...enrolled,
    environment: { ...enrolled.environment, SWARM_WORKER_MCP_SERVERS: JSON.stringify({
      ...options.mcpServers,
      swarm: { command: options.nodePath, args: [join(here, "mcp-cli.js")] },
    }) },
    arguments: ["--mode", "rpc", "--no-session", "--extension", join(here, "pi-worker-extension.js"),
      ...(options.model ? ["--model", options.model] : [])],
  };
  const servers = { ...options.mcpServers, swarm: {
    command: options.nodePath, args: [join(here, "mcp-cli.js")],
  } };
  const overrides = Object.entries(servers).flatMap(([name, server]) => {
    const key = `mcp_servers.${JSON.stringify(name)}`;
    const { env, ...configuration } = server as { command: string; args: string[]; env?: Record<string, string> };
    return [...Object.entries({ ...configuration, enabled: true,
      // Launch binding must reach the MCP child as well as the enrollment.
      env_vars: [...Object.keys(enrolled.environment), "SWARM_WORKER_LAUNCH"],
    }).flatMap(([field, value]) => ["-c", `${key}.${field}=${JSON.stringify(value)}`]),
      ...Object.entries(env ?? {}).flatMap(([field, value]) => ["-c", `${key}.env.${JSON.stringify(field)}=${JSON.stringify(value)}`])];
  });
  return { ...enrolled, arguments: [...overrides, "app-server", "--stdio"] };
}
