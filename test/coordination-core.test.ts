import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore, type Json } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import {
  APPLICATION_ID,
  SCHEMA_VERSION,
  type FaultHook,
} from "../src/coordination/migrations";

const stores: CoordinationStore[] = [];
let nodeFixture: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeFixture = join(mkdtempSync(resolve("dist/test/core-")), "worker.mjs");
  await build({
    entryPoints: ["test/fixtures/coordination-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: nodeFixture,
  });
});
const fixture = () =>
  join(mkdtempSync(join(tmpdir(), "coordination-core-")), "coordination.db");
async function open(path = fixture(), fault?: FaultHook) {
  const store = await CoordinationStore.open({
    path,
    clock: () => 1000,
    fault,
  });
  stores.push(store);
  return { store, core: new CoordinationCore(store), path };
}
const actor = { scope: "test", actor: "alice" };
const create = {
  id: "shared-command",
  type: "task.create" as const,
  payload: { title: "durable work" },
};
function taskId(result: { value: Json }) {
  return (result.value as { task: { id: string } }).task.id;
}
async function child(
  path: string,
  action: string,
  runtime: "bun" | "node" = "bun",
) {
  const process = Bun.spawn({
    cmd: [
      runtime === "bun" ? globalThis.process.execPath : Bun.which("node")!,
      runtime === "bun"
        ? resolve("test/fixtures/coordination-worker.ts")
        : nodeFixture,
      path,
      action,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("coordination command boundary", () => {
  test("commits task, event and reusable result together", async () => {
    const { core, store } = await open();
    let notice = 0;
    store.subscribe((cursor) => {
      notice = cursor;
      expect(core.events(actor).items).toHaveLength(1);
    });
    const first = core.command(actor, create);
    const retry = core.command(actor, create);
    expect(retry).toEqual({ ...first, replayed: true });
    expect(core.task(actor, taskId(first))?.title).toBe("durable work");
    expect(core.events(actor).items).toHaveLength(1);
    expect(notice).toBe(first.cursor);
    expect(() =>
      core.command(actor, { ...create, payload: { title: "different work" } }),
    ).toThrow("different content");
  });

  test("same timestamps remain observable through ordered paginated cursors", async () => {
    const { core } = await open();
    for (let i = 0; i < 3; i++)
      core.command(actor, { ...create, id: `command-${i}` });
    const first = core.events(actor, 0, 2);
    const second = core.events(actor, first.cursor, 2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBeGreaterThan(first.cursor);
    expect(
      [...first.items, ...second.items].every((row) => row.created_at === 1000),
    ).toBe(true);
    expect(core.events({ ...actor, scope: "other" }).items).toEqual([]);
    expect(() => core.events(actor, 0, 501)).toThrow("page limit");
  });

  test("cancel checks scope, creator and version inside its transaction", async () => {
    const { core } = await open();
    const id = taskId(core.command(actor, create));
    const cancel = {
      id: "cancel",
      type: "task.cancel" as const,
      payload: { taskId: id, expectedVersion: 1 },
    };
    expect(() => core.command({ ...actor, actor: "mallory" }, cancel)).toThrow(
      "creator",
    );
    expect(() => core.command({ ...actor, scope: "other" }, cancel)).toThrow(
      "this scope",
    );
    expect(() =>
      core.command(actor, {
        ...cancel,
        payload: { ...cancel.payload, expectedVersion: 2 },
      }),
    ).toThrow("version");
    core.command(actor, cancel);
    expect(core.task(actor, id)?.version).toBe(2);
    expect(core.task(actor, id)?.status).toBe("cancelled");
    expect(core.command(actor, cancel).replayed).toBe(true);
    expect(() =>
      core.command(actor, { ...cancel, id: "stale-cancel" }),
    ).toThrow("version");
    expect(core.events(actor).items).toHaveLength(2);
  });

  test("transaction failure rolls back state, event and command receipt", async () => {
    let fail = true;
    const { core, path } = await open(undefined, (point) => {
      if (fail && point === "before_command_commit")
        throw new Error("injected failure");
    });
    expect(() => core.command(actor, create)).toThrow("injected failure");
    expect(core.events(actor).items).toEqual([]);
    const inspection = new Database(path, { readonly: true });
    expect(inspection.query("SELECT count(*) AS n FROM tasks").get()).toEqual({
      n: 0,
    });
    expect(
      inspection.query("SELECT count(*) AS n FROM commands").get(),
    ).toEqual({ n: 0 });
    inspection.close();
    fail = false;
    const result = core.command(actor, create);
    expect(result.replayed).toBe(false);
    expect(core.events(actor).items).toHaveLength(1);
  });

  test("failed notification cannot turn a committed command into a failed acceptance", async () => {
    const { core, store } = await open();
    store.subscribe(() => {
      throw new Error("disconnected subscriber");
    });
    const result = core.command(actor, create);
    expect(core.events(actor).cursor).toBe(result.cursor);
    expect(core.command(actor, create).replayed).toBe(true);
  });

  test("mutation without an event is rejected and rolled back", async () => {
    const { store } = await open();
    expect(() =>
      store.execute(
        { ...actor, id: "broken", type: "test", payload: {} },
        (tx) => {
          tx.createTask({
            id: "uncommitted",
            scope: actor.scope,
            creator: actor.actor,
            title: "broken",
            status: "open",
            version: 1,
            created_at: 1000,
            updated_at: 1000,
          });
          return {};
        },
      ),
    ).toThrow("same transaction");
    expect(store.task(actor.scope, "uncommitted")).toBeNull();
  });
});

describe("real process persistence and migration", () => {
  test.each(["bun", "node"] as const)(
    "commit-before-publish crash is replayable after process restart (%s)",
    async (runtime) => {
      const path = fixture();
      const crashed = await child(path, "after_command_commit", runtime);
      expect(crashed.code).toBe(73);
      const { core } = await open(path);
      expect(core.events(actor).items).toHaveLength(1);
      expect(core.command(actor, create).replayed).toBe(true);
      expect(core.events(actor).items).toHaveLength(1);
    },
  );

  test.each(["bun", "node"] as const)(
    "process exit during migration leaves no adopted partial schema (%s)",
    async (runtime) => {
      const path = fixture();
      expect((await child(path, "before_migration_commit", runtime)).code).toBe(
        73,
      );
      const inspection = new Database(path, { readonly: true });
      expect(inspection.query("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
      expect(
        inspection
          .query("SELECT name FROM sqlite_master WHERE type='table'")
          .all(),
      ).toEqual([]);
      inspection.close();
      const { core } = await open(path);
      expect(core.command(actor, create).replayed).toBe(false);
    },
  );

  test.each(["bun", "node"] as const)(
    "concurrent startup and repeated commands converge on one state change (%s)",
    async (runtime) => {
      const path = fixture();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => child(path, "create", runtime)),
      );
      expect(results.filter((row) => row.code !== 0)).toEqual([]);
      const { core } = await open(path);
      expect(core.events(actor).items).toHaveLength(1);
      expect(core.command(actor, create).replayed).toBe(true);
    },
  );

  test("legacy and newer databases are refused without rewriting their version", async () => {
    const legacy = fixture();
    const db = new Database(legacy);
    db.exec("CREATE TABLE instances(id TEXT); PRAGMA user_version=1;");
    db.close();
    await expect(CoordinationStore.open({ path: legacy })).rejects.toThrow(
      "migrate a copy",
    );
    const verify = new Database(legacy, { readonly: true });
    expect(verify.query("PRAGMA application_id").get()).toEqual({
      application_id: 0,
    });
    expect(verify.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    verify.close();
    const future = fixture();
    const newer = new Database(future);
    newer.exec(
      `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION + 1}`,
    );
    newer.close();
    await expect(CoordinationStore.open({ path: future })).rejects.toThrow(
      "exceeds supported",
    );
  });
});
