/**
 * S7 — No-double-spawn under retry (both layers + cross-instance).
 *
 * The live smoke test for the §5.5 no-double-spawn protocol described in
 * `integrations/hermes/SPEC.md` §10.1 S7 and §5.5. A passing S7 is the proof
 * that the layered defense actually short-circuits duplicate spawns.
 *
 * Layered defense, in order:
 *   1. Task idempotency  — `request_task` with the same `idempotency_key`
 *      returns the existing task row. Catches almost all gateway retries.
 *   2. Spawn mutex       — `lock_file("/__swarm/spawn/<role>/<intent_hash>",
 *      exclusive=true)` conflicts on any pre-existing lock (including one
 *      held by the same gateway), so the second concurrent dispatch
 *      short-circuits to `spawn_in_flight` instead of firing a second spawn.
 *   3. Cross-instance    — two distinct gateway instances racing the same
 *      dispatch intent must also collapse onto a single spawn via the
 *      database-level UNIQUE INDEX on the lock path.
 *
 * Isolated from the user's real swarm DB by setting SWARM_DB_PATH to a
 * tmpdir before importing any module that touches the DB.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-s7-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const registry = await import("../src/registry");
const tasks = await import("../src/tasks");
const dispatch = await import("../src/dispatch");
const context = await import("../src/context");
const spawnerBackend = await import("../src/spawner_backend");

const originalAllowUnlabeled = process.env.SWARM_MCP_ALLOW_UNLABELED;
const originalPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function resetDb() {
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
}

beforeEach(() => {
  process.env.SWARM_MCP_ALLOW_UNLABELED = "1";
  process.env.SWARM_MCP_PERSONAL_ROOTS = "/tmp";
  resetDb();
});

afterEach(() => {
  restoreEnv("SWARM_MCP_ALLOW_UNLABELED", originalAllowUnlabeled);
  restoreEnv("SWARM_MCP_PERSONAL_ROOTS", originalPersonalRoots);
});

/**
 * Counting fake spawner that blocks inside `spawn` until released. Lets the
 * test interleave a second `runDispatch` call between lock acquisition and
 * spawn completion, then confirm the second call short-circuited without
 * invoking `spawn` again.
 */
function makeBlockingSpawner(name: string) {
  let releaseBlock!: () => void;
  const block = new Promise<void>((resolve) => {
    releaseBlock = resolve;
  });
  let spawnCount = 0;
  const spawnedWorkerIds: string[] = [];

  const backend: spawnerBackend.SpawnerBackend = {
    name,
    defaultHarness: () => "cdx",
    defaultWaitSeconds: 2,
    async spawn(input): Promise<spawnerBackend.SpawnResult> {
      spawnCount += 1;
      // Hold the spawn open so a concurrent runDispatch races against the
      // already-acquired spawn lock instead of finding a live worker.
      await block;

      const leaseUntil =
        Math.floor(Date.now() / 1000) + Math.max(60, input.wait_seconds + 30);
      const label = `identity:personal role:${input.role} provider:fake session:${name}-${spawnCount}`;
      const leased = registry.precreateInstanceLease(
        input.cwd,
        label,
        input.scope,
        input.cwd,
        leaseUntil,
      );
      const adopted = registry.register(
        input.cwd,
        label,
        input.scope,
        input.cwd,
        leased.id,
      );
      spawnedWorkerIds.push(adopted.id);

      return {
        status: "spawned",
        spawned_instance: adopted.id,
        expected_instance: leased.id,
        launch_token: input.launch_token,
      };
    },
  };
  spawnerBackend.registerSpawner(backend);

  return {
    backend,
    release: () => releaseBlock(),
    counts: () => ({ spawnCount, spawnedWorkerIds }),
  };
}

function spawnLocksFor(scope: string) {
  return db
    .query(
      "SELECT file, instance_id FROM context WHERE scope = ? AND type = 'lock' AND file LIKE '/__swarm/spawn/%'",
    )
    .all(scope) as Array<{ file: string; instance_id: string }>;
}

describe("S7: no-double-spawn under retry", () => {
  test("Layer 1: request_task with the same idempotency_key returns the existing task", () => {
    const scope = "/tmp/s7-layer1";
    const requester = registry.register(
      scope,
      "identity:personal hermes mode:gateway role:planner",
      scope,
    );

    const key = "linear:VUH-30:layer1";
    const first = tasks.request(
      requester.id,
      scope,
      "implement",
      "Layer 1 idempotency probe",
      { idempotency_key: key },
    );
    const second = tasks.request(
      requester.id,
      scope,
      "implement",
      "Layer 1 idempotency probe (duplicate)",
      { idempotency_key: key },
    );

    expect("error" in first ? first.error : null).toBeNull();
    expect("error" in second ? second.error : null).toBeNull();
    if ("error" in first || "error" in second) {
      throw new Error("expected both task.request calls to succeed");
    }

    expect(second.id).toBe(first.id);
    expect(second.existing).toBe(true);

    const rows = db
      .query("SELECT id FROM tasks WHERE scope = ? AND idempotency_key = ?")
      .all(scope, key) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  test("Layer 2: concurrent dispatches from the same gateway fire exactly one spawn", async () => {
    const scope = "/tmp/s7-layer2";
    const cwd = "/tmp/s7-layer2";
    const gateway = registry.register(
      cwd,
      "identity:personal hermes mode:gateway role:planner",
      scope,
    );

    const spawner = makeBlockingSpawner("fake-s7-layer2");
    const idempotencyKey = "linear:VUH-30:layer2";

    // Kick off the first dispatch. It synchronously acquires the spawn lock
    // and parks inside `await spawner.spawn(...)`, yielding to the event loop.
    const promiseA = dispatch.runDispatch({
      scope,
      requester: gateway.id,
      title: "S7 layer-2 single-gateway race",
      type: "implement",
      role: "implementer",
      spawner: spawner.backend.name,
      cwd,
      nudge: false,
      wait_seconds: 1,
      idempotency_key: idempotencyKey,
    });

    // Verify the spawn lock is in place before B runs.
    const locksBeforeB = spawnLocksFor(scope);
    expect(locksBeforeB).toHaveLength(1);
    expect(locksBeforeB[0].file.startsWith("/__swarm/spawn/implementer/")).toBe(true);

    // Second dispatch with the same idempotency key. Layer 1 returns the
    // existing task; Layer 2 sees the lock and short-circuits to in-flight.
    const promiseB = dispatch.runDispatch({
      scope,
      requester: gateway.id,
      title: "S7 layer-2 single-gateway race (retry)",
      type: "implement",
      role: "implementer",
      spawner: spawner.backend.name,
      cwd,
      nudge: false,
      wait_seconds: 1,
      idempotency_key: idempotencyKey,
    });

    // Release the spawn so A can finish.
    spawner.release();
    const [a, b] = (await Promise.all([promiseA, promiseB])) as Array<
      Record<string, unknown>
    >;

    const { spawnCount, spawnedWorkerIds } = spawner.counts();
    expect(spawnCount).toBe(1);
    expect(spawnedWorkerIds).toHaveLength(1);

    expect(a.task_id).toBe(b.task_id);
    expect(a.status).toBe("spawned");
    expect(b.status).toBe("spawn_in_flight");
    expect(b.lock).toBeTruthy();

    // Exactly one task row.
    const taskRows = db
      .query("SELECT id FROM tasks WHERE scope = ? AND idempotency_key = ?")
      .all(scope, idempotencyKey) as Array<{ id: string }>;
    expect(taskRows).toHaveLength(1);

    // Spawn lock must be cleared after the successful spawn.
    expect(spawnLocksFor(scope)).toHaveLength(0);
  });

  test("Cross-instance: two gateway instances racing the same intent fire exactly one spawn", async () => {
    const scope = "/tmp/s7-cross";
    const cwd = "/tmp/s7-cross";
    const gatewayOne = registry.register(
      cwd,
      "identity:personal hermes mode:gateway role:planner session:s7-cross-A",
      scope,
    );
    const gatewayTwo = registry.register(
      cwd,
      "identity:personal hermes mode:gateway role:planner session:s7-cross-B",
      scope,
    );
    expect(gatewayOne.id).not.toBe(gatewayTwo.id);

    const spawner = makeBlockingSpawner("fake-s7-cross");
    const idempotencyKey = "linear:VUH-30:cross-instance";

    const promiseA = dispatch.runDispatch({
      scope,
      requester: gatewayOne.id,
      title: "S7 cross-instance race",
      type: "implement",
      role: "implementer",
      spawner: spawner.backend.name,
      cwd,
      nudge: false,
      wait_seconds: 1,
      idempotency_key: idempotencyKey,
    });

    const locksBeforeB = spawnLocksFor(scope);
    expect(locksBeforeB).toHaveLength(1);
    expect(locksBeforeB[0].instance_id).toBe(gatewayOne.id);

    const promiseB = dispatch.runDispatch({
      scope,
      requester: gatewayTwo.id,
      title: "S7 cross-instance race (retry from peer gateway)",
      type: "implement",
      role: "implementer",
      spawner: spawner.backend.name,
      cwd,
      nudge: false,
      wait_seconds: 1,
      idempotency_key: idempotencyKey,
    });

    spawner.release();
    const [a, b] = (await Promise.all([promiseA, promiseB])) as Array<
      Record<string, unknown>
    >;

    const { spawnCount } = spawner.counts();
    expect(spawnCount).toBe(1);

    // Both gateways must converge on the same task row.
    expect(a.task_id).toBe(b.task_id);
    expect(a.status).toBe("spawned");
    expect(b.status).toBe("spawn_in_flight");
    expect(b.lock).toBeTruthy();

    const taskRows = db
      .query("SELECT id FROM tasks WHERE scope = ? AND idempotency_key = ?")
      .all(scope, idempotencyKey) as Array<{ id: string }>;
    expect(taskRows).toHaveLength(1);

    // Spawn lock must be cleared after the successful spawn.
    expect(spawnLocksFor(scope)).toHaveLength(0);
  });
});
