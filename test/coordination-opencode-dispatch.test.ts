import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { CoordinationStore } from "../src/coordination/store";
import { openCodeDispatchProvider } from "../src/coordination/opencode-dispatch";
import { runDispatchIntent } from "../src/coordination/dispatch-runner";
import type {
  DispatchIntent,
  DispatchPolicy,
} from "../src/coordination/dispatch";

for (const lostResponse of [false, true])
  test(`OpenCode creation persists identity before enrollment (lost response=${lostResponse})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-dispatch-"));
    const path = join(root, "db");
    let store = await CoordinationStore.open({ path });
    const enroll = (agentId: string) =>
      store.openSession({
        scope: "scope",
        agentId,
        requestId: agentId,
        resumeToken: `${agentId}-resume-secret-with-at-least-32-characters`,
      });
    const requester = enroll("requester"),
      worker = enroll("worker");
    const permission = [{ permission: "bash", pattern: "*", action: "ask" }];
    let childParent = "parent";
    let creates = 0,
      enrolled = false;
    const requests: string[] = [];
    const api = createOpencodeClient({
      baseUrl: "http://fixture",
      fetch: (async (request: Request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/session" && request.method === "POST") {
          creates++;
          const body = await request.json();
          expect(body.parentID).toBe("parent");
          expect(body.permission).toEqual(permission);
          if (lostResponse)
            throw new Error("Lost create response after acceptance");
          return Response.json({
            id: "child",
            parentID: childParent,
            directory: root,
            time: {},
          });
        }
        if (url.pathname === "/session/parent")
          return Response.json({
            id: "parent",
            directory: root,
            time: {},
            permission,
          });
        if (url.pathname === "/session/child")
          return Response.json({
            id: "child",
            parentID: childParent,
            directory: root,
            time: {},
          });
        throw new Error("Unexpected host request");
      }) as typeof fetch,
    });
    const intent: DispatchIntent = {
      intentId: "native-work",
      title: "Work",
      capabilities: ["code"],
      durable: false,
      contract: {
        objective: "Work",
        worktree: root,
        acceptanceCriteria: ["Works"],
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
          id: "native",
          path: "native",
          scope: "scope",
          host: "opencode",
          worktree: root,
          capabilities: ["code"],
          durable: false,
          availability: "idle",
          observedAt: Date.now(),
          active: 0,
          capacity: 1,
          overhead: 0,
          authorized: true,
        },
      ],
    };
    const run = () =>
      runDispatchIntent({
        store,
        requester,
        intent,
        policy,
        providers: [
          openCodeDispatchProvider({
            store,
            requester,
            api,
            parentSessionId: "parent",
            directory: root,
            routeId: "native",
            authorized: () => true,
            resolveWorker: async (id) => {
              expect(id).toBe("child");
              return enrolled ? worker : null;
            },
          }),
        ],
      });
    try {
      expect((await run()).status).toBe("uncertain");
      expect(creates).toBe(1);
      store.close();
      store = await CoordinationStore.open({ path });
      enrolled = true;
      if (!lostResponse) {
        childParent = "different-parent";
        expect((await run()).status).toBe("uncertain");
        expect(store.inbox("scope", worker.actor).items).toHaveLength(0);
        childParent = "parent";
      }
      expect((await run()).status).toBe(lostResponse ? "uncertain" : "bound");
      expect((await run()).status).toBe(lostResponse ? "uncertain" : "bound");
      expect(creates).toBe(1);
      expect(store.inbox("scope", worker.actor).items).toHaveLength(
        lostResponse ? 0 : 1,
      );
      expect(requests.filter((r) => r === "GET /session")).toHaveLength(0);
    } finally {
      store.close();
    }
  });
