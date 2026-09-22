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
    const run = async (context: typeof alice, begin = false) => {
      const child = Bun.spawn(
        [
          Bun.which("node")!,
          worker,
          path,
          JSON.stringify({ context, input, policy, begin }),
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
    expect(() =>
      store.execute(
        { ...bob, id: "steal", type: "task.claim", payload: {} },
        (tx) =>
          tx.tasks.claim({ taskId: results[0].taskId, expectedVersion: 1 }),
      ),
    ).toThrow("reserved by dispatch");
    const starts = await Promise.all([run(alice, true), run(bob, true)]);
    expect(starts.filter((result) => result.start)).toHaveLength(1);
    expect(starts[0].token).toBe(starts[1].token);
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
      const retryStart = reopened.execute(
        {
          ...bob,
          id: "resume-provisioning",
          type: "dispatch.begin",
          payload: {},
        },
        (tx) => tx.dispatch.begin(input.intentId),
      ).value;
      expect(retryStart).toMatchObject({
        start: false,
        token: starts[0].token,
      });
      const worker = enroll("worker");
      const binding = {
        intentId: input.intentId,
        token: starts[0].token,
        routeId: "native",
        externalId: "native-thread",
        worker,
      };
      const bind = (id: string, value = binding) =>
        reopened.execute(
          { ...alice, id, type: "dispatch.bind", payload: value },
          (tx) => tx.dispatch.bind(value),
        ).value;
      const accepted = bind("bind-first");
      expect(bind("bind-retry")).toEqual({ ...accepted, existing: true });
      expect(reopened.attempts("scope", results[0].taskId)).toHaveLength(1);
      expect(() => bind("bind-other", { ...binding, worker: bob })).toThrow(
        "another worker",
      );
      expect(reopened.task("scope", results[0].taskId)?.status).toBe("running");
      const finishPayload = {
        taskId: accepted.taskId,
        attemptId: accepted.attemptId,
        fence: accepted.fence,
        outcome: "completed" as const,
        result: { artifact: "verified-result" },
      };
      expect(() =>
        reopened.execute(
          {
            ...bob,
            id: "wrong-completion",
            type: "task.finish",
            payload: finishPayload,
          },
          (tx) => tx.tasks.finish(finishPayload),
        ),
      ).toThrow();
      const finish = () =>
        reopened.execute(
          {
            ...worker,
            id: "native-completion",
            type: "task.finish",
            payload: finishPayload,
          },
          (tx) => tx.tasks.finish(finishPayload),
        );
      expect(finish().replayed).toBe(false);
      expect(finish().replayed).toBe(true);
      expect(reopened.task("scope", accepted.taskId)?.status).toBe("completed");
      const cancelled = reopened.execute(
        {
          ...alice,
          id: "reserve-cancel",
          type: "dispatch.reserve",
          payload: {},
        },
        (tx) =>
          tx.dispatch.reserve(
            { ...input, intentId: "cancel-before-start" },
            {
              ...policy,
              maximum: 2,
              routes: policy.routes.map((route) => ({ ...route, capacity: 2 })),
            },
          ),
      ).value;
      if (!("taskId" in cancelled))
        throw new Error("Cancellation fixture was not reserved");
      reopened.execute(
        {
          ...alice,
          id: "cancel-before-start",
          type: "task.cancel",
          payload: {},
        },
        (tx) =>
          tx.tasks.cancel({ taskId: cancelled.taskId, expectedVersion: 1 }),
      );
      expect(() =>
        reopened.execute(
          {
            ...alice,
            id: "begin-cancelled",
            type: "dispatch.begin",
            payload: {},
          },
          (tx) => tx.dispatch.begin("cancel-before-start"),
        ),
      ).toThrow("no longer open");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
});
