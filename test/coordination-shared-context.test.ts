import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
const stores: CoordinationStore[] = [];
let nodeWorker: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeWorker = join(mkdtempSync(resolve("dist/test/shared-")), "worker.mjs");
  await build({
    entryPoints: ["test/fixtures/task-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: nodeWorker,
  });
});
const alice = { scope: "test", actor: "alice" },
  bob = { scope: "test", actor: "bob" };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  let now = 1000;
  const path = join(mkdtempSync(join(tmpdir(), "swarm-shared-")), "db.sqlite");
  const open = async () => {
    const store = await CoordinationStore.open({ path, clock: () => now });
    stores.push(store);
    return { store, core: new CoordinationCore(store) };
  };
  return {
    ...(await open()),
    path,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("compare-and-set prevents lost updates and history survives restart", async () => {
  const e = await fixture();
  e.core.command(alice, {
    id: "set",
    type: "kv.set",
    payload: { key: "decision", value: "first", expectedVersion: 0 },
  });
  e.core.command(bob, {
    id: "update",
    type: "kv.set",
    payload: { key: "decision", value: "second", expectedVersion: 1 },
  });
  expect(() =>
    e.core.command(alice, {
      id: "stale",
      type: "kv.set",
      payload: { key: "decision", value: "lost", expectedVersion: 1 },
    }),
  ).toThrow("changed");
  e.store.close();
  const { core } = await e.open();
  expect(core.shared(alice, "decision")).toMatchObject({
    version: 2,
    value: "second",
    author: "bob",
  });
  expect(
    core.sharedHistory(alice, "decision").items.map((r) => r.value),
  ).toEqual(["first", "second"]);
  expect(core.shared({ ...alice, scope: "other" }, "decision").status).toBe(
    "missing",
  );
});
test("append is atomic, replay deduplicates and payload size stays bounded", async () => {
  const { core } = await fixture();
  const command = {
    id: "append",
    type: "kv.append" as const,
    payload: { key: "notes", value: { artifact: "report-1" } },
  };
  core.command(alice, command);
  core.command(alice, command);
  core.command(bob, {
    ...command,
    id: "next",
    payload: { key: "notes", value: { artifact: "report-2" } },
  });
  expect(core.shared(alice, "notes").value).toEqual([
    { artifact: "report-1" },
    { artifact: "report-2" },
  ]);
  expect(() =>
    core.command(alice, {
      id: "oversize",
      type: "kv.set",
      payload: { key: "blob", value: "x".repeat(9000), expectedVersion: 0 },
    }),
  ).toThrow("8 KiB");
  expect(core.shared(alice, "blob").version).toBe(0);
});
test("expiry and deletion remain visible and cannot reset version numbers", async () => {
  const { core, advance } = await fixture();
  core.command(alice, {
    id: "temporary",
    type: "kv.set",
    payload: { key: "hint", value: "old", expectedVersion: 0, ttlMs: 10 },
  });
  advance(10);
  expect(core.shared(alice, "hint")).toMatchObject({
    status: "expired",
    value: null,
    version: 1,
  });
  expect(() =>
    core.command(bob, {
      id: "append-expired",
      type: "kv.append",
      payload: { key: "hint", value: "new" },
    }),
  ).toThrow("Reset expired");
  core.command(alice, {
    id: "reset",
    type: "kv.set",
    payload: { key: "hint", value: "new", expectedVersion: 1 },
  });
  core.command(alice, {
    id: "delete",
    type: "kv.delete",
    payload: { key: "hint", expectedVersion: 2 },
  });
  expect(core.shared(alice, "hint")).toMatchObject({
    status: "deleted",
    version: 3,
    value: null,
  });
  expect(() =>
    core.command(bob, {
      id: "aba",
      type: "kv.set",
      payload: { key: "hint", value: "wrong", expectedVersion: 0 },
    }),
  ).toThrow("changed");
});
test("prefix and history retrieval are bounded and paginated", async () => {
  const { core } = await fixture();
  for (let i = 0; i < 3; i++)
    core.command(alice, {
      id: `set-${i}`,
      type: "kv.set",
      payload: { key: `file/${i}`, value: i, expectedVersion: 0 },
    });
  const first = core.sharedList(alice, "file/", "", 2),
    next = core.sharedList(alice, "file/", first.cursor, 2);
  expect(first.items.map((x) => x.key)).toEqual(["file/0", "file/1"]);
  expect(next.items.map((x) => x.key)).toEqual(["file/2"]);
  expect(() => core.sharedList(alice, "", "", 101)).toThrow("1..100");
  expect(core.sharedList(alice, "%", "", 50).items).toEqual([]);
});

for (const runtime of ["bun", "node"] as const)
  test(`eight concurrent writers preserve every append and accept one CAS (${runtime})`, async () => {
    const e = await fixture(),
      worker = e.store.openSession({
        scope: "test",
        agentId: "worker",
        requestId: "enroll",
        resumeToken: randomBytes(32).toString("hex"),
      });
    const run = async (type: "kv.set" | "kv.append", i: number) => {
      const command = {
        id: `${type}-${i}`,
        type,
        payload:
          type === "kv.set"
            ? { key: "winner", value: i, expectedVersion: 0 }
            : { key: "appends", value: i },
      };
      const proc = Bun.spawn({
        cmd: [
          runtime === "bun" ? process.execPath : Bun.which("node")!,
          runtime === "bun"
            ? resolve("test/fixtures/task-worker.ts")
            : nodeWorker,
          e.path,
          worker.capability,
          JSON.stringify(command),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      return JSON.parse(out);
    };
    const cas = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run("kv.set", i)),
    );
    expect(cas.filter((x) => x.result)).toHaveLength(1);
    expect(cas.filter((x) => x.error === "version_conflict")).toHaveLength(7);
    const appends = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run("kv.append", i)),
    );
    expect(appends.every((x) => x.result)).toBe(true);
    expect((e.core.shared(alice, "appends").value as number[]).sort()).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(e.core.shared(alice, "appends").version).toBe(8);
  }, 20000);
