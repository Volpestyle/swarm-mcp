import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import {
  existingPeerProvider,
  cancelDispatchIntent,
  runDispatchIntent,
} from "../src/coordination/dispatch-runner";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

for (const outcome of ["completed", "cancelled"] as const)
  test(`existing peer ${outcome} from another Node process`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dispatch-peer-")), "db");
    const store = await CoordinationStore.open({
      path,
      inboxPolicy: { maxPendingPerRecipient: 1 },
    });
    const enroll = (agentId: string) =>
      store.openSession({
        scope: "scope",
        agentId,
        requestId: agentId,
        resumeToken: `${agentId}-resume-secret-with-more-than-32-characters`,
      });
    const requester = enroll("requester"),
      worker = enroll("worker");
    const intent: DispatchIntent = {
      intentId: "one",
      title: "Work",
      capabilities: ["code"],
      durable: true,
      contract: {
        objective: "Produce result",
        worktree: "/work",
        acceptanceCriteria: ["Result received"],
        expectedArtifacts: [],
        constraints: [],
      },
    };
    const policy: DispatchPolicy = {
      active: 0,
      maximum: 1,
      observationMaxAgeMs: 60000,
      routes: [
        {
          id: "existing",
          path: "peer",
          scope: "scope",
          host: "node",
          worktree: "/work",
          capabilities: ["code"],
          durable: true,
          availability: "idle",
          observedAt: Date.now(),
          active: 0,
          capacity: 1,
          overhead: 0,
          authorized: true,
        },
      ],
    };
    const providers = [
      existingPeerProvider({
        store,
        requester,
        routeId: "existing",
        worker,
        authorized: () => true,
      }),
    ];
    try {
      const run = () =>
        runDispatchIntent({ store, requester, intent, policy, providers });
      store.execute(
        { ...requester, id: "fill-inbox", type: "message.send", payload: {} },
        (tx) =>
          tx.inbox.send(
            { kind: "note", body: "Existing pending work" },
            [worker.actor],
            "direct",
          ),
      );
      await expect(run()).rejects.toThrow("pending-message quota");
      const reservedTask = store.taskSummaries("scope").items[0]!;
      expect(reservedTask.status).toBe("open");
      expect(store.attempts("scope", reservedTask.id)).toHaveLength(0);
      const old = store.execute(
        { ...worker, id: "fetch-old", type: "inbox.fetch", payload: {} },
        (tx) => tx.inbox.fetch({ consumer: "prior-work" }),
      ).value.deliveries[0]!;
      store.execute(
        { ...worker, id: "ack-old", type: "inbox.ack", payload: {} },
        (tx) =>
          tx.inbox.acknowledge({
            messageId: old.message.id,
            leaseToken: old.leaseToken,
          }),
      );
      const assigned = await run();
      expect(assigned.status).toBe("bound");
      expect((await run()).status).toBe("bound");
      const assignments = () =>
        store
          .inbox("scope", worker.actor)
          .items.filter((item) => item.message.kind === "task.assigned");
      expect(assignments()).toHaveLength(1);
      expect(assignments()[0]?.state).toBe("pending");
      const cancel = () =>
        cancelDispatchIntent({
          store,
          requester,
          intentId: intent.intentId,
          providers,
        });
      if (outcome === "cancelled") {
        await expect(cancel()).rejects.toThrow("pending-message quota");
        const assignment = store.execute(
          { ...worker, id: "admit", type: "inbox.fetch", payload: {} },
          (tx) => tx.inbox.fetch({ consumer: "admitted-work" }),
        ).value.deliveries[0]!;
        store.execute(
          { ...worker, id: "admit-ack", type: "inbox.ack", payload: {} },
          (tx) =>
            tx.inbox.acknowledge({
              messageId: assignment.message.id,
              leaseToken: assignment.leaseToken,
            }),
        );
        expect((await cancel()).status).toBe("uncertain");
        expect((await cancel()).status).toBe("uncertain");
        expect(
          store
            .inbox("scope", worker.actor)
            .items.filter((i) => i.message.kind === "task.cancel_requested"),
        ).toHaveLength(1);
      }
      mkdirSync(resolve("dist/test"), { recursive: true });
      const fixture = join(
        mkdtempSync(resolve("dist/test/dispatch-peer-")),
        "worker.mjs",
      );
      await build({
        entryPoints: ["test/fixtures/dispatch-peer-worker.ts"],
        outfile: fixture,
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
      });
      const child = Bun.spawn(
        [Bun.which("node")!, fixture, path, JSON.stringify(worker), outcome],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(stderr);
      const result = JSON.parse(stdout);
      expect(result.acknowledged).toBe(true);
      expect(store.task("scope", result.taskId)?.status).toBe(outcome);
      expect(store.attempts("scope", result.taskId)).toHaveLength(1);
      expect(assignments()[0]?.state).toBe("acknowledged");
      expect((await run()).status).toBe("bound");
      expect(assignments()).toHaveLength(1);
      expect((await cancel()).status).toBe("released");
      expect((await run()).status).toBe("released");
    } finally {
      store.close();
    }
  });
