import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { DispatchProvider, ProvisionedWorker } from "./dispatch-runner";
import type { SessionContext } from "./sessions";
import type { CoordinationStore } from "./store";
import { prepareClaudeLaunch } from "./claude-launcher";

const exec = promisify(execFile);
export interface HerdrRoute {
  id: string;
  enabled?: boolean;
  stateDirectory: string;
  profile: string;
  socketPath: string;
  herdrPath: string;
  nodePath: string;
  workerPath: string;
  claudePath: string;
  capabilities: string[];
  capacity: number;
  mcpServers?: Parameters<typeof prepareClaudeLaunch>[0]["mcpServers"];
}
export interface HerdrWorkerRecord {
  token: string;
  routeFingerprint?: string;
  paneId?: string;
  worker: ProvisionedWorker["worker"];
  command: string;
  args: string[];
  environment: Record<string, string>;
  cwd: string;
  started?: boolean;
}
// Herdr serves one newline-framed response per connection.
async function applyLayout(socketPath: string, params: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: socketPath, signal });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id, method: "layout.apply", params }) + "\n"));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Herdr closed before a layout response; launch may be uncertain")));
    socket.on("data", chunk => {
      buffer += chunk;
      try {
        if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("Herdr layout response exceeds 1 MiB");
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply.id !== id || !reply.result) throw new Error(reply.error?.message ?? "Invalid Herdr layout response");
        resolve();
      } catch (error) { reject(error); }
      socket.destroy();
    });
  });
}

/** One persisted token owns one pane launch. Missing results never authorize a retry. */
export function herdrDispatchProvider(store: CoordinationStore, requester: SessionContext, route: HerdrRoute): DispatchProvider {
  // Runtime paths are authority: a renamed/retargeted route cannot adopt an old pane.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    route.id, route.socketPath, route.stateDirectory, route.profile, route.herdrPath,
    route.nodePath, route.workerPath, route.claudePath,
  ])).digest("hex");
  const path = (token: string) => {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid provisioning token");
    return join(route.stateDirectory, `herdr-${token}.json`);
  };
  const run = async (args: string[], signal: AbortSignal) => { const { stdout } = await exec(route.herdrPath, args, {
    env: { ...process.env, HERDR_SOCKET_PATH: route.socketPath }, signal, timeout: 30000,
  }); return stdout.trim() ? JSON.parse(stdout) : undefined; };
  const read = async (token: string): Promise<HerdrWorkerRecord | null> => {
    try {
      const record: HerdrWorkerRecord = JSON.parse(await readFile(path(token), "utf8"));
      if (record.routeFingerprint !== fingerprint) throw new Error("Provisioning receipt runtime identity changed or is unverified");
      return record;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const find = async (token: string, signal: AbortSignal) => {
    const record = await read(token);
    if (!record?.paneId || !record.started) return null;
    await run(["pane", "get", record.paneId], signal);
    store.assertContext(record.worker);
    const session = store.session(requester.scope, record.worker.sessionId);
    if (!session || !["available", "busy"].includes(session.runtime_state)) return null;
    return { externalId: record.paneId, worker: record.worker };
  };
  return {
    routeId: route.id,
    authorized: () => { try { store.assertContext(requester); return route.enabled !== false; } catch { return false; } },
    async start({ token }, signal) {
      const worktree = store.worktree(requester);
      const prepared = await prepareClaudeLaunch({
        stateDirectory: route.stateDirectory, nodePath: route.nodePath,
        ownerPath: join(dirname(route.workerPath), "owner-cli.js"),
        hookPath: join(dirname(route.workerPath), "claude-hook-cli.js"),
        identity: { projectRoot: worktree.repository, fileRoot: worktree.root, directory: worktree.root, profile: route.profile },
        skillPath: join(dirname(route.workerPath), "../../skills/swarm-mcp/SKILL.md"),
        mcpServers: route.mcpServers,
        hostSessionId: randomUUID(), incarnation: token, label: "runtime:claude-code transport:herdr",
      });
      if (prepared.scope !== requester.scope) throw new Error("Herdr route profile does not match requester scope");
      const record: HerdrWorkerRecord = {
        token, routeFingerprint: fingerprint, worker: { scope: prepared.scope, actor: prepared.actor, sessionId: prepared.sessionId, generation: prepared.generation },
        command: route.claudePath, args: prepared.arguments, environment: prepared.environment, cwd: worktree.root,
      };
      // Exclusive publication precedes every external side effect.
      await writeFile(path(token), JSON.stringify(record), { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      const created = await run(["workspace", "create", "--cwd", worktree.root, "--label", `swarm-${token.slice(0, 8)}`, "--no-focus"], signal);
      record.paneId = created.result?.root_pane?.pane_id;
      const tabId = created.result?.tab?.tab_id;
      if (!record.paneId || !tabId) throw new Error("Herdr did not return the created pane and tab");
      const temporary = `${path(token)}.next`;
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, path(token));
      signal.throwIfAborted();
      // Replace only our fresh shell tab. Herdr starts argv directly, so shell
      // startup prompts cannot consume the launch. The worker publishes its new
      // pane ID in the receipt, including when the layout response is lost.
      await applyLayout(route.socketPath, { tab_id: tabId, focus: false, root: {
        type: "pane", cwd: worktree.root, command: [route.nodePath, route.workerPath, path(token)],
      } }, signal);
      for (;;) {
        signal.throwIfAborted();
        const running = await find(token, signal);
        if (running) return running;
        await delay(50, undefined, { signal });
      }
    },
    find,
    // Cooperative cancellation uses the existing fenced task outcome. Closing a
    // pane alone cannot prove its descendants stopped, so it never releases capacity.
    async stop(token) {
      const record = await read(token);
      if (!record) return { stopped: false };
      return store.execute({ ...requester, id: randomUUID(), type: "dispatch.peerStopped", payload: { token } },
        tx => tx.dispatch.peerStopped({ token, routeId: route.id, worker: record.worker })).value;
    },
  };
}
