import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-events-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const context = await import("../src/context");
const events = await import("../src/events");
const kv = await import("../src/kv");
const messages = await import("../src/messages");
const registry = await import("../src/registry");
const tasks = await import("../src/tasks");

const originalAllowUnlabeled = process.env.SWARM_MCP_ALLOW_UNLABELED;

// `registry.register` runs the `value` arg through `clean()` (resolve +
// normalize), so the live scope is the normalized form — keep a literal
// for INSERTs but read the canonical form back from `paths.scope` for
// query-side helpers.
const SCOPE_HINT = "test-scope-events";

let SCOPE: string;
beforeEach(() => {
  process.env.SWARM_MCP_ALLOW_UNLABELED = "1";
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
  // Cheap way to discover the post-clean scope: register/derive once.
  const tmpInst = registry.register(
    join("/tmp/__events_scope_probe"),
    "probe",
    SCOPE_HINT,
  );
  SCOPE = tmpInst.scope;
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM instances");
});

afterEach(() => {
  if (originalAllowUnlabeled === undefined) delete process.env.SWARM_MCP_ALLOW_UNLABELED;
  else process.env.SWARM_MCP_ALLOW_UNLABELED = originalAllowUnlabeled;
});

function reg(name: string) {
  return registry.register(join("/tmp/repo", name), name, SCOPE_HINT);
}

function listEvents() {
  return events.listSince(SCOPE, 0, 1000);
}

function eventTypes() {
  return listEvents().map((e) => e.type);
}

describe("events: registry", () => {
  test("register emits instance.registered", () => {
    const a = reg("alice");
    const types = eventTypes();
    expect(types).toContain("instance.registered");
    const e = listEvents().find((x) => x.type === "instance.registered");
    expect(e?.actor).toBe(a.id);
    expect(e?.subject).toBe(a.id);
  });

  test("deregister emits instance.deregistered", () => {
    const a = reg("alice");
    db.exec("DELETE FROM events"); // isolate
    registry.deregister(a.id);
    const types = eventTypes();
    expect(types).toContain("instance.deregistered");
  });

  test("offline prune emits instance.stale_reclaimed inside the cleanup tx", () => {
    const a = reg("alice");
    reg("bob"); // keeps the recipient list non-empty for broadcast
    // Force alice's heartbeat into the offline window so the next prune reclaims her.
    db.run(`UPDATE instances SET heartbeat = ? WHERE id = ?`, [
      Math.floor(Date.now() / 1000) - 120,
      a.id,
    ]);
    db.exec("DELETE FROM events"); // isolate

    // Trigger prune via any registry-backed path.
    registry.list(SCOPE);

    const reclaimed = listEvents().filter(
      (e) => e.type === "instance.stale_reclaimed",
    );
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].subject).toBe(a.id);
    expect(reclaimed[0].actor).toBe("system");
  });
});

describe("events: messages", () => {
  test("send emits message.sent", () => {
    const a = reg("alice");
    const b = reg("bob");
    db.exec("DELETE FROM events");
    messages.send(a.id, SCOPE, b.id, "hello");
    const e = listEvents().find((x) => x.type === "message.sent");
    expect(e).toBeDefined();
    expect(e?.actor).toBe(a.id);
    expect(e?.subject).toBe(b.id);
  });

  test("broadcast emits one message.broadcast event with recipient count", () => {
    const a = reg("alice");
    reg("bob");
    reg("charlie");
    db.exec("DELETE FROM events");
    messages.broadcast(a.id, SCOPE, "all hands");
    const broadcasts = listEvents().filter(
      (e) => e.type === "message.broadcast",
    );
    expect(broadcasts).toHaveLength(1);
    const payload = JSON.parse(broadcasts[0].payload!);
    expect(payload.recipients).toBe(2);
  });
});

describe("events: kv", () => {
  test("set emits kv.set with the actor", () => {
    const a = reg("alice");
    db.exec("DELETE FROM events");
    kv.set(SCOPE, "pixel:turn", '{"n":1}', a.id);
    const e = listEvents().find((x) => x.type === "kv.set");
    expect(e?.actor).toBe(a.id);
    expect(e?.subject).toBe("pixel:turn");
  });

  test("set without actor leaves actor null", () => {
    kv.set(SCOPE, "k", "v");
    const e = listEvents().find((x) => x.type === "kv.set");
    expect(e?.actor).toBeNull();
  });

  test("del only emits when something was deleted", () => {
    kv.del(SCOPE, "missing");
    expect(eventTypes().filter((t) => t === "kv.deleted")).toHaveLength(0);

    kv.set(SCOPE, "k", "v");
    db.exec("DELETE FROM events");
    kv.del(SCOPE, "k");
    expect(eventTypes()).toContain("kv.deleted");
  });
});

describe("events: context", () => {
  test("lock emits context.lock_acquired", () => {
    const a = reg("alice");
    db.exec("DELETE FROM events");
    context.lock(a.id, SCOPE, "/tmp/foo.ts", "editing");
    const types = eventTypes();
    expect(types).toContain("context.lock_acquired");
  });

  test("clearLocks emits context.lock_released only when something was removed", () => {
    const a = reg("alice");
    context.clearLocks(a.id, SCOPE, "/tmp/never-locked.ts");
    expect(eventTypes()).not.toContain("context.lock_released");

    context.lock(a.id, SCOPE, "/tmp/foo.ts", "x");
    db.exec("DELETE FROM events");
    context.clearLocks(a.id, SCOPE, "/tmp/foo.ts");
    expect(eventTypes()).toContain("context.lock_released");
  });
});

describe("events: tasks + cascades", () => {
  test("request emits task.created", () => {
    const a = reg("alice");
    db.exec("DELETE FROM events");
    const r = tasks.request(a.id, SCOPE, "implement", "do thing");
    if ("error" in r) throw new Error(r.error);
    const e = listEvents().find((x) => x.type === "task.created");
    expect(e?.subject).toBe(r.id);
    expect(e?.actor).toBe(a.id);
  });

  test("claim then update emits the right pair", () => {
    const a = reg("alice");
    const b = reg("bob");
    const r = tasks.request(a.id, SCOPE, "implement", "do thing");
    if ("error" in r) throw new Error(r.error);
    db.exec("DELETE FROM events");

    const claimed = tasks.claim(r.id, SCOPE, b.id);
    if ("error" in claimed) throw new Error(claimed.error);
    const updated = tasks.update(r.id, SCOPE, b.id, "done");
    if ("error" in updated) throw new Error(updated.error);

    const types = eventTypes();
    expect(types).toContain("task.claimed");
    expect(types).toContain("task.updated");
  });

  test("completing a task that unblocks dependents emits task.cascade.unblocked", () => {
    const a = reg("alice");
    const b = reg("bob");
    const dep = tasks.request(a.id, SCOPE, "implement", "dep", { assignee: a.id });
    if ("error" in dep) throw new Error(dep.error);
    const dependent = tasks.request(a.id, SCOPE, "implement", "dependent", {
      depends_on: [dep.id],
      assignee: b.id,
    });
    if ("error" in dependent) throw new Error(dependent.error);

    // Sanity: dependent should be blocked while dep is open.
    const before = db
      .query("SELECT status FROM tasks WHERE id = ?")
      .get(dependent.id) as { status: string };
    expect(before.status).toBe("blocked");

    db.exec("DELETE FROM events");
    const r = tasks.update(dep.id, SCOPE, a.id, "done");
    if ("error" in r) throw new Error(r.error);

    const cascade = listEvents().filter(
      (e) => e.type === "task.cascade.unblocked",
    );
    expect(cascade).toHaveLength(1);
    expect(cascade[0].subject).toBe(dependent.id);
    expect(cascade[0].actor).toBe("system");
    const payload = JSON.parse(cascade[0].payload!);
    expect(payload.trigger).toBe(dep.id);
  });

  test("failing a dep cascades cancellation to all dependents", () => {
    const a = reg("alice");
    const dep = tasks.request(a.id, SCOPE, "implement", "dep", { assignee: a.id });
    if ("error" in dep) throw new Error(dep.error);
    const child = tasks.request(a.id, SCOPE, "implement", "child", {
      depends_on: [dep.id],
      assignee: a.id,
    });
    if ("error" in child) throw new Error(child.error);
    const grandchild = tasks.request(a.id, SCOPE, "implement", "grandchild", {
      depends_on: [child.id],
      assignee: a.id,
    });
    if ("error" in grandchild) throw new Error(grandchild.error);

    db.exec("DELETE FROM events");
    const r = tasks.update(dep.id, SCOPE, a.id, "failed", "broke");
    if ("error" in r) throw new Error(r.error);

    const cancels = listEvents().filter(
      (e) => e.type === "task.cascade.cancelled",
    );
    const subjects = cancels.map((e) => e.subject);
    expect(subjects).toContain(child.id);
    expect(subjects).toContain(grandchild.id);
  });
});

describe("events: TTL", () => {
  test("cleanup deletes events older than 24h", () => {
    const a = reg("alice");
    db.exec("DELETE FROM events");
    events.emit({ scope: SCOPE, type: "kv.set", actor: a.id, subject: "x" });
    // Backdate: stamp the row 25h in the past.
    db.run("UPDATE events SET created_at = ?", [
      Math.floor(Date.now() / 1000) - 25 * 60 * 60,
    ]);

    events.emit({ scope: SCOPE, type: "kv.set", actor: a.id, subject: "y" });

    events.cleanup();

    const remaining = listEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].subject).toBe("y");
  });
});

describe("events: scope filtering", () => {
  test("listSince only returns rows for the requested scope", () => {
    events.emit({ scope: "scope-a", type: "kv.set", subject: "x" });
    events.emit({ scope: "scope-b", type: "kv.set", subject: "y" });
    expect(events.listSince("scope-a", 0).map((e) => e.subject)).toEqual(["x"]);
    expect(events.listSince("scope-b", 0).map((e) => e.subject)).toEqual(["y"]);
  });

  test("listSince respects sinceId", () => {
    events.emit({ scope: SCOPE, type: "kv.set", subject: "1" });
    events.emit({ scope: SCOPE, type: "kv.set", subject: "2" });
    const all = events.listSince(SCOPE, 0);
    expect(all).toHaveLength(2);
    const after = events.listSince(SCOPE, all[0].id);
    expect(after.map((e) => e.subject)).toEqual(["2"]);
  });
});
