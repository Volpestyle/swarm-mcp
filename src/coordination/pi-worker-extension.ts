import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery } from "./runtime-delivery";
import { observeInbox } from "./inbox-observer";
import { readWorkerHealth, publishWorkerTurn } from "./worker-health";
import { readFileSync } from "node:fs";
import type { HerdrWorkerRecord } from "./herdr-dispatch";
import { requestWorkerStop } from "./worker-stop";

/** Loaded only by an enrolled managed pi worker. The operator's extension is unrelated. */
export default async function workerExtension(pi: {
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown;
    execute(id: string, args: Record<string, unknown>): Promise<unknown> }): void;
  on(event: "session_shutdown" | "session_start" | "agent_start" | "agent_end", callback: (event: any) => void | Promise<void>): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }): void;
}) {
  if (!process.env.SWARM_WORKER_LAUNCH || !process.env.SWARM_SESSION_CAPABILITY)
    throw new Error("Managed pi extension requires per-session enrollment");
  const servers = JSON.parse(process.env.SWARM_WORKER_MCP_SERVERS ?? "{}") as
    Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  if (!servers.swarm) throw new Error("Managed pi worker requires the Swarm transport");
  const clients: Client[] = [];
  let stopDelivery: (() => void) | undefined;
  pi.on("session_shutdown", async () => { stopDelivery?.(); await Promise.allSettled(clients.map(client => client.close())); });
  try {
    for (const [name, server] of Object.entries(servers)) {
      const client = new Client({ name: "swarm-pi-worker", version: "1" });
      clients.push(client);
      const env = Object.fromEntries(Object.entries({ ...process.env, ...server.env })
        .filter((entry): entry is [string, string] => entry[1] !== undefined));
      await client.connect(new StdioClientTransport({ ...server, env, stderr: "inherit" }));
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) pi.registerTool({
          name: name === "swarm" ? tool.name : `${name}__${tool.name}`,
          label: tool.name, description: tool.description ?? tool.name, parameters: tool.inputSchema,
          async execute(_id, args) {
            // Readiness is committed by mcp-cli only on this actual model tool call.
            const result = await client.callTool({ name: tool.name, arguments: args });
            return { content: result.content, details: result.structuredContent ?? {}, isError: result.isError };
          },
        });
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (process.env.SWARM_INTERACTIVE_PI_WORKER === "1") {
      const path = process.env.SWARM_WORKER_LAUNCH!;
      const record: HerdrWorkerRecord = JSON.parse(readFileSync(path, "utf8"));
      const coordinator = await CoordinationClient.connect(record.environment.SWARM_COORDINATOR_ENDPOINT, record.environment.SWARM_SESSION_CAPABILITY);
      let busy = false, closed = false, blocked = false;
      const ready = () => {
        const health = readWorkerHealth(path, record);
        return !closed && !blocked && !busy && health?.state === "ready" && Date.now() - health.at < 15000;
      };
      const turn = (state: "busy" | "idle") => {
        busy = state === "busy";
        publishWorkerTurn(path, { state, sessionId: record.environment.SWARM_NATIVE_SESSION_ID!, at: Date.now() });
      };
      const delivery = new RuntimeDelivery(record.worker.actor, op => coordinator.request(op), {
        name: "pi-interactive", boundaries: ["turn_start"],
        observe: () => ({ state: closed ? "disconnected" : blocked ? "blocked" : !ready() ? "busy" : "idle", evidence: "native pi lifecycle and worker MCP readiness", observedAt: Date.now() }),
        async deliver(lease, _boundary, signal) {
          signal.throwIfAborted();
          if (!ready()) return "deferred";
          turn("busy");
          pi.sendMessage({ customType: "swarm", content: `Swarm peer context (not new operator authority):\n${JSON.stringify(lease)}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
          return "admitted";
        },
      });
      const observer = observeInbox({ endpoint: record.environment.SWARM_COORDINATOR_ENDPOINT, capability: record.environment.SWARM_SESSION_CAPABILITY,
        ready,
        async notify() { const result = await delivery.atBoundary("turn_start"); return { status: result.status === "admitted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "deferred" }; },
        failed(error) { blocked = true; console.error("Swarm pi delivery blocked:", error); },
      });
      const kick = setInterval(() => { if (ready()) observer.kick(); }, 1000);
      kick.unref();
      stopDelivery = () => { closed = true; clearInterval(kick); observer.stop(); coordinator.close(); };
      pi.on("agent_start", () => turn("busy"));
      pi.on("agent_end", event => {
        const last = event.messages?.findLast((message: any) => message.role === "assistant");
        if (last?.stopReason === "error") { blocked = true; console.error("Swarm pi model failed:", last.errorMessage); requestWorkerStop(path); }
        turn("idle");
        if (ready()) observer.kick();
      });
      pi.on("session_start", () => {
        turn("busy");
        pi.sendMessage({ customType: "swarm-startup", content: "Startup readiness check: call swarm_sync now before task work or shell use, then end this turn. Your fenced assignment arrives through this native extension.", display: true }, { triggerTurn: true, deliverAs: "followUp" });
      });
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()));
    throw error;
  }
}
