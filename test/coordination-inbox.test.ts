import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore, type CoreCommand } from "../src/coordination/core";
import type { InboxPolicy } from "../src/coordination/inbox";

const stores: CoordinationStore[] = [];
let nodeFixture: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeFixture = join(mkdtempSync(resolve("dist/test/inbox-")), "worker.mjs");
  await build({
    entryPoints: ["test/fixtures/inbox-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: nodeFixture,
  });
});
async function child(
  path: string,
  command: CoreCommand,
  at: number,
  runtime: "bun" | "node",
  crash = "",
) {
  const proc = Bun.spawn({
    cmd: [
      runtime === "bun" ? process.execPath : Bun.which("node")!,
      runtime === "bun"
        ? resolve("test/fixtures/inbox-worker.ts")
        : nodeFixture,
      path,
      JSON.stringify(command),
      String(at),
      crash,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const alice = { scope: "test", actor: "alice" };
const bob = { scope: "test", actor: "bob" };
async function setup(policy: Partial<InboxPolicy> = {}) {
  let now = 1000;
  const path = join(
    mkdtempSync(join(tmpdir(), "coordination-inbox-")),
    "db.sqlite",
  );
  const open = async () => {
    const store = await CoordinationStore.open({
      path,
      clock: () => now,
      inboxPolicy: policy,
    });
    stores.push(store);
    return { store, core: new CoordinationCore(store) };
  };
  return {
    ...(await open()),
    path,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const send = (id = "send", recipient = "bob"): CoreCommand => ({
  id,
  type: "message.send",
  payload: { recipient, kind: "task", body: "do work" },
});
const fetch = (id = "fetch"): CoreCommand => ({
  id,
  type: "inbox.fetch",
  payload: { consumer: "worker", leaseMs: 100 },
});
function delivery(core: CoordinationCore, id = "fetch") {
  return (
    core.command(bob, fetch(id)).value as {
      deliveries: {
        message: { id: string };
        leaseToken: string;
        attempt: number;
      }[];
    }
  ).deliveries[0]!;
}

test("fetch replay preserves the lease; acknowledgment is explicit and idempotent", async () => {
  const { core } = await setup();
  const sent = core.command(alice, send());
  expect(core.command(alice, send())).toEqual({ ...sent, replayed: true });
  const first = delivery(core);
  expect(delivery(core)).toEqual(first);
  expect(core.inbox(bob).items[0]!.state).toBe("leased");
  expect(
    (
      core.command(bob, fetch("other-consumer")).value as {
        deliveries: unknown[];
      }
    ).deliveries,
  ).toEqual([]);
  const ack: CoreCommand = {
    id: "ack",
    type: "inbox.ack",
    payload: { messageId: first.message.id, leaseToken: first.leaseToken },
  };
  const receipt = core.command(bob, ack);
  expect(core.command(bob, ack)).toEqual({ ...receipt, replayed: true });
  expect(core.command(bob, { ...ack, id: "ack-again" }).value).toEqual(
    receipt.value,
  );
  expect(core.inbox(bob).items[0]!.state).toBe("acknowledged");
});

test("active inbox pagination excludes terminal history without consuming work", async () => {
  const { core } = await setup();
  for (let i = 0; i < 120; i++) {
    core.command(alice, send(`history-${i}`));
    const lease = delivery(core, `lease-${i}`);
    core.command(bob, {
      id: `ack-${i}`,
      type: "inbox.ack",
      payload: {
        messageId: lease.message.id,
        leaseToken: lease.leaseToken,
      },
    });
  }
  core.command(alice, send("leased"));
  const lease = delivery(core, "active-lease");
  const pending = core.command(alice, send("pending")).value as {
    messageId: string;
  };
  core.command(alice, send("other-recipient", "carol"));
  const first = core.inbox(bob, 0, 1, true);
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({
    messageId: lease.message.id,
    state: "leased",
    attempts: 1,
  });
  const second = core.inbox(bob, first.cursor, 1, true);
  expect(second.items).toHaveLength(1);
  expect(second.items[0]).toMatchObject({
    messageId: pending.messageId,
    state: "pending",
    attempts: 0,
  });
  expect(core.inbox(bob, second.cursor, 1, true).items).toEqual([]);
  expect(core.inbox(bob, 0, 1).items[0]!.state).toBe("acknowledged");
  expect(core.inbox({ ...bob, scope: "other" }, 0, 1, true).items).toEqual([]);
  expect(() => core.inbox(bob, 0, 1, "true" as unknown as boolean)).toThrow(
    "activeOnly must be boolean",
  );
});

test("recipient restart retains hour-old work and fences stale delivery tokens", async () => {
  const env = await setup({ backoffMs: 10 });
  env.core.command(alice, send());
  const first = delivery(env.core);
  env.store.close();
  env.advance(3600001);
  const { core } = await env.open();
  const second = delivery(core, "resume");
  expect(second.message.id).toBe(first.message.id);
  expect(second.attempt).toBe(2);
  expect(second.leaseToken).not.toBe(first.leaseToken);
  expect(() =>
    core.command(bob, {
      id: "stale",
      type: "inbox.ack",
      payload: { messageId: first.message.id, leaseToken: first.leaseToken },
    }),
  ).toThrow("not current");
});

test("bounded retry and backoff expose poison messages without blocking healthy work", async () => {
  const { core, advance } = await setup({ maxAttempts: 2, backoffMs: 10 });
  core.command(alice, send());
  const first = delivery(core);
  core.command(bob, {
    id: "reject",
    type: "inbox.reject",
    payload: {
      messageId: first.message.id,
      leaseToken: first.leaseToken,
      reason: "bad payload",
    },
  });
  expect(
    (core.command(bob, fetch("too-soon")).value as { deliveries: unknown[] })
      .deliveries,
  ).toEqual([]);
  advance(10);
  const second = delivery(core, "retry");
  core.command(bob, {
    id: "reject-last",
    type: "inbox.reject",
    payload: {
      messageId: second.message.id,
      leaseToken: second.leaseToken,
      reason: "still bad",
    },
  });
  core.command(alice, send("healthy"));
  expect(delivery(core, "healthy-fetch").message.id).not.toBe(first.message.id);
  expect(core.messageStatus(alice, first.message.id).deliveries[0]!.state).toBe(
    "dead_letter",
  );
});

test("explicit expiry keeps visible records and scoped announcements have separate deliveries", async () => {
  const { core, advance } = await setup();
  core.command(alice, {
    id: "announcement",
    type: "message.announce",
    payload: {
      recipients: ["bob", "carol", "bob"],
      kind: "notice",
      body: "hello",
      ttlMs: 50,
    },
  });
  const first = delivery(core);
  expect(core.messageStatus(alice, first.message.id).deliveries).toHaveLength(
    2,
  );
  expect(core.messageStatus(bob, first.message.id).deliveries).toHaveLength(1);
  expect(() =>
    core.messageStatus(
      { scope: "elsewhere", actor: "alice" },
      first.message.id,
    ),
  ).toThrow("not visible");
  advance(50);
  core.command(bob, { id: "sweep", type: "inbox.sweep", payload: {} });
  expect(core.inbox(bob).items[0]!.state).toBe("expired");
  expect(
    core.events(bob).items.some((e) => e.type === "delivery.expired"),
  ).toBe(true);
});

test("recipient quota is atomic for fanout and does not block independent recipients", async () => {
  const { core } = await setup({ maxPendingPerRecipient: 1 });
  core.command(alice, send());
  expect(() =>
    core.command(alice, {
      id: "fanout",
      type: "message.announce",
      payload: { recipients: ["carol", "bob"], kind: "notice", body: "hello" },
    }),
  ).toThrow("quota");
  expect(core.inbox({ ...bob, actor: "carol" }).items).toEqual([]);
  core.command(alice, send("independent", "carol"));
  expect(core.inbox({ ...bob, actor: "carol" }).items).toHaveLength(1);
});

test("untrusted command properties cannot replace the authorized scope or sender", async () => {
  const { core } = await setup();
  core.command(alice, {
    ...send(),
    actor: "mallory",
    scope: "stolen",
  } as unknown as CoreCommand);
  expect(core.inbox(bob).items[0]!.message.sender).toBe("alice");
  expect(core.inbox({ ...bob, scope: "stolen" }).items).toEqual([]);
});

test("version-one migration preserves tasks and rolls back interrupted schema changes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "coordinator-v1-")), "db.sqlite");
  const db = new Database(path);
  db.exec(readFileSync(resolve("test/fixtures/coordinator-v1.sql"), "utf8"));
  db.exec(`INSERT INTO tasks VALUES('existing-task','test','alice','keep me','open',1,1000,1000);
    INSERT INTO events(scope,actor,type,entity_id,payload,created_at)
    VALUES('test','alice','task.created','existing-task','{}',1000);`);
  db.close();
  const failure = await CoordinationStore.open({
    path,
    fault: (point) => {
      if (point === "before_migration_commit") throw new Error("interrupted");
    },
  }).catch((error) => error);
  expect(failure.message).toBe("interrupted");
  const inspect = new Database(path);
  expect(inspect.query("PRAGMA user_version").get()).toEqual({
    user_version: 1,
  });
  expect(
    inspect
      .query("SELECT name FROM sqlite_master WHERE name='inbox_messages'")
      .get(),
  ).toBeNull();
  inspect.close();
  const store = await CoordinationStore.open({ path }); stores.push(store);
  const core = new CoordinationCore(store);
  expect(core.events(alice).items[0]!.type).toBe("task.created");
  expect(core.task(alice, "existing-task")).toMatchObject({ title: "keep me", status: "open" });
  core.command(alice, send());
  expect(core.inbox(bob).items).toHaveLength(1);
});

for (const runtime of ["bun", "node"] as const) {
  test(`lost fetch and ack responses survive abrupt process exit (${runtime})`, async () => {
    const env = await setup();
    env.core.command(alice, send());
    const lost = await child(
      env.path,
      fetch(),
      1000,
      runtime,
      "after_command_commit",
    );
    expect(lost.code).toBe(73);
    expect(lost.stdout).toBe("");
    const first = delivery(env.core);
    expect(first.attempt).toBe(1);
    expect(env.core.command(bob, fetch()).replayed).toBe(true);
    const ack: CoreCommand = {
      id: "ack",
      type: "inbox.ack",
      payload: { messageId: first.message.id, leaseToken: first.leaseToken },
    };
    expect(
      (await child(env.path, ack, 1050, runtime, "after_command_commit")).code,
    ).toBe(73);
    env.store.close();
    const { core } = await env.open();
    expect(core.command(bob, ack).replayed).toBe(true);
    expect(core.inbox(bob).items[0]!.state).toBe("acknowledged");
  });

  test(`crashed consumer loses lease and eight concurrent consumers claim once (${runtime})`, async () => {
    const env = await setup();
    env.core.command(alice, send());
    expect(
      (await child(env.path, fetch(), 1000, runtime, "after_command_commit"))
        .code,
    ).toBe(73);
    env.advance(3600001);
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        child(env.path, fetch(`consumer-${i}`), 3601001, runtime),
      ),
    );
    for (const reply of replies) {
      expect(reply.stderr).toBe("");
      expect(reply.code).toBe(0);
    }
    const deliveries = replies.flatMap(
      (reply) => JSON.parse(reply.stdout).value.deliveries,
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].attempt).toBe(2);
    expect(env.core.inbox(bob).items[0]!.state).toBe("leased");
  });
}
