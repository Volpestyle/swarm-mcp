import { afterEach, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
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
async function fixture(mode?: string) {
  const child = spawn(mode);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!value) throw new Error(await new Response(child.stderr).text());
  const {
    endpoint,
    capability: sessionCapability,
    worktreeRoot,
  } = JSON.parse(new TextDecoder().decode(value));
  const connect = async (capability = sessionCapability ?? "alice-secret") => {
    const client = await CoordinationClient.connect(endpoint, capability);
    cleanup.push(() => client.close());
    return client;
  };
  return {
    client: await connect(),
    connect,
    worktreeRoot: worktreeRoot as string,
  };
}
const command = {
  id: "ipc-create",
  type: "task.create" as const,
  payload: { title: "work over local IPC" },
};

test("artifact bytes, evidence links and shared context round trip through the owner", async () => {
  const { client, worktreeRoot } = await fixture("sessions");
  const path = join(worktreeRoot, "evidence.txt");
  writeFileSync(path, "verified IPC evidence");
  const captured = (await client.request({
    op: "artifact_import",
    input: {
      id: "import",
      path: "evidence.txt",
      summary: "IPC verification",
      mediaType: "text/plain",
    },
  })) as { value: { artifactId: string } };
  unlinkSync(path);
  const read = (await client.request({
    op: "artifact_read",
    artifactId: captured.value.artifactId,
  })) as { status: string; data: string };
  expect(read.status).toBe("available");
  expect(Buffer.from(read.data, "base64").toString()).toBe(
    "verified IPC evidence",
  );
  await client.request({
    op: "command",
    command: {
      id: "finding",
      type: "finding.record",
      payload: {
        kind: "decision",
        summary: "Verified transport",
        revision: "a".repeat(40),
        files: [],
        verification: "IPC roundtrip",
        artifactIds: [captured.value.artifactId],
      },
    },
  });
  const findings = (await client.request({
    op: "findings",
    filter: { kind: "decision" },
  })) as { items: Array<{ artifacts: Array<{ status: string }> }> };
  expect(findings.items[0]!.artifacts[0]!.status).toBe("available");
  await client.request({
    op: "command",
    command: {
      id: "set",
      type: "kv.set",
      payload: {
        key: "evidence",
        value: { artifactId: captured.value.artifactId },
        expectedVersion: 0,
      },
    },
  });
  expect(await client.request({ op: "kv", key: "evidence" })).toMatchObject({
    version: 1,
    value: { artifactId: captured.value.artifactId },
  });
});

test("session capability fences task ownership over IPC after suspension", async () => {
  const { client } = await fixture("sessions");
  const created = (await client.request({ op: "command", command })) as {
    value: { task: { id: string; version: number } };
  };
  const task = created.value.task;
  const claimed = (await client.request({
    op: "command",
    command: {
      id: "claim",
      type: "task.claim",
      payload: { taskId: task.id, expectedVersion: task.version },
    },
  })) as { value: { attemptId: string; fence: number } };
  const attempts = (await client.request({
    op: "attempts",
    taskId: task.id,
  })) as Array<{ state: string }>;
  expect(attempts[0]!.state).toBe("running");
  await client.request({
    op: "command",
    command: { id: "suspend", type: "session.suspend", payload: {} },
  });
  const error = await client
    .request({
      op: "command",
      command: {
        id: "late",
        type: "task.finish",
        payload: { taskId: task.id, ...claimed.value, outcome: "completed" },
      },
    })
    .catch((error) => error);
  expect(error).toHaveProperty("code", "stale_session");
});

test("inbox leases and acknowledgments round trip through the authenticated owner", async () => {
  const { client } = await fixture();
  await client.request({
    op: "command",
    command: {
      id: "send",
      type: "message.send",
      payload: { recipient: "alice", kind: "notice", body: "hello" },
    },
  });
  const result = (await client.request({
    op: "command",
    command: { id: "fetch", type: "inbox.fetch", payload: { consumer: "ipc" } },
  })) as {
    value: {
      deliveries: Array<{ message: { id: string }; leaseToken: string }>;
    };
  };
  const item = result.value.deliveries[0]!;
  await client.request({
    op: "command",
    command: {
      id: "ack",
      type: "inbox.ack",
      payload: { messageId: item.message.id, leaseToken: item.leaseToken },
    },
  });
  const status = (await client.request({
    op: "message_status",
    messageId: item.message.id,
  })) as { deliveries: Array<{ state: string }> };
  expect(status.deliveries[0]!.state).toBe("acknowledged");
  const inbox = (await client.request({ op: "inbox" })) as {
    items: Array<{ state: string }>;
  };
  expect(inbox.items[0]!.state).toBe("acknowledged");
});

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
