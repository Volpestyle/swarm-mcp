import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import {
  runDispatchIntent,
  type DispatchProvider,
  type ProvisionedWorker,
} from "../src/coordination/dispatch-runner";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

for (const failure of ["lost-response", "timeout"] as const)
  test(`${failure} reconciles one task/worker across coordinator reopen without another start`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dispatch-runner-")), "db");
    let store = await CoordinationStore.open({ path });
    const enrollment = (agentId: string) => ({
      scope: "scope",
      agentId,
      requestId: agentId,
      resumeToken: `${agentId}-resume-secret-with-enough-characters`,
    });
    const requester = store.openSession(enrollment("requester"));
    const worker = store.openSession(enrollment("worker"));
    const intent: DispatchIntent = {
      intentId: "one-action",
      title: "Work",
      contract: {
        objective: "Work",
        worktree: "/work",
        acceptanceCriteria: ["Verified"],
        expectedArtifacts: [],
        constraints: [],
      },
      capabilities: ["code"],
      durable: true,
    };
    const policy: DispatchPolicy = {
      active: 0,
      maximum: 1,
      observationMaxAgeMs: 60000,
      routes: [
        {
          id: "peer",
          path: "peer",
          scope: "scope",
          host: "other",
          worktree: "/work",
          capabilities: ["code"],
          durable: true,
          availability: "idle",
          observedAt: Date.now(),
          active: 0,
          capacity: 1,
          overhead: 1,
          authorized: true,
        },
      ],
    };
    const external = new Map<string, ProvisionedWorker>();
    let starts = 0,
      lookups = 0,
      visible = false;
    const provider: DispatchProvider = {
      routeId: "peer",
      authorized: () => true,
      async start({ token }, signal) {
        starts++;
        external.set(token, { externalId: "existing-worker", worker });
        if (failure === "timeout")
          return await new Promise<ProvisionedWorker>((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("Timed out after acceptance")),
              { once: true },
            ),
          );
        throw new Error("Response lost after external acceptance");
      },
      async find(token) {
        lookups++;
        return visible ? (external.get(token) ?? null) : null;
      },
    };
    const run = () =>
      runDispatchIntent({
        store,
        requester,
        intent,
        policy,
        providers: [provider],
        timeoutMs: 20,
      });
    try {
      const first = await run();
      expect(first.status).toBe("uncertain");
      store.close();
      store = await CoordinationStore.open({ path });
      expect((await run()).status).toBe("uncertain");
      expect(starts).toBe(1);
      visible = true;
      const bound = await run();
      expect(bound.status).toBe("bound");
      expect((await run()).status).toBe("bound");
      expect(starts).toBe(1);
      expect(lookups).toBe(3);
      if (!("taskId" in bound) || !bound.taskId)
        throw new Error("Missing task");
      expect(store.attempts("scope", bound.taskId)).toHaveLength(1);
      expect(store.taskSummaries("scope").items).toHaveLength(1);
      const release = (stopped?: { token: string; routeId: string }) =>
        store.execute(
          {
            ...requester,
            id: crypto.randomUUID(),
            type: "dispatch.release",
            payload: {},
          },
          (tx) => tx.dispatch.release({ intentId: intent.intentId, stopped }),
        ).value;
      const stopped = { token: [...external.keys()][0]!, routeId: "peer" };
      expect(() => release(stopped)).toThrow("not terminal");
      if (!("attemptId" in bound)) throw new Error("Missing attempt");
      store.execute(
        { ...worker, id: "finish", type: "task.finish", payload: {} },
        (tx) =>
          tx.tasks.finish({
            taskId: bound.taskId,
            attemptId: bound.attemptId,
            fence: bound.fence,
            outcome: "completed",
          }),
      );
      expect(() => release()).toThrow("confirmed provider termination");
      expect(
        store.execute(
          {
            ...requester,
            id: "capacity-still-held",
            type: "dispatch.reserve",
            payload: {},
          },
          (tx) =>
            tx.dispatch.reserve({ ...intent, intentId: "next-action" }, policy),
        ).value.status,
      ).toBe("blocked");
      expect(() => release({ ...stopped, token: "wrong" })).toThrow(
        "confirmed provider termination",
      );
      expect(release(stopped).existing).toBe(false);
      expect(release(stopped).existing).toBe(true);
      expect((await run()).status).toBe("released");
      expect(starts).toBe(1);
      const next = store.execute(
        { ...requester, id: "next", type: "dispatch.reserve", payload: {} },
        (tx) =>
          tx.dispatch.reserve({ ...intent, intentId: "next-action" }, policy),
      ).value;
      expect(next.status).toBe("reserved");
    } finally {
      store.close();
    }
  });
