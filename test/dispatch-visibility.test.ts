/**
 * Positive-path regression coverage for dispatch's spawned-worker handoff.
 *
 * Complements the negative-path test in test/workspace_identity.test.ts
 * (`dispatch fails spawned handoff when worker cannot see the task`), which
 * asserts the dispatch_health check fires when the spawned worker can't see
 * its task. These tests assert the success case: when adoption goes
 * through normally, the worker's `tasks.get` and `tasks.list` find the
 * dispatched task. Also covers the late-adoption edge case where the
 * leased instance row expires before the worker calls register.
 *
 * Isolated from the user's real swarm DB by setting SWARM_DB_PATH to a
 * tmpdir before importing any module that touches the DB.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnerBackend, SpawnResult } from "../src/spawner_backend";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-dispatch-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const registry = await import("../src/registry");
const tasks = await import("../src/tasks");
const dispatch = await import("../src/dispatch");
const spawnerBackend = await import("../src/spawner_backend");

const originalAllowUnlabeled = process.env.SWARM_MCP_ALLOW_UNLABELED;
const originalPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.SWARM_MCP_ALLOW_UNLABELED = "1";
  process.env.SWARM_MCP_PERSONAL_ROOTS = "/tmp";
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
});

afterEach(() => {
  restoreEnv("SWARM_MCP_ALLOW_UNLABELED", originalAllowUnlabeled);
  restoreEnv("SWARM_MCP_PERSONAL_ROOTS", originalPersonalRoots);
});

describe("dispatch task visibility", () => {
  test("spawned worker can see the dispatched task via get_task and list_tasks", async () => {
    const scope = "/tmp/dispatch-vis";
    const cwd = "/tmp/dispatch-vis";

    // Gateway hermes-like instance.
    const gateway = registry.register(
      cwd,
      "identity:personal hermes mode:gateway role:planner",
      scope,
    );

    // A fake spawner that mimics herdr_spawner:
    //  - precreates a leased instance row with the gateway's scope
    //  - sets env vars (SWARM_MCP_SCOPE, SWARM_MCP_DIRECTORY, etc.)
    //  - synchronously adopts the leased row as if the codex worker came up
    //  - returns spawned_instance = leased.id
    let workerId: string | null = null;
    const fakeSpawner: SpawnerBackend = {
      name: "fake-test",
      defaultHarness: () => "cdx",
      defaultWaitSeconds: 2,
      async spawn(input): Promise<SpawnResult> {
        const leaseUntil =
          Math.floor(Date.now() / 1000) + Math.max(60, input.wait_seconds + 30);
        const leased = registry.precreateInstanceLease(
          input.cwd,
          "identity:personal role:researcher provider:cdx session:fake123",
          input.scope,
          input.cwd,
          leaseUntil,
        );

        // Simulate the worker booting and calling register with adopt_instance_id.
        // This is what tryAutoAdopt → registry.register(preassignedId=...) does
        // when SWARM_MCP_INSTANCE_ID + SWARM_MCP_SCOPE + SWARM_MCP_DIRECTORY are
        // injected by the spawner.
        const adopted = registry.register(
          input.cwd,
          "identity:personal role:researcher provider:cdx session:fake123",
          input.scope,
          input.cwd,
          leased.id, // preassignedId
        );
        workerId = adopted.id;

        return {
          status: "spawned",
          spawned_instance: adopted.id,
          expected_instance: leased.id,
          launch_token: input.launch_token,
        };
      },
    };

    spawnerBackend.registerSpawner(fakeSpawner);

    const payload = (await dispatch.runDispatch({
      scope,
      requester: gateway.id,
      title: "Test agent A bootstrap smoke test",
      type: "research",
      role: "researcher",
      spawner: "fake-test",
      cwd,
      nudge: false,
      wait_seconds: 2,
    })) as Record<string, unknown>;

    expect(payload.status).toBe("spawned");
    expect(workerId).not.toBeNull();

    const taskId = payload.task_id as string;
    expect(typeof taskId).toBe("string");

    // The "gateway view" — what hermes would see.
    const gatewayView = tasks.get(taskId, scope);
    expect(gatewayView).not.toBeNull();
    expect(gatewayView?.scope).toBe(scope);

    // The "worker view" — what the spawned codex would see when calling
    // get_task. This is where the bug manifests.
    const worker = registry.get(workerId!);
    expect(worker).not.toBeNull();
    expect(worker?.scope).toBe(scope);

    const workerView = tasks.get(taskId, worker!.scope, worker!);
    expect(workerView).not.toBeNull();
    expect(workerView?.id).toBe(taskId);

    // list_tasks from the worker's perspective should also include the task.
    const workerList = tasks.list(worker!.scope, { viewer: worker! });
    expect(workerList.some((t) => t.id === taskId)).toBe(true);
  });

  test("late-adoption: worker registers after the leased instance is reclaimed", async () => {
    const scope = "/tmp/dispatch-vis";
    const cwd = "/tmp/dispatch-vis";

    const gateway = registry.register(
      cwd,
      "identity:personal hermes mode:gateway role:planner",
      scope,
    );

    let leasedId: string | null = null;
    let workerId: string | null = null;
    const fakeSpawner: SpawnerBackend = {
      name: "fake-late",
      defaultHarness: () => "cdx",
      defaultWaitSeconds: 1,
      async spawn(input): Promise<SpawnResult> {
        // Precreate a leased instance with a lease that's already expired in
        // the past. This simulates the worker coming up after the lease has
        // lapsed (slow auth, slow MCP boot, etc.). The next prune() should
        // reclaim it before the worker calls register.
        const expiredLease = Math.floor(Date.now() / 1000) - 60;
        const leased = registry.precreateInstanceLease(
          input.cwd,
          "identity:personal role:researcher provider:cdx session:late123",
          input.scope,
          input.cwd,
          expiredLease,
        );
        leasedId = leased.id;

        // The gateway calls messages.send to the leased.id BEFORE the worker
        // is up (see promptPeerResult). Mimic that here.
        const messages = await import("../src/messages");
        messages.send(
          input.requester,
          input.scope,
          leased.id,
          `[task:fake] Test dispatch instruction`,
        );

        // Worker boots up and calls register with the leased.id as preassigned.
        // First call inside register triggers prune() which should reclaim the
        // expired-lease row and delete messages addressed to it.
        const adopted = registry.register(
          input.cwd,
          "identity:personal role:researcher provider:cdx session:late123",
          input.scope,
          input.cwd,
          leased.id,
        );
        workerId = adopted.id;

        return {
          status: "spawned",
          spawned_instance: adopted.id,
          expected_instance: leased.id,
          launch_token: input.launch_token,
        };
      },
    };
    spawnerBackend.registerSpawner(fakeSpawner);

    const payload = (await dispatch.runDispatch({
      scope,
      requester: gateway.id,
      title: "Late adoption test",
      type: "research",
      role: "researcher",
      spawner: "fake-late",
      cwd,
      nudge: false,
      wait_seconds: 1,
    })) as Record<string, unknown>;

    expect(workerId).not.toBeNull();
    const taskId = payload.task_id as string;
    const worker = registry.get(workerId!);
    expect(worker).not.toBeNull();
    expect(worker?.scope).toBe(scope);

    // Did the worker keep the leased id, or did it get a fresh uuid because
    // the leased row was already deleted?
    if (leasedId) {
      // This is the key invariant: workerId should equal leasedId because the
      // dispatched task and the gateway's outgoing message both target leasedId.
      expect(workerId).toBe(leasedId);
    }

    // Worker should be able to see the dispatched task.
    const workerView = tasks.get(taskId, worker!.scope, worker!);
    expect(workerView).not.toBeNull();
  });
});
