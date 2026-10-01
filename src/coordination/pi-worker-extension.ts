import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Loaded only by an enrolled managed pi worker. The operator's extension is unrelated. */
export default async function workerExtension(pi: {
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown;
    execute(id: string, args: Record<string, unknown>): Promise<unknown> }): void;
  on(event: "session_shutdown", callback: () => Promise<void>): void;
}) {
  if (!process.env.SWARM_WORKER_LAUNCH || !process.env.SWARM_SESSION_CAPABILITY)
    throw new Error("Managed pi extension requires per-session enrollment");
  const servers = JSON.parse(process.env.SWARM_WORKER_MCP_SERVERS ?? "{}") as
    Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  if (!servers.swarm) throw new Error("Managed pi worker requires the Swarm transport");
  const clients: Client[] = [];
  pi.on("session_shutdown", async () => { await Promise.allSettled(clients.map(client => client.close())); });
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
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()));
    throw error;
  }
}
