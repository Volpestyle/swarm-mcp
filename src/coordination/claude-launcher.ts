import { isAbsolute, dirname, join } from "node:path";
import { statSync } from "node:fs";
import { enrollRuntime } from "./runtime-launcher";

type Settings = Record<string, unknown>;

/** Claude command hooks use the host's POSIX shell (including Git Bash on
 * Windows). Paths are shell data, never executable interpolation. */
function shellPath(path: string) {
  if (!isAbsolute(path) || !statSync(path).isFile())
    throw new Error(
      "Claude launcher requires absolute executable and hook paths",
    );
  const normalized =
    process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  return "'" + normalized.replaceAll("'", "'\\''") + "'";
}

export function claudeHookSettings(
  nodePath: string,
  hookPath: string,
  settings: Settings = {},
  events: readonly string[] = ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"],
): Settings & { hooks: Record<string, unknown> } {
  if (!settings || Array.isArray(settings) || typeof settings !== "object")
    throw new Error("Claude settings must be an object");
  if (settings.disableAllHooks === true)
    throw new Error("Claude hooks are disabled in the supplied settings");
  const previous = settings.hooks ?? {};
  if (!previous || typeof previous !== "object" || Array.isArray(previous))
    throw new Error("Claude hooks must be an event map");
  const hooks = { ...previous } as Record<string, unknown>;
  const command = `${shellPath(nodePath)} ${shellPath(hookPath)}`;
  for (const event of events) {
    const entries = hooks[event] ?? [];
    if (!Array.isArray(entries))
      throw new Error("Claude hook event must contain an array");
    hooks[event] = [
      ...entries,
      { hooks: [{ type: "command", command, timeout: 10 }] },
    ];
  }
  return { ...settings, hooks };
}

/** Trusted launcher composition. The caller chooses a native session and an
 * incarnation, then launches the host with these arguments and environment.
 * This never launches an agent in response to a peer message. */
export async function prepareClaudeLaunch(
  options: Omit<Parameters<typeof enrollRuntime>[0], "host"> & {
    hookPath: string;
    clientPath?: string;
    mcpPath?: string;
    settings?: Settings;
    mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    resume?: boolean;
    /** Interactive worker channel (ADR 0194). With a plugin, that installed
     * plugin serves the Swarm MCP and an owner-managed allowlist must approve it;
     * without one, the bare `swarm` server is a development channel that a
     * person confirms at startup. Its hooks then report lifecycle only. */
    channel?: { plugin?: string };
  },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      options.hostSessionId,
    )
  )
    throw new Error("Claude native session ID must be a UUID");
  const plugin = options.channel?.plugin;
  if (plugin !== undefined && !/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(plugin))
    throw new Error("Channel plugin must be name@marketplace");
  const settings = claudeHookSettings(
    options.nodePath,
    options.hookPath,
    plugin
      ? { ...options.settings, enabledPlugins: { ...(options.settings?.enabledPlugins as Record<string, boolean> | undefined), [plugin]: true } }
      : options.settings,
    options.channel
      ? ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]
      : undefined,
  );
  const serialized = JSON.stringify(settings);
  const clientPath =
    options.clientPath ?? join(dirname(options.hookPath), "client-cli.js");
  shellPath(clientPath);
  const mcpPath =
    options.mcpPath ?? join(dirname(options.hookPath), "mcp-cli.js");
  shellPath(mcpPath);
  if (options.mcpServers && Object.hasOwn(options.mcpServers, "swarm"))
    throw new Error("The swarm MCP server is reserved for the enrolled runtime");
  // One Swarm MCP per worker: the approved plugin serves it, or this bare server does.
  const mcp = JSON.stringify({
    mcpServers: plugin ? { ...options.mcpServers } : { ...options.mcpServers, swarm: { command: options.nodePath, args: [mcpPath] } },
  });
  // Leave room for Windows argument escaping and the caller's remaining flags.
  if (Buffer.byteLength(serialized) + Buffer.byteLength(mcp) > 8 * 1024)
    throw new Error("Claude additional settings exceed 8 KiB");
  const enrolled = await enrollRuntime({ ...options, host: "claude-code" });
  return {
    ...enrolled,
    environment: {
      ...enrolled.environment,
      SWARM_NATIVE_SESSION_ID: options.hostSessionId,
      SWARM_COORDINATOR_HOOK_OWNER: "launcher",
      SWARM_COORDINATOR_CLIENT: JSON.stringify([options.nodePath, clientPath]),
      ...(options.channel ? { SWARM_MCP_CHANNEL: "1" } : {}),
      // The plugin's server command reads this trusted argv; it carries no credential.
      ...(plugin ? { SWARM_WORKER_MCP: JSON.stringify([options.nodePath, mcpPath]) } : {}),
    },
    arguments: [
      options.resume ? "--resume" : "--session-id",
      options.hostSessionId,
      "--settings",
      serialized,
      "--mcp-config",
      mcp,
      ...(options.channel
        ? plugin
          ? ["--channels", `plugin:${plugin}`]
          : ["--dangerously-load-development-channels", "server:swarm"]
        : []),
    ],
  };
}
