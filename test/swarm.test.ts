import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RequestResult,
  RequestOpts,
  TaskType,
  TaskStatus,
} from "../src/tasks";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const context = await import("../src/context");
const kv = await import("../src/kv");
const messages = await import("../src/messages");
const planner = await import("../src/planner");
const registry = await import("../src/registry");
const tasks = await import("../src/tasks");
const paths = await import("../src/paths");

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
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
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
});

describe("scope", () => {
  test("non-git directories fall back to their own path as scope", () => {
    const dir = join("C:/plain", "workspace");

    expect(paths.scope(dir)).toBe(paths.norm(dir));
  });

  test("stale instances are pruned before lookups succeed", () => {
    const item = reg("worker", "scope-a");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [0, item.id]);

    expect(registry.get(item.id)).toBeNull();
  });
});

describe("tasks", () => {
  test("claiming is single-winner and updates are ownership checked", () => {
    const requester = reg("requester", "scope-a");
    const assignee = reg("assignee", "scope-a");
    const other = reg("other", "scope-a");

    const { id } = req(requester.id, requester.scope, "review", "Check change");

    expect(tasks.claim(id, assignee.scope, assignee.id)).toEqual({ ok: true });
    expect(tasks.claim(id, other.scope, other.id)).toEqual({
      error: "Task is already claimed",
    });
    expect(tasks.update(id, other.scope, other.id, "in_progress")).toEqual({
      error: "Only the assignee can update this task",
    });
    expect(
      tasks.update(id, assignee.scope, assignee.id, "in_progress"),
    ).toEqual({ ok: true });
    expect(
      tasks.update(id, assignee.scope, assignee.id, "done", "done"),
    ).toEqual({ ok: true });
    expect(tasks.get(id, assignee.scope)?.status).toBe("done");
  });

  test("stale assignees are released and their locks are removed", () => {
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
    expect(snapshot.failed.map((task: any) => task.id)).toContain(failed);
    expect(snapshot.cancelled.map((task: any) => task.id)).toContain(cancelled);
    expect(snapshot.approval_required.map((task: any) => task.id)).toContain(
      gated.id,
    );
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

  test("blocked tasks cannot be moved to in_progress", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id: t1 } = req(a.id, a.scope, "implement", "Task 1");
    const { id: t2 } = req(a.id, a.scope, "implement", "Task 2", {
      depends_on: [t1],
    });

    const result = tasks.update(t2, a.scope, w.id, "in_progress");
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

  test("approval_required tasks cannot be moved to in_progress", () => {
    const a = reg("planner", "scope-a");
    const w = reg("worker", "scope-a");

    const { id } = req(a.id, a.scope, "implement", "Not approved yet", {
      approval_required: true,
    });

    const result = tasks.update(id, a.scope, w.id, "in_progress");
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

describe("stale release with new statuses", () => {
  test("blocked tasks keep status when assignee goes stale", () => {
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

  test("owner/planner fails over when the current owner goes stale", () => {
    const first = regPlanner("planner-a", "scope-a");
    const second = regPlanner("planner-b", "scope-a");

    db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [0, first.id]);
    registry.prune();

    expect(planner.getOwner(second.scope)).toMatchObject({
      instance_id: second.id,
    });
  });
});
