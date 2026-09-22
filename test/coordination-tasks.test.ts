import { afterEach, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore, type Task } from "../src/coordination/store";
import { CoordinationCore, type CoreCommand } from "../src/coordination/core";
const stores: CoordinationStore[] = [];
let nodeFixture: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeFixture = join(mkdtempSync(resolve("dist/test/tasks-")), "worker.mjs");
  await build({
    entryPoints: ["test/fixtures/task-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: nodeFixture,
  });
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  let now = 1000;
  const path = join(
    mkdtempSync(join(tmpdir(), "coordination-tasks-")),
    "db.sqlite",
  );
  const store = await CoordinationStore.open({ path, clock: () => now });
  stores.push(store);
  const core = new CoordinationCore(store);
  const enroll = (agentId: string) => ({
    scope: "test",
    agentId,
    requestId: `enroll-${agentId}`,
    resumeToken: randomBytes(32).toString("hex"),
  });
  const ae = enroll("alice"),
    be = enroll("bob"),
    ce = enroll("carol");
  const alice = store.openSession(ae),
    bob = store.openSession(be),
    carol = store.openSession(ce);
  let seq = 0;
  const create = (dependencies?: string[]) =>
    (
      core.command(alice, {
        id: `create-${++seq}`,
        type: "task.create",
        payload: { title: "work", ...(dependencies ? { dependencies } : {}) },
      }).value as unknown as { task: Task }
    ).task;
  const claim = (task: Task, actor = bob, leaseMs = 100) =>
    core.command(actor, {
      id: `claim-${++seq}`,
      type: "task.claim",
      payload: { taskId: task.id, expectedVersion: task.version, leaseMs },
    }).value as unknown as {
      attemptId: string;
      fence: number;
      leaseUntil: number;
      task: Task;
    };
  return {
    store,
    core,
    path,
    alice,
    bob,
    carol,
    be,
    create,
    claim,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("task contracts survive restart and invalid creation rolls back for retry", async () => {
  const env = await fixture();
  const contract = {
    objective: "Make delivery survive restart",
    worktree: "C:/work/repo",
    acceptanceCriteria: ["Restart after commit retains accepted work"],
    expectedArtifacts: ["test report"],
    constraints: ["Keep the live database unchanged"],
  };
  const command = {
    id: "contract",
    type: "task.create" as const,
    payload: { title: "delivery", contract },
  };
  expect(() =>
    env.core.command(env.alice, {
      ...command,
      payload: {
        ...command.payload,
        contract: { ...contract, acceptanceCriteria: [] },
      },
    }),
  ).toThrow("acceptanceCriteria");
  const created = env.core.command(env.alice, command);
  const task = (created.value as unknown as { task: Task }).task;
  expect(JSON.parse(task.contract!)).toEqual(contract);
  env.claim(task);
  env.store.close();
  const reopened = await CoordinationStore.open({
    path: env.path,
    clock: () => 1000,
  });
  stores.push(reopened);
  const core = new CoordinationCore(reopened);
  expect(JSON.parse(core.task(env.alice, task.id)!.contract!)).toEqual(
    contract,
  );
  expect(core.attempts(env.alice, task.id)[0]!.actor).toBe("bob");
  expect(core.command(env.alice, command).replayed).toBe(true);
  expect(() =>
    core.command(env.alice, {
      ...command,
      id: "oversize",
      payload: {
        ...command.payload,
        contract: {
          ...contract,
          constraints: Array(20).fill("x".repeat(1000)),
        },
      },
    }),
  ).toThrow("8 KiB");
});

test("bounded waits resume the same task without cancellation or duplicated attempts", async () => {
  const env = await fixture();
  const task = env.create(),
    claim = env.claim(task);
  const timedOut = await env.core.waitForTask(env.alice, task.id, 1);
  expect(timedOut).toMatchObject({
    taskId: task.id,
    waitState: "timeout",
    task: { status: "running", current_attempt: claim.attemptId },
  });
  const abort = new AbortController();
  const waiting = env.core.waitForTask(env.alice, task.id, 30000, abort.signal);
  abort.abort();
  expect(await waiting).toMatchObject({
    taskId: task.id,
    waitState: "interrupted",
  });
  expect(env.core.attempts(env.alice, task.id)).toHaveLength(1);
  const resumed = env.core.waitForTask(env.alice, task.id, 30000);
  env.core.command(env.bob, {
    id: "finish-waited",
    type: "task.finish",
    payload: {
      taskId: task.id,
      attemptId: claim.attemptId,
      fence: claim.fence,
      outcome: "completed",
      result: { summary: "verified", evidence: ["test log"], limitations: [] },
    },
  });
  expect(await resumed).toMatchObject({
    taskId: task.id,
    waitState: "terminal",
    task: { status: "completed" },
  });
  expect(await env.core.waitForTask(env.alice, task.id, 0)).toMatchObject({
    waitState: "terminal",
  });
  expect(env.core.attempts(env.alice, task.id)).toHaveLength(1);
  expect(() => env.core.waitForTask(env.alice, "absent", 10)).toThrow(
    "does not exist",
  );
});

test("completion racing with a wait timeout is observed without another mutation", async () => {
  const env = await fixture();
  const task = env.create(),
    claim = env.claim(task);
  const finished = new Promise<void>((resolve) =>
    setTimeout(() => {
      env.core.command(env.bob, {
        id: "finish-at-deadline",
        type: "task.finish",
        payload: {
          taskId: task.id,
          attemptId: claim.attemptId,
          fence: claim.fence,
          outcome: "completed",
        },
      });
      resolve();
    }, 1),
  );
  const first = await env.core.waitForTask(env.alice, task.id, 1);
  await finished;
  // Either ordering is valid; the resumed read must always observe the commit.
  expect(["terminal", "timeout"]).toContain(first.waitState);
  expect((await env.core.waitForTask(env.alice, task.id, 0)).waitState).toBe(
    "terminal",
  );
  expect(env.core.attempts(env.alice, task.id)).toHaveLength(1);
});

test("expired ownership is recovered once and stale completion cannot overwrite its replacement", async () => {
  const env = await fixture();
  const task = env.create(),
    first = env.claim(task);
  env.advance(100);
  expect(() =>
    env.core.command(env.bob, {
      id: "late",
      type: "task.finish",
      payload: {
        taskId: task.id,
        attemptId: first.attemptId,
        fence: first.fence,
        outcome: "completed",
      },
    }),
  ).toThrow("expired");
  const recovered = env.core.command(env.alice, {
    id: "recover",
    type: "task.recover",
    payload: { taskId: task.id },
  });
  expect((recovered.value as { recovered: boolean }).recovered).toBe(true);
  const duplicate = env.core.command(env.alice, {
    id: "recover-again",
    type: "task.recover",
    payload: { taskId: task.id },
  });
  expect((duplicate.value as { recovered: boolean }).recovered).toBe(false);
  const second = env.claim(env.core.task(env.alice, task.id)!, env.carol);
  expect(second.fence).toBe(first.fence + 1);
  expect(() =>
    env.core.command(env.bob, {
      id: "stale-renew",
      type: "task.renew",
      payload: {
        taskId: task.id,
        attemptId: first.attemptId,
        fence: first.fence,
      },
    }),
  ).toThrow("replaced");
  env.core.command(env.carol, {
    id: "finish",
    type: "task.finish",
    payload: {
      taskId: task.id,
      attemptId: second.attemptId,
      fence: second.fence,
      outcome: "completed",
      result: { answer: 42 },
    },
  });
  expect(env.core.task(env.alice, task.id)!.status).toBe("completed");
  const history = env.core.attempts(env.alice, task.id);
  expect(history.map((a) => a.state)).toEqual(["abandoned", "completed"]);
  expect(history[0]!.reason).toBe("lease_expired");
  expect(history[1]!.result).toEqual({ answer: 42 });
});
test("suspended owner is recoverable and cannot resume its old task attempt", async () => {
  const env = await fixture(),
    task = env.create(),
    attempt = env.claim(task);
  env.core.command(env.bob, {
    id: "suspend",
    type: "session.suspend",
    payload: {},
  });
  env.core.command(env.alice, {
    id: "recover",
    type: "task.recover",
    payload: { taskId: task.id },
  });
  const resumed = env.store.openSession({ ...env.be, requestId: "resume" });
  expect(() =>
    env.core.command(resumed, {
      id: "stale",
      type: "task.renew",
      payload: {
        taskId: task.id,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
      },
    }),
  ).toThrow("replaced");
  expect(env.claim(env.core.task(env.alice, task.id)!, resumed).fence).toBe(2);
});

test("long tool lease renewal is independent of heartbeat and model progress", async () => {
  const env = await fixture();
  const task = env.create(),
    attempt = env.claim(task);
  env.advance(90);
  env.core.command(env.bob, {
    id: "busy",
    type: "session.observe",
    payload: { runtime: "busy", transport: true },
  });
  env.core.command(env.bob, {
    id: "renew",
    type: "task.renew",
    payload: {
      taskId: task.id,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      leaseMs: 200,
    },
  });
  env.advance(100);
  expect(() =>
    env.core.command(env.alice, {
      id: "recover",
      type: "task.recover",
      payload: { taskId: task.id },
    }),
  ).toThrow("valid lease");
  expect(env.core.attempts(env.alice, task.id)[0]!.progress_at).toBeNull();
  env.advance(101);
  env.core.command(env.bob, {
    id: "heartbeat",
    type: "session.observe",
    payload: { transport: true },
  });
  env.core.command(env.alice, {
    id: "recover-expired",
    type: "task.recover",
    payload: { taskId: task.id },
  });
  expect(env.core.task(env.alice, task.id)!.status).toBe("open");
});
test("restart adoption fences the old task attempt even before its lease expires", async () => {
  const env = await fixture();
  const task = env.create(),
    attempt = env.claim(task);
  const resumed = env.store.openSession({ ...env.be, requestId: "restart" });
  expect(() =>
    env.core.command(env.bob, {
      id: "old",
      type: "task.finish",
      payload: {
        taskId: task.id,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        outcome: "completed",
      },
    }),
  ).toThrow("superseded");
  expect(() =>
    env.core.command(resumed, {
      id: "steal",
      type: "task.finish",
      payload: {
        taskId: task.id,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        outcome: "completed",
      },
    }),
  ).toThrow("another session");
  env.core.command(env.alice, {
    id: "recover",
    type: "task.recover",
    payload: { taskId: task.id },
  });
  expect(env.core.attempts(env.alice, task.id)[0]!.reason).toBe(
    "session_superseded_or_ended",
  );
  expect(env.claim(env.core.task(env.alice, task.id)!, resumed).fence).toBe(2);
});
test("cancellation during work rejects late success and propagates dependency state through retry", async () => {
  const env = await fixture();
  const parent = env.create(),
    child = env.create([parent.id]);
  expect(child.status).toBe("blocked");
  expect(() => env.claim(child)).toThrow("not claimable");
  const attempt = env.claim(parent);
  env.core.command(env.alice, {
    id: "cancel",
    type: "task.cancel",
    payload: { taskId: parent.id, expectedVersion: attempt.task.version },
  });
  expect(env.core.task(env.alice, parent.id)!.status).toBe("cancel_requested");
  expect(() =>
    env.core.command(env.bob, {
      id: "late-success",
      type: "task.finish",
      payload: {
        taskId: parent.id,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        outcome: "completed",
      },
    }),
  ).toThrow("cancellation");
  env.core.command(env.bob, {
    id: "cancel-ack",
    type: "task.finish",
    payload: {
      taskId: parent.id,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      outcome: "cancelled",
    },
  });
  expect(env.core.task(env.alice, child.id)!.reason).toContain("cancelled");
  const cancelled = env.core.task(env.alice, parent.id)!;
  env.core.command(env.alice, {
    id: "retry",
    type: "task.retry",
    payload: { taskId: parent.id, expectedVersion: cancelled.version },
  });
  const replacement = env.claim(env.core.task(env.alice, parent.id)!);
  env.core.command(env.bob, {
    id: "success",
    type: "task.finish",
    payload: {
      taskId: parent.id,
      attemptId: replacement.attemptId,
      fence: replacement.fence,
      outcome: "completed",
    },
  });
  expect(env.core.task(env.alice, child.id)!.status).toBe("open");
  expect(env.core.attempts(env.alice, parent.id).map((a) => a.state)).toEqual([
    "cancelled",
    "completed",
  ]);
});
test("failed attempts retain results across retry and task addressing remains scope-bound", async () => {
  const env = await fixture(),
    task = env.create(),
    attempt = env.claim(task);
  env.core.command(env.bob, {
    id: "failed",
    type: "task.finish",
    payload: {
      taskId: task.id,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      outcome: "failed",
      result: { diagnostic: "oops" },
      reason: "tool failed",
    },
  });
  const failed = env.core.task(env.alice, task.id)!;
  expect(() =>
    env.core.command(env.carol, {
      id: "unauthorized",
      type: "task.retry",
      payload: { taskId: task.id, expectedVersion: failed.version },
    }),
  ).toThrow("creator");
  env.core.command(env.alice, {
    id: "retry",
    type: "task.retry",
    payload: { taskId: task.id, expectedVersion: failed.version },
  });
  expect(env.core.attempts(env.alice, task.id)[0]!.result).toEqual({
    diagnostic: "oops",
  });
  const other = env.store.openSession({
    scope: "other",
    agentId: "alice",
    requestId: "new",
    resumeToken: randomBytes(32).toString("hex"),
  });
  expect(env.core.task(other, task.id)).toBeNull();
  expect(() =>
    env.core.command(other, {
      id: "cross",
      type: "task.create",
      payload: { title: "bad dependency", dependencies: [task.id] },
    }),
  ).toThrow("scope");
});
for (const runtime of ["bun", "node"] as const)
  test(`simultaneous task claims accept exactly one owner (${runtime})`, async () => {
    const env = await fixture(),
      task = env.create();
    const replies = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const command: CoreCommand = {
          id: `claim-${i}`,
          type: "task.claim",
          payload: { taskId: task.id, expectedVersion: task.version },
        };
        const proc = Bun.spawn({
          cmd: [
            runtime === "bun" ? process.execPath : Bun.which("node")!,
            runtime === "bun"
              ? resolve("test/fixtures/task-worker.ts")
              : nodeFixture,
            env.path,
            (i % 2 ? env.bob : env.carol).capability,
            JSON.stringify(command),
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
        return JSON.parse(stdout);
      }),
    );
    expect(replies.filter((r) => r.result)).toHaveLength(1);
    expect(replies.filter((r) => r.error === "conflict")).toHaveLength(7);
    expect(env.core.attempts(env.alice, task.id)).toHaveLength(1);
  });
