import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";
import { CodexLifecycle } from "./codex-lifecycle";
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

/** Subscribe before resume so early native lifecycle events cannot be missed.
 * The app-server owner supplies its trusted notification and disconnect source.
 * Dispose this handle before resuming the same native thread again. */
export async function resumeCodexRuntime(
  options: Parameters<typeof resumeCodexThread>[0],
  host: {
    call: HostCall;
    subscribe: (
      notify: (method: string, params: unknown) => void,
      disconnected: () => void,
    ) => () => void;
  },
) {
  let client: CoordinationClient | undefined;
  let lifecycle: CodexLifecycle | undefined;
  let revision = 0;
  let lost = false;
  let failure: unknown;
  const buffered: Array<[string, unknown]> = [];
  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const handled = work
      .catch((error) => {
        failure = error;
      })
      .finally(() => pending.delete(handled));
    pending.add(handled);
  };
  const settle = async () => {
    while (pending.size) await Promise.all([...pending]);
    if (failure) throw failure;
  };
  const unsubscribe = host.subscribe(
    (method, params) => {
      if (
        !params ||
        typeof params !== "object" ||
        (params as { threadId?: unknown }).threadId !== options.hostSessionId ||
        ![
          "thread/status/changed",
          "thread/closed",
          "thread/archived",
          "thread/deleted",
        ].includes(method)
      )
        return;
      revision++;
      if (lifecycle) track(lifecycle.notify(method, params));
      else if (buffered.length < 128) buffered.push([method, params]);
      else failure = new Error("Codex lifecycle buffer exceeded its bound");
    },
    () => {
      lost = true;
      revision++;
      if (lifecycle) track(lifecycle.disconnected());
    },
  );
  try {
    const binding = await resumeCodexThread(options, host.call);
    client = await CoordinationClient.connect(
      binding.environment.SWARM_COORDINATOR_ENDPOINT,
      binding.environment.SWARM_SESSION_CAPABILITY,
    );
    lifecycle = new CodexLifecycle(binding.threadId, (operation) =>
      client!.request(operation),
    );
    for (const [method, params] of buffered)
      track(lifecycle.notify(method, params));
    buffered.length = 0;
    if (lost) throw new Error("Codex transport disconnected during resume");
    const snapshotRevision = revision;
    const snapshot = await host.call("thread/read", {
      threadId: binding.threadId,
    });
    if (snapshot.thread.id !== binding.threadId)
      throw new Error("Codex lifecycle snapshot identity mismatch");
    // A notification arriving during the read is newer than its snapshot.
    if (revision === snapshotRevision)
      track(
        lifecycle.notify("thread/status/changed", {
          threadId: binding.threadId,
          status: snapshot.thread.status,
        }),
      );
    await settle();
    let disposed = false;
    return {
      ...binding,
      lifecycle,
      settle,
      async dispose() {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        try {
          await settle();
          await lifecycle!.disconnected();
        } finally {
          client!.close();
        }
      },
    };
  } catch (error) {
    unsubscribe();
    await Promise.all([...pending]);
    client?.close();
    throw error;
  }
}
