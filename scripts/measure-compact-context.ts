import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { processMemory } from "./fixtures/process-memory";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient } from "../src/coordination/ipc";

// Actual Node owner and stdio adapters; enrollment happens outside model calls.
const count = Number(process.argv[2]);
const output = process.argv[3];
if (![2, 8, 32].includes(count) || !output)
  throw new Error(
    "Usage: bun scripts/measure-compact-context.ts 2|8|32 output.json",
  );
mkdirSync(resolve("dist/test"), { recursive: true });
const bundle = mkdtempSync(resolve("dist/test/context-"));
await build({
  entryPoints: [
    "scripts/fixtures/context-owner.ts",
    "src/coordination/mcp-cli.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outdir: bundle,
  outbase: ".",
});
const fixture = mkdtempSync(join(tmpdir(), "swarm-compact-context-"));
const owner = Bun.spawn({
  cmd: [
    Bun.which("node")!,
    join(bundle, "scripts/fixtures/context-owner.js"),
    join(fixture, "db"),
    String(count),
  ],
  stdout: "pipe",
  stderr: "pipe",
});
const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
const transcript: Array<Record<string, unknown>> = [];
try {
  const reader = owner.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(await new Response(owner.stderr).text());
    line += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  const { endpoint, capabilities } = JSON.parse(line);
  for (const capability of capabilities) {
    const client = new Client({
      name: "compact-context-measurement",
      version: "1",
    });
    clients.push(client);
    const transport = new StdioClientTransport({
        command: Bun.which("node")!,
        args: [join(bundle, "src/coordination/mcp-cli.js")],
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          SWARM_COORDINATOR_ENDPOINT: endpoint,
          SWARM_SESSION_CAPABILITY: capability,
        },
      });
    transports.push(transport);
    await client.connect(transport);
  }
  const toolSchema = await clients[0]!.listTools();
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
    return (result.structuredContent as any).data;
  };
  for (let agent = 0; agent < count; agent++)
    await call(agent, "swarm_sync", {});
  for (let agent = 0; agent < count; agent++)
    await call(agent, "swarm_send", {
      commandId: `send-${agent}`,
      recipient: `agent-${(agent + 1) % count}`,
      kind: "question",
      threadId: `thread-${agent}`,
      body: `fixture handoff ${agent}: inspect the assigned module and return evidence`,
    });
  for (let agent = 0; agent < count; agent++) {
    const receipt = await call(agent, "swarm_inbox", {
      commandId: `fetch-${agent}`,
      action: "fetch",
      consumer: "measurement",
    });
    assert.ok(
      JSON.stringify(receipt).includes(
        `fixture handoff ${(agent + count - 1) % count}:`,
      ),
      "Peer message missing",
    );
    const delivery = receipt.value.deliveries[0];
    await call(agent, "swarm_inbox", {
      commandId: `ack-${agent}`,
      action: "ack",
      messageId: delivery.message.id,
      leaseToken: delivery.leaseToken,
    });
  }
  // Separate from the handoff transcript: exercise a resumed model sync while
  // another actor generates real task/lease traffic through the owner.
  const beforeNoise = await clients[0]!.callTool({ name: "swarm_sync", arguments: {} });
  assert.notEqual(beforeNoise.isError, true);
  const cursor = (beforeNoise.structuredContent as any).data.eventCursor;
  const worker = await CoordinationClient.connect(endpoint, capabilities[1]);
  try {
    const created: any = await worker.request({ op: "command", command: { id: "noise-create", type: "task.create", payload: { title: "Unrelated work" } } });
    const owned: any = await worker.request({ op: "command", command: { id: "noise-claim", type: "task.claim", payload: { taskId: created.value.task.id, expectedVersion: 1 } } });
    for (let i = 0; i < 40; i++) await worker.request({ op: "command", command: { id: `noise-${i}`, type: "task.renew", payload: {
      taskId: created.value.task.id, attemptId: owned.value.attemptId, fence: owned.value.fence,
    } } });
  } finally { worker.close(); }
  const deltaResult = await clients[0]!.callTool({ name: "swarm_sync", arguments: { cursor } });
  assert.notEqual(deltaResult.isError, true);
  assert.deepEqual((deltaResult.structuredContent as any).data.items, []);
  assert.ok((deltaResult.structuredContent as any).data.cursor > cursor);
  await delay(2000);
  const memory = processMemory([...transports.map(transport => transport.pid!), owner.pid]);
  writeFileSync(
    output,
    JSON.stringify(
      {
        count,
        fixture,
        server: clients[0]!.getServerVersion(),
        instructions: clients[0]!.getInstructions(),
        toolSchema,
        toolCalls: transcript.length,
        transcript,
        deltaCheck: { before: cursor, result: deltaResult, unrelatedRenewals: 40 },
        memory,
        memoryRoles: { owner: owner.pid, adapters: transports.map(transport => transport.pid) },
        limitations:
          "Real stdio catalog/bootstrap/send/fetch/ack. Trusted enrollment excluded from model calls. Explicit processing acknowledgment adds a call compared with legacy poll; no claim of reduced handoff calls. No inference or hidden host framing measured. Text results counted once; hosts may additionally include structuredContent.",
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  owner.kill();
  await owner.exited;
}
