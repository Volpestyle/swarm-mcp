import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CoordinationStore, type Task } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";

test("bootstrap resumes from a scoped snapshot and summary pages omit large payloads", async () => {
  const store = await CoordinationStore.open({
    path: join(mkdtempSync(join(tmpdir(), "swarm-queries-")), "db"),
  });
  const core = new CoordinationCore(store);
  const enroll = (
    agentId: string,
    scope = "test",
    label = "role:implementer",
  ) =>
    store.openSession({
      scope,
      agentId,
      label,
      requestId: "enroll",
      resumeToken: randomBytes(32).toString("hex"),
    });
  try {
    const alice = enroll("alice"),
      bob = enroll("bob", "test", "role:reviewer"),
      outside = enroll("outsider", "other", "role:reviewer");
    const tasks: Task[] = [];
    for (let i = 0; i < 3; i++)
      tasks.push(
        (
          core.command(alice, {
            id: `task-${i}`,
            type: "task.create",
            payload: { title: `work ${i}` },
          }).value as unknown as { task: Task }
        ).task,
      );
    core.command(bob, {
      id: "claim",
      type: "task.claim",
      payload: { taskId: tasks[0]!.id, expectedVersion: 1 },
    });
    expect(core.taskDetail(alice, tasks[0]!.id)).toMatchObject({
      scope: "test",
      taskId: tasks[0]!.id,
      dependencies: [],
      owner: { actor: "bob", active: true },
      contract: null,
    });
    expect(() => core.taskDetail(outside, tasks[0]!.id)).toThrow(
      "does not exist",
    );
    core.command(alice, {
      id: "send",
      type: "message.send",
      payload: {
        recipient: "bob",
        kind: "question",
        body: "private message body",
      },
    });
    const first = core.taskSummaries(alice, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(
      core.taskSummaries(alice, { cursor: first.cursor, limit: 2 }).items,
    ).toHaveLength(1);
    expect(core.taskSummaries(bob, { owner: "bob" }).items[0]!.id).toBe(
      tasks[0]!.id,
    );
    expect(core.taskSummaries(outside).items).toEqual([]);
    const snapshot = core.bootstrap(bob);
    expect(snapshot.tasks.items[0]!.owner).toBe("bob");
    expect(snapshot.inbox).toEqual([{ state: "pending", count: 1 }]);
    expect(JSON.stringify(snapshot)).not.toContain("private message body");
    expect(core.events(bob, snapshot.eventCursor).items).toEqual([]);
    core.command(alice, {
      id: "next",
      type: "task.create",
      payload: { title: "next event" },
    });
    expect(core.events(bob, snapshot.eventCursor).items[0]!.type).toBe(
      "task.created",
    );
    const peers = core.peers(alice, { role: "reviewer" });
    expect(peers.items.map((p) => p.agentId)).toEqual(["bob"]);
    expect(JSON.stringify(peers)).not.toContain("resume_hash");
    expect(JSON.stringify(peers)).not.toContain("capability");
    const peerPage = core.peers(alice, { limit: 1 });
    expect(
      core.peers(alice, { cursor: peerPage.cursor, limit: 1 }).items,
    ).toHaveLength(1);
    core.command(bob, { id: "suspend", type: "session.suspend", payload: {} });
    expect(core.peers(alice, { role: "reviewer" }).items).toEqual([]);
    expect(core.taskDetail(alice, tasks[0]!.id).owner!.active).toBe(false);
    expect(() => core.bootstrap(bob)).toThrow();
    expect(() => core.peers(alice, { limit: 51 })).toThrow("1..50");
    expect(() => core.taskSummaries(alice, { status: "invented" })).toThrow(
      "Unknown task state",
    );
  } finally {
    store.close();
  }
});
