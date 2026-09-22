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
    } finally {
      const closingAt = Date.now();
      await client.close();
      expect(Date.now() - closingAt).toBeLessThan(1500);
    }
  }, 25000);
}
