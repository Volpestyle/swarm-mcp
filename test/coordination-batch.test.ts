import { expect, test } from "bun:test";
import { build } from "esbuild";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";

test("batch isolates command failure and publishes only a durable combined cursor", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "batch-")), "db");
  const store = await CoordinationStore.open({ path });
  const core = new CoordinationCore(store);
  const reader = new Database(path, { readonly: true });
  const notifications: number[] = [];
  const visibleAtNotification: number[] = [];
  store.subscribe((cursor) => {
    visibleAtNotification.push(
      (reader.query("SELECT count(*) AS n FROM tasks").get() as any).n,
    );
    notifications.push(cursor);
  });
  try {
    store.batch("test", () => {
      core.command(
        { scope: "test", actor: "alice" },
        { id: "one", type: "task.create", payload: { title: "one" } },
      );
      expect(
        (reader.query("SELECT count(*) AS n FROM tasks").get() as any).n,
      ).toBe(0);
      expect(notifications).toHaveLength(0);
      expect(() =>
        store.execute(
          {
            scope: "test",
            actor: "alice",
            id: "bad",
            type: "fixture",
            payload: {},
          },
          (tx) => {
            tx.createTask({
              id: "rolled-back",
              scope: "test",
              creator: "alice",
              title: "bad",
              status: "open",
              version: 1,
              created_at: 1,
              updated_at: 1,
            });
            tx.event("fixture", "rolled-back", {});
            throw new Error("after write");
          },
        ),
      ).toThrow("after write");
      core.command(
        { scope: "test", actor: "alice" },
        { id: "two", type: "task.create", payload: { title: "two" } },
      );
    });
    expect(store.taskSummaries("test").items).toHaveLength(2);
    expect(store.events("test").items).toHaveLength(2);
    expect(notifications).toHaveLength(1);
    expect(visibleAtNotification).toEqual([2]);
    expect(store.inspect("test").processMetrics.writerAcquisitions).toBe(1);
    expect(store.inspect("test").database).toEqual({
      journalMode: "wal",
      synchronous: 2,
    });
    expect(() =>
      core.commandBatch([
        {
          context: { scope: "one", actor: "a" },
          command: { id: "a", type: "task.create", payload: { title: "one" } },
        },
        {
          context: { scope: "two", actor: "a" },
          command: { id: "b", type: "task.create", payload: { title: "two" } },
        },
      ]),
    ).toThrow("cross scopes");
  } finally {
    reader.close();
    store.close();
  }
});

for (const runtime of ["bun", "node"] as const)
  for (const point of ["before_batch_commit", "after_batch_commit"] as const)
    test(`batch process exit ${point} preserves all receipts or none (${runtime})`, async () => {
      const path = join(mkdtempSync(join(tmpdir(), "batch-crash-")), "db");
      mkdirSync(resolve("dist/test"), { recursive: true });
      const script = join(
        mkdtempSync(resolve("dist/test/batch-")),
        "worker.mjs",
      );
      if (runtime === "node")
        await build({
          entryPoints: ["test/fixtures/batch-worker.ts"],
          outfile: script,
          bundle: true,
          platform: "node",
          format: "esm",
          packages: "external",
        });
      const run = async (fault: string) => {
        const child = Bun.spawn({
          cmd: [
            runtime === "bun" ? process.execPath : Bun.which("node")!,
            runtime === "bun"
              ? resolve("test/fixtures/batch-worker.ts")
              : script,
            path,
            fault,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      };
      expect((await run(point)).code).toBe(73);
      const reader = new Database(path, { readonly: true });
      try {
        expect(
          (reader.query("SELECT count(*) AS n FROM commands").get() as any).n,
        ).toBe(point === "before_batch_commit" ? 0 : 2);
        const replay = await run("none");
        expect(replay.stderr).toBe("");
        expect(replay.code).toBe(0);
        expect(
          JSON.parse(replay.stdout).map((item: any) => item.result.replayed),
        ).toEqual([
          point === "after_batch_commit",
          point === "after_batch_commit",
        ]);
        expect(
          (reader.query("SELECT count(*) AS n FROM tasks").get() as any).n,
        ).toBe(2);
        expect(
          (reader.query("SELECT count(*) AS n FROM events").get() as any).n,
        ).toBe(2);
      } finally {
        reader.close();
      }
    });
