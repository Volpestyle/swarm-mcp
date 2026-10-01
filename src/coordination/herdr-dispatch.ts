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
import { canonicalPath, discoverWorktree, executionWorktrees, type ExecutionWorkspace } from "./worktrees";
import { realpathSync, statSync } from "node:fs";
import { prepareManagedLaunch, type ManagedHarness } from "./managed-launcher";
import type { ExecutionMode } from "./routing";

import { CoordinationError } from "./errors";
import { readWorkerHealth } from "./worker-health";
import { requestWorkerStop, workerStopped } from "./worker-stop";

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
  claudePath?: string;
  harness?: ManagedHarness;
  harnessPath?: string;
  model?: string;
  capabilities: string[];
  capacity: number | null;
  readinessTimeoutMs?: number;
  workspaces?: ExecutionWorkspace[];
  mcpServers?: Parameters<typeof prepareManagedLaunch>[0]["mcpServers"];
  /** Owner-selected; omitted means stream. */
  workerMode?: ExecutionMode;
  channelPlugin?: string;
}
export interface HerdrWorkerRecord {
  harness?: ManagedHarness;
  model?: string;
  token: string;
  intentId?: string;
  taskId?: string;
  routeFingerprint?: string;
  paneId?: string;
  worker: ProvisionedWorker["worker"];
  command: string;
  args: string[];
  environment: Record<string, string>;
  cwd: string;
  started?: boolean;
  /** Mode fixed by the intent; legacy receipts without it are stream. */
  mode?: ExecutionMode;
  channelPlugin?: string;
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
    ...(route.harness || route.harnessPath || route.model ? [route.harness ?? "claude-code", route.harnessPath, route.model] : []),
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
    const health = readWorkerHealth(path(token), record);
    if (health?.state === "blocked") throw new CoordinationError(health.reason ?? "worker_mcp_unavailable", "Worker MCP startup/health failed; reconcile the retained launch");
    if (!record.intentId) throw new CoordinationError("worker_claim_failed", "Legacy physical receipt has no worker readiness proof");
    const ready = store.dispatchReady(requester, { intentId: record.intentId, token, worker: record.worker });
    if (!ready.ready) return null;
    if (ready.externalId !== record.paneId) throw new CoordinationError("worker_claim_failed", "Claim pane does not match launch receipt");
    return { externalId: record.paneId, worker: record.worker };

  };
  return {
    routeId: route.id,
    requiresWorkerReady: true,
    readinessTimeoutMs: route.readinessTimeoutMs ?? 60000,
    authorized: () => { try { store.assertContext(requester); return route.enabled !== false; } catch { return false; } },
    authorizedToStop: () => { try { store.assertContext(requester); return true; } catch { return false; } },
    async start({ token, taskId, intent, executionMode = "stream" }, signal) {
      // The intent row fixed the mode at reservation. A route since switched by
      // its owner refuses to launch rather than silently changing transport.
      if (executionMode !== (route.workerMode ?? "stream"))
        throw new CoordinationError("execution_mode_changed",
          `Intent was reserved for ${executionMode} but route ${route.id} is now ${route.workerMode ?? "stream"}; reconcile and dispatch again`);
      const interactive = executionMode === "interactive";
      const parent = store.worktree(requester);
      let directory: string;
      try {
        directory = canonicalPath(realpathSync.native(intent.contract.worktree));
        if (!statSync(directory).isDirectory()) throw new Error("Not a directory");
      } catch { throw new Error("Requested worktree is missing or no longer allowed by the runtime owner"); }
      if (![canonicalPath(parent.root), ...executionWorktrees(route.workspaces ?? []).worktrees].includes(directory))
        throw new Error("Requested worktree is no longer allowed by the runtime owner");
      let repository = directory;
      try { repository = discoverWorktree(directory).repository; } catch { /* Explicit non-git directory. */ }
      const worktree = { root: directory, repository };
      const harness = route.harness ?? "claude-code";
      const command = route.harnessPath ?? (harness === "claude-code" ? route.claudePath : undefined);
      if (!command) throw new CoordinationError("harness_unavailable", "Selected harness has no executable");
      const prepared = await prepareManagedLaunch({
        harness, model: route.model,
        stateDirectory: route.stateDirectory, nodePath: route.nodePath,
        ownerPath: join(dirname(route.workerPath), "owner-cli.js"),
        hookPath: join(dirname(route.workerPath), "claude-hook-cli.js"),
        identity: { projectRoot: parent.repository, repository: worktree.repository, fileRoot: worktree.root, directory: worktree.root, profile: route.profile },
        skillPath: join(dirname(route.workerPath), "../../skills/swarm-mcp/SKILL.md"),
        mcpServers: route.mcpServers,
        ...(interactive && harness === "claude-code" ? { channel: route.channelPlugin ? { plugin: route.channelPlugin } : {} } : {}),
        hostSessionId: randomUUID(), incarnation: token,
        label: `runtime:${harness} transport:herdr mode:${executionMode}`,
      });
      if (prepared.scope !== requester.scope) throw new Error("Herdr route profile does not match requester scope");
      const record: HerdrWorkerRecord = {
        token, intentId: intent.intentId, taskId, routeFingerprint: fingerprint, worker: { scope: prepared.scope, actor: prepared.actor, sessionId: prepared.sessionId, generation: prepared.generation },
        harness, model: route.model ?? (harness === "codex" ? "gpt-6-astra" : undefined), command, args: prepared.arguments, environment: prepared.environment, cwd: worktree.root,
        mode: executionMode, ...(interactive && route.channelPlugin ? { channelPlugin: route.channelPlugin } : {}),
      };
      record.environment.SWARM_WORKER_LAUNCH = path(token);
      if (!interactive) record.environment.SWARM_STREAM_WORKER = "1";
      store.execute({ ...requester, id: randomUUID(), type: "dispatch.expectWorker", payload: { token } },
        tx => tx.dispatch.expectWorker({ intentId: intent.intentId, token, worker: record.worker }));
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
    // A terminal fenced outcome is sufficient cooperative proof. Otherwise the
    // owning wrapper must stop its process group and publish a launch-bound receipt.
    async stop(token, signal) {
      const record = await read(token);
      if (!record) return { stopped: false };
      const cooperative = store.execute({ ...requester, id: randomUUID(), type: "dispatch.peerStopped", payload: { token } },
        tx => tx.dispatch.peerStopped({ token, routeId: route.id, worker: record.worker })).value;
      requestWorkerStop(path(token));
      if (cooperative.stopped) return cooperative;
      while (!workerStopped(path(token), record)) {
        signal.throwIfAborted();
        await delay(50, undefined, { signal });
      }
      return { stopped: true };
    },
  };
}
