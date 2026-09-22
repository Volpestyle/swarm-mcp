import { afterEach, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../src/coordination/ipc";

const cleanup: Array<() => Promise<void> | void> = [];
let fixtureScript: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  fixtureScript = join(mkdtempSync(resolve("dist/test/ipc-")), "service.mjs");
  await build({
    entryPoints: ["test/fixtures/coordination-service.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: fixtureScript,
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function spawn(mode?: string) {
  const path = join(
    mkdtempSync(join(tmpdir(), "coordination-ipc-")),
    "coordination.db",
  );
  const child = Bun.spawn({
    cmd: [Bun.which("node")!, fixtureScript, path, ...(mode ? [mode] : [])],
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(async () => {
    child.kill();
    await child.exited;
  });
  return child;
}
async function fixture() {
  const child = spawn();
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!value) throw new Error(await new Response(child.stderr).text());
  const { endpoint } = JSON.parse(new TextDecoder().decode(value));
  const connect = async (capability = "alice-secret") => {
    const client = await CoordinationClient.connect(endpoint, capability);
    cleanup.push(() => client.close());
    return client;
  };
  return { client: await connect(), connect };
}
const command = {
  id: "ipc-create",
  type: "task.create" as const,
  payload: { title: "work over local IPC" },
};

test("Bun client command and replay use the Node owner's durable core", async () => {
  const { client } = await fixture();
  const created = (await client.request({ op: "command", command })) as {
    value: { task: { id: string } };
    cursor: number;
    replayed: boolean;
  };
  expect(await client.request({ op: "command", command })).toEqual({
    ...created,
    replayed: true,
  });
  const snapshot = (await client.request({
    op: "task",
    taskId: created.value.task.id,
  })) as { title: string };
  expect(snapshot.title).toBe(command.payload.title);
});

test("held event wait wakes after a committed relevant event", async () => {
  const { client, connect } = await fixture();
  const waiting = client.request({ op: "watch", cursor: 0, timeoutMs: 2000 });
  const bob = await connect("bob-secret");
  await bob.request({
    op: "command",
    command: { ...command, id: "unrelated" },
  });
  await client.request({ op: "command", command });
  const result = (await waiting) as {
    items: Array<{ scope: string; type: string }>;
  };
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    scope: "test",
    type: "task.created",
  });
});

test("capability binds actor and scope; invalid capability cannot mutate", async () => {
  const { client, connect } = await fixture();
  const invalid = await connect("invalid");
  const rejected = await invalid
    .request({ op: "command", command })
    .catch((error) => error);
  expect(rejected).toMatchObject({
    code: "unauthorized",
    message: "Invalid capability",
  });
  const created = (await client.request({ op: "command", command })) as {
    value: { task: { id: string } };
  };
  const bob = await connect("bob-secret");
  expect(
    await bob.request({ op: "task", taskId: created.value.task.id }),
  ).toBeNull();
  expect(await bob.request({ op: "events", cursor: 0 })).toEqual({
    items: [],
    cursor: 0,
  });
});

test("disconnect rejects pending wait and reconnect replays committed events", async () => {
  const { client, connect } = await fixture();
  const pending = client
    .request({ op: "watch", cursor: 0, timeoutMs: 30000 })
    .catch((error) => error);
  client.close();
  expect(await pending).toMatchObject({ code: "disconnected" });
  const reconnect = await connect();
  await reconnect.request({ op: "command", command });
  const events = (await reconnect.request({ op: "events", cursor: 0 })) as {
    items: unknown[];
  };
  expect(events.items).toHaveLength(1);
});

test("Node owner rejects a duplicate named-pipe service without crashing", async () => {
  const child = spawn("duplicate");
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual({ code: "EADDRINUSE" });
});

test("Node client uses the same command interface", async () => {
  const child = spawn("roundtrip");
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toMatchObject({
    value: { task: { title: "Node client" } },
    replayed: false,
  });
});
