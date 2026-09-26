import { readFileSync } from "node:fs";
import type { HerdrWorkerRecord } from "./herdr-dispatch";
import { publishWorkerHealth, workerFailure } from "./worker-health";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CoordinationClient } from "./ipc";
import { CoordinationError } from "./errors";
import { createCoordinatorMcp, notifyCoordinatorResource } from "./mcp";
import { changedResources } from "./notifications";
import type { Event } from "./store";
import { assertCompatibleOwner, inspectSkill } from "./compatibility";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log("Usage: swarm-mcp\nServe the Swarm MCP API using SWARM_COORDINATOR_ENDPOINT and SWARM_SESSION_CAPABILITY supplied by a trusted runtime launcher.");
    return;
  }
  if (args.length) throw new Error("Usage: swarm-mcp (no subcommands); use a trusted runtime launcher for enrollment and swarm-coordinator-migrate for offline migration");
  const endpoint = process.env.SWARM_COORDINATOR_ENDPOINT;
  const capability = process.env.SWARM_SESSION_CAPABILITY;
  if (!endpoint || !capability)
    throw new Error("Coordinator endpoint and session capability are required");
  inspectSkill(process.env.SWARM_SKILL_PATH);
  const client = await CoordinationClient.connect(endpoint, capability);
  let bootstrap: {
    eventCursor: number;
    actor: string;
  };
  try {
    const state = await client.request({ op: "bootstrap" }) as typeof bootstrap & { compatibility?: unknown };
    assertCompatibleOwner(state.compatibility);
    bootstrap = state;
  } catch (error) { client.close(); throw error; }
  const observer = await CoordinationClient.connect(endpoint, capability);
  const waits = new Set<CoordinationClient>();
  let closing = false,
    activeWaits = 0;
  const launchPath = process.env.SWARM_WORKER_LAUNCH;
  const launch: HerdrWorkerRecord | undefined = launchPath ? JSON.parse(readFileSync(launchPath, "utf8")) : undefined;
  let readiness: Promise<unknown> | undefined;
  let ready = false;
  let checkingHealth = false;
  publishWorkerHealth(launchPath, "connected");
  const heartbeat = setInterval(() => {
    if (closing || checkingHealth || !launch) return;
    checkingHealth = true;
    void client.request({ op: "bootstrap" }).then(state => {
      assertCompatibleOwner((state as { compatibility?: unknown }).compatibility);
      publishWorkerHealth(launchPath, ready ? "ready" : "connected");
    }).catch(error => {
      publishWorkerHealth(launchPath, "blocked", workerFailure(error));
      close(workerFailure(error));
    }).finally(() => { checkingHealth = false; });
  }, 5000);
  heartbeat.unref();
  const server = createCoordinatorMcp(async (operation, signal) => {
    if (closing)
      throw new CoordinationError("disconnected", "Adapter is closing");
    // Only a request received from the actual harness MCP transport can commit
    // this claim. Bootstrap/heartbeat and the independent wrapper cannot do it.
    if (launch && !ready) {
      readiness ??= client.request({ op: "command", command: {
        id: `worker-ready-${launch.token}`, type: "dispatch.workerReady",
        payload: { intentId: launch.intentId!, token: launch.token, externalId: launch.paneId! },
      } }).then(result => {
        ready = true;
        publishWorkerHealth(launchPath, "ready");
        return result;
      }).catch(error => { readiness = undefined; close("worker_claim_failed"); throw error; });
      await readiness;
    }
    if (operation.op !== "watch" && operation.op !== "task_wait")
      return client.request(operation);
    if (activeWaits >= 8)
      throw new CoordinationError(
        "overloaded",
        "At most eight waits may be active",
      );
    activeWaits++;
    let waiter: CoordinationClient | undefined;
    const abort = () => waiter?.close();
    try {
      waiter = await CoordinationClient.connect(endpoint, capability);
      waits.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (closing || signal?.aborted)
        throw new CoordinationError(
          "interrupted",
          "Wait interrupted; resume using the same task ID or event cursor",
        );
      return await waiter.request(operation);
    } finally {
      signal?.removeEventListener("abort", abort);
      waiter?.close();
      if (waiter) waits.delete(waiter);
      activeWaits--;
    }
  });
  let observing = false;
  const observe = async () => {
    let cursor = bootstrap.eventCursor;
    while (!closing) {
      const page = (await observer.request({
        op: "watch",
        cursor,
        timeoutMs: 30000,
      })) as { items: Event[]; cursor: number };
      if (closing) return;
      for (const uri of changedResources(page.items, bootstrap.actor))
        await notifyCoordinatorResource(server, uri);
      cursor = page.cursor;
    }
  };
  const handle = serveStdio(
    () => {
      if (!observing) {
        observing = true;
        setTimeout(() => {
          void observe().catch((error) => {
            if (!closing) {
              console.error("swarm event observer:", error.message);
              close();
            }
          });
        }, 0);
      }
      return server;
    },
    {
      legacy: "serve",
      maxSubscriptions: 16,
    },
  );
  const close = (reason = "worker_mcp_unavailable") => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    publishWorkerHealth(launchPath, "blocked", reason);
    client.close();
    observer.close();
    for (const waiter of waits) waiter.close();
    void handle.close();
  };
  server.server.onclose = () => close();
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
main().catch((error) => {
  try { publishWorkerHealth(process.env.SWARM_WORKER_LAUNCH, "blocked", workerFailure(error)); } catch {}
  console.error("swarm coordinator MCP:", error.message);
  process.exitCode = 1;
});
