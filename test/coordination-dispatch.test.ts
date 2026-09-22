import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore, type Json } from "../src/coordination/store";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

test("concurrent Node dispatch reservations share one task and retain capacity across restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dispatch-intent-")), "db");
  const store = await CoordinationStore.open({ path });
  const enroll = (agentId: string) =>
    store.openSession({
      scope: "scope",
      agentId,
      requestId: agentId,
      resumeToken: `${agentId}-resume-secret-is-long-enough-for-enrollment`,
    });
  const alice = enroll("alice"),
    bob = enroll("bob");
  const input: DispatchIntent = {
    intentId: "same-user-action",
    title: "Implement feature",
    contract: {
      objective: "Implement feature",
      worktree: "/work",
      acceptanceCriteria: ["Works"],
      expectedArtifacts: [],
      constraints: [],
    },
    capabilities: ["code"],
    durable: false,
  };
  const policy: DispatchPolicy = {
    active: 0,
    maximum: 1,
    observationMaxAgeMs: 60000,
    routes: [
      {
        id: "native",
        path: "native",
        scope: "scope",
        host: "codex",
        worktree: "/work",
        capabilities: ["code"],
        durable: false,
        availability: "idle",
        observedAt: Date.now(),
        active: 0,
        capacity: 1,
        overhead: 1,
        authorized: true,
      },
    ],
  };
  mkdirSync(resolve("dist/test"), { recursive: true });
  const worker = join(
    mkdtempSync(resolve("dist/test/dispatch-")),
    "worker.mjs",
  );
  await build({
    entryPoints: ["test/fixtures/dispatch-worker.ts"],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  try {
    const run = async (context: typeof alice) => {
      const child = Bun.spawn(
        [
          Bun.which("node")!,
          worker,
          path,
          JSON.stringify({ context, input, policy }),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(stderr);
      return JSON.parse(stdout);
    };
    const results = await Promise.all([run(alice), run(bob)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].taskId).toBe(results[1].taskId);
    expect(store.task("scope", results[0].taskId)?.status).toBe("open");
    const reopened = await CoordinationStore.open({ path });
    try {
      const reserve = (id: string, intent: DispatchIntent) =>
        reopened.execute(
          {
            ...bob,
            id,
            type: "dispatch.reserve",
            payload: intent as unknown as Json,
          },
          (tx) => tx.dispatch.reserve(intent, policy),
        ).value;
      expect(reserve("retry-after-restart", input)).toMatchObject({
        created: false,
        taskId: results[0].taskId,
      });
      expect(
        reserve("another-intent", { ...input, intentId: "second-action" }),
      ).toEqual({ status: "blocked", reasons: ["concurrency_budget"] });
      expect(() =>
        reserve("changed-work", { ...input, title: "Different work" }),
      ).toThrow("different work");
      expect(reopened.taskSummaries("scope").items).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});
