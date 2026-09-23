import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore, type ActorContext } from "../src/coordination/core";
import type { Reservation } from "../src/coordination/reservations";
type Acquisition = {
  acquired: boolean;
  grants: Reservation[];
  reused: Reservation[];
  conflicts: Reservation[];
  warnings: Reservation[];
};
const stores: CoordinationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  let now = 1000,
    seq = 0;
  const root = mkdtempSync(join(tmpdir(), "swarm-reservations-")),
    main = join(root, "main"),
    peer = join(root, "peer"),
    repo = join(root, "repository");
  for (const path of [main, peer, repo]) mkdirSync(path);
  const path = join(root, "db.sqlite"),
    store = await CoordinationStore.open({ path, clock: () => now });
  stores.push(store);
  const core = new CoordinationCore(store);
  const ae = {
    scope: "test",
    agentId: "alice",
    requestId: "enroll-a",
    resumeToken: randomBytes(32).toString("hex"),
    worktree: { root: main, repository: repo },
  };
  const be = {
    ...ae,
    agentId: "bob",
    requestId: "enroll-b",
    resumeToken: randomBytes(32).toString("hex"),
  };
  const alice = store.openSession(ae),
    bob = store.openSession(be),
    carol = store.openSession({
      ...be,
      agentId: "carol",
      requestId: "enroll-c",
      worktree: { root: peer, repository: repo },
    });
  const acquire = (
    actor: ActorContext,
    paths: string[],
    options: {
      kind?: "file" | "integration";
      leaseMs?: number;
      attemptId?: string;
    } = {},
  ) =>
    core.command(actor, {
      id: `acquire-${++seq}`,
      type: "reservation.acquire",
      payload: {
        kind: "file",
        paths,
        reason: "test critical section",
        ...options,
      },
    }).value as unknown as Acquisition;
  return {
    root,
    main,
    peer,
    repo,
    path,
    store,
    core,
    alice,
    bob,
    carol,
    ae,
    be,
    acquire,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("multi-file acquisition is atomic and conflict includes actionable holder details", async () => {
  const e = await fixture(),
    a = e.acquire(e.alice, ["b.txt"]);
  e.advance(10);
  const b = e.acquire(e.bob, ["a.txt", "b.txt"]);
  expect(b.acquired).toBe(false);
  expect(b.grants).toEqual([]);
  expect(b.conflicts[0]).toMatchObject({
    actor: "alice",
    reason: "test critical section",
    ageMs: 10,
    expires_at: 61000,
  });
  expect(e.core.reservations(e.bob)).toHaveLength(1);
  e.core.command(e.alice, {
    id: "release",
    type: "reservation.release",
    payload: { grants: a.grants },
  });
  expect(e.acquire(e.bob, ["b.txt", "a.txt"]).grants).toHaveLength(2);
});
test("nested tools reuse enclosing grants without releasing them", async () => {
  const e = await fixture(),
    outer = e.acquire(e.alice, ["a.txt"]),
    inner = e.acquire(e.alice, ["a.txt", "b.txt"]);
  expect(inner.reused[0]!.id).toBe(outer.grants[0]!.id);
  expect(inner.grants).toHaveLength(1);
  e.core.command(e.alice, {
    id: "inner-release",
    type: "reservation.release",
    payload: { grants: inner.grants },
  });
  expect(e.acquire(e.bob, ["a.txt"]).acquired).toBe(false);
  expect(e.acquire(e.bob, ["b.txt"]).acquired).toBe(true);
});
test("expired and superseded holders cannot release or renew replacement grants", async () => {
  const e = await fixture(),
    first = e.acquire(e.alice, ["a.txt"], { leaseMs: 10 });
  e.advance(10);
  const next = e.acquire(e.bob, ["a.txt"]);
  expect(next.acquired).toBe(true);
  expect(next.grants[0]!.fence).toBeGreaterThan(first.grants[0]!.fence);
  expect(() =>
    e.core.command(e.alice, {
      id: "stale-release",
      type: "reservation.release",
      payload: { grants: first.grants },
    }),
  ).toThrow("expired");
  expect(() =>
    e.core.command(e.alice, {
      id: "wrong-owner",
      type: "reservation.renew",
      payload: { grants: next.grants },
    }),
  ).toThrow("another session");
  const resumed = e.store.openSession({ ...e.be, requestId: "restart" });
  expect(() =>
    e.core.command(e.bob, {
      id: "old",
      type: "reservation.release",
      payload: { grants: next.grants },
    }),
  ).toThrow("superseded");
  expect(e.acquire(resumed, ["a.txt"]).acquired).toBe(true);
});
test("cross-worktree edits warn without physical serialization; integration is exclusive", async () => {
  const e = await fixture();
  e.acquire(e.alice, ["same.txt"]);
  const peer = e.acquire(e.carol, ["same.txt"]);
  expect(peer.acquired).toBe(true);
  expect(peer.warnings[0]!.actor).toBe("alice");
  expect(peer.grants[0]!.resource).not.toBe(peer.warnings[0]!.resource);
  expect(e.acquire(e.alice, [], { kind: "integration" }).acquired).toBe(true);
  expect(e.acquire(e.carol, [], { kind: "integration" }).acquired).toBe(false);
  expect(e.acquire(e.bob, ["unrelated-in-main.txt"]).acquired).toBe(false);
  expect(e.acquire(e.carol, ["unrelated-in-peer.txt"]).acquired).toBe(true);
});
test("task-bound grants expire with their attempt and checks reject stale fences", async () => {
  const e = await fixture();
  const task = e.core.command(e.alice, {
    id: "task",
    type: "task.create",
    payload: { title: "work" },
  }).value as { task: { id: string; version: number } };
  const attempt = e.core.command(e.alice, {
    id: "claim",
    type: "task.claim",
    payload: {
      taskId: task.task.id,
      expectedVersion: task.task.version,
      leaseMs: 100,
    },
  }).value as { attemptId: string };
  const acquired = e.acquire(e.alice, ["task.txt"], {
    attemptId: attempt.attemptId,
    leaseMs: 1000,
  });
  expect(acquired.grants[0]!.expires_at).toBe(1100);
  expect(() =>
    e.core.command(e.alice, {
      id: "wrong-fence",
      type: "reservation.check",
      payload: { grants: [{ id: acquired.grants[0]!.id, fence: 999 }] },
    }),
  ).toThrow("superseded");
  e.advance(100);
  expect(e.acquire(e.bob, ["task.txt"]).acquired).toBe(true);
});
