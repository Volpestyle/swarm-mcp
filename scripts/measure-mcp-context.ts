import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { processMemory } from "./fixtures/process-memory";
import { setTimeout as delay } from "node:timers/promises";

// Real stdio MCP calls against disposable servers. No model invocation or host billing claim.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
const count = Number(process.argv[2]);
if (![2, 8, 32].includes(count)) throw new Error("Expected 2, 8 or 32 agents");
const fixture = mkdtempSync(join(tmpdir(), "swarm-mcp-context-"));
const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
const ids: string[] = [];
const transcript: Array<{
  agent: number;
  name: string;
  arguments: unknown;
  result: unknown;
  elapsedMs: number;
}> = [];
let schema: unknown;
const call = async (
  agent: number,
  name: string,
  args: Record<string, unknown>,
) => {
  const start = performance.now();
  const result = await clients[agent]!.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  transcript.push({
    agent,
    name,
    arguments: args,
    result,
    elapsedMs: performance.now() - start,
  });
  return result;
};
const text = (result: any) =>
  result.content
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text);
try {
  for (let agent = 0; agent < count; agent++) {
    const client = new Client({
      name: "baseline-context-measurement",
      version: "1",
    });
    clients.push(client);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", resolve("src/index.ts")],
        cwd: process.cwd(),
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          SWARM_DB_PATH: join(fixture, "swarm.db"),
          AGENT_IDENTITY: "benchmark",
        },
      });
    transports.push(transport);
    await client.connect(transport);
    if (agent === 0) schema = await client.listTools();
    const result = await call(agent, "register", {
      directory: fixture,
      scope: fixture,
      label: `identity:benchmark role:implementer agent:${agent}`,
    });
    ids.push(JSON.parse(text(result)[0]!).id);
  }
  for (let agent = 0; agent < count; agent++)
    await call(agent, "bootstrap", {});
  for (let agent = 0; agent < count; agent++)
    await call(agent, "send_message", {
      recipient: ids[(agent + 1) % count],
      content: `fixture handoff ${agent}: inspect the assigned module and return evidence`,
    });
  for (let agent = 0; agent < count; agent++) {
    const result = await call(agent, "poll_messages", {});
    assert.ok(
      JSON.stringify(result).includes(
        `fixture handoff ${(agent + count - 1) % count}:`,
      ),
      "Peer message missing",
    );
  }
  await delay(2000);
  const memory = processMemory(transports.map(transport => transport.pid!));
  console.log(
    JSON.stringify(
      {
        count,
        fixture,
        server: clients[0]!.getServerVersion(),
        toolSchema: schema,
        toolCalls: transcript.length,
        transcript,
        memory,
        limitations:
          "Real stdio discovery/register/bootstrap/send/poll. Count tool-call arguments and textual results with a named tokenizer; schemas may be loaded once per agent or deferred by the host. Excludes hidden host prompt framing, reasoning tokens, model inference and native host delivery integration.",
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}
