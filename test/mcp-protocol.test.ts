import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
      expect(stderr).not.toContain("fatal");
    } finally {
      await client.close();
    }
  }, 15000);
}
