import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import {
  coordinationScope,
  launcherIdentity,
} from "../src/coordination/sessions";
const stores: CoordinationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  let now = 1000;
  const path = join(
    mkdtempSync(join(tmpdir(), "coordination-session-")),
    "db.sqlite",
  );
  const open = async () => {
    const store = await CoordinationStore.open({ path, clock: () => now });
    stores.push(store);
    return store;
  };
  const store = await open();
  const enrollment = {
    scope: coordinationScope("project", "personal"),
    agentId: "stable-launcher-id",
    requestId: "enroll",
    resumeToken: randomBytes(32).toString("hex"),
  };
  return {
    store,
    path,
    core: new CoordinationCore(store),
    enrollment,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("restart adoption preserves identity and inbox but supersedes old session commands and reads", async () => {
  const env = await fixture();
  const first = env.store.openSession(env.enrollment);
  env.core.command(first, {
    id: "send",
    type: "message.send",
    payload: { recipient: first.actor, kind: "notice", body: "retained" },
  });
  env.store.close();
  const store = await env.open();
  const second = store.openSession({ ...env.enrollment, requestId: "restart" });
  const core = new CoordinationCore(store);
  expect(second.actor).toBe(first.actor);
  expect(second.generation).toBe(2);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(core.inbox(second).items[0]!.message.body).toBe("retained");
  expect(() => store.authorize(first.capability)).toThrow("superseded");
  expect(() => core.inbox(first)).toThrow("superseded");
  expect(() =>
    core.command(first, {
      id: "late",
      type: "task.create",
      payload: { title: "stale" },
    }),
  ).toThrow("superseded");
  expect(store.session(first.scope, first.sessionId)!.state).toBe("superseded");
});
for (const ending of ["replace", "session.suspend", "session.close"] as const)
  test(`generation-pinned messages expire on ${ending} without retargeting or losing durable mail`, async () => {
    const env = await fixture();
    const first = env.store.openSession(env.enrollment);
    const sender = env.store.openSession({ ...env.enrollment, agentId: "sender" });
    const isolated = env.store.openSession({ ...env.enrollment, scope: "another-scope" });
    expect(env.core.bootstrap(sender).recipientGeneration).toBe(true);
    const pinned = {
      id: "pinned",
      type: "message.send" as const,
      payload: { recipient: first.actor, recipientGeneration: first.generation, kind: "reply", body: "only this session" },
    };
    const receipt = env.core.command(sender, pinned);
    const messageId = (receipt.value as { messageId: string }).messageId;
    env.core.command(first, { ...pinned, id: "pending" });
    env.core.command(isolated, { ...pinned, id: "isolated" });
    const lease = (env.core.command(first, {
      id: "fetch", type: "inbox.fetch", payload: { consumer: "contact", limit: 1 },
    }).value as { deliveries: Array<{ message: { recipientGeneration: number }; leaseToken: string }> }).deliveries[0]!;
    expect(lease.message.recipientGeneration).toBe(1);
    env.core.command(sender, {
      id: "durable", type: "message.send",
      payload: { recipient: first.actor, kind: "reply", body: "survives replacement" },
    });
    if (ending !== "replace") {
      env.core.command(first, { id: "end", type: ending, payload: {} });
      expect(() => env.core.command(sender, { ...pinned, id: "closed-send" })).toThrow("Recipient session");
    }
    env.store.close();
    const store = await env.open();
    const core = new CoordinationCore(store);
    const second = store.openSession({ ...env.enrollment, requestId: "replacement" });
    expect(core.inbox(second).items.map((item) => item.message.body)).toEqual(["survives replacement"]);
    const deliveries = core.command(second, {
      id: "replacement-fetch", type: "inbox.fetch", payload: { consumer: "replacement" },
    }).value as { deliveries: Array<{ message: { body: string } }> };
    expect(deliveries.deliveries.map((item) => item.message.body)).toEqual(["survives replacement"]);
    expect(core.inbox(isolated).items).toHaveLength(1);
    expect(() => core.command(second, {
      id: "fetch", type: "inbox.fetch", payload: { consumer: "contact", limit: 1 },
    })).toThrow("previous recipient session");
    expect(core.messageStatus(sender, messageId).deliveries[0]).toMatchObject({
      state: "expired", recipientGeneration: 1, error: "recipient_session_ended", leaseUntil: null,
    });
    expect(core.command(sender, pinned)).toMatchObject({ value: receipt.value, replayed: true });
    expect(() => core.command(sender, { ...pinned, id: "late-send" })).toThrow("Recipient session");
    expect(() => core.command(second, {
      id: "old-ack", type: "inbox.ack", payload: { messageId, leaseToken: lease.leaseToken },
    })).toThrow("Delivery does not belong");
    expect(() => core.command(sender, {
      ...pinned, payload: { ...pinned.payload, recipientGeneration: second.generation },
    })).toThrow();
    core.command(sender, { ...pinned, id: "new-session", payload: { ...pinned.payload, recipientGeneration: second.generation } });
    expect(core.inbox(second).items.at(-1)!.message.recipientGeneration).toBe(2);
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => core.command(sender, { ...pinned, id: `invalid-${generation}`, payload: { ...pinned.payload, recipientGeneration: generation } })).toThrow("recipientGeneration must be");
  });
test("schema 11 inboxes migrate without pinning or losing existing deliveries", async () => {
  const env = await fixture();
  const first = env.store.openSession(env.enrollment);
  env.core.command(first, {
    id: "schema-11-mail", type: "message.send",
    payload: { recipient: first.actor, kind: "reply", body: "durable before migration" },
  });
  env.store.close();
  const db = new Database(env.path);
  db.exec("ALTER TABLE inbox_deliveries DROP COLUMN recipient_generation; ALTER TABLE inbox_messages DROP COLUMN sender_generation; ALTER TABLE task_attempts DROP COLUMN progress_timeout_ms; ALTER TABLE commands DROP COLUMN pruned; ALTER TABLE commands DROP COLUMN type; ALTER TABLE artifacts DROP COLUMN collected_at; DROP TABLE event_retention; DROP INDEX command_retention; PRAGMA user_version=11");
  db.close();
  const migrated = await env.open();
  const second = migrated.openSession({ ...env.enrollment, requestId: "after-migration" });
  const core = new CoordinationCore(migrated);
  expect(core.inbox(second).items[0]!.message).toMatchObject({ body: "durable before migration" });
  expect(core.inbox(second).items[0]!.message.recipientGeneration).toBeUndefined();
  expect(core.command(second, {
    id: "pinned-after-migration", type: "message.send",
    payload: { recipient: second.actor, recipientGeneration: second.generation, kind: "reply", body: "pinned" },
  }).replayed).toBe(false);
});
test("lost enrollment response replays without a new incarnation or persisted plaintext secrets", async () => {
  const { store, enrollment, path } = await fixture();
  const first = store.openSession(enrollment);
  expect(store.openSession(enrollment)).toEqual({ ...first, replayed: true });
  expect(store.authorize(first.capability)).toEqual({
    scope: first.scope,
    actor: first.actor,
    sessionId: first.sessionId,
    generation: 1,
  });
  expect(
    JSON.stringify(store.session(first.scope, first.sessionId)),
  ).not.toContain(first.capability);
  const db = new Database(path, { readonly: true });
  const persisted = JSON.stringify([
    db.query("SELECT * FROM agents").all(),
    db.query("SELECT * FROM sessions").all(),
    db.query("SELECT * FROM commands").all(),
    db.query("SELECT * FROM events").all(),
  ]);
  db.close();
  expect(persisted).not.toContain(first.capability);
  expect(persisted).not.toContain(enrollment.resumeToken);
  expect(() =>
    store.openSession({
      ...enrollment,
      resumeToken: randomBytes(32).toString("hex"),
    }),
  ).toThrow("resume token");
});

test("launcher identity canonicalizes paths and preserves configured profile roots", () => {
  const root = mkdtempSync(join(tmpdir(), "coordination-roots-"));
  const project = join(root, "project"),
    outside = mkdtempSync(join(tmpdir(), "coordination-outside-"));
  mkdirSync(project);
  const input = {
    projectRoot: project,
    profile: "personal",
    directory: project,
    fileRoot: project,
    allowedRoots: [root],
  };
  const first = launcherIdentity(input);
  expect(
    launcherIdentity({ ...input, projectRoot: join(project, ".") }).scope,
  ).toBe(first.scope);
  expect(() => launcherIdentity({ ...input, fileRoot: outside })).toThrow(
    "allowed roots",
  );
  expect(launcherIdentity({ ...input, profile: "work" }).scope).not.toBe(
    first.scope,
  );
});
test("project/profile binding is independent of labels and enrolled agents cannot omit session fencing", async () => {
  const { store, core, enrollment } = await fixture();
  const first = store.openSession({
    ...enrollment,
    label: "identity:work role:lead",
  });
  const isolated = store.openSession({
    ...enrollment,
    scope: coordinationScope("project", "work"),
    resumeToken: randomBytes(32).toString("hex"),
  });
  core.command(first, {
    id: "send",
    type: "message.send",
    payload: { recipient: first.actor, kind: "notice", body: "private" },
  });
  expect(core.inbox(isolated).items).toEqual([]);
  expect(() => core.inbox({ scope: first.scope, actor: first.actor })).toThrow(
    "current session",
  );
  core.command(first, {
    id: "relabel",
    type: "session.observe",
    payload: { label: "identity:work role:other" },
  });
  expect(core.inbox(isolated).items).toEqual([]);
  expect(coordinationScope("a:b", "c")).not.toBe(coordinationScope("a", "b:c"));
});
test("transport, runtime and progress observations remain independent through long tools and suspension", async () => {
  const env = await fixture();
  const session = env.store.openSession(env.enrollment);
  env.core.command(session, {
    id: "transport",
    type: "session.observe",
    payload: { transport: true },
  });
  let row = env.store.session(session.scope, session.sessionId)!;
  expect(row.transport_at).toBe(1000);
  expect(row.runtime_at).toBeNull();
  expect(row.progress_at).toBeNull();
  env.advance(3600000);
  env.core.command(session, {
    id: "tool",
    type: "session.observe",
    payload: { runtime: "busy" },
  });
  row = env.store.session(session.scope, session.sessionId)!;
  expect(row.runtime_state).toBe("busy");
  expect(row.transport_at).toBe(1000);
  expect(row.progress_at).toBeNull();
  env.core.command(session, {
    id: "suspend",
    type: "session.suspend",
    payload: {},
  });
  expect(() => env.store.authorize(session.capability)).toThrow("suspended");
  const resumed = env.store.openSession({
    ...env.enrollment,
    requestId: "resume",
  });
  expect(resumed.generation).toBe(2);
  expect(env.store.authorize(resumed.capability).actor).toBe(session.actor);
});

test("thread-filtered fetch preserves ordinary mail and records the original sender session", async () => {
  const env = await fixture();
  const sender = env.store.openSession(env.enrollment);
  const recipient = env.store.openSession({ ...env.enrollment, agentId: "recipient" });
  const send = (id: string, threadId: string) => env.core.command(sender, {
    id, type: "message.send", payload: {
      recipient: recipient.actor, kind: "reply", body: id, threadId,
      senderGeneration: 999,
    },
  } as never);
  const ordinary = send("captain-mail", "ordinary");
  send("contact-mail", "contact");
  env.store.openSession({ ...env.enrollment, requestId: "replacement" });
  expect(env.core.bootstrap(recipient).messageSessionIdentity).toBe(true);
  expect(env.core.command(recipient, {
    id: "no-threads", type: "inbox.fetch", payload: { consumer: "contact", threadIds: [] },
  }).value).toEqual({ deliveries: [] });
  const fetched = env.core.command(recipient, {
    id: "contact-only", type: "inbox.fetch", payload: { consumer: "contact", threadIds: ["contact"] },
  }).value as { deliveries: Array<{ message: { senderGeneration: number; body: string } }> };
  expect(fetched.deliveries.map((entry) => entry.message)).toMatchObject([
    { body: "contact-mail", senderGeneration: 1 },
  ]);
  expect(env.core.messageStatus(recipient, (ordinary.value as { messageId: string }).messageId).deliveries[0]).toMatchObject({ state: "pending", attempts: 0 });
});
