import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RequestResult,
  RequestOpts,
  TaskType,
  TaskStatus,
} from "../src/tasks";
import type {
  PromotionDecision,
  TaskPromotionInput,
  TrackerBinding,
} from "../src/work_tracker";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const cleanup = await import("../src/cleanup");
const context = await import("../src/context");
const kv = await import("../src/kv");
const messages = await import("../src/messages");
const planner = await import("../src/planner");
const registry = await import("../src/registry");
const status = await import("../src/status");
const tasks = await import("../src/tasks");
const dispatch = await import("../src/dispatch");
const paths = await import("../src/paths");
const workTracker = await import("../src/work_tracker");

const originalAllowUnlabeled = process.env.SWARM_MCP_ALLOW_UNLABELED;
const originalPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;

function req(
  requester: string,
  scope: string,
  type: TaskType,
  title: string,
  opts?: RequestOpts,
): { id: string; status: TaskStatus } {
  const result = tasks.request(requester, scope, type, title, opts);
  if ("error" in result) throw new Error(result.error);
  return result;
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

function reg(name: string, scope: string) {
  return registry.register(join("C:/repo", name), name, scope);
}

function regPlanner(name: string, scope: string) {
  return registry.register(
    join("C:/repo", name),
    `provider:test role:planner name:${name}`,
    scope,
  );
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskIdFromMessage(content: string) {
  const match = content.match(/\[task:([^\]]+)\]/);
  if (!match) throw new Error(`message did not include task id: ${content}`);
  return match[1];
}

describe("database schema", () => {
  test("bootstrap stamps the shared schema version", () => {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(1);
  });
});

describe("messages", () => {
  test("broadcast fans out per recipient and stays inside scope", () => {
    const a = reg("one", "scope-a");
    const b = reg("two", "scope-a");
    const c = reg("three", "scope-a");
    const d = reg("four", "scope-b");

    expect(messages.broadcast(a.id, a.scope, "hello")).toBe(2);
    expect(messages.poll(b.id, b.scope)).toHaveLength(1);
    expect(messages.poll(c.id, c.scope)).toHaveLength(1);
    expect(messages.poll(d.id, d.scope)).toHaveLength(0);
    expect(messages.poll(b.id, b.scope)).toHaveLength(0);
  });

  test("completion waits consume matching task messages for the requester", async () => {
    const scope = "/tmp/scope-a";
    const gateway = registry.register(
      "/tmp/planner",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const worker = registry.register(
      "/tmp/worker",
      "identity:personal role:implementer",
      scope,
    );

    const workerDone = (async () => {
      for (;;) {
        const rows = messages.poll(worker.id, scope);
        if (rows.length) {
          const taskId = taskIdFromMessage(rows[0].content);
          const claim = tasks.claim(taskId, scope, worker.id, {
            ignoreUnreadMessages: true,
          });
          if ("error" in claim) throw new Error(claim.error);
          messages.send(worker.id, scope, gateway.id, `[task:${taskId}] done`);
          const done = tasks.completeStructured(taskId, scope, worker.id, {
            summary: "done",
          });
          if ("error" in done) throw new Error(done.error);
          return;
        }
        await sleep(5);
      }
    })();

    const payload = await dispatch.runDispatch({
      scope,
      requester: gateway.id,
      title: "Complete a task",
      type: "research",
      role: "implementer",
      completion_wait_seconds: 1,
      completion_poll_ms: 5,
    }) as Record<string, any>;
    await workerDone;

    expect(payload.completion.status).toBe("completed");
    expect(payload.consumed_completion_messages).toHaveLength(1);
    expect(messages.peek(gateway.id, scope)).toHaveLength(0);
  });
});

describe("cleanup", () => {
  test("removes internal spawn locks once their dispatch task is terminal", () => {
    const scope = "/tmp/scope-a";
    const gateway = registry.register(
      "/tmp/planner",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const worker = registry.register(
      "/tmp/worker",
      "identity:personal role:researcher",
      scope,
    );
    const requested = tasks.request(gateway.id, scope, "research", "Smoke", {
      assignee: worker.id,
    });
    if ("error" in requested) throw new Error(requested.error);
    const claimed = tasks.claim(requested.id, scope, worker.id, {
      ignoreUnreadMessages: true,
    });
    if ("error" in claimed) throw new Error(claimed.error);

    const lockPath = "/__swarm/spawn/researcher/test-intent";
    const locked = context.lock(
      gateway.id,
      scope,
      lockPath,
      JSON.stringify({ task_id: requested.id }),
    );
    if ("error" in locked) throw new Error(locked.error);
    const done = tasks.completeStructured(requested.id, scope, worker.id, {
      summary: "done",
    });
    if ("error" in done) throw new Error(done.error);

    expect(context.lookup(scope, lockPath)).toHaveLength(1);
    const result = cleanup.runCleanup({ scope, mode: "manual" });

    expect(result.terminal_spawn_locks_deleted).toBe(1);
    expect(context.lookup(scope, lockPath)).toHaveLength(0);
  });
});

describe("registry adoption", () => {
  test("adopts an existing unadopted row via preassignedId", () => {
    // Simulate swarm-ui's pre-create step: insert a row with pid=0,
    // adopted=0. When the child calls register() with SWARM_MCP_INSTANCE_ID
    // set (passed through here as preassignedId), it should flip the row
    // to adopted=1 and take over the pid/label rather than creating a
    // duplicate.
    const preassignedId = "ui-preassigned-id";
    db.run(
      "INSERT INTO instances (id, scope, directory, root, file_root, pid, label, heartbeat, adopted) VALUES (?, ?, ?, ?, ?, 0, NULL, unixepoch(), 0)",
      [preassignedId, "scope-a", "/tmp/repo", "/tmp/repo", "/tmp/repo"],
    );

    const adopted = registry.register(
      "/tmp/repo",
      "role:planner",
      "scope-a",
      undefined,
      preassignedId,
    );

    expect(adopted.id).toBe(preassignedId);
    expect(adopted.adopted).toBe(true);
    expect(adopted.pid).toBe(process.pid);
    expect(adopted.label).toBe("role:planner");

    // Only one row in the DB — no duplicate INSERT.
    const rows = db
      .query("SELECT COUNT(*) as n FROM instances WHERE id = ?")
      .all(preassignedId) as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);

    const [row] = db
      .query(
        "SELECT pid, label, adopted FROM instances WHERE id = ?",
      )
      .all(preassignedId) as Array<{ pid: number; label: string; adopted: number }>;
    expect(row.pid).toBe(process.pid);
    expect(row.label).toBe("role:planner");
    expect(row.adopted).toBe(1);
  });

  test("falls through to fresh insert with same id when pre-created row was pruned", () => {
    const preassignedId = "stale-preassigned-id";
    // No pre-created row — simulates the UI's row being pruned (stale
    // heartbeat) before the child got to call register().
    const instance = registry.register(
      "/tmp/repo",
      "role:researcher",
      "/tmp/scope-b",
      undefined,
      preassignedId,
    );

    expect(instance.id).toBe(preassignedId);
    expect(instance.adopted).toBe(true);
    expect(instance.scope).toBe(paths.norm("/tmp/scope-b"));
  });

  test("register without preassignedId still creates adopted row", () => {
    const instance = registry.register("/tmp/repo", "role:reviewer", "scope-c");
    expect(instance.adopted).toBe(true);
    const [row] = db
      .query("SELECT adopted FROM instances WHERE id = ?")
      .all(instance.id) as Array<{ adopted: number }>;
    expect(row.adopted).toBe(1);
  });

  test("register with an existing session label adopts instead of duplicating", () => {
    const label = "identity:personal claude-code platform:cli role:planner origin:claude-code session:abc12345";
    const first = registry.register("/tmp/repo", label, "scope-d");
    registry.setLease(first.id, Math.floor(Date.now() / 1000) + 86400);

    const second = registry.register("/tmp/repo", label, "scope-d");

    expect(second.id).toBe(first.id);
    expect(second.adopted).toBe(true);

    const [row] = db
      .query("SELECT COUNT(*) as n FROM instances WHERE scope = ? AND label = ?")
      .all(first.scope, label) as Array<{ n: number }>;
    expect(row.n).toBe(1);
  });

  test("register with adoptInstanceId adopts an existing same-scope row", () => {
    const label = "identity:personal codex platform:cli origin:codex session:abc12345";
    const lease = registry.register("/tmp/repo", label, "scope-e");
    kv.set(
      lease.scope,
      `identity/workspace/herdr/${lease.id}`,
      JSON.stringify({ backend: "herdr", handle: "pane-1" }),
      lease.id,
    );

    const adopted = registry.register(
      "/tmp/repo",
      "identity:personal role:researcher session:abc12345",
      "scope-e",
      undefined,
      undefined,
      lease.id,
    );

    expect(adopted.id).toBe(lease.id);
    expect(adopted.adopted).toBe(true);
    expect(adopted.label).toBe("identity:personal role:researcher session:abc12345");

    const [instances] = db
      .query("SELECT COUNT(*) as n FROM instances WHERE scope = ? AND directory = ?")
      .all(lease.scope, lease.directory) as Array<{ n: number }>;
    expect(instances.n).toBe(1);

    const identityRows = db
      .query("SELECT key FROM kv WHERE scope = ? AND key LIKE 'identity/workspace/herdr/%'")
      .all(lease.scope) as Array<{ key: string }>;
    expect(identityRows).toEqual([
      { key: `identity/workspace/herdr/${adopted.id}` },
    ]);
  });

  test("register with wrong-scope adoptInstanceId falls through to a fresh row", () => {
    const lease = registry.register("/tmp/repo", "identity:personal session:abc12345", "scope-f");

    const next = registry.register(
      "/tmp/repo",
      "identity:personal session:def67890",
      "scope-g",
      undefined,
      undefined,
      lease.id,
    );

    expect(next.id).not.toBe(lease.id);
    expect(next.scope).toBe(paths.norm("scope-g"));
    expect(registry.get(lease.id)?.scope).toBe(paths.norm("scope-f"));
  });

  test("register preserves adoptInstanceId when the leased row was already pruned", () => {
    const adoptId = "pruned-lease-id";

    const next = registry.register(
      "/tmp/repo",
      "identity:personal codex platform:cli session:abc12345",
      "scope-pruned-adopt",
      undefined,
      undefined,
      adoptId,
    );

    expect(next.id).toBe(adoptId);
    expect(next.adopted).toBe(true);
    expect(next.lease_until).toBeNull();
  });
});

describe("scope", () => {
  test("non-git directories fall back to their own path as scope", () => {
    const dir =
      process.platform === "win32"
        ? join("C:/plain", "workspace")
        : "/tmp/plain/workspace";

    expect(paths.scope(dir)).toBe(paths.norm(dir));
  });

  test("stale instances remain visible until they are offline", () => {
    const item = reg("worker", "scope-a");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) -
        cleanup.CLEANUP_POLICY.instanceStaleAfterSecs -
        1,
      item.id,
    ]);

    expect(registry.get(item.id)).toMatchObject({ id: item.id });
  });

  test("offline instances are pruned before lookups succeed", () => {
    const item = reg("worker", "scope-a");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) -
        cleanup.CLEANUP_POLICY.instanceReclaimAfterSecs -
        1,
      item.id,
    ]);

    expect(registry.get(item.id)).toBeNull();
  });

  test("setLease creates an unadopted placeholder hidden from list_instances", () => {
    const placeholder = reg("leased", "scope-lease-list");
    registry.setLease(placeholder.id, Math.floor(Date.now() / 1000) + 86400);

    const peers = registry.list("scope-lease-list") as Array<{ id: string }>;
    expect(peers.find((row) => row.id === placeholder.id)).toBeUndefined();

    const stored = registry.get(placeholder.id);
    expect(stored?.adopted).toBe(false);
    expect(stored?.lease_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("leases that expire without adoption are reclaimed", () => {
    const placeholder = reg("expired-lease", "scope-lease-expire");
    registry.setLease(placeholder.id, Math.floor(Date.now() / 1000) - 1);

    expect(registry.get(placeholder.id)).toBeNull();
  });

  test("adoption clears lease_until and flips adopted=1", () => {
    const placeholder = reg("adopt-me", "scope-lease-adopt");
    registry.setLease(placeholder.id, Math.floor(Date.now() / 1000) + 86400);

    const adopted = registry.adoptInstanceId(
      placeholder.directory,
      placeholder.label ?? undefined,
      placeholder.scope,
      placeholder.id,
    );

    expect(adopted?.id).toBe(placeholder.id);
    expect(adopted?.adopted).toBe(true);
    expect(adopted?.lease_until).toBeNull();
  });

  test("legacy zombies (adopted=1 with future heartbeat, no lease_until) are reclaimed", () => {
    const zombie = reg("zombie", "scope-zombie");
    db.run(
      "UPDATE instances SET heartbeat = unixepoch() + 86400, lease_until = NULL WHERE id = ?",
      [zombie.id],
    );

    expect(registry.get(zombie.id)).toBeNull();
  });
});

describe("tasks", () => {
  test("claiming is single-winner, transitions to in_progress, and updates are ownership checked", () => {
    const requester = reg("requester", "scope-a");
    const assignee = reg("assignee", "scope-a");
    const other = reg("other", "scope-a");

    const { id } = req(requester.id, requester.scope, "review", "Check change");

    expect(tasks.claim(id, assignee.scope, assignee.id)).toEqual({ ok: true });
    expect(tasks.get(id, assignee.scope)?.status).toBe("in_progress");

    expect(tasks.claim(id, other.scope, other.id)).toEqual({
      error: "Task is already in_progress",
    });
    expect(tasks.update(id, other.scope, other.id, "done")).toEqual({
      error: "Only the assignee can update this task",
    });
    expect(
      tasks.update(id, assignee.scope, assignee.id, "done", "done"),
    ).toEqual({ ok: true });
    expect(tasks.get(id, assignee.scope)?.status).toBe("done");
  });

  test("pre-assigned task is started by the assignee via claim_task", () => {
    const requester = reg("requester", "scope-a");
    const assignee = reg("assignee", "scope-a");
    const other = reg("other", "scope-a");

    const { id, status } = req(
      requester.id,
      requester.scope,
      "implement",
      "Pre-assigned",
      { assignee: assignee.id },
    );
    expect(status).toBe("claimed");

    // Other instances cannot start it
    expect(tasks.claim(id, other.scope, other.id)).toEqual({
      error: "Task is already claimed",
    });

    // Assignee starts it directly via claim_task
    expect(tasks.claim(id, assignee.scope, assignee.id)).toEqual({ ok: true });
    expect(tasks.get(id, assignee.scope)?.status).toBe("in_progress");
  });

  test("claiming open work is blocked until unread messages are polled", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const { id } = req(planner.id, planner.scope, "implement", "Build thing");

    messages.send(planner.id, planner.scope, worker.id, "Stop and read context first");

    expect(tasks.claim(id, worker.scope, worker.id)).toMatchObject({
      error: expect.stringContaining("Unread messages pending (1)"),
      unread_message_count: 1,
      latest_message_sender: planner.id,
    });
    expect(tasks.get(id, worker.scope)).toMatchObject({
      status: "open",
      assignee: null,
    });

    expect(messages.poll(worker.id, worker.scope)).toHaveLength(1);
    expect(tasks.claim(id, worker.scope, worker.id)).toEqual({ ok: true });
  });

  test("claiming can explicitly override the unread-message guard", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const { id } = req(planner.id, planner.scope, "implement", "Build thing");

    messages.send(planner.id, planner.scope, worker.id, "Non-blocking note");

    expect(
      tasks.claim(id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });
    expect(messages.peek(worker.id, worker.scope)).toHaveLength(1);
  });

  test("offline assignees are released and their locks are removed", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/index.ts");
    const { id } = req(requester.id, requester.scope, "fix", "Fix bug", {
      files: [file],
      assignee: worker.id,
    });

    expect(
      context.lock(worker.id, worker.scope, file, "editing"),
    ).toMatchObject({ ok: true });

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [0, worker.id]);
    registry.prune();

    expect(registry.get(worker.id)).toBeNull();
    expect(tasks.get(id, requester.scope)).toMatchObject({
      status: "open",
      assignee: null,
    });
    expect(context.lookup(requester.scope, file)).toHaveLength(0);
  });

  test("creating a task after dependency failure auto-cancels it", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");

    const { id: dep } = req(requester.id, requester.scope, "implement", "Dep");
    tasks.claim(dep, requester.scope, worker.id);
    tasks.update(dep, requester.scope, worker.id, "failed", "broken");

    const child = req(requester.id, requester.scope, "implement", "Child", {
      depends_on: [dep],
    });

    expect(child.status).toBe("cancelled");
    expect(tasks.get(child.id, requester.scope)).toMatchObject({
      status: "cancelled",
      result: `auto-cancelled: dependency ${dep} is already failed`,
    });
  });

  test("creating an approval_required task after dependency cancellation auto-cancels it", () => {
    const requester = reg("requester", "scope-a");

    const { id: dep } = req(requester.id, requester.scope, "implement", "Dep");
    tasks.update(dep, requester.scope, requester.id, "cancelled");

    const child = req(requester.id, requester.scope, "review", "Child", {
      depends_on: [dep],
      approval_required: true,
    });

    expect(child.status).toBe("cancelled");
    expect(tasks.get(child.id, requester.scope)?.result).toBe(
      `auto-cancelled: dependency ${dep} is already cancelled`,
    );
  });

  test("snapshot includes failed, cancelled, and approval_required tasks", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");

    const { id: failed } = req(requester.id, requester.scope, "implement", "Failed");
    const { id: cancelled } = req(
      requester.id,
      requester.scope,
      "implement",
      "Cancelled",
    );
    const gated = req(requester.id, requester.scope, "review", "Gated", {
      approval_required: true,
    });

    tasks.claim(failed, requester.scope, worker.id);
    tasks.update(failed, requester.scope, worker.id, "failed", "nope");
    tasks.update(cancelled, requester.scope, requester.id, "cancelled");

    const snapshot = tasks.snapshot(requester.scope);
    expect(snapshot.failed!.map((task: any) => task.id)).toContain(failed);
    expect(snapshot.cancelled!.map((task: any) => task.id)).toContain(cancelled);
    expect(snapshot.approval_required.map((task: any) => task.id)).toContain(
      gated.id,
    );
  });

  test("snapshot can omit terminal rows while returning terminal counts", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");

    const { id: done } = req(requester.id, requester.scope, "implement", "Done");
    const { id: failed } = req(requester.id, requester.scope, "implement", "Failed");
    const { id: open } = req(requester.id, requester.scope, "implement", "Open");
    tasks.claim(done, requester.scope, worker.id);
    tasks.update(done, requester.scope, worker.id, "done");
    tasks.claim(failed, requester.scope, worker.id);
    tasks.update(failed, requester.scope, worker.id, "failed");

    const snapshot = tasks.snapshot(requester.scope, { include_terminal: false });
    expect(snapshot.open.map((task: any) => task.id)).toContain(open);
    expect(snapshot.terminal_counts).toEqual({ done: 1, failed: 1, cancelled: 0 });
    expect("done" in snapshot).toBe(false);
    expect("failed" in snapshot).toBe(false);
    expect("cancelled" in snapshot).toBe(false);
  });
});

describe("claim_next_task", () => {
  test("atomically claims the highest-priority open task", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");

    req(planner.id, planner.scope, "implement", "Low", { priority: 1 });
    const high = req(planner.id, planner.scope, "fix", "High", { priority: 10 });
    req(planner.id, planner.scope, "review", "Medium", { priority: 5 });

    const result = tasks.claimNext(worker.scope, worker.id);

    expect(result).toMatchObject({ ok: true, task_id: high.id, prior_status: "open" });
    expect(tasks.get(high.id, worker.scope)).toMatchObject({
      status: "in_progress",
      assignee: worker.id,
    });
  });

  test("prefers tasks already assigned to the caller", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");

    const openHigh = req(planner.id, planner.scope, "implement", "Open high", { priority: 50 });
    const assignedLow = req(planner.id, planner.scope, "review", "Assigned low", {
      assignee: worker.id,
      priority: 1,
    });

    const result = tasks.claimNext(worker.scope, worker.id);

    expect(result).toMatchObject({ ok: true, task_id: assignedLow.id, prior_status: "claimed" });
    expect(tasks.get(assignedLow.id, worker.scope)).toMatchObject({
      status: "in_progress",
      assignee: worker.id,
    });
    expect(tasks.get(openHigh.id, worker.scope)).toMatchObject({
      status: "open",
      assignee: null,
    });
  });

  test("filters by type and file overlap", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const target = paths.file(worker.directory, "src/target.ts");
    const other = paths.file(worker.directory, "src/other.ts");

    req(planner.id, planner.scope, "implement", "Wrong type", {
      files: [target],
      priority: 20,
    });
    req(planner.id, planner.scope, "review", "Wrong file", {
      files: [other],
      priority: 15,
    });
    const match = req(planner.id, planner.scope, "review", "Matching review", {
      files: [target],
      priority: 1,
    });

    const result = tasks.claimNext(worker.scope, worker.id, {
      types: ["review"],
      files: [target],
    });

    expect(result).toMatchObject({ ok: true, task_id: match.id });
  });

  test("is blocked by unread messages unless explicitly overridden", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const task = req(planner.id, planner.scope, "implement", "Build thing");

    messages.send(planner.id, planner.scope, worker.id, "Read me first");

    expect(tasks.claimNext(worker.scope, worker.id)).toMatchObject({
      error: expect.stringContaining("Unread messages pending (1)"),
      unread_message_count: 1,
    });
    expect(tasks.get(task.id, worker.scope)).toMatchObject({
      status: "open",
      assignee: null,
    });

    expect(
      tasks.claimNext(worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toMatchObject({ ok: true, task_id: task.id });
  });
});

describe("priority", () => {
  test("tasks are listed in priority order (highest first)", () => {
    const a = reg("planner", "scope-a");

    req(a.id, a.scope, "implement", "Low priority", { priority: 0 });
    req(a.id, a.scope, "implement", "High priority", { priority: 10 });
    req(a.id, a.scope, "implement", "Medium priority", { priority: 5 });

    const list = tasks.list(a.scope, { status: "open" });
    expect(list.map((t: any) => t.title)).toEqual([
      "High priority",
      "Medium priority",
      "Low priority",
    ]);
  });
});

describe("dependencies", () => {
  test("task with unmet deps starts as blocked", () => {
    const a = reg("planner", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2, status } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    expect(status).toBe("blocked");
    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");
  });

  test("task with already-done deps starts as open", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");

    const { id: t2, status } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    expect(status).toBe("open");
  });

  test("auto-unblocks when dependency completes", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");

    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");

    expect(tasks.get(t2, a.scope)?.status).toBe("open");
  });

  test("auto-unblocks to claimed when assignee is pre-set", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
      assignee: w.id,
    });

    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");

    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");

    expect(tasks.get(t2, a.scope)?.status).toBe("claimed");
  });

  test("multi-dep task only unblocks when all deps are done", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2");
    const { id: t3 } = req(a.id, a.scope, "implement", "Task 3", {
      depends_on: [t1, t2],
    });

    expect(tasks.get(t3, a.scope)?.status).toBe("blocked");

    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");
    // t2 still not done
    expect(tasks.get(t3, a.scope)?.status).toBe("blocked");

    tasks.claim(t2, a.scope, w.id);
    tasks.update(t2, a.scope, w.id, "done", "ok");
    // Now all deps are done
    expect(tasks.get(t3, a.scope)?.status).toBe("open");
  });

  test("auto-cancels dependents when dependency fails", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });
    const { id: t3 } = req(a.id, a.scope, "implement", "Task 3", {
      depends_on: [t2],
    });

    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "failed", "broken");

    expect(tasks.get(t2, a.scope)?.status).toBe("cancelled");
    expect(tasks.get(t2, a.scope)?.result).toContain("auto-cancelled");
    // Recursive cascade
    expect(tasks.get(t3, a.scope)?.status).toBe("cancelled");
  });

  test("auto-cancels dependents when dependency is cancelled", () => {
    const a = reg("planner", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    tasks.update(t1, a.scope, a.id, "cancelled");

    expect(tasks.get(t2, a.scope)?.status).toBe("cancelled");
  });

  test("rejects invalid dependency IDs", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.request(a.id, a.scope, "implement", "Bad deps", {
      depends_on: ["nonexistent-id"],
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  test("blocked tasks cannot be moved to a terminal status by a non-owner", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    // Non-cancellation update on blocked task is rejected
    const result = tasks.update(t2, a.scope, w.id, "done");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("blocked");
  });

  test("blocked tasks can be cancelled by requester", () => {
    const a = reg("planner", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    expect(tasks.update(t2, a.scope, a.id, "cancelled")).toEqual({ ok: true });
    expect(tasks.get(t2, a.scope)?.status).toBe("cancelled");
  });
});

describe("idempotency", () => {
  test("duplicate idempotency key returns existing task", () => {
    const a = reg("planner", "scope-a");

    const r1 = req(a.id, a.scope, "implement", "Task 1", {
      idempotency_key: "unique-key-1",
    });
    const r2 = tasks.request(a.id, a.scope, "implement", "Task 1 duplicate", {
      idempotency_key: "unique-key-1",
    });

    expect("id" in r2 && r2.id).toBe(r1.id);
    expect("existing" in r2 && r2.existing).toBe(true);
  });

  test("different idempotency keys create separate tasks", () => {
    const a = reg("planner", "scope-a");

    const r1 = req(a.id, a.scope, "implement", "Task 1", {
      idempotency_key: "key-a",
    });
    const r2 = req(a.id, a.scope, "implement", "Task 2", {
      idempotency_key: "key-b",
    });

    expect(r1.id).not.toBe(r2.id);
  });

  test("idempotency keys are scoped", () => {
    const a = reg("one", "scope-a");
    const b = reg("two", "scope-b");

    const r1 = req(a.id, a.scope, "implement", "Task A", {
      idempotency_key: "shared-key",
    });
    const r2 = req(b.id, b.scope, "implement", "Task B", {
      idempotency_key: "shared-key",
    });

    expect(r1.id).not.toBe(r2.id);
  });
});

describe("approval", () => {
  test("approval_required task starts in correct status", () => {
    const a = reg("planner", "scope-a");

    const { id, status } = req(a.id, a.scope, "implement", "Needs approval", {
      approval_required: true,
    });

    expect(status).toBe("approval_required");
    expect(tasks.get(id, a.scope)?.status).toBe("approval_required");
  });

  test("approve transitions to open when no deps", () => {
    const a = reg("planner", "scope-a");

    const { id } = req(a.id, a.scope, "implement", "Needs approval", {
      approval_required: true,
    });

    const result = tasks.approve(id, a.scope);
    expect(result).toMatchObject({ ok: true, status: "open" });
    expect(tasks.get(id, a.scope)?.status).toBe("open");
  });

  test("approve transitions to claimed when assignee is pre-set", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id } = req(a.id, a.scope, "implement", "Needs approval", {
      approval_required: true,
      assignee: w.id,
    });

    const result = tasks.approve(id, a.scope);
    expect(result).toMatchObject({ ok: true, status: "claimed" });
  });

  test("approve transitions to blocked when deps are unmet", () => {
    const a = reg("planner", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Dep task");
    const { id: t2 } = req(a.id, a.scope, "implement", "Needs both", {
      approval_required: true,
      depends_on: [t1],
    });

    const result = tasks.approve(t2, a.scope);
    expect(result).toMatchObject({ ok: true, status: "blocked" });
    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");
  });

  test("approve auto-cancels when dep has already failed", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Will fail");
    const { id: t2 } = req(a.id, a.scope, "implement", "Needs approval", {
      approval_required: true,
      depends_on: [t1],
    });

    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "failed", "broken");

    // t2 should already be auto-cancelled by failure cascade
    expect(tasks.get(t2, a.scope)?.status).toBe("cancelled");
  });

  test("approval_required tasks can be cancelled", () => {
    const a = reg("planner", "scope-a");

    const { id } = req(a.id, a.scope, "implement", "Reject this", {
      approval_required: true,
    });

    expect(tasks.update(id, a.scope, a.id, "cancelled")).toEqual({ ok: true });
    expect(tasks.get(id, a.scope)?.status).toBe("cancelled");
  });

  test("approval_required tasks cannot be moved to done before approval", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id } = req(a.id, a.scope, "implement", "Not approved yet", {
      approval_required: true,
    });

    const result = tasks.update(id, a.scope, w.id, "done");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("approval_required");
  });

  test("approve + deps: approved then deps complete → unblocks", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Dep task");
    const { id: t2 } = req(a.id, a.scope, "implement", "Needs both", {
      approval_required: true,
      depends_on: [t1],
    });

    // Approve first (goes to blocked since t1 not done)
    tasks.approve(t2, a.scope);
    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");

    // Complete t1 → t2 should auto-unblock
    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");

    expect(tasks.get(t2, a.scope)?.status).toBe("open");
  });

  test("approve + deps: deps complete then approve → open", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Dep task");
    const { id: t2 } = req(a.id, a.scope, "implement", "Needs both", {
      approval_required: true,
      depends_on: [t1],
    });

    // Complete t1 first
    tasks.claim(t1, a.scope, w.id);
    tasks.update(t1, a.scope, w.id, "done", "ok");
    // t2 is still approval_required (not auto-unblocked)
    expect(tasks.get(t2, a.scope)?.status).toBe("approval_required");

    // Now approve → should go straight to open
    const result = tasks.approve(t2, a.scope);
    expect(result).toMatchObject({ ok: true, status: "open" });
  });
});

describe("parent_task_id", () => {
  test("task can reference a parent task", () => {
    const a = reg("planner", "scope-a");

    const { id: parent } = req(a.id, a.scope, "implement", "Parent");
    const { id: child } = req(a.id, a.scope, "implement", "Child", {
      parent_task_id: parent,
    });

    expect(tasks.get(child, a.scope)?.parent_task_id).toBe(parent);
  });

  test("rejects invalid parent task ID", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.request(a.id, a.scope, "implement", "Bad parent", {
      parent_task_id: "nonexistent",
    });
    expect(result).toHaveProperty("error");
  });
});

describe("task relationships and handoffs", () => {
  test("review and fix task relationships are stored and validated", () => {
    const planner = reg("planner", "scope-a");

    const implementation = req(planner.id, planner.scope, "implement", "Implement feature");
    const review = req(planner.id, planner.scope, "review", "Review feature", {
      review_of_task_id: implementation.id,
    });
    const fix = req(planner.id, planner.scope, "fix", "Fix review findings", {
      fixes_task_id: implementation.id,
    });

    expect(tasks.get(review.id, planner.scope)?.review_of_task_id).toBe(implementation.id);
    expect(tasks.get(fix.id, planner.scope)?.fixes_task_id).toBe(implementation.id);

    expect(
      tasks.request(planner.id, planner.scope, "review", "Bad review target", {
        review_of_task_id: "missing-review-target",
      }),
    ).toMatchObject({ error: expect.stringContaining("Review target task missing-review-target not found") });
    expect(
      tasks.request(planner.id, planner.scope, "fix", "Bad fix target", {
        fixes_task_id: "missing-fix-target",
      }),
    ).toMatchObject({ error: expect.stringContaining("Fix target task missing-fix-target not found") });
  });

  test("batch creation resolves $N review and fix relationships", () => {
    const planner = reg("planner", "scope-a");

    const result = tasks.requestBatch(planner.id, planner.scope, [
      { type: "implement", title: "Implement feature" },
      { type: "review", title: "Review feature", review_of_task_id: "$1" },
      { type: "fix", title: "Fix feature", fixes_task_id: "$1" },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;

    expect(tasks.get(result.task_ids[1], planner.scope)?.review_of_task_id).toBe(result.task_ids[0]);
    expect(tasks.get(result.task_ids[2], planner.scope)?.fixes_task_id).toBe(result.task_ids[0]);
  });

  test("report_progress stores progress metadata and preserves or clears optional fields", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const task = req(planner.id, planner.scope, "implement", "Long-running task");
    const nextUpdate = Math.floor(Date.now() / 1000) + 60;

    expect(tasks.reportProgress(task.id, worker.scope, worker.id, "too early")).toMatchObject({
      error: "Only the assignee can report progress on this task",
    });

    expect(tasks.claim(task.id, worker.scope, worker.id)).toEqual({ ok: true });
    const first = tasks.reportProgress(task.id, worker.scope, worker.id, "half done", {
      blocked_reason: "waiting on dependency docs",
      expected_next_update_at: nextUpdate,
    });

    expect(first).toMatchObject({
      ok: true,
      progress_summary: "half done",
      blocked_reason: "waiting on dependency docs",
      expected_next_update_at: nextUpdate,
      progress_updated_at: expect.any(Number),
    });
    expect(tasks.get(task.id, worker.scope)).toMatchObject({
      progress_summary: "half done",
      blocked_reason: "waiting on dependency docs",
      expected_next_update_at: nextUpdate,
      progress_updated_at: expect.any(Number),
    });

    expect(
      tasks.reportProgress(task.id, worker.scope, worker.id, "unblocked", {
        blocked_reason: null,
      }),
    ).toMatchObject({
      ok: true,
      progress_summary: "unblocked",
      blocked_reason: null,
      expected_next_update_at: nextUpdate,
    });
  });

  test("complete_task stores structured result, clears progress, and releases task file locks", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/feature.ts");
    const reviewGate = req(planner.id, planner.scope, "review", "Review after implement");
    const task = req(planner.id, planner.scope, "implement", "Implement feature", {
      files: [file],
    });

    tasks.claim(task.id, worker.scope, worker.id);
    context.lock(worker.id, worker.scope, file, "editing feature");
    tasks.reportProgress(task.id, worker.scope, worker.id, "almost done", {
      blocked_reason: "waiting on final test",
    });

    const result = tasks.completeStructured(task.id, worker.scope, worker.id, {
      summary: "Implemented feature",
      files_changed: [file, file],
      tests: [{ command: "bun test", status: "passed" }],
      tracker_update_skipped: {
        provider: "linear",
        issue: "VUH-35",
        reason: "No Linear MCP in this worker",
      },
      followups: ["Review edge cases"],
    });

    expect(result).toMatchObject({
      ok: true,
      status: "done",
      result: {
        summary: "Implemented feature",
        files_changed: [file],
        tests: [{ command: "bun test", status: "passed" }],
        tracker_update_skipped: {
          provider: "linear",
          issue: "VUH-35",
          reason: "No Linear MCP in this worker",
        },
        followups: ["Review edge cases"],
      },
    });

    const completed = tasks.get(task.id, worker.scope);
    expect(completed).toMatchObject({
      status: "done",
      progress_summary: null,
      progress_updated_at: null,
      blocked_reason: null,
      expected_next_update_at: null,
    });
    expect(JSON.parse(completed?.result as string)).toEqual({
      summary: "Implemented feature",
      files_changed: [file],
      tests: [{ command: "bun test", status: "passed" }],
      tracker_update_skipped: {
        provider: "linear",
        issue: "VUH-35",
        reason: "No Linear MCP in this worker",
      },
      followups: ["Review edge cases"],
    });
    expect(context.lookup(worker.scope, file)).toHaveLength(0);

    expect(tasks.claim(reviewGate.id, planner.scope, planner.id)).toEqual({ ok: true });
    expect(
      tasks.completeStructured(reviewGate.id, planner.scope, planner.id, {
        status: "failed",
        summary: "Needs changes",
        tests: [{ status: "skipped", notes: "review only" }],
      }),
    ).toMatchObject({
      ok: true,
      status: "failed",
      result: {
        summary: "Needs changes",
        files_changed: [],
        tests: [{ status: "skipped", notes: "review only" }],
        followups: [],
      },
    });
  });

  test("complete_task requires tracker disposition for Linear-backed tasks", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const task = req(planner.id, planner.scope, "implement", "VUH-99: Implement bridge", {
      description: "Ticket URL: https://linear.app/vuhlp/issue/VUH-99/implement-bridge",
      idempotency_key: "linear:VUH-99:implement",
    });

    tasks.claim(task.id, worker.scope, worker.id);

    expect(
      tasks.completeStructured(task.id, worker.scope, worker.id, {
        summary: "Implemented bridge",
      }),
    ).toEqual({
      error:
        "Tracker-backed tasks require tracker_update or tracker_update_skipped in complete_task",
    });

    expect(
      tasks.completeStructured(task.id, worker.scope, worker.id, {
        summary: "Implemented bridge",
        tracker_update_skipped: "No Linear MCP in this worker; planner must update Linear.",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        summary: "Implemented bridge",
        tracker_update_skipped: "No Linear MCP in this worker; planner must update Linear.",
      },
    });
  });

  test("complete_task requires tracker disposition when task metadata requires it", () => {
    const planner = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const task = req(planner.id, planner.scope, "implement", "Implement promoted work", {
      tracker_required: true,
      tracker_provider: "github_issues",
    });

    tasks.claim(task.id, worker.scope, worker.id);

    expect(
      tasks.completeStructured(task.id, worker.scope, worker.id, {
        summary: "Implemented promoted work",
      }),
    ).toEqual({
      error:
        "Tracker-backed tasks require tracker_update or tracker_update_skipped in complete_task",
    });

    expect(
      tasks.completeStructured(task.id, worker.scope, worker.id, {
        summary: "Implemented promoted work",
        tracker_update: {
          provider: "github_issues",
          issue: "42",
          action: "commented",
        },
      }),
    ).toMatchObject({
      ok: true,
      result: {
        tracker_update: {
          provider: "github_issues",
          issue: "42",
          action: "commented",
        },
      },
    });
  });
});

describe("offline release with new statuses", () => {
  test("blocked tasks keep status when assignee goes offline", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Dep");
    const { id: t2 } = req(a.id, a.scope, "implement", "Blocked", {
      depends_on: [t1],
      assignee: w.id,
    });

    expect(tasks.get(t2, a.scope)?.status).toBe("blocked");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [0, w.id]);
    registry.prune();

    // Should remain blocked but lose assignee
    const task = tasks.get(t2, a.scope);
    expect(task?.status).toBe("blocked");
    expect(task?.assignee).toBeNull();
  });
});

describe("locks", () => {
  test("only one active lock can exist per file per scope", () => {
    const a = reg("one", "scope-a");
    const b = reg("two", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(context.lock(a.id, a.scope, file, "editing")).toMatchObject({
      ok: true,
    });
    expect(context.lock(b.id, b.scope, file, "editing")).toMatchObject({
      error: "File is already locked",
    });

    context.clearLocks(a.id, a.scope, file);

    expect(context.lock(b.id, b.scope, file, "editing")).toMatchObject({
      ok: true,
    });
  });

  test("default lock is re-entrant for the same instance", () => {
    const a = reg("one", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    const first = context.lock(a.id, a.scope, file, "editing");
    expect(first).toMatchObject({ ok: true });

    const second = context.lock(a.id, a.scope, file, "still editing");
    expect(second).toMatchObject({ ok: true });
    if ("ok" in second) {
      expect(second.id).not.toBe("id" in first ? first.id : "");
    }
  });

  test("exclusive=true conflicts on same-instance re-entry", () => {
    const a = reg("one", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(context.lock(a.id, a.scope, file, "first")).toMatchObject({
      ok: true,
    });
    const result = context.lock(a.id, a.scope, file, "second", {
      exclusive: true,
    });
    expect(result).toMatchObject({ error: "File is already locked" });
    if ("error" in result) {
      expect((result.active as { instance_id: string }).instance_id).toBe(a.id);
    }
  });

  test("exclusive=true conflicts on different-instance lock", () => {
    const a = reg("one", "scope-a");
    const b = reg("two", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(context.lock(a.id, a.scope, file, "editing")).toMatchObject({
      ok: true,
    });
    expect(
      context.lock(b.id, b.scope, file, "editing", { exclusive: true }),
    ).toMatchObject({ error: "File is already locked" });
  });

  test("exclusive=true succeeds when no lock exists", () => {
    const a = reg("one", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(
      context.lock(a.id, a.scope, file, "spawning", { exclusive: true }),
    ).toMatchObject({ ok: true });

    expect(
      context.lock(a.id, a.scope, file, "spawning again", { exclusive: true }),
    ).toMatchObject({ error: "File is already locked" });
  });

  test("cross-identity lock attempts on another identity root are blocked", () => {
    delete process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY;
    const priorPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;
    const scope = "scope-identity-lock";
    const work = registry.register(
      "/tmp/work-repo",
      "identity:work role:implementer",
      scope,
    );
    process.env.SWARM_MCP_PERSONAL_ROOTS = "/tmp/personal-repo";
    const personal = registry.register(
      "/tmp/personal-repo",
      "identity:personal role:planner",
      scope,
    );
    const file = paths.file(work.directory, "src/index.ts");

    expect(context.lock(personal.id, personal.scope, file, "wedging")).toMatchObject({
      error: "Cannot lock a path owned by another identity",
      active: { hidden: true, reason: "cross_identity", file },
    });
    restoreEnv("SWARM_MCP_PERSONAL_ROOTS", priorPersonalRoots);
  });

  test("cross-identity lock conflicts return a redacted owner", () => {
    delete process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY;
    const priorPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;
    const scope = "scope-hidden-lock";
    process.env.SWARM_MCP_PERSONAL_ROOTS = "/tmp/shared-root";
    const personal = registry.register(
      "/tmp/shared-root",
      "identity:personal role:planner",
      scope,
    );
    const file = paths.file(personal.directory, "src/index.ts");

    expect(context.lock(personal.id, personal.scope, file, "editing")).toMatchObject({
      ok: true,
    });

    const work = registry.register(
      "/tmp/shared-root",
      "identity:work role:implementer",
      scope,
    );

    expect(context.lock(work.id, work.scope, file, "editing")).toMatchObject({
      error: "Cannot lock a path owned by another identity",
      active: { hidden: true, reason: "cross_identity", file },
    });
    restoreEnv("SWARM_MCP_PERSONAL_ROOTS", priorPersonalRoots);
  });

  test("clearLocks releases an exclusive lock", () => {
    const a = reg("one", "scope-a");
    const b = reg("two", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(
      context.lock(a.id, a.scope, file, "spawning", { exclusive: true }),
    ).toMatchObject({ ok: true });

    context.clearLocks(a.id, a.scope, file);

    expect(
      context.lock(b.id, b.scope, file, "editing", { exclusive: true }),
    ).toMatchObject({ ok: true });
  });

  test("lock conflict includes owner and active task context", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const other = reg("other", "scope-a");
    const file = paths.file(worker.directory, "src/index.ts");
    const { id } = req(requester.id, requester.scope, "fix", "Fix bug", {
      files: [file],
      assignee: worker.id,
    });
    expect(
      tasks.claim(id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(context.lock(worker.id, worker.scope, file, "editing")).toMatchObject({
      ok: true,
    });
    const result = context.lock(other.id, other.scope, file, "editing");

    expect(result).toMatchObject({ error: "File is already locked" });
    if ("error" in result) {
      expect(result.active).toMatchObject({
        instance_id: worker.id,
        owner: {
          id: worker.id,
          label: "worker",
          active: true,
          stale: false,
          reclaimable: false,
        },
        active_tasks: [{ id, status: "in_progress" }],
      });
    }
  });

  test("fileLock reads active lock without acquiring a lock", () => {
    const a = reg("one", "scope-a");
    const file = paths.file(a.directory, "src/index.ts");

    expect(context.lock(a.id, a.scope, file, "editing")).toMatchObject({
      ok: true,
    });

    expect(context.fileLock(a.scope, file)).toMatchObject({
      file,
      active: { instance_id: a.id },
    });
  });

  test("terminal task update releases edit locks but keeps internal locks", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const fileA = paths.file(worker.directory, "src/index.ts");
    const fileB = paths.file(worker.directory, "src/context.ts");
    const internal = "/__swarm/spawn/implementer/hash";
    const { id } = req(requester.id, requester.scope, "fix", "Fix bug", {
      files: [fileA],
      assignee: worker.id,
    });
    expect(
      tasks.claim(id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(context.lock(worker.id, worker.scope, fileA, "editing")).toMatchObject({
      ok: true,
    });
    expect(context.lock(worker.id, worker.scope, fileB, "editing")).toMatchObject({
      ok: true,
    });
    expect(context.lock(worker.id, worker.scope, internal, "spawning")).toMatchObject({
      ok: true,
    });

    expect(tasks.update(id, worker.scope, worker.id, "done")).toEqual({ ok: true });

    expect(context.lookup(worker.scope, fileA)).toEqual([]);
    expect(context.lookup(worker.scope, fileB)).toEqual([]);
    expect(context.lookup(worker.scope, internal)).toMatchObject([
      { type: "lock", instance_id: worker.id },
    ]);
  });

  test("terminal task update keeps edit locks for other active tasks", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const fileA = paths.file(worker.directory, "src/index.ts");
    const fileB = paths.file(worker.directory, "src/context.ts");
    const taskA = req(requester.id, requester.scope, "fix", "Fix A", {
      files: [fileA],
      assignee: worker.id,
    });
    const taskB = req(requester.id, requester.scope, "fix", "Fix B", {
      files: [fileB],
      assignee: worker.id,
    });
    expect(
      tasks.claim(taskA.id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });
    expect(
      tasks.claim(taskB.id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(context.lock(worker.id, worker.scope, fileA, "editing A")).toMatchObject({
      ok: true,
    });
    expect(context.lock(worker.id, worker.scope, fileB, "editing B")).toMatchObject({
      ok: true,
    });

    expect(tasks.update(taskA.id, worker.scope, worker.id, "done")).toEqual({
      ok: true,
    });

    expect(context.lookup(worker.scope, fileA)).toEqual([]);
    expect(context.lookup(worker.scope, fileB)).toMatchObject([
      { type: "lock", instance_id: worker.id },
    ]);
  });

  test("terminal task update releases locks tagged with that task_id even when file is not in task.files", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const declared = paths.file(worker.directory, "src/declared.ts");
    const undeclared = paths.file(worker.directory, "src/undeclared.ts");
    const { id } = req(requester.id, requester.scope, "fix", "Fix bug", {
      files: [declared],
      assignee: worker.id,
    });
    expect(
      tasks.claim(id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(
      context.lock(worker.id, worker.scope, declared, "editing", { taskId: id }),
    ).toMatchObject({ ok: true });
    expect(
      context.lock(worker.id, worker.scope, undeclared, "editing", { taskId: id }),
    ).toMatchObject({ ok: true });

    expect(tasks.update(id, worker.scope, worker.id, "done")).toEqual({ ok: true });

    expect(context.lookup(worker.scope, declared)).toEqual([]);
    expect(context.lookup(worker.scope, undeclared)).toEqual([]);
  });

  test("legacy locks without task_id still release via task.files at terminal update", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/legacy.ts");
    const { id } = req(requester.id, requester.scope, "fix", "Fix legacy", {
      files: [file],
      assignee: worker.id,
    });
    expect(
      tasks.claim(id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(context.lock(worker.id, worker.scope, file, "editing")).toMatchObject({
      ok: true,
    });

    expect(tasks.update(id, worker.scope, worker.id, "done")).toEqual({ ok: true });

    expect(context.lookup(worker.scope, file)).toEqual([]);
  });

  test("releaseInstanceLocksForTask returns 0 and is a no-op when no locks match", () => {
    const a = reg("a", "scope-a");
    expect(
      context.releaseInstanceLocksForTask(a.id, a.scope, "no-such-task"),
    ).toBe(0);
  });

  test("terminal task update keeps locks tagged with a different active task_id", () => {
    const requester = reg("requester", "scope-a");
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/shared.ts");
    const taskA = req(requester.id, requester.scope, "fix", "Fix A", {
      assignee: worker.id,
    });
    const taskB = req(requester.id, requester.scope, "fix", "Fix B", {
      assignee: worker.id,
    });
    expect(
      tasks.claim(taskA.id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });
    expect(
      tasks.claim(taskB.id, worker.scope, worker.id, { ignoreUnreadMessages: true }),
    ).toEqual({ ok: true });

    expect(
      context.lock(worker.id, worker.scope, file, "editing for B", {
        taskId: taskB.id,
      }),
    ).toMatchObject({ ok: true });

    expect(tasks.update(taskA.id, worker.scope, worker.id, "done")).toEqual({
      ok: true,
    });

    // Task A's terminal release must not yank task B's lock because the
    // assignee still has an active task, so the assignee-wide sweep is skipped.
    const survivors = context.lookup(worker.scope, file) as Array<{
      type: string;
      instance_id: string;
      task_id: string | null;
    }>;
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      type: "lock",
      instance_id: worker.id,
      task_id: taskB.id,
    });
  });
});

describe("batch creation", () => {
  test("creates multiple tasks atomically", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task 1" },
      { type: "implement", title: "Task 2" },
      { type: "implement", title: "Task 3" },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;
    expect(result.task_ids).toHaveLength(3);
    expect(result.created).toBe(3);
    expect(result.existing).toBe(0);
    expect(result.tasks.every((t) => t.new)).toBe(true);
    expect(result.tasks.every((t) => t.status === "open")).toBe(true);
  });

  test("$N references resolve to correct task IDs", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Step 1" },
      { type: "implement", title: "Step 2", depends_on: ["$1"] },
      { type: "review", title: "Review all", depends_on: ["$1", "$2"] },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;

    expect(result.tasks[0].status).toBe("open");
    expect(result.tasks[1].status).toBe("blocked");
    expect(result.tasks[2].status).toBe("blocked");

    const t2 = tasks.get(result.task_ids[1], a.scope);
    expect(t2?.depends_on).toEqual([result.task_ids[0]]);

    const t3 = tasks.get(result.task_ids[2], a.scope);
    expect(t3?.depends_on).toEqual([result.task_ids[0], result.task_ids[1]]);
  });

  test("rejects forward references", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task 1", depends_on: ["$2"] },
      { type: "implement", title: "Task 2" },
    ]);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("Validation failed");
    expect(result.details?.[0].task_index).toBe(0);
    expect(result.details?.[0].message).toContain("forward reference");
  });

  test("rejects duplicate idempotency keys within one batch", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task 1", idempotency_key: "dup-key" },
      { type: "implement", title: "Task 2", idempotency_key: "dup-key" },
    ]);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("Validation failed");
    expect(result.details?.[0].field).toBe("idempotency_key");
  });

  test("rejects self-references", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task 1", depends_on: ["$1"] },
    ]);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("Validation failed");
    expect(result.details?.[0].message).toContain("self-reference");
  });

  test("rejects out-of-range $N references", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task 1" },
      { type: "implement", title: "Task 2", depends_on: ["$5"] },
    ]);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.details?.[0].message).toContain("out of range");
  });

  test("mixed $N refs and external task IDs", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: ext } = req(a.id, a.scope, "implement", "External dep");
    tasks.claim(ext, a.scope, w.id);
    tasks.update(ext, a.scope, w.id, "done", "ok");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Step 1" },
      { type: "test", title: "Test", depends_on: ["$1", ext] },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;

    expect(result.tasks[1].status).toBe("blocked");

    const t2 = tasks.get(result.task_ids[1], a.scope);
    expect(t2?.depends_on).toEqual([result.task_ids[0], ext]);
  });

  test("new batch task with failed external dependency is auto-cancelled", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: dep } = req(a.id, a.scope, "implement", "External dep");
    tasks.claim(dep, a.scope, w.id);
    tasks.update(dep, a.scope, w.id, "failed", "broken");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "test", title: "Blocked forever before fix", depends_on: [dep] },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;
    expect(result.tasks[0].status).toBe("cancelled");
    expect(tasks.get(result.task_ids[0], a.scope)?.result).toBe(
      `auto-cancelled: dependency ${dep} is already failed`,
    );
  });

  test("idempotency: existing tasks reused, new tasks created", () => {
    const a = reg("planner", "scope-a");

    const r1 = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task A", idempotency_key: "key-a" },
      { type: "implement", title: "Task B", idempotency_key: "key-b" },
    ]);
    expect("task_ids" in r1).toBe(true);
    if (!("task_ids" in r1)) return;
    expect(r1.created).toBe(2);

    const r2 = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Task A", idempotency_key: "key-a" },
      { type: "implement", title: "Task B", idempotency_key: "key-b" },
      { type: "test", title: "Task C", idempotency_key: "key-c", depends_on: ["$1", "$2"] },
    ]);
    expect("task_ids" in r2).toBe(true);
    if (!("task_ids" in r2)) return;

    expect(r2.existing).toBe(2);
    expect(r2.created).toBe(1);
    expect(r2.task_ids[0]).toBe(r1.task_ids[0]);
    expect(r2.task_ids[1]).toBe(r1.task_ids[1]);
    expect(r2.tasks[0].new).toBe(false);
    expect(r2.tasks[2].new).toBe(true);

    const t3 = tasks.get(r2.task_ids[2], a.scope);
    expect(t3?.depends_on).toEqual([r1.task_ids[0], r1.task_ids[1]]);
  });

  test("$N parent_task_id resolves correctly", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Parent" },
      { type: "implement", title: "Child", parent_task_id: "$1" },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;

    const child = tasks.get(result.task_ids[1], a.scope);
    expect(child?.parent_task_id).toBe(result.task_ids[0]);
  });

  test("rolls back entire batch on validation failure", () => {
    const a = reg("planner", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Good task", idempotency_key: "rollback-test" },
      { type: "implement", title: "Bad task", depends_on: ["nonexistent-uuid"] },
    ]);

    expect("error" in result).toBe(true);

    const check = db
      .query("SELECT id FROM tasks WHERE idempotency_key = ? AND scope = ?")
      .get("rollback-test", a.scope);
    expect(check).toBeNull();
  });

  test("priority is respected in batch", () => {
    const a = reg("planner", "scope-a");

    tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Low", priority: 1 },
      { type: "implement", title: "High", priority: 10 },
      { type: "implement", title: "Medium", priority: 5 },
    ]);

    const list = tasks.list(a.scope, { status: "open" });
    expect(list.map((t: any) => t.title)).toEqual(["High", "Medium", "Low"]);
  });

  test("empty batch returns error", () => {
    const a = reg("planner", "scope-a");
    const result = tasks.requestBatch(a.id, a.scope, []);
    expect("error" in result).toBe(true);
  });

  test("diamond DAG from design spec", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const result = tasks.requestBatch(a.id, a.scope, [
      { type: "implement", title: "Add auth middleware", priority: 10 },
      { type: "implement", title: "Add auth routes", priority: 10 },
      { type: "test", title: "Integration tests", priority: 5, depends_on: ["$1", "$2"] },
      { type: "review", title: "Review auth", priority: 1, depends_on: ["$3"], assignee: a.id },
    ]);

    expect("task_ids" in result).toBe(true);
    if (!("task_ids" in result)) return;

    expect(result.tasks[0].status).toBe("open");
    expect(result.tasks[1].status).toBe("open");
    expect(result.tasks[2].status).toBe("blocked");
    expect(result.tasks[3].status).toBe("blocked");

    // Complete middleware and routes
    tasks.claim(result.task_ids[0], a.scope, w.id);
    tasks.update(result.task_ids[0], a.scope, w.id, "done", "ok");
    expect(tasks.get(result.task_ids[2], a.scope)?.status).toBe("blocked");

    tasks.claim(result.task_ids[1], a.scope, w.id);
    tasks.update(result.task_ids[1], a.scope, w.id, "done", "ok");
    expect(tasks.get(result.task_ids[2], a.scope)?.status).toBe("open");
    expect(tasks.get(result.task_ids[3], a.scope)?.status).toBe("blocked");

    // Complete tests → review unblocks to claimed
    tasks.claim(result.task_ids[2], a.scope, w.id);
    tasks.update(result.task_ids[2], a.scope, w.id, "done", "ok");
    expect(tasks.get(result.task_ids[3], a.scope)?.status).toBe("claimed");
  });
});

describe("swarm_status", () => {
  test("summarizes current coordination state and next action", () => {
    const plannerInstance = regPlanner("planner-a", "scope-a");
    const worker = registry.register(
      join("C:/repo", "worker"),
      "provider:test role:implementer name:worker",
      "scope-a",
    );
    const file = paths.file(worker.directory, "src/index.ts");
    const assigned = req(plannerInstance.id, plannerInstance.scope, "implement", "Assigned", {
      assignee: worker.id,
      files: [file],
      priority: 20,
    });
    const open = req(plannerInstance.id, plannerInstance.scope, "review", "Open review", {
      priority: 5,
    });

    messages.send(plannerInstance.id, plannerInstance.scope, worker.id, "Read before starting");

    const result = status.buildStatus(worker);

    expect(result.instance).toMatchObject({ id: worker.id, role: "implementer" });
    expect(result.peers.map((peer: any) => peer.id)).toContain(plannerInstance.id);
    expect(result.planner_owner).toMatchObject({
      instance_id: plannerInstance.id,
      is_me: false,
    });
    expect(result.unread_messages).toHaveLength(1);
    expect(result.task_counts.claimed).toBe(1);
    expect(result.task_counts.open).toBe(1);
    expect(result.assigned_tasks.map((task: any) => task.id)).toContain(assigned.id);
    expect(result.claimable_tasks.map((task: any) => task.id)).toEqual([
      assigned.id,
      open.id,
    ]);
    expect(result.next_action).toMatchObject({ tool: "poll_messages" });
  });

  test("surfaces file collision and lock compliance warnings", () => {
    const plannerInstance = reg("planner", "scope-a");
    const worker = reg("worker", "scope-a");
    const peer = reg("peer", "scope-a");
    const file = paths.file(worker.directory, "src/shared.ts");

    const mine = req(plannerInstance.id, plannerInstance.scope, "implement", "Mine", {
      files: [file],
    });
    const theirs = req(plannerInstance.id, plannerInstance.scope, "fix", "Theirs", {
      files: [file],
      assignee: peer.id,
    });

    tasks.claim(mine.id, worker.scope, worker.id);
    tasks.claim(theirs.id, peer.scope, peer.id);
    context.lock(peer.id, peer.scope, file, "editing shared file");

    const result = status.buildStatus(worker);
    const codes = result.warnings.map((warning: any) => warning.code);

    expect(codes).toContain("missing_lock_for_in_progress_task");
    expect(codes).toContain("file_locked_by_peer");
    expect(codes).toContain("active_task_file_overlap");
    expect(result.blocking_locks).toEqual([
      expect.objectContaining({ file, instance_id: peer.id, task_id: mine.id }),
    ]);
  });
});

describe("list_instances label filter", () => {
  test("filters by label substring", () => {
    const a = reg("planner-a", "scope-a");
    reg("worker-b", "scope-a");

    const all = registry.list(a.scope);
    expect(all).toHaveLength(2);

    const planners = registry.list(a.scope, "planner");
    expect(planners).toHaveLength(1);
    expect((planners[0] as any).label).toBe("planner-a");

    const workers = registry.list(a.scope, "worker");
    expect(workers).toHaveLength(1);
    expect((workers[0] as any).label).toBe("worker-b");

    const none = registry.list(a.scope, "nonexistent");
    expect(none).toHaveLength(0);
  });

  test("returns all when no filter", () => {
    const a = reg("one", "scope-a");
    reg("two", "scope-a");

    expect(registry.list(a.scope)).toHaveLength(2);
    expect(registry.list(a.scope, undefined)).toHaveLength(2);
  });
});

describe("kv", () => {
  test("keys are namespaced by scope", () => {
    kv.set("scope-a", "plan", "one");
    kv.set("scope-b", "plan", "two");

    expect(kv.get("scope-a", "plan")?.value).toBe("one");
    expect(kv.get("scope-b", "plan")?.value).toBe("two");
    expect(kv.keys("scope-a")).toEqual([
      { key: "plan", updated_at: expect.any(Number) },
    ]);
  });

  test("append creates array from scratch", () => {
    kv.append("scope-a", "results", '"first"');
    const val = kv.get("scope-a", "results");
    expect(JSON.parse(val!.value)).toEqual(["first"]);
  });

  test("append pushes to existing array", () => {
    kv.append("scope-a", "log", '{"step":1}');
    kv.append("scope-a", "log", '{"step":2}');
    kv.append("scope-a", "log", '{"step":3}');

    const val = kv.get("scope-a", "log");
    expect(JSON.parse(val!.value)).toEqual([
      { step: 1 },
      { step: 2 },
      { step: 3 },
    ]);
  });

  test("append wraps non-array existing value", () => {
    kv.set("scope-a", "scalar", '"hello"');
    kv.append("scope-a", "scalar", '"world"');

    const val = kv.get("scope-a", "scalar");
    expect(JSON.parse(val!.value)).toEqual(["hello", "world"]);
  });

  test("append returns new array length", () => {
    expect(kv.append("scope-a", "counter", "1")).toBe(1);
    expect(kv.append("scope-a", "counter", "2")).toBe(2);
    expect(kv.append("scope-a", "counter", "3")).toBe(3);
  });

  test("version changes on same-second writes", () => {
    kv.set("scope-a", "one", "1");
    const first = kv.version("scope-a");

    kv.set("scope-a", "two", "2");
    const second = kv.version("scope-a");

    expect(second).toBeGreaterThan(first);
  });

  test("version changes when deleting a key", () => {
    kv.set("scope-a", "plan/latest", '"v1"');
    const first = kv.version("scope-a");

    kv.del("scope-a", "plan/latest");
    const second = kv.version("scope-a");

    expect(second).toBeGreaterThan(first);
  });

  test("set cannot overwrite a key owned by another identity", () => {
    const priorPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;
    const scope = "scope-kv-identity";
    const work = registry.register(
      "/tmp/work-kv",
      "identity:work role:planner",
      scope,
    );
    process.env.SWARM_MCP_PERSONAL_ROOTS = "/tmp/personal-kv";
    const personal = registry.register(
      "/tmp/personal-kv",
      "identity:personal role:planner",
      scope,
    );

    expect(kv.set(scope, "config/work_tracker/work", "linear", work.id)).toEqual({ ok: true });
    expect(kv.set(scope, "config/work_tracker/work", "garbage", personal.id)).toEqual({
      error: "KV key is owned by another identity",
    });
    expect(kv.get(scope, "config/work_tracker/work", work.id)?.value).toBe("linear");
    expect(kv.get(scope, "config/work_tracker/work", personal.id)).toBeNull();
    restoreEnv("SWARM_MCP_PERSONAL_ROOTS", priorPersonalRoots);
  });

  test("cleanup removes old orphaned instance-scoped kv and keeps durable plans", () => {
    const worker = reg("worker", "scope-a");
    const old =
      Math.floor(Date.now() / 1000) -
      cleanup.CLEANUP_POLICY.orphanKvTtlSecs -
      1;

    kv.set(worker.scope, `progress/${worker.id}`, '"active"');
    kv.set(worker.scope, "progress/missing-worker", '"old"');
    kv.set(worker.scope, "plan/missing-planner", '"old"');
    kv.set(worker.scope, "plan/latest", '"keep"');
    db.run("UPDATE kv SET updated_at = ?", [old]);

    const result = cleanup.runCleanup({ scope: worker.scope, mode: "manual" });

    expect(result.kv_deleted).toBe(2);
    expect(kv.get(worker.scope, `progress/${worker.id}`)).not.toBeNull();
    expect(kv.get(worker.scope, "progress/missing-worker")).toBeNull();
    expect(kv.get(worker.scope, "plan/missing-planner")).toBeNull();
    expect(kv.get(worker.scope, "plan/latest")).not.toBeNull();
  });

  test("cleanup dry-run reports orphaned kv without deleting it", () => {
    const worker = reg("worker", "scope-a");
    const old =
      Math.floor(Date.now() / 1000) -
      cleanup.CLEANUP_POLICY.orphanKvTtlSecs -
      1;
    kv.set(worker.scope, "progress/missing-worker", '"old"');
    db.run("UPDATE kv SET updated_at = ?", [old]);

    const result = cleanup.runCleanup({
      scope: worker.scope,
      mode: "manual",
      dryRun: true,
    });

    expect(result.kv_deleted).toBe(1);
    expect(kv.get(worker.scope, "progress/missing-worker")).not.toBeNull();
  });

  test("cleanup deletes locks whose owning instance is no longer registered", () => {
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/foo.ts");

    context.lock(worker.id, worker.scope, file, "editing");
    const before = context.lookup(worker.scope, file) as Array<{ type: string }>;
    expect(before.find((c) => c.type === "lock")).toBeDefined();

    db.run("DELETE FROM instances WHERE id = ?", [worker.id]);

    const result = cleanup.runCleanup({ mode: "manual" });

    expect(result.locks_deleted).toBeGreaterThanOrEqual(1);
    const after = context.lookup(worker.scope, file) as Array<{ type: string }>;
    expect(after.find((c) => c.type === "lock")).toBeUndefined();
  });

  test("orphan-lock sweep dry-run reports without deleting", () => {
    const worker = reg("worker", "scope-a");
    const file = paths.file(worker.directory, "src/bar.ts");
    context.lock(worker.id, worker.scope, file, "editing");
    db.run("DELETE FROM instances WHERE id = ?", [worker.id]);

    const result = cleanup.runCleanup({ mode: "manual", dryRun: true });

    expect(result.locks_deleted).toBeGreaterThanOrEqual(1);
    const after = context.lookup(worker.scope, file) as Array<{ type: string }>;
    expect(after.find((c) => c.type === "lock")).toBeDefined();
  });
});

describe("planner ownership", () => {
  test("first active planner claims owner/planner automatically", () => {
    const first = regPlanner("planner-a", "scope-a");

    expect(planner.getOwner(first.scope)).toMatchObject({
      instance_id: first.id,
    });
  });

  test("owner/planner fails over to the next planner on deregister", () => {
    const first = regPlanner("planner-a", "scope-a");
    const second = regPlanner("planner-b", "scope-a");

    registry.deregister(first.id);

    expect(planner.getOwner(second.scope)).toMatchObject({
      instance_id: second.id,
    });
  });

  test("owner/planner fails over when the current owner goes offline", () => {
    const first = regPlanner("planner-a", "scope-a");
    const second = regPlanner("planner-b", "scope-a");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [0, first.id]);
    registry.prune();

    expect(planner.getOwner(second.scope)).toMatchObject({
      instance_id: second.id,
    });
  });
});

describe("linear promotion bridge (VUH-36)", () => {
  function regGateway(scope: string, label: string) {
    return registry.register(join("C:/repo", "gateway"), label, scope);
  }

  function publishTracker(
    scope: string,
    identity: string,
    overrides: Record<string, unknown> = {},
  ) {
    kv.set(
      scope,
      `config/work_tracker/${identity}`,
      JSON.stringify({
        schema_version: 1,
        identity,
        provider: "linear",
        mcp: "linear",
        ...overrides,
      }),
    );
  }

  function taskInput(
    overrides: Partial<TaskPromotionInput> = {},
  ): TaskPromotionInput {
    return {
      task_id: "task-1",
      type: "implement",
      title: "Wire the new promotion bridge into dispatch handoff",
      description:
        "Multi-line description that is comfortably above the trivial-edit threshold so the medium-or-larger heuristic does not bail out for the default test case.",
      idempotency_key: "dispatch:abcd1234",
      parent_task_id: null,
      label: "identity:default role:implementer",
      files: ["src/work_tracker.ts"],
      ...overrides,
    };
  }

  test("evaluatePromotion creates when policy fires and tracker is configured", () => {
    const scope = "scope-promotion-create";
    publishTracker(scope, "default");
    const tracker = workTracker.configuredWorkTracker(scope, "identity:default");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput(),
      tracker,
    });

    expect(result.decision).toMatchObject({
      promote: true,
      mode: "create",
      identity: "default",
      provider: "linear",
      existing_binding: null,
    });
    // No auto-write for the create path — the gateway has to call Linear MCP
    // first and write the binding when it knows the issuer identifier.
    expect(workTracker.getBinding(scope, "linear", "default", "task-1")).toBeNull();
  });

  test("evaluatePromotion skips when no tracker is configured", () => {
    const scope = "scope-promotion-skip";
    const tracker = workTracker.configuredWorkTracker(scope, "identity:default");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput(),
      tracker,
    });

    expect(result.decision).toMatchObject({
      promote: false,
      reason: "no_tracker_configured",
      identity: "default",
    });
    expect(workTracker.getBinding(scope, "linear", "default", "task-1")).toBeNull();
  });

  test("evaluatePromotion skips when label has no identity token", () => {
    const scope = "scope-promotion-noidentity";
    publishTracker(scope, "default");
    const tracker = workTracker.configuredWorkTracker(scope, "");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput({ label: "role:implementer" }),
      tracker,
    });

    expect(result.decision).toMatchObject({
      promote: false,
      reason: "missing_identity_label",
    });
  });

  test("type=test and trivial inline edits are not promoted", () => {
    const scope = "scope-promotion-trivial";
    publishTracker(scope, "default");
    const tracker = workTracker.configuredWorkTracker(scope, "identity:default");

    const testKindDecision = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput({ task_id: "task-test", type: "test" }),
      tracker,
    }).decision;
    expect(testKindDecision).toMatchObject({
      promote: false,
      reason: "type_not_promotable",
    });

    const trivialDecision = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput({
        task_id: "task-trivial",
        title: "Tiny tweak",
        description: "one-liner",
        files: ["src/x.ts"],
      }),
      tracker,
    }).decision;
    expect(trivialDecision).toMatchObject({
      promote: false,
      reason: "trivial_inline_edit",
    });
  });

  test("explicit linear:VUH-XX in idempotency key writes the binding row immediately", () => {
    const scope = "scope-promotion-link";
    publishTracker(scope, "default");
    const tracker = workTracker.configuredWorkTracker(scope, "identity:default");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput({
        task_id: "task-link",
        idempotency_key: "linear:VUH-20:implement",
      }),
      tracker,
    });

    expect(result.decision).toMatchObject({
      promote: true,
      mode: "link",
      identifier: "VUH-20",
      reason: "explicit_identifier",
    });
    expect(result.binding_written).toMatchObject({ identifier: "VUH-20" });
    expect(
      workTracker.getBinding(scope, "linear", "default", "task-link"),
    ).toMatchObject({ identifier: "VUH-20" });
  });

  test("per-dispatch promote=false suppresses promotion even when policy would fire", () => {
    const scope = "scope-promotion-suppressed";
    publishTracker(scope, "default");
    const tracker = workTracker.configuredWorkTracker(scope, "identity:default");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput(),
      tracker,
      override: { promote: false },
    });

    expect(result.decision).toMatchObject({
      promote: false,
      reason: "operator_suppressed",
    });
  });

  test("identity mismatch between task label and configured tracker is refused", () => {
    const scope = "scope-promotion-mismatch";
    // tracker config explicitly belongs to a different identity ("work"),
    // but the task is labeled identity:personal — the bridge must refuse.
    kv.set(
      scope,
      "config/work_tracker/personal",
      JSON.stringify({ identity: "work", provider: "linear", mcp: "linear_work" }),
    );
    const tracker = workTracker.configuredWorkTracker(scope, "identity:personal");

    const result = workTracker.evaluateAndAutoLink({
      scope,
      task: taskInput({ label: "identity:personal role:implementer" }),
      tracker,
    });

    expect(result.decision).toMatchObject({
      promote: false,
      reason: "identity_mismatch",
    });
  });

  test("a worker missing the Linear MCP records tracker_update_skipped on complete_task", () => {
    const scope = "/tmp/scope-promotion-worker";
    const worker = registry.register(
      "/tmp/scope-promotion-worker",
      "identity:default role:implementer",
      scope,
    );
    const task = req(worker.id, worker.scope, "implement", "Land VUH-36 bridge", {
      description:
        "Bridge implementation per docs/linear-promotion-policy.md — non-trivial.",
    });
    tasks.claim(task.id, worker.scope, worker.id);

    const completed = tasks.completeStructured(task.id, worker.scope, worker.id, {
      summary: "Bridge implementation landed",
      tracker_update_skipped: {
        provider: "linear",
        reason: "no Linear MCP in claude harness",
        next: "planner should dispatch hermes to update Linear",
      },
    });

    expect(completed).toMatchObject({
      ok: true,
      status: "done",
      result: {
        summary: "Bridge implementation landed",
        tracker_update_skipped: {
          provider: "linear",
          reason: "no Linear MCP in claude harness",
        },
      },
    });
  });

  test("dispatch attaches promotion decision to its response", async () => {
    const scope = "/tmp/scope-promotion-dispatch";
    const gateway = regGateway(
      scope,
      "identity:default mode:gateway role:planner",
    );
    publishTracker(gateway.scope, "default");

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Promote me — a sufficiently lengthy implementation title to clear the medium-or-larger heuristic",
      type: "implement",
      role: "implementer",
      message:
        "Implementation contract: write the new tracker bridge and wire the Linear MCP call. Multiple files. Non-trivial.",
      spawn: false,
    });

    expect((result as Record<string, unknown>).promotion).toBeDefined();
    const promo = (result as Record<string, unknown>).promotion as {
      decision: PromotionDecision;
    };
    expect(promo.decision).toMatchObject({
      promote: true,
      mode: "create",
      identity: "default",
      provider: "linear",
    });
  });

  test("dispatch with explicit promote_identifier emits a link decision and writes binding", async () => {
    const scope = "/tmp/scope-promotion-dispatch-link";
    const gateway = regGateway(
      scope,
      "identity:default mode:gateway role:planner",
    );
    publishTracker(gateway.scope, "default");

    const result = (await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Continue work tracked elsewhere",
      type: "implement",
      role: "implementer",
      message: "Link to VUH-36 explicitly.",
      promote_identifier: "VUH-36",
      spawn: false,
    })) as Record<string, unknown>;

    const promotion = result.promotion as {
      decision: PromotionDecision;
      binding_written?: TrackerBinding;
    };
    expect(promotion.decision).toMatchObject({
      promote: true,
      mode: "link",
      identifier: "VUH-36",
    });
    expect(promotion.binding_written).toMatchObject({ identifier: "VUH-36" });

    const taskId = result.task_id as string;
    expect(
      workTracker.getBinding(gateway.scope, "linear", "default", taskId),
    ).toMatchObject({ identifier: "VUH-36" });
  });
});
