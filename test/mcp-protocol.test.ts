import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

for (const mode of ["legacy", "modern"] as const) {
  test(`real stdio server serves ${mode} tools, resources and prompts`, async () => {
    const root = mkdtempSync(join(tmpdir(), "swarm-protocol-"));
    const client = new Client(
      { name: "protocol-test", version: "1" },
      {
        versionNegotiation: {
          mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("src/index.ts")],
      env: {
        ...getDefaultEnvironment(),
        SWARM_DB_PATH: join(root, "legacy.db"),
        AGENT_IDENTITY: "protocol-test",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const wire: any[] = [];
      const receive = transport.onmessage!;
      transport.onmessage = (message, ...rest) => {
        wire.push(message);
        receive(message, ...rest);
      };
      expect(client.getProtocolEra()).toBe(mode);
      expect(
        (await client.listTools()).tools.some((t) => t.name === "register"),
      ).toBe(true);
      expect(
        (await client.listResources()).resources.some(
          (r) => r.uri === "swarm://inbox",
        ),
      ).toBe(true);
      expect(
        (await client.listPrompts()).prompts.some((p) => p.name === "protocol"),
      ).toBe(true);
      const registered = await client.callTool({
        name: "register",
        arguments: {
          directory: root,
          scope: root,
          label: "identity:protocol-test role:implementer",
        },
      });
      expect(registered.isError).not.toBe(true);
      const inbox = await client.readResource({ uri: "swarm://inbox" });
      expect(inbox.contents).toHaveLength(1);
      if (mode === "modern") {
        expect(wire.at(-1).result).toMatchObject({
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "swarm" } },
        });
        expect(wire.find((m) => m.result?.tools)?.result).toMatchObject({
          ttlMs: 60000,
          cacheScope: "private",
          resultType: "complete",
        });
      } else {
        expect(wire.at(-1).result.resultType).toBeUndefined();
        expect(wire.at(-1).result.ttlMs).toBeUndefined();
      }
      expect(stderr).not.toContain("fatal");
      const changes: string[] = [];
      client.setNotificationHandler(
        "notifications/resources/updated",
        (message) => {
          changes.push(message.params.uri);
        },
      );
      const subscription =
        mode === "modern"
          ? await client.listen({ resourceSubscriptions: ["swarm://tasks"] })
          : null;
      if (!subscription)
        await client.subscribeResource({ uri: "swarm://tasks" });
      const result = await client.callTool({
        name: "request_task",
        arguments: { type: "implement", title: "notification proof" },
      });
      expect(result.isError).not.toBe(true);
      const deadline = Date.now() + 6500;
      while (!changes.length && Date.now() < deadline) await delay(50);
      expect(changes).toEqual(["swarm://tasks"]);
      if (subscription) await subscription.close();
      else await client.unsubscribeResource({ uri: "swarm://tasks" });
      changes.length = 0;
      await client.callTool({
        name: "request_task",
        arguments: { type: "implement", title: "after unsubscribe" },
      });
      await delay(5200);
      expect(changes).toEqual([]);
      const abort = new AbortController();
      const started = Date.now();
      const waiting = client
        .callTool(
          { name: "wait_for_activity", arguments: { timeout_seconds: 60 } },
          { signal: abort.signal },
        )
        .catch((error) => error);
      await delay(100);
      abort.abort();
      expect(await waiting).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(1500);
      expect((await client.listResources()).resources.length).toBeGreaterThan(
        0,
      );
      const inboxSubscription =
        mode === "modern"
          ? await client.listen({ resourceSubscriptions: ["swarm://inbox"] })
          : null;
      if (!inboxSubscription)
        await client.subscribeResource({ uri: "swarm://inbox" });
      const peer = new Client({ name: "peer", version: "1" });
      try {
        await peer.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [resolve("src/index.ts")],
            env: {
              ...getDefaultEnvironment(),
              SWARM_DB_PATH: join(root, "legacy.db"),
              AGENT_IDENTITY: "protocol-test",
            },
            stderr: "pipe",
          }),
        );
        await peer.callTool({
          name: "register",
          arguments: {
            directory: root,
            scope: root,
            label: "identity:protocol-test role:reviewer",
          },
        });
        const identity = JSON.parse(
          (registered.content![0] as { text: string }).text,
        );
        await peer.callTool({
          name: "send_message",
          arguments: {
            recipient: identity.id,
            content: "inbox notification proof",
          },
        });
        const inboxDeadline = Date.now() + 6500;
        while (!changes.length && Date.now() < inboxDeadline) await delay(50);
        expect(changes).toEqual(["swarm://inbox"]);
        expect(
          JSON.stringify(await client.readResource({ uri: "swarm://inbox" })),
        ).toContain("inbox notification proof");
      } finally {
        await peer.close();
      }
      if (inboxSubscription) await inboxSubscription.close();
      else await client.unsubscribeResource({ uri: "swarm://inbox" });
    } finally {
      const closingAt = Date.now();
      await client.close();
      expect(Date.now() - closingAt).toBeLessThan(1500);
    }
  }, 35000);
}

test("modern stdio requires valid metadata on every request", async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-wire-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/index.ts")],
    env: { ...getDefaultEnvironment(), SWARM_DB_PATH: join(root, "db") },
    stderr: "pipe",
  });
  const responses = new Map<number, (message: any) => void>();
  transport.onmessage = (message) => {
    if ("id" in message) responses.get(message.id as number)?.(message);
  };
  let id = 0;
  const request = async (method: string, meta?: Record<string, unknown>) => {
    const next = ++id;
    const result = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("wire response timeout")),
        3000,
      );
      responses.set(next, (message) => {
        clearTimeout(timeout);
        responses.delete(next);
        resolve(message);
      });
    });
    await transport.send({
      jsonrpc: "2.0",
      id: next,
      method,
      params: meta ? { _meta: meta } : {},
    });
    return result;
  };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  try {
    await transport.start();
    expect(
      (
        await request("server/discover", {
          ...meta,
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
        })
      ).error,
    ).toBeDefined();
    const discovered = await request("server/discover", meta);
    expect(
      discovered.result._meta["io.modelcontextprotocol/serverInfo"].name,
    ).toBe("swarm");
    expect(discovered.result.supportedVersions).toContain("2026-07-28");
    expect(
      (await request("tools/list", meta)).result.tools.length,
    ).toBeGreaterThan(0);
    expect((await request("tools/list")).error).toBeDefined();
    expect(
      (
        await request("tools/list", {
          ...meta,
          "io.modelcontextprotocol/protocolVersion": 42,
        })
      ).error,
    ).toBeDefined();
    expect(
      (await request("tools/list", meta)).result.tools.length,
    ).toBeGreaterThan(0);
  } finally {
    await transport.close();
  }
}, 10000);
