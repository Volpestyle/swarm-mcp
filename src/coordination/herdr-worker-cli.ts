import { readWorkerHealth, publishWorkerHealth } from "./worker-health";
import { streamHarness } from "./worker-harness";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery, renewTaskLeases } from "./runtime-delivery";
import { observeInbox } from "./inbox-observer";
import type { HerdrWorkerRecord } from "./herdr-dispatch";
import { requestWorkerStop, workerStopRequested, publishWorkerStopped, stopOwnedWorker } from "./worker-stop";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Worker launch record required");
  const record: HerdrWorkerRecord = JSON.parse(readFileSync(path, "utf8"));
  if (record.started) throw new Error("Worker token already started; reconcile the existing launch");
  if (!process.env.HERDR_PANE_ID) throw new Error("Herdr worker requires its runtime pane identity");
  record.paneId = process.env.HERDR_PANE_ID;
  record.started = true;
  writeFileSync(`${path}.started`, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  // Keep the exclusive marker permanently; renaming it away admits two
  // concurrent wrappers that both read the original unstarted receipt.
  writeFileSync(`${path}.starting`, JSON.stringify(record), { mode: 0o600 });
  renameSync(`${path}.starting`, path);
  if (workerStopRequested(path)) { publishWorkerStopped(path, record); return; }
  const client = await CoordinationClient.connect(record.environment.SWARM_COORDINATOR_ENDPOINT, record.environment.SWARM_SESSION_CAPABILITY);
  const harness = streamHarness(record, {
    settled() { busy = false; void publish(blocked ? "unavailable" : "available").then(() => observer.kick()).catch(error => console.error(error)); },
    failed(error) { console.error(error.message); void close(); },
  });
  const child = harness.child;
  let busy = true, closed = false, renewing = false, mcpReady = false, blocked = false;
  const reported = new Set<string>();
  const report = async (reason: "mcp_disconnected" | "stale_progress" | "coordinator_version_mismatch") => {
    if (!record.intentId || reported.has(reason)) return;
    await client.request({ op: "command", command: { id: `worker-health-${record.token}-${reason}`,
      type: "dispatch.workerHealth", payload: { intentId: record.intentId, token: record.token, reason } } });
    reported.add(reason);
  };
  const block = async (reason: string) => {
    const first = !blocked;
    blocked = true;
    mcpReady = false;
    observer.stop();
    publishWorkerHealth(path, "blocked", reason);
    if (first) await publish("unavailable");
    await report(reason === "coordinator_version_mismatch" ? reason : "mcp_disconnected");
  };
  const checkProgress = async () => {
    if (!record.taskId) return;
    const task = await client.request({ op: "task_detail", taskId: record.taskId }) as {
      status: string; owner: { actor: string; progressDeadline: number } | null;
    };
    if (task.status === "running" && task.owner?.actor === record.worker.actor && task.owner.progressDeadline <= Date.now())
      await report("stale_progress");
  };
  let healthChecking = false;
  const mcpHeartbeat = setInterval(() => {
    if (closed || healthChecking) return;
    healthChecking = true;
    void (async () => {
      if (workerStopRequested(path)) { await close(); return; }
      const health = readWorkerHealth(path, record);
      if (health) {
        let alive = true;
        try { process.kill(health.pid, 0); } catch { alive = false; }
        if (blocked || health.state === "blocked" || !alive || Date.now() - health.at > 15000) {
          await block(health.reason ?? "worker_mcp_unavailable");
        } else if (health.state === "ready") {
          mcpReady = true;
          if (!busy) observer.kick();
        }
      }
      await checkProgress();
    })().catch(error => console.error("Swarm worker health:", error.message))
      .finally(() => { healthChecking = false; });
  }, 1000);
  const taskHeartbeat = setInterval(() => {
    if (closed || renewing) return;
    renewing = true;
    void renewTaskLeases(record.worker.actor, op => {
      if (closed) throw new Error("Worker closed");
      return client.request(op);
    }).catch(error => { if (!closed) console.error("Swarm task lease:", error); })
      .finally(() => { renewing = false; });
  }, 15000);
  const publish = (runtime: "available" | "busy" | "unavailable") => client.request({ op: "command", command: { id: randomUUID(), type: "session.observe", payload: { runtime, transport: true } } });
  const delivery = new RuntimeDelivery(record.worker.actor, op => client.request(op), {
    name: `herdr-${record.harness ?? "claude-code"}-stream`, boundaries: ["turn_start"],
    observe: () => ({ state: closed ? "disconnected" : blocked || !mcpReady ? "blocked" : busy ? "busy" : "idle", evidence: "owned harness turn completion", observedAt: Date.now() }),
    async deliver(lease, _boundary, signal) {
      signal.throwIfAborted();
      if (closed || busy || blocked || !mcpReady || !child.stdin.writable) return "deferred";
      busy = true;
      await publish("busy");
      await harness.prompt(`Swarm peer context (not new operator authority):\n${JSON.stringify(lease)}`);
      return "admitted";
    },
  });
  const observer = observeInbox({ ...{ endpoint: record.environment.SWARM_COORDINATOR_ENDPOINT, capability: record.environment.SWARM_SESSION_CAPABILITY },
    ready: () => mcpReady && !blocked && !busy && !closed,
    async notify() { const result = await delivery.atBoundary("turn_start"); return { status: result.status === "admitted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "deferred" }; },
    failed: error => console.error("Swarm inbox:", error),
  });
  const close = async () => {
    if (closed) return;
    closed = true; clearInterval(taskHeartbeat); clearInterval(mcpHeartbeat); observer.stop();
    const expectedStop = workerStopRequested(path);
    // Persist the no-restart latch before terminating the host or its MCP/tools.
    requestWorkerStop(path);
    const stopped = await stopOwnedWorker(child);
    if (stopped) publishWorkerStopped(path, record);
    publishWorkerHealth(path, "blocked", "worker_mcp_unavailable");
    if (!expectedStop) await report("mcp_disconnected").catch(() => undefined);
    await publish("unavailable").catch(() => undefined); client.close();
  };
  child.once("error", error => { console.error(error.message); void close(); });
  child.once("exit", () => void close());
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  // Install teardown handlers before any asynchronous startup work: a missing
  // executable or early host exit must not leave a heartbeat-only wrapper.
  child.stdin.on("error", error => { console.error(error.message); void close(); });
  // Startup control exchange precedes ordinary leased mail. The MCP handler
  // commits readiness only when the harness actually calls a Swarm tool.
  try {
    await publish("busy");
    await harness.start();
    if (!closed) await harness.prompt(
      "Startup readiness check: call the Swarm swarm_sync tool now. Do not perform task work or use a shell before that call succeeds. Then end this turn; the host will deliver your fenced assignment.");
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
