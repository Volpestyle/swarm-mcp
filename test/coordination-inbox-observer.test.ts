import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient } from "../src/coordination/ipc";
import { observeInbox } from "../src/coordination/inbox-observer";

test("inbox observer reconnects to a restarted production owner without replacing identity", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const output = join(
    mkdtempSync(resolve("dist/test/inbox-reconnect-")),
    "owner.mjs",
  );
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: output,
  });
  const root = mkdtempSync(join(tmpdir(), "swarm-inbox-reconnect-"));
  const secret = randomBytes(32).toString("hex");
  const config = join(root, "owner.json");
  writeFileSync(
    config,
    JSON.stringify({ databasePath: join(root, "db"), launcherSecret: secret }),
  );
  const start = () =>
    Bun.spawn({
      cmd: [Bun.which("node")!, output, config],
      stdout: "pipe",
      stderr: "pipe",
    });
  let child = start();
  const ready = async () => {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!first.value) throw new Error(await new Response(child.stderr).text());
    return JSON.parse(new TextDecoder().decode(first.value)).endpoint as string;
  };
  const clients: CoordinationClient[] = [];
  let observer: ReturnType<typeof observeInbox> | undefined;
  try {
    const endpoint = await ready();
    const launcher = await CoordinationClient.connect(endpoint, secret);
    clients.push(launcher);
    const enroll = async (agentId: string) =>
      (await launcher.request({
        op: "enroll",
        input: {
          scope: "test",
          agentId,
          requestId: "initial",
          resumeToken: randomBytes(32).toString("hex"),
        },
      })) as { capability: string };
    const sender = await enroll("sender");
    const recipient = await enroll("recipient");
    const senderClient = await CoordinationClient.connect(
      endpoint,
      sender.capability,
    );
    clients.push(senderClient);
    await senderClient.request({
      op: "command",
      command: {
        id: "send",
        type: "message.send",
        payload: {
          recipient: "recipient",
          kind: "question",
          body: "survive owner restart",
        },
      },
    });
    let idle = true;
    const hints: string[] = [];
    const failures: unknown[] = [];
    observer = observeInbox({
      endpoint,
      capability: recipient.capability,
      ready: () => idle,
      notify: async (id) => {
        hints.push(id);
        idle = false;
      },
      failed: (error) => failures.push(error),
    });
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) await delay(10);
      expect(predicate()).toBe(true);
    };
    await until(() => hints.length === 1);
    child.kill();
    await child.exited;
    idle = true;
    child = start();
    expect(await ready()).toBe(endpoint);
    await until(() => hints.length === 2);
    expect(hints[1]).toBe(hints[0]);
    expect(failures.length).toBeGreaterThan(0);
    const retained = await CoordinationClient.connect(
      endpoint,
      recipient.capability,
    );
    clients.push(retained);
    expect(await retained.request({ op: "bootstrap" })).toMatchObject({
      actor: "recipient",
      inbox: [{ state: "pending", count: 1 }],
    });

    let rejected = 0;
    const unauthorized = observeInbox({
      endpoint,
      capability: "invalid-capability",
      ready: () => true,
      notify: async () => {
        throw new Error("must not notify");
      },
      failed: () => {
        rejected++;
      },
    });
    await unauthorized.done;
    expect(rejected).toBe(1);
  } finally {
    observer?.stop();
    await observer?.done;
    clients.forEach((client) => client.close());
    child.kill();
    await child.exited;
  }
}, 15000);

test("observer bounds unavailable-owner retries and stop cancels backoff", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\missing-${randomBytes(8).toString("hex")}`
      : join(tmpdir(), `missing-${randomBytes(8).toString("hex")}.sock`);
  let failures = 0;
  const options = {
    endpoint,
    capability: "test",
    ready: () => true,
    notify: async () => {},
    failed: () => {
      failures++;
    },
  };
  const observer = observeInbox(options);
  await observer.done;
  expect(failures).toBe(4);
  failures = 0;
  const stopped = observeInbox(options);
  while (!failures) await delay(5);
  stopped.stop();
  await stopped.done;
  expect(failures).toBe(1);
});
