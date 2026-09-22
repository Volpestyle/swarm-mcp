import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient } from "../src/coordination/ipc";
import { observeInbox } from "../src/coordination/inbox-observer";

test("uncertain wake does not hide later work or expiry behind an accepted wake", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const script = join(
    mkdtempSync(resolve("dist/test/inbox-backlog-")),
    "service.mjs",
  );
  await build({
    entryPoints: ["test/fixtures/coordination-service.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: script,
  });
  const child = Bun.spawn({
    cmd: [
      Bun.which("node")!,
      script,
      join(mkdtempSync(join(tmpdir(), "inbox-backlog-")), "db"),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  let client: CoordinationClient | undefined;
  let observer: ReturnType<typeof observeInbox> | undefined;
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!first.value) throw new Error(await new Response(child.stderr).text());
    const { endpoint } = JSON.parse(new TextDecoder().decode(first.value));
    client = await CoordinationClient.connect(endpoint, "alice-secret");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const receipt = (await client.request({
        op: "command",
        command: {
          id: `send-${i}`,
          type: "message.send",
          payload: {
            recipient: "alice",
            kind: "question",
            body: String(i),
            ...(i === 2 ? { ttlMs: 500 } : {}),
          },
        },
      })) as { value: { messageId: string } };
      ids.push(receipt.value.messageId);
    }
    const hints: string[] = [];
    const errors: unknown[] = [];
    observer = observeInbox({
      endpoint,
      capability: "alice-secret",
      ready: () => true,
      notify: async (id) => {
        hints.push(id);
        return {
          status:
            id === ids[0] ? ("uncertain" as const) : ("accepted" as const),
        };
      },
      failed: (error) => errors.push(error),
    });
    let terminal = false;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const status = (await client.request({
        op: "message_status",
        messageId: ids[2],
      })) as {
        deliveries: Array<{ state: string }>;
      };
      terminal = status.deliveries[0].state === "expired";
      if (terminal && hints.includes(ids[1])) break;
      await delay(20);
    }
    expect(hints).toContain(ids[1]);
    expect(terminal).toBe(true);
    expect(hints).not.toContain(ids[2]);
    expect(errors).toEqual([]);
    expect(await client.request({ op: "bootstrap" })).toMatchObject({
      inbox: [
        { state: "expired", count: 1 },
        { state: "pending", count: 2 },
      ],
    });
  } finally {
    observer?.stop();
    await observer?.done;
    client?.close();
    child.kill();
    await child.exited;
  }
}, 10000);
