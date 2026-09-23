import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import { ownerDispatch } from "../src/coordination/owner-dispatch";
import {
  agentState,
  retainedAgentId,
} from "../src/coordination/launcher-state";
import { canonicalPath } from "../src/coordination/worktrees";

test("configured native route resolves retained plugin identity without reenrollment", async () => {
  const root = mkdtempSync(join(tmpdir(), "owner-native-")),
    stateDirectory = join(root, "private");
  const store = await CoordinationStore.open({ path: join(root, "db") });
  const parent = store.openSession({
    scope: "scope",
    agentId: "parent",
    requestId: "parent",
    resumeToken: "parent-resume-secret-at-least-32-characters",
    worktree: { root, repository: root },
  });
  let creates = 0;
  const host = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/session") {
        creates++;
        return Response.json({
          id: "child",
          parentID: "parent",
          directory: root,
          time: {},
        });
      }
      if (path === "/session/parent")
        return Response.json({
          id: "parent",
          directory: root,
          time: {},
          permission: [],
        });
      if (path === "/session/child")
        return Response.json({
          id: "child",
          parentID: "parent",
          directory: root,
          time: {},
        });
      return new Response("Unexpected request", { status: 404 });
    },
  });
  try {
    expect(
      await retainedAgentId(stateDirectory, "scope", "opencode", "child"),
    ).toBeNull();
    expect(existsSync(stateDirectory)).toBe(false);
    const core = new CoordinationCore(
      store,
      ownerDispatch(store, {
        maximum: 1,
        observationMaxAgeMs: 60000,
        peers: [],
        opencode: [
          {
            id: "native",
            parent: {
              scope: parent.scope,
              actor: parent.actor,
              sessionId: parent.sessionId,
              generation: parent.generation,
            },
            parentSessionId: "parent",
            baseUrl: host.url.href,
            stateDirectory,
            capabilities: ["code"],
            durable: false,
            capacity: 1,
            overhead: 0,
          },
        ],
      }),
    );
    const input = {
      action: "assign" as const,
      intent: {
        intentId: "native-intent",
        title: "Work",
        capabilities: ["code"],
        durable: false,
        contract: {
          objective: "Work",
          worktree: canonicalPath(root),
          acceptanceCriteria: ["Verified"],
          expectedArtifacts: [],
          constraints: [],
        },
      },
    };
    expect((await core.dispatch(parent, input)).status).toBe("blocked");
    expect(creates).toBe(0);
    store.execute(
      { ...parent, id: "busy", type: "session.observe", payload: {} },
      (tx) => tx.sessions.observe({ runtime: "busy" }),
    );
    expect((await core.dispatch(parent, input)).status).toBe("uncertain");
    expect(creates).toBe(1);
    // Simulate the trusted plugin enrolling the child after its native event.
    const identity = await agentState(
      stateDirectory,
      "scope",
      "opencode",
      "child",
    );
    const worker = store.openSession({
      scope: "scope",
      ...identity,
      requestId: "plugin-incarnation",
      worktree: { root, repository: root },
    });
    expect((await core.dispatch(parent, input)).status).toBe("bound");
    expect((await core.dispatch(parent, input)).status).toBe("bound");
    expect(creates).toBe(1);
    expect(store.currentSession("scope", worker.actor)?.generation).toBe(1);
    expect(store.inbox("scope", worker.actor).items).toHaveLength(1);
  } finally {
    host.stop(true);
    store.close();
  }
}, 30000);
