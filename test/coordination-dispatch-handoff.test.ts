import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import {
  runDispatchIntent,
  cancelDispatchIntent,
  type DispatchProvider,
} from "../src/coordination/dispatch-runner";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

test("native-to-peer handoff retains one contract and rejects the old owner", async () => {
  const store = await CoordinationStore.open({
    path: join(mkdtempSync(join(tmpdir(), "dispatch-handoff-")), "db"),
  });
  const enroll = (agentId: string) =>
    store.openSession({
      scope: "scope",
      agentId,
      requestId: agentId,
      resumeToken: `${agentId}-resume-secret-with-at-least-32-characters`,
    });
  const requester = enroll("creator"),
    native = enroll("native"),
    peer = enroll("peer");
  const intent: DispatchIntent = {
    intentId: "one-contract",
    title: "Deliver artifact",
    capabilities: ["code"],
    durable: false,
    contract: {
      objective: "Deliver artifact",
      worktree: "/work",
      acceptanceCriteria: ["Verified artifact"],
      constraints: [],
      expectedArtifacts: ["artifact"],
    },
  };
  const route = (id: "native" | "peer", overhead: number) => ({
    id,
    path: id,
    scope: "scope",
    host: id,
    worktree: "/work",
    capabilities: ["code"],
    durable: true,
    availability: "idle" as const,
    observedAt: Date.now(),
    active: 0,
    capacity: 1,
    overhead,
    authorized: true,
  });
  const policy: DispatchPolicy = {
    active: 0,
    maximum: 1,
    observationMaxAgeMs: 60000,
    routes: [route("native", 0), route("peer", 1)],
  };
  const tokens = new Map<string, string>();
  const providers: DispatchProvider[] = [native, peer].map((worker, index) => {
    const routeId = index === 0 ? "native" : "peer";
    return {
      routeId,
      authorized: () => true,
      async start({ token, intent: supplied }) {
        expect(supplied).toEqual(intent);
        tokens.set(routeId, token);
        return { externalId: routeId, worker };
      },
      async find(token) {
        return tokens.get(routeId) === token
          ? { externalId: routeId, worker }
          : null;
      },
      async stop(token) {
        return { stopped: tokens.get(routeId) === token };
      },
    };
  });
  try {
    const first = await runDispatchIntent({
      store,
      requester,
      intent,
      policy,
      providers,
    });
    if (!("attemptId" in first)) throw new Error("No native attempt");
    const fallback = { ...policy, routes: [route("peer", 1)] };
    const reassign = (
      id: string,
      version: number,
      routes = fallback,
      input = intent,
    ) =>
      store.execute(
        {
          ...requester,
          id,
          type: "dispatch.reassign",
          payload: { intentId: input.intentId, version },
        },
        (tx) => tx.dispatch.reassign(input, routes, version),
      );
    expect(() => reassign("too-early", 2)).toThrow("must be released");
    expect(
      (
        await cancelDispatchIntent({
          store,
          requester,
          intentId: intent.intentId,
          providers,
        })
      ).status,
    ).toBe("released");
    const version = store.task("scope", first.taskId)!.version;
    const blocked = reassign("missing-capability", version, {
      ...fallback,
      routes: fallback.routes.map((r) => ({ ...r, capabilities: [] })),
    });
    expect(blocked.value.status).toBe("blocked");
    expect(store.task("scope", first.taskId)?.status).toBe("cancelled");
    expect(() =>
      reassign("changed-work", version, fallback, { ...intent, durable: true }),
    ).toThrow("different work");
    expect(() => reassign("stale-version", version - 1)).toThrow();
    expect(reassign("handoff", version).value.status).toBe("reserved");
    expect(reassign("handoff", version).replayed).toBe(true);
    const second = await runDispatchIntent({
      store,
      requester,
      intent,
      policy: fallback,
      providers,
    });
    if (!("attemptId" in second)) throw new Error("No peer attempt");
    expect(second.taskId).toBe(first.taskId);
    expect(second.fence).toBeGreaterThan(first.fence);
    expect(tokens.get("peer")).not.toBe(tokens.get("native"));
    expect(() =>
      store.execute(
        { ...requester, id: "late-bind", type: "dispatch.bind", payload: {} },
        (tx) =>
          tx.dispatch.bind({
            intentId: intent.intentId,
            token: tokens.get("native")!,
            routeId: "native",
            externalId: "native",
            worker: native,
          }),
      ),
    ).toThrow("does not match");
    const finish = (worker: typeof native, attempt: typeof first, id: string) =>
      store.execute(
        {
          ...worker,
          id,
          type: "task.finish",
          payload: { attemptId: attempt.attemptId },
        },
        (tx) =>
          tx.tasks.finish({
            taskId: attempt.taskId,
            attemptId: attempt.attemptId,
            fence: attempt.fence,
            outcome: "completed",
            result: { artifact: "verified" },
          }),
      );
    expect(() => finish(native, first, "late-native-result")).toThrow();
    expect(finish(peer, second, "peer-result").replayed).toBe(false);
    expect(finish(peer, second, "peer-result").replayed).toBe(true);
    expect(store.taskSummaries("scope").items).toHaveLength(1);
    expect(store.attempts("scope", first.taskId).map((a) => a.state)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(JSON.parse(store.task("scope", first.taskId)!.contract!)).toEqual(
      intent.contract,
    );
  } finally {
    store.close();
  }
});
