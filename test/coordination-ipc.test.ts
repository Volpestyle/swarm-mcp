import { afterEach, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../src/coordination/ipc";

const cleanup: Array<() => Promise<void> | void> = [];
let fixtureScript: string;
let clientScript: string;
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
  clientScript = fixtureScript.replace("service.mjs", "client.mjs");
  await build({
    entryPoints: ["src/coordination/client-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: clientScript,
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
    endpoint,
    sessionCapability: sessionCapability ?? "alice-secret",
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

test("inspect over IPC is bounded and derives scope from authorization", async () => {
  const { client, endpoint, sessionCapability } = await fixture();
  await client.request({ op: "command", command });
  const report = (await client.request({
    op: "inspect",
    scope: "forged",
    filter: { limit: 1 },
  } as any)) as any;
  expect(report.scope).not.toBe("forged");
  expect(report.protocol.modern).toBe("2026-07-28");
  expect(report.protocol.legacy).toContain("2025-11-25");
  expect(report.tasks.items).toHaveLength(1);
  expect(report.tasks.items[0].status).toBe("open");
  const error = await client
    .request({ op: "inspect", filter: { limit: 21 } })
    .catch((error) => error);
  expect(error).toMatchObject({ code: "invalid_input" });
  const cli = Bun.spawn({
    cmd: [Bun.which("node")!, clientScript, "doctor"],
    env: {
      ...process.env,
      SWARM_COORDINATOR_ENDPOINT: endpoint,
      SWARM_SESSION_CAPABILITY: sessionCapability,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, stderr] = await Promise.all([
    cli.exited,
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output).tasks.items).toHaveLength(1);
});

test("dispatch over authenticated IPC uses owner routes and deduplicates assignment", async () => {
  const { client, worktreeRoot } = await fixture("dispatch");
  const intent = {
    intentId: "ipc-dispatch",
    title: "Work",
    capabilities: ["code"],
    durable: true,
    contract: {
      objective: "Work",
      worktree: worktreeRoot,
      acceptanceCriteria: ["Verified"],
      expectedArtifacts: [],
      constraints: [],
    },
  };
  const request = {
    op: "dispatch" as const,
    input: { action: "assign" as const, intent },
    scope: "forged",
    actor: "forged",
    policy: { maximum: 999, routes: [] },
  };
  const first = (await client.request(request)) as {
    status: string;
    taskId: string;
    attemptId: string;
  };
  expect(first.status).toBe("bound");
  const replay = (await client.request(request)) as typeof first;
  expect(replay.taskId).toBe(first.taskId);
  expect(replay.attemptId).toBe(first.attemptId);
  const attempts = await client.request({
    op: "attempts",
    taskId: first.taskId,
  });
  expect(attempts).toMatchObject([{ actor: "peer" }]);
  expect(
    await client
      .request({
        op: "dispatch",
        input: { action: "assign", intent: { ...intent, title: "Changed" } },
      })
      .catch((error) => error),
  ).toMatchObject({ code: "idempotency_conflict" });
  const blocked = await client.request({
    op: "dispatch",
    input: { action: "assign", intent: { ...intent, intentId: "second" } },
  });
  expect(blocked).toMatchObject({ status: "blocked" });
  const disabled = await fixture("sessions");
  expect(
    await disabled.client
      .request({
        op: "dispatch",
        input: { action: "assign", intent },
      })
      .catch((error) => error),
  ).toMatchObject({ code: "unsupported_runtime" });
});

test("launcher enrollment is separate from agent authority and resume fences old transports", async () => {
  const { client, connect, worktreeRoot } = await fixture("sessions");
  const input = {
    scope: "test",
    agentId: "bob",
    requestId: "launch-bob",
    resumeToken: "fixture-resume-secret-at-least-32-characters",
    worktree: { root: worktreeRoot, repository: worktreeRoot },
  };
  const denied = await client
    .request({ op: "enroll", input })
    .catch((error) => error);
  expect(denied).toMatchObject({ code: "forbidden" });
  const launcher = await connect("fixture-launcher-secret-32-characters");
  const notAgent = await launcher
    .request({ op: "bootstrap" })
    .catch((error) => error);
  expect(notAgent).toMatchObject({ code: "unauthorized" });
  const enrolled = (await launcher.request({ op: "enroll", input })) as {
    capability: string;
    generation: number;
    replayed: boolean;
  };
  expect(enrolled.generation).toBe(1);
  const replay = await launcher.request({ op: "enroll", input });
  expect(replay).toEqual({ ...enrolled, replayed: true });
  const bob = await connect(enrolled.capability);
  expect(await bob.request({ op: "bootstrap" })).toMatchObject({
    actor: "bob",
    scope: "test",
  });
  const resumed = (await launcher.request({
    op: "enroll",
    input: { ...input, requestId: "resume-bob" },
  })) as { capability: string; generation: number };
  expect(resumed.generation).toBe(2);
  const stale = await bob.request({ op: "bootstrap" }).catch((error) => error);
  expect(stale).toMatchObject({ code: "stale_session" });
  const current = await connect(resumed.capability);
  expect(await current.request({ op: "bootstrap" })).toMatchObject({
    actor: "bob",
  });
  const impersonated = await launcher
    .request({
      op: "enroll",
      input: {
        ...input,
        requestId: "wrong-secret",
        resumeToken: "different-resume-secret-32-characters",
      },
    })
    .catch((error) => error);
  expect(impersonated).toMatchObject({ code: "forbidden" });
});

test("enrollment is unavailable unless the owner explicitly configures it", async () => {
  const { client } = await fixture();
  const result = await client
    .request({
      op: "enroll",
      input: {
        scope: "test",
        agentId: "x",
        requestId: "x",
        resumeToken: "fixture-resume-secret-at-least-32-characters",
      },
    })
    .catch((error) => error);
  expect(result).toMatchObject({ code: "forbidden" });
});

test("held event pages obey their limit without skipping the remaining events", async () => {
  const { client } = await fixture();
  for (let index = 0; index < 25; index++)
    await client.request({
      op: "command",
      command: { ...command, id: `page-${index}` },
    });
  const first = (await client.request({
    op: "watch",
    cursor: 0,
    timeoutMs: 1,
    limit: 20,
  })) as { items: Array<{ id: number }>; cursor: number };
  expect(first.items).toHaveLength(20);
  expect(first.cursor).toBe(first.items.at(-1)!.id);
  const second = (await client.request({
    op: "watch",
    cursor: first.cursor,
    timeoutMs: 1,
    limit: 20,
  })) as { items: Array<{ id: number }>; cursor: number };
  expect(second.items).toHaveLength(5);
  expect(
    new Set([...first.items, ...second.items].map((event) => event.id)).size,
  ).toBe(25);
  expect(
    await client.request({
      op: "watch",
      cursor: second.cursor,
      timeoutMs: 1,
      limit: 20,
    }),
  ).toEqual({ items: [], cursor: second.cursor });
  const invalid = await client
    .request({ op: "watch", cursor: 0, timeoutMs: 1, limit: 0 })
    .catch((error) => error);
  expect(invalid).toMatchObject({ code: "invalid_input" });
});

test("task waits survive client disconnect without creating or cancelling work", async () => {
  const { client, connect } = await fixture("sessions");
  const created = (await client.request({ op: "command", command })) as {
    value: { task: { id: string } };
  };
  const taskId = created.value.task.id;
  const first = await client.request({ op: "task_wait", taskId, timeoutMs: 1 });
  expect(first).toMatchObject({
    taskId,
    waitState: "timeout",
    task: { status: "open" },
  });
  const pending = client
    .request({ op: "task_wait", taskId, timeoutMs: 30000 })
    .catch((error) => error);
  client.close();
  expect(await pending).toMatchObject({ code: "disconnected" });
  const resumed = await connect();
  try {
    expect(
      await resumed.request({ op: "task_wait", taskId, timeoutMs: 0 }),
    ).toMatchObject({ taskId, waitState: "timeout", task: { status: "open" } });
    expect(await resumed.request({ op: "attempts", taskId })).toEqual([]);
    expect(await resumed.request({ op: "command", command })).toMatchObject({
      replayed: true,
      value: { task: { id: taskId } },
    });
  } finally {
    resumed.close();
  }
});

test("artifact bytes, evidence links and shared context round trip through the owner", async () => {
  const { client, worktreeRoot } = await fixture("sessions");
  const initial = (await client.request({ op: "bootstrap" })) as {
    actor: string;
    eventCursor: number;
  };
  expect(initial.eventCursor).toBeGreaterThanOrEqual(0);
  const peers = (await client.request({
    op: "peers",
    filter: { limit: 1 },
  })) as { items: Array<{ agentId: string }> };
  expect(peers.items[0]!.agentId).toBe(initial.actor);
  await client.request({ op: "command", command });
  const summaries = (await client.request({
    op: "tasks",
    filter: { status: "open" },
  })) as { items: Array<{ title: string }> };
  expect(summaries.items[0]!.title).toBe(command.payload.title);
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
  expect(await client.request({ op: "inbox", activeOnly: true })).toEqual({
    items: [],
    cursor: 0,
  });
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
