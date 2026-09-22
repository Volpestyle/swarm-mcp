import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { opencodeLifecycle } from "../src/coordination/opencode-plugin";
import { CoordinationClient } from "../src/coordination/ipc";
import { observeInbox } from "../src/coordination/inbox-observer";
import { setTimeout as delay } from "node:timers/promises";

test("OpenCode post-tool admission preserves explicit ack and suppresses repeated callbacks", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const ownerPath = join(
    mkdtempSync(resolve("dist/test/opencode-owner-")),
    "owner.mjs",
  );
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: ownerPath,
  });
  const root = mkdtempSync(join(tmpdir(), "opencode-delivery-"));
  const options = {
    stateDirectory: join(root, "private"),
    nodePath: Bun.which("node")!,
    ownerPath,
    identity: {
      projectRoot: root,
      directory: root,
      fileRoot: root,
      profile: "test",
      allowedRoots: [root],
    },
  };
  const sender = await enrollRuntime({
    ...options,
    host: "opencode",
    hostSessionId: "sender",
    incarnation: "test",
  });
  const client = await CoordinationClient.connect(
    sender.environment.SWARM_COORDINATOR_ENDPOINT,
    sender.environment.SWARM_SESSION_CAPABILITY,
  );
  let recipient: CoordinationClient | undefined;
  try {
    let actor = "";
    const hooks = opencodeLifecycle(options, (event) => {
      if (event.actor) actor = event.actor;
    });
    const env: Record<string, string> = {};
    await hooks["shell.env"]({ sessionID: "recipient" }, { env });
    recipient = await CoordinationClient.connect(
      env.SWARM_COORDINATOR_ENDPOINT,
      env.SWARM_SESSION_CAPABILITY,
    );
    for (const id of ["one", "two"])
      await client.request({
        op: "command",
        command: {
          id,
          type: "message.send",
          payload: { recipient: actor, kind: "question", body: id },
        },
      });
    const output = { output: "original tool output" };
    const hints: string[] = [];
    const errors: string[] = [];
    const observer = observeInbox({
      endpoint: env.SWARM_COORDINATOR_ENDPOINT,
      capability: env.SWARM_SESSION_CAPABILITY,
      ready: () => true,
      notify: async (id) => {
        hints.push(id);
      },
      failed: () => {
        errors.push("failed");
      },
    });
    try {
      for (let i = 0; i < 100 && !hints.length; i++) await delay(10);
      expect(hints.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      const untouched = (await recipient.request({ op: "bootstrap" })) as {
        inbox: Array<{ state: string; count: number }>;
      };
      expect(untouched.inbox).toEqual([{ state: "pending", count: 2 }]);
    } finally {
      observer.stop();
      await observer.done;
    }
    const input = { sessionID: "recipient", callID: "first" };
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: { sessionID: "recipient", id: "waiting" },
      },
    });
    await hooks["tool.execute.after"](input, output);
    expect(output.output).toBe("original tool output");
    const blocked = (await recipient.request({ op: "bootstrap" })) as {
      inbox: Array<{ state: string; count: number }>;
    };
    expect(blocked.inbox).toEqual([{ state: "pending", count: 2 }]);
    await hooks.event({
      event: {
        type: "permission.replied",
        properties: { sessionID: "recipient", requestID: "waiting" },
      },
    });
    await hooks["tool.execute.after"](input, output);
    const first = output.output;
    expect(first.startsWith("original tool output")).toBe(true);
    const lease = JSON.parse(first.split("\n").at(-1)!);
    expect(lease.message.body).toBe("one");
    await hooks["tool.execute.after"](input, output);
    expect(output.output).toBe(first);
    const state = (await client.request({
      op: "message_status",
      messageId: lease.message.id,
    })) as any;
    expect(state.deliveries[0].state).toBe("leased");
    await recipient.request({
      op: "command",
      command: {
        id: "ack",
        type: "inbox.ack",
        payload: { messageId: lease.message.id, leaseToken: lease.leaseToken },
      },
    });
    const mcp = { content: [{ type: "text", text: "original" }] };
    await hooks["tool.execute.after"]({ ...input, callID: "second" }, mcp);
    expect(mcp.content.length).toBe(2);
    expect(
      JSON.parse(mcp.content[1].text.split("\n").at(-1)!).message.body,
    ).toBe("two");
    await client.request({
      op: "command",
      command: {
        id: "three",
        type: "message.send",
        payload: { recipient: actor, kind: "question", body: "three" },
      },
    });
    const chat = {
      message: { id: "msg_fixture" },
      parts: [{ type: "text", text: "wake" }],
    };
    await hooks["chat.message"]({ sessionID: "recipient" }, chat);
    expect(chat.parts[0].text).toBe("wake");
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "recipient", status: { type: "idle" } },
      },
    });
    await hooks["chat.message"]({ sessionID: "recipient" }, chat);
    expect(
      JSON.parse(chat.parts[0].text.split("\n").at(-1)!).message.body,
    ).toBe("three");
    const admitted = chat.parts[0].text;
    await hooks["chat.message"]({ sessionID: "recipient" }, chat);
    expect(chat.parts[0].text).toBe(admitted);
  } finally {
    recipient?.close();
    client.close();
    if (sender.launchedOwner) {
      sender.launchedOwner.ref();
      const exited = once(sender.launchedOwner, "exit");
      sender.launchedOwner.kill();
      await exited;
    }
  }
}, 30000);
