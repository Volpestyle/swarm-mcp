import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import { Database } from "bun:sqlite";

test("diagnostics count real SQLite writer contention after rollback", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "diagnostic-contention-")),
    "db",
  );
  const store = await CoordinationStore.open({ path });
  const contender = new Database(path);
  try {
    contender.exec("BEGIN IMMEDIATE");
    expect(() =>
      new CoordinationCore(store).command(
        { scope: "test", actor: "worker" },
        { id: "blocked", type: "task.create", payload: { title: "contended" } },
      ),
    ).toThrow();
    contender.exec("ROLLBACK");
    expect(store.inspect("test").processMetrics.databaseBusyErrors).toBe(1);
    expect(store.inspect("other").processMetrics.databaseBusyErrors).toBe(0);
  } finally {
    contender.close();
    store.close();
  }
}, 10000);

test("diagnostics distinguish processing, ack and stale runtime without disclosing content or credentials", async () => {
  let now = 1000;
  const store = await CoordinationStore.open({
    path: join(mkdtempSync(join(tmpdir(), "diagnostics-")), "db"),
    clock: () => now,
  });
  const core = new CoordinationCore(store);
  const session = store.openSession({
    scope: "one",
    agentId: "worker",
    requestId: "open",
    resumeToken: "private-resume-token-at-least-32-characters",
  });
  try {
    core.command(session, {
      id: "available",
      type: "session.observe",
      payload: { runtime: "available" },
    });
    core.command(session, {
      id: "send",
      type: "message.send",
      payload: {
        recipient: "worker",
        kind: "note",
        body: "PRIVATE MESSAGE CONTENT",
      },
    });
    core.command(
      { scope: "other", actor: "hidden" },
      {
        id: "send",
        type: "message.send",
        payload: {
          recipient: "hidden",
          kind: "note",
          body: "OTHER SCOPE CONTENT",
        },
      },
    );
    let report = core.inspect(session);
    expect(report.deliveries.items[0]!.state).toBe("pending");
    expect(report.sessions.items[0]!.availability).toBe("available");
    const fetched = core.command(session, {
      id: "fetch",
      type: "inbox.fetch",
      payload: { consumer: "worker", leaseMs: 100 },
    }).value as any;
    const lease = fetched.deliveries[0];
    report = core.inspect(session);
    expect(
      report.audit.items.find((e) => e.type === "delivery.leased"),
    ).toMatchObject({
      sessionId: session.sessionId,
      generation: session.generation,
    });
    expect(report.deliveries.items[0]!.recovery).toContain(
      "await processing acknowledgment",
    );
    now += 50;
    core.command(session, {
      id: "ack",
      type: "inbox.ack",
      payload: { messageId: lease.message.id, leaseToken: lease.leaseToken },
    });
    report = core.inspect(session);
    expect(report.deliveries.items[0]!.acknowledgmentLatencyMs).toBe(50);
    expect(
      report.audit.items.some((e) => e.type === "delivery.acknowledged"),
    ).toBe(true);
    core.command(session, {
      id: "wake",
      type: "inbox.wake_observed",
      payload: { messageId: lease.message.id, status: "accepted" },
    });
    core.command(session, {
      id: "wake",
      type: "inbox.wake_observed",
      payload: { messageId: lease.message.id, status: "accepted" },
    });
    expect(core.inspect(session).wakes.items).toHaveLength(1);
    expect(core.inspect(session).wakes.items[0]).toMatchObject({
      sessionId: session.sessionId,
      generation: session.generation,
      messageId: lease.message.id,
      status: "accepted",
    });
    now += 60001;
    expect(core.inspect(session).sessions.items[0]!.availability).toBe(
      "unknown_stale_observation",
    );
    const encoded = JSON.stringify(core.inspect(session));
    for (const forbidden of [
      "PRIVATE MESSAGE CONTENT",
      "OTHER SCOPE CONTENT",
      session.capability,
      lease.leaseToken,
      "private-resume-token",
    ])
      expect(encoded).not.toContain(forbidden);
    expect(
      core.inspect(session, { messageId: "absent" }).deliveries.items,
    ).toHaveLength(0);
    expect(() => core.inspect(session, { limit: 21 })).toThrow("1..20");
    expect(core.inspect(session, { limit: 1 }).audit.truncated).toBe(true);
    core.command(session, {
      id: "suspend",
      type: "session.suspend",
      payload: {},
    });
    expect(() => core.inspect(session)).toThrow();
    expect(store.inspect("one").processMetrics.staleOwnerRejections).toBe(1);
    expect(
      store.inspect("one").processMetrics.writerAcquisitions,
    ).toBeGreaterThan(0);
  } finally {
    store.close();
  }
});
