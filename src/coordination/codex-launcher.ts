import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { enrollRuntime } from "./runtime-launcher";
export { CodexLifecycle } from "./codex-lifecycle";

type HostCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<any>;

/** Trusted app-server owner only. Serialize lifecycle operations for this native
 * thread. This resumes an existing, unloaded thread; peer delivery cannot create
 * a thread or change host approval/sandbox settings through this helper.
 * After an uncertain resume, inspect the host outcome before retrying. Reuse
 * the incarnation only if the thread is still unloaded; never rotate blindly.
 */
export async function resumeCodexThread(
  options: Omit<Parameters<typeof enrollRuntime>[0], "host"> & {
    mcpPath: string;
  },
  call: HostCall,
) {
  const threadId = options.hostSessionId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId))
    throw new Error("Codex native thread ID must be a UUID");
  for (const path of [options.nodePath, options.mcpPath])
    if (!isAbsolute(path) || !statSync(path).isFile())
      throw new Error(
        "Codex launcher requires absolute executable and MCP paths",
      );
  const normalize = (path: string) => {
    const real = realpathSync(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const snapshot = await call("thread/read", { threadId });
  if (
    snapshot.thread.id !== threadId ||
    normalize(snapshot.thread.cwd) !== normalize(options.identity.directory)
  )
    throw new Error(
      "Codex native thread does not match the configured workspace",
    );
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 32)
      throw new Error("Codex loaded-thread inventory exceeded its bound");
    const loaded = await call("thread/loaded/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (loaded.data.includes(threadId))
      throw new Error(
        "Codex thread is already loaded; refusing to rotate its actor binding",
      );
    if (!loaded.nextCursor) break;
    cursor = loaded.nextCursor;
    if (seen.has(cursor!))
      throw new Error("Codex loaded-thread cursor repeated");
    seen.add(cursor!);
  }
  const enrolled = await enrollRuntime({ ...options, host: "codex" });
  const resumed = await call("thread/resume", {
    threadId,
    config: {
      "mcp_servers.swarm": {
        command: options.nodePath,
        args: [options.mcpPath],
        env: enrolled.environment,
        enabled: true,
      },
    },
  });
  if (resumed.thread.id !== threadId)
    throw new Error("Codex resumed an unexpected native thread");
  const sync = await call("mcpServer/tool/call", {
    threadId,
    server: "swarm",
    tool: "swarm_sync",
    arguments: {},
  });
  if (sync.isError || sync.structuredContent?.data?.actor !== enrolled.actor)
    throw new Error("Codex resumed without the expected coordinator actor");
  return { ...enrolled, threadId };
}
