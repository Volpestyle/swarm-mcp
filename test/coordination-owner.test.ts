import { test, expect } from "bun:test";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../src/coordination/ipc";
import { ensureCoordinator } from "../src/coordination/owner-launcher";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalPath } from "../src/coordination/worktrees";
import { ownerDispatchSchema } from "../src/coordination/owner-dispatch";

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
        sessionId: string;
        actor: string;
        scope: string;
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
        const intent = {
          intentId: "owner-dispatch",
          title: "Configured work",
          capabilities: ["code"],
          durable: true,
          contract: {
            objective: "Configured work",
            worktree: canonicalPath(root),
            acceptanceCriteria: ["Verified"],
            expectedArtifacts: [],
            constraints: [],
          },
        };
        expect(
          await agent.request({
            op: "dispatch",
            input: { action: "assign", intent },
          }),
        ).toMatchObject({ status: "blocked" });
        await agent.request({
          op: "command",
          command: {
            id: "available",
            type: "session.observe",
            payload: { runtime: "available" },
          },
        });
        const assigned = (await agent.request({
          op: "dispatch",
          input: { action: "assign", intent },
        })) as {
          status: string;
          taskId: string;
          attemptId: string;
          fence: number;
        };
        expect(assigned.status).toBe("bound");
        const inbox = (await agent.request({ op: "inbox" })) as {
          items: Array<{ message: { kind: string } }>;
        };
        expect(inbox.items.map((i) => i.message.kind)).toEqual([
          "task.assigned",
        ]);
        await agent.request({
          op: "command",
          command: {
            id: "done",
            type: "task.finish",
            payload: {
              taskId: assigned.taskId,
              attemptId: assigned.attemptId,
              fence: assigned.fence,
              outcome: "completed",
            },
          },
        });
        expect(
          await agent.request({
            op: "dispatch",
            input: { action: "cancel", intentId: intent.intentId },
          }),
        ).toMatchObject({ status: "released" });
        const resumed = (await launcher.request({
          op: "enroll",
          input: { ...input, requestId: "resume" },
        })) as { generation: number };
        expect(resumed.generation).toBe(2);
        const stale = await agent
          .request({ op: "bootstrap" })
          .catch((error) => error);
        expect(stale).toMatchObject({ code: "stale_session" });
        const current = await CoordinationClient.connect(
          endpoint,
          (resumed as unknown as { capability: string }).capability,
        );
        clients.push(current);
        expect(
          await current.request({
            op: "dispatch",
            input: {
              action: "assign",
              intent: { ...intent, intentId: "after-resume" },
            },
          }),
        ).toMatchObject({ status: "blocked" });
      } else {
        const dispatch = {
          maximum: 1,
          observationMaxAgeMs: 60000,
          peers: [
            {
              id: "configured-peer",
              worker: {
                scope: result.scope,
                actor: result.actor,
                sessionId: result.sessionId,
                generation: result.generation,
              },
              host: "node",
              capabilities: ["code"],
              durable: true,
              capacity: 1,
              overhead: 0,
            },
          ],
        };
        expect(() =>
          ownerDispatchSchema.parse({
            ...dispatch,
            peers: [dispatch.peers[0], dispatch.peers[0]],
          }),
        ).toThrow();
        writeFileSync(
          config,
          JSON.stringify({
            databasePath: join(root, "db"),
            launcherSecret: secret,
            dispatch,
          }),
          { mode: 0o600 },
        );
      }
    } finally {
      for (const client of clients) client.close();
      child.kill();
      await child.exited;
    }
  }
});

test("simultaneous launchers converge on one owner and reuse it without spawning", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const output = join(
    mkdtempSync(resolve("dist/test/owner-launch-")),
    "owner.mjs",
  );
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: output,
  });
  const root = mkdtempSync(join(tmpdir(), "swarm-owner-launch-"));
  const configPath = join(root, "owner.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath: join(root, "db"),
      launcherSecret: randomBytes(32).toString("hex"),
    }),
    { mode: 0o600 },
  );
  const options = {
    configPath,
    nodePath: Bun.which("node")!,
    ownerPath: output,
  };
  const started: Awaited<ReturnType<typeof ensureCoordinator>>[] = [];
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        const result = await ensureCoordinator(options);
        started.push(result);
        return result;
      }),
    );
    // Report the reason so a hosted-runner rejection is diagnosable.
    expect(
      results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      ),
    ).toEqual([]);
    const input = {
      scope: "test",
      agentId: "alice",
      requestId: "shared-launch",
      resumeToken: randomBytes(32).toString("hex"),
    };
    const receipts = (await Promise.all(
      started.map(({ client }) => client.request({ op: "enroll", input })),
    )) as Array<{ capability: string; replayed: boolean }>;
    expect(new Set(receipts.map((receipt) => receipt.capability)).size).toBe(1);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    const reused = await ensureCoordinator({
      ...options,
      nodePath: join(root, "missing-node"),
    });
    started.push(reused);
    expect(reused.launched).toBeUndefined();
    const deadline = Date.now() + 2000;
    const living = () =>
      started.filter(
        (result) =>
          result.launched &&
          result.launched.exitCode === null &&
          result.launched.signalCode === null,
      );
    while (living().length > 1 && Date.now() < deadline) await delay(20);
    expect(living()).toHaveLength(1);
  } finally {
    for (const { client } of started) client.close();
    await Promise.all(
      started.map(async ({ launched }) => {
        if (
          !launched ||
          launched.exitCode !== null ||
          launched.signalCode !== null
        )
          return;
        // Re-reference the detached handle before explicitly awaiting its exit.
        launched.ref();
        const exited = once(launched, "exit");
        launched.kill();
        await exited;
      }),
    );
  }
});

test("owner startup reports a missing runtime without an endless retry loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-owner-failed-"));
  const configPath = join(root, "owner.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath: join(root, "db"),
      launcherSecret: randomBytes(32).toString("hex"),
    }),
  );
  const result = await ensureCoordinator({
    configPath,
    nodePath: join(root, "missing-node"),
    ownerPath: join(root, "owner.js"),
    timeoutMs: 1000,
  }).catch((error) => error);
  expect(result).toMatchObject({ code: "ENOENT" });
});

test("launcher keeps connecting after its own candidate owner exits", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const dir = mkdtempSync(resolve("dist/test/owner-race-"));
  const output = join(dir, "owner.mjs");
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: output,
  });
  const root = mkdtempSync(join(tmpdir(), "swarm-owner-race-"));
  const config = join(root, "owner.json");
  writeFileSync(
    config,
    JSON.stringify({
      databasePath: join(root, "db"),
      launcherSecret: randomBytes(32).toString("hex"),
    }),
    { mode: 0o600 },
  );
  // A candidate that lost the endpoint race exits non-zero before the winner
  // accepts connections. The marker lets the test order those two events.
  const loser = join(dir, "loser.mjs");
  const marker = join(root, "loser-exited");
  writeFileSync(
    loser,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\nprocess.exit(1);\n`,
  );
  const pending = ensureCoordinator({
    configPath: config,
    nodePath: Bun.which("node")!,
    ownerPath: loser,
    timeoutMs: 20000,
  });
  pending.catch(() => {});
  while (!existsSync(marker)) await delay(20);
  // Long enough for the launcher to observe that exit across several
  // connect attempts before any owner listens.
  await delay(1500);
  const winner = Bun.spawn({
    cmd: [Bun.which("node")!, output, config],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = winner.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!first.value) throw new Error(await new Response(winner.stderr).text());
    const result = await pending;
    try {
      expect(result.launched?.exitCode).toBe(1);
      expect(await result.client.request({ op: "compatibility" })).toBeTruthy();
    } finally {
      result.client.close();
    }
  } finally {
    winner.kill();
  }
}, 30000);
