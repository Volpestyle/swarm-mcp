import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";
import { CodexLifecycle } from "./codex-lifecycle";
export { CodexLifecycle } from "./codex-lifecycle";
export { codexContextItem, hasCodexContext } from "./codex-context";

const CODEX_HOOK_EVENTS = [
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PostToolUse", "post_tool_use"],
] as const;

/** A drive path that PowerShell, pwsh and cmd all read as one bare word. */
const WINDOWS_BARE_PATH = /^[A-Za-z]:\\[A-Za-z0-9_.~\\-]*$/;

/** The 8.3 alias of an existing Windows path, which has no spaces. */
export function windowsShortPath(path: string) {
  const result = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`],
    { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true },
  );
  if (result.status !== 0) throw new Error("Could not resolve an 8.3 path alias");
  return result.stdout.trim();
}

/** Codex runs hook command lines through the user's shell (PowerShell on a
 * typical Windows install, where a quoted first word is a string, not a
 * command) or `sh -lc` elsewhere. On Windows both paths must therefore be bare
 * words; a path with spaces uses its 8.3 alias. Paths are shell data, never
 * executable interpolation. */
function hookCommand(
  nodePath: string,
  hookPath: string,
  platform: string,
  shorten: (path: string) => string,
) {
  for (const path of [nodePath, hookPath])
    if (!isAbsolute(path) || !statSync(path).isFile())
      throw new Error("Codex hooks require absolute executable and hook paths");
  if (platform === "win32") {
    const bare = [nodePath, hookPath].map((path) =>
      WINDOWS_BARE_PATH.test(path) ? path : shorten(path),
    );
    if (!bare.every((path) => WINDOWS_BARE_PATH.test(path)))
      throw new Error(
        "Codex hook paths need spaces or shell characters and have no 8.3 alias",
      );
    return bare.join(" ");
  }
  const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
  return `${quote(nodePath)} ${quote(hookPath)}`;
}

/** Codex's trust identity for a single unmatched command hook: SHA-256 of the
 * key-sorted compact JSON of its normalized event, group and handler
 * (codex-rs hooks `hook_hash` / config `version_for_toml`). */
export function codexHookTrustHash(
  eventLabel: string,
  command: string,
  timeout: number,
) {
  const identity = JSON.stringify({
    event_name: eventLabel,
    hooks: [{ async: false, command, timeout, type: "command" }],
  });
  return "sha256:" + createHash("sha256").update(identity).digest("hex");
}

/** Session-flag overrides that install the delivery hooks for one Codex
 * process and pre-trust exactly those hooks. Codex trusts a hook by a hash of
 * its normalized identity (sorted JSON of event, matcher and handler); a
 * mismatch shows the hook review screen instead of running it, so a Codex
 * normalization change fails visibly rather than silently. Nothing is written
 * to the user's Codex configuration. */
export function codexHookOverrides(
  nodePath: string,
  hookPath: string,
  platform: string = process.platform,
  shorten: (path: string) => string = windowsShortPath,
) {
  const command = hookCommand(nodePath, hookPath, platform, shorten);
  const timeout = 10;
  const layer =
    platform === "win32"
      ? "C:\\<session-flags>\\config.toml"
      : "/<session-flags>/config.toml";
  const state: Record<string, { trusted_hash: string }> = {};
  const overrides: string[] = [];
  for (const [event, label] of CODEX_HOOK_EVENTS) {
    state[`${layer}:${label}:0:0`] = {
      trusted_hash: codexHookTrustHash(label, command, timeout),
    };
    overrides.push(
      "-c",
      `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`,
    );
  }
  // Keys contain dots, which -c key paths would split, so the whole table
  // travels as one inline-table value.
  const table = Object.entries(state)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}={trusted_hash=${JSON.stringify(value.trusted_hash)}}`,
    )
    .join(",");
  overrides.push("-c", `hooks.state={${table}}`);
  return overrides;
}

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
    const real = realpathSync.native(path);
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
