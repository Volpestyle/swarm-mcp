import { test, expect } from "bun:test";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../src/coordination/ipc";

test("production Node owner resumes durable launcher enrollment after restart", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const output = join(mkdtempSync(resolve("dist/test/owner-")), "owner.mjs");
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: output,
  });
  const root = mkdtempSync(join(tmpdir(), "swarm-owner-"));
  const secret = randomBytes(32).toString("hex");
  const config = join(root, "owner.json");
  writeFileSync(
    config,
    JSON.stringify({ databasePath: join(root, "db"), launcherSecret: secret }),
    { mode: 0o600 },
  );
  const input = {
    scope: "test",
    agentId: "alice",
    requestId: "first",
    resumeToken: randomBytes(32).toString("hex"),
    worktree: { root, repository: root },
  };
  let original = "";
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn({
      cmd: [Bun.which("node")!, output, config],
      stdout: "pipe",
      stderr: "pipe",
    });
    const clients: CoordinationClient[] = [];
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      if (!first.value)
        throw new Error(await new Response(child.stderr).text());
      const readyText = new TextDecoder().decode(first.value);
      expect(readyText).not.toContain(secret);
      const { endpoint } = JSON.parse(readyText);
      const launcher = await CoordinationClient.connect(endpoint, secret);
      clients.push(launcher);
      const result = (await launcher.request({ op: "enroll", input })) as {
        capability: string;
        replayed: boolean;
        generation: number;
      };
      expect(result.replayed).toBe(Boolean(restart));
      expect(result.generation).toBe(1);
      if (!restart) original = result.capability;
      expect(result.capability).toBe(original);
      const agent = await CoordinationClient.connect(
        endpoint,
        result.capability,
      );
      clients.push(agent);
      expect(await agent.request({ op: "bootstrap" })).toMatchObject({
        actor: "alice",
        scope: "test",
      });
      if (restart) {
        const resumed = (await launcher.request({
          op: "enroll",
          input: { ...input, requestId: "resume" },
        })) as { generation: number };
        expect(resumed.generation).toBe(2);
        const stale = await agent
          .request({ op: "bootstrap" })
          .catch((error) => error);
        expect(stale).toMatchObject({ code: "stale_session" });
      }
    } finally {
      for (const client of clients) client.close();
      child.kill();
      await child.exited;
    }
  }
});
