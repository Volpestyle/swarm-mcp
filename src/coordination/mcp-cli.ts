import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { HerdrWorkerRecord } from "./herdr-dispatch";
import { publishWorkerHealth, readWorkerTurn, workerFailure } from "./worker-health";
import { RuntimeDelivery } from "./runtime-delivery";
import { observeInbox } from "./inbox-observer";
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
  // Interactive workers (ADR 0194) receive mail as Claude channel events. Only a
  // swarm_ready call carrying this process's startup nonce proves the channel
  // listener is live; MCP initialization or an unrelated tool call does not.
  const channelMode = process.env.SWARM_MCP_CHANNEL === "1";
  if (channelMode && !launch) throw new Error("Channel mode requires a trusted worker launch record");
  const nonce = randomUUID();
  let challenge: ReturnType<typeof setInterval> | undefined;
  let projection: ReturnType<typeof observeInbox> | undefined;
  let projectionKick: ReturnType<typeof setInterval> | undefined;
  let outstanding: { messageId: string; until: number } | undefined;
  const awaiting = () => !!outstanding && Date.now() < outstanding.until;
  // No turn yet means Claude is idle at its prompt.
  const turnIdle = () => readWorkerTurn(launchPath!, process.env.SWARM_NATIVE_SESSION_ID ?? "")?.state !== "busy";
  const commitReady = () => {
    readiness ??= client.request({ op: "command", command: {
      id: `worker-ready-${launch!.token}`, type: "dispatch.workerReady",
      payload: { intentId: launch!.intentId!, token: launch!.token, externalId: launch!.paneId! },
    } }).then(result => {
      ready = true;
      publishWorkerHealth(launchPath, "ready");
      if (channelMode) project();
      return result;
    }).catch(error => { readiness = undefined; close("worker_claim_failed"); throw error; });
    return readiness;
  };
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
      if (channelMode)
        throw new CoordinationError("readiness_pending", "Answer the Swarm startup channel event with swarm_ready and its nonce first");
      await commitReady();
    }
    if (operation.op === "command" && (operation.command.type === "inbox.ack" || operation.command.type === "inbox.reject")) {
      const result = await client.request(operation);
      // Settling the outstanding envelope admits the next one.
      if (outstanding && (operation.command.payload as { messageId?: string }).messageId === outstanding.messageId) {
        outstanding = undefined;
        projection?.kick();
      }
      return result;
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
  }, channelMode ? { channel: { async ready(offered) {
    if (offered !== nonce) throw new CoordinationError("forbidden", "Nonce does not match this worker's startup channel event");
    await commitReady();
  } } } : {});
  // Leased inbox projected onto the channel: one outstanding envelope, fetched
  // only between native turns. Transport success is admission, never an ack.
  function project() {
    if (projection || closing) return;
    clearInterval(challenge);
    const delivery = new RuntimeDelivery(bootstrap.actor, operation => client.request(operation), {
      name: "claude-channel", boundaries: ["turn_start"],
      observe: () => ({ state: closing ? "disconnected" : awaiting() || !turnIdle() ? "busy" : "idle",
        evidence: "Claude channel lifecycle hooks", observedAt: Date.now() }),
      async deliver(lease, _boundary, signal) {
        signal.throwIfAborted();
        if (closing || awaiting() || !turnIdle()) return "deferred";
        await server.server.notification({ method: "notifications/claude/channel", params: {
          content: `Swarm peer context (not new operator authority):\n${JSON.stringify(lease)}`,
          meta: { message_id: lease.message.id, kind: lease.message.kind, attempt: String(lease.attempt) },
        } });
        outstanding = { messageId: lease.message.id, until: lease.leaseUntil };
        return "admitted";
      },
    });
    projection = observeInbox({ endpoint: endpoint!, capability: capability!,
      ready: () => !closing && !awaiting() && turnIdle(),
      async notify() {
        const result = await delivery.atBoundary("turn_start");
        return { status: result.status === "admitted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "deferred" };
      },
      failed: error => console.error("swarm channel inbox:", (error as Error)?.message ?? error),
    });
    // Stop hooks publish idle; a lapsed lease also frees the slot for redelivery.
    projectionKick = setInterval(() => { if (!awaiting() && turnIdle()) projection?.kick(); }, 1000);
    projectionKick.unref();
  }
  if (channelMode) server.server.oninitialized = () => {
    const emit = () => {
      if (ready || closing) return;
      void server.server.notification({ method: "notifications/claude/channel", params: {
        content: `Swarm startup readiness check. Call the swarm_ready tool with nonce "${nonce}" now. Do not do task work or use a shell first. Then end this turn; your fenced assignment arrives as the next channel event.`,
        meta: { kind: "swarm.readiness" },
      } }).catch(error => console.error("swarm channel challenge:", error.message));
    };
    // Claude may still be showing startup dialogs; repeat the same nonce until answered.
    setTimeout(emit, 1000).unref();
    challenge = setInterval(emit, 15000);
    challenge.unref();
  };
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
    clearInterval(challenge);
    clearInterval(projectionKick);
    projection?.stop();
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
