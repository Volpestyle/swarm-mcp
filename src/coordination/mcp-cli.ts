import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CoordinationClient } from "./ipc";
import { CoordinationError } from "./errors";
import { createCoordinatorMcp, notifyCoordinatorResource } from "./mcp";
import { changedResources } from "./notifications";
import type { Event } from "./store";

async function main() {
  const endpoint = process.env.SWARM_COORDINATOR_ENDPOINT;
  const capability = process.env.SWARM_SESSION_CAPABILITY;
  if (!endpoint || !capability)
    throw new Error("Coordinator endpoint and session capability are required");
  const client = await CoordinationClient.connect(endpoint, capability);
  const bootstrap = (await client.request({ op: "bootstrap" })) as {
    eventCursor: number;
    actor: string;
  };
  const observer = await CoordinationClient.connect(endpoint, capability);
  const waits = new Set<CoordinationClient>();
  let closing = false,
    activeWaits = 0;
  const server = createCoordinatorMcp(async (operation, signal) => {
    if (closing)
      throw new CoordinationError("disconnected", "Adapter is closing");
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
  const close = () => {
    if (closing) return;
    closing = true;
    client.close();
    observer.close();
    for (const waiter of waits) waiter.close();
    void handle.close();
  };
  server.server.onclose = close;
  process.stdin.once("end", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
main().catch((error) => {
  console.error("swarm coordinator MCP:", error.message);
  process.exitCode = 1;
});
