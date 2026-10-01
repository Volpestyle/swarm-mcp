import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import {
  runDispatchIntent,
  type DispatchProvider,
} from "../src/coordination/dispatch-runner";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

test("a bound worker reclaims its own dispatched task after the lease lapses", async () => {
  let now = 1_000_000;
  const store = await CoordinationStore.open({
    path: join(mkdtempSync(join(tmpdir(), "dispatch-rebind-")), "db"),
    clock: () => now,
  });
  const enroll = (agentId: string) =>
    store.openSession({
      scope: "scope",
      agentId,
      requestId: agentId,
      resumeToken: `${agentId}-resume-secret-with-at-least-32-characters`,
    });
  const requester = enroll("creator"),
    worker = enroll("worker"),
    stranger = enroll("stranger");
  const intent: DispatchIntent = {
    intentId: "long-task",
    title: "Long task",
    capabilities: ["code"],
    durable: true,
    contract: {
      objective: "Long task",
      worktree: "/work",
      acceptanceCriteria: ["Done"],
      constraints: [],
      expectedArtifacts: [],
      progressTimeoutMs: 3600000,
    },
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
        host: "native",
        worktree: "/work",
        capabilities: ["code"],
        durable: true,
        availability: "idle",
        observedAt: now,
        active: 0,
        capacity: 1,
        overhead: 0,
        authorized: true,
      },
    ],
  };
  let started: string | undefined;
  const providers: DispatchProvider[] = [
    {
      routeId: "native",
      authorized: () => true,
      async start({ token }) {
        started = token;
        return { externalId: "pane", worker };
      },
      async find(token) {
        return started === token ? { externalId: "pane", worker } : null;
      },
      async stop(token) {
        return { stopped: started === token };
      },
    },
  ];
  try {
    const first = await runDispatchIntent({
      store,
      requester,
      intent,
      policy,
      providers,
    });
    if (!("attemptId" in first)) throw new Error("No dispatched attempt");
    expect(store.taskDetail("scope", first.taskId).owner!.progressDeadline).toBe(now + 3600000);

    now += 16 * 60_000;
    store.execute(
      { ...worker, id: "recover", type: "task.recover", payload: {} },
      (tx) => tx.tasks.recover({ taskId: first.taskId }),
    );
    const version = store.task("scope", first.taskId)!.version;
    const claim = (who: typeof worker, id: string) =>
      store.execute(
        { ...who, id, type: "task.claim", payload: {} },
        (tx) =>
          tx.tasks.claim({ taskId: first.taskId, expectedVersion: version }),
      ).value;

    expect(() => claim(stranger, "steal")).toThrow("reserved by dispatch");
    const again = claim(worker, "reclaim");
    expect(again.fence).toBeGreaterThan(first.fence);
    expect(store.taskDetail("scope", first.taskId).owner!.progressDeadline).toBe(now + 3600000);

    const finished = store.execute(
      { ...worker, id: "finish", type: "task.finish", payload: {} },
      (tx) =>
        tx.tasks.finish({
          taskId: first.taskId,
          attemptId: again.attemptId,
          fence: again.fence,
          outcome: "completed",
          result: { done: true },
        }),
    );
    expect(finished.replayed).toBe(false);
    expect(store.task("scope", first.taskId)?.status).toBe("completed");
  } finally {
    store.close();
  }
});
