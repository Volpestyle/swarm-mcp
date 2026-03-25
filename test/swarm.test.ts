import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const context = await import("../src/context");
const kv = await import("../src/kv");
const messages = await import("../src/messages");
const registry = await import("../src/registry");
const tasks = await import("../src/tasks");
const paths = await import("../src/paths");

beforeEach(() => {
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM instances");
});

function reg(name: string, scope: string) {
  return registry.register(join("C:/repo", name), name, scope);
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

    const id = tasks.request(
      requester.id,
      requester.scope,
      "review",
      "Check change",
    );

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
    const id = tasks.request(
      requester.id,
      requester.scope,
      "fix",
      "Fix bug",
      undefined,
      [file],
      worker.id,
    );

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
});
