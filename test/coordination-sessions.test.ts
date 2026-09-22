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
