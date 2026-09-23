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
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "SessionEnd",
  ]) {
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
    resume?: boolean;
  },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      options.hostSessionId,
    )
  )
    throw new Error("Claude native session ID must be a UUID");
  const settings = claudeHookSettings(
    options.nodePath,
    options.hookPath,
    options.settings,
  );
  const serialized = JSON.stringify(settings);
  const clientPath =
    options.clientPath ?? join(dirname(options.hookPath), "client-cli.js");
  shellPath(clientPath);
  const mcpPath =
    options.mcpPath ?? join(dirname(options.hookPath), "mcp-cli.js");
  shellPath(mcpPath);
  const mcp = JSON.stringify({
    mcpServers: { swarm: { command: options.nodePath, args: [mcpPath] } },
  });
  // Leave room for Windows argument escaping and the caller's remaining flags.
  if (Buffer.byteLength(serialized) > 8 * 1024)
    throw new Error("Claude additional settings exceed 8 KiB");
  const enrolled = await enrollRuntime({ ...options, host: "claude-code" });
  return {
    ...enrolled,
    environment: {
      ...enrolled.environment,
      SWARM_NATIVE_SESSION_ID: options.hostSessionId,
      SWARM_COORDINATOR_HOOK_OWNER: "launcher",
      SWARM_COORDINATOR_CLIENT: JSON.stringify([options.nodePath, clientPath]),
    },
    arguments: [
      options.resume ? "--resume" : "--session-id",
      options.hostSessionId,
      "--settings",
      serialized,
      "--mcp-config",
      mcp,
    ],
  };
}
