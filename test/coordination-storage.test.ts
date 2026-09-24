import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import { maintain } from "../src/coordination/maintenance";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

test("maintenance CLI refuses a live owner and supports offline dry-run/apply", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const bundle = mkdtempSync(resolve("dist/test/maintenance-"));
  await build({ entryPoints: ["src/coordination/owner-cli.ts", "src/coordination/maintenance-cli.ts"],
    bundle: true, platform: "node", format: "esm", packages: "external", outdir: bundle });
  const root = mkdtempSync(join(tmpdir(), "swarm-maintenance-cli-")), config = join(root, "owner.json");
  writeFileSync(config, JSON.stringify({ databasePath: join(root, "db"), launcherSecret: "fixture-".repeat(8) }));
  const owner = Bun.spawn({ cmd: [Bun.which("node")!, join(bundle, "owner-cli.js"), config], stdout: "pipe", stderr: "pipe" });
  const run = async (...flags: string[]) => {
    const process = Bun.spawn({ cmd: [Bun.which("node")!, join(bundle, "maintenance-cli.js"), config, ...flags], stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, output, error };
  };
  try {
    const reader = owner.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    expect(first.value, await (first.value ? Promise.resolve("") : new Response(owner.stderr).text())).toBeDefined();
    const refused = await run("--apply");
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("Stop the coordinator owner");
    owner.kill(); await owner.exited;
    const dry = await run();
    expect(dry.code, dry.error).toBe(0);
    expect(JSON.parse(dry.output)).toMatchObject({ applied: false });
    const applied = await run("--apply");
    expect(applied.code, applied.error).toBe(0);
    expect(JSON.parse(applied.output)).toMatchObject({ applied: true });
  } finally { owner.kill(); await owner.exited; }
}, 30000);

test("offline retention preserves unread work, replay identity and live artifact references", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "swarm-retention-")), "db");
  const store = await CoordinationStore.open({ path, clock: () => 1000 });
  const core = new CoordinationCore(store), actor = { scope: "test", actor: "alice" };
  const send = { id: "send", type: "message.send" as const, payload: { recipient: "bob", kind: "question", body: "Unprocessed work" } };
  core.command(actor, send);
  const a = (await core.importArtifact(actor, { id: "a", data: Buffer.from("keep").toString("base64"), summary: "referenced", ttlMs: 1 })).value as any;
  const b = (await core.importArtifact(actor, { id: "b", data: Buffer.from("collect").toString("base64"), summary: "expired", ttlMs: 1 })).value as any;
  core.command(actor, { id: "finding", type: "finding.record", payload: { kind: "decision", summary: "Retain evidence", revision: "a".repeat(40), files: [], verification: "fixture", artifactIds: [a.artifactId] } });
  const paths = [a, b].map(item => store.artifactFiles.path(actor.scope, item.digest));
  for (const file of paths) utimesSync(file, new Date(1000), new Date(1000));
  store.close();
  const db = new Database(path);
  try {
    expect(maintain(db, path + ".artifacts", 2000, false, 3000)).toMatchObject({ applied: false, blobs: 1 });
    expect(existsSync(paths[1]!)).toBe(true);
    expect(maintain(db, path + ".artifacts", 2000, true, 3000)).toMatchObject({ applied: true, blobs: 1 });
    expect(existsSync(paths[0]!)).toBe(true);
    expect(existsSync(paths[1]!)).toBe(false);
  } finally { db.close(); }
  const reopened = await CoordinationStore.open({ path, clock: () => 3000 });
  try {
    const resumed = new CoordinationCore(reopened);
    expect(resumed.inbox({ ...actor, actor: "bob" }).items[0]!.message.body).toBe("Unprocessed work");
    expect(() => resumed.command(actor, send)).toThrow("response was pruned");
    expect(() => resumed.events(actor, 0)).toThrow("bootstrap again");
    const cursor = resumed.bootstrap(actor).eventCursor;
    expect(cursor).toBeGreaterThan(0);
    expect(resumed.events(actor, cursor).items).toEqual([]);
    expect(await resumed.readArtifact(actor, b.artifactId)).toMatchObject({ status: "collected", data: null });
    expect(() => resumed.command(actor, { id: "restore", type: "retention.set", payload: { kind: "artifact", entityId: b.artifactId, expiresAt: null } })).toThrow("cannot be restored");
    expect(resumed.inbox({ ...actor, actor: "bob" }).items).toHaveLength(1);
  } finally { reopened.close(); }
});

test("storage quotas reject atomically, including a whole batch after SQLite rolls it back", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "swarm-capacity-")), "db");
  const store = await CoordinationStore.open({ path, storage: { databaseBytes: 1024 ** 2, artifactBytes: 1024 ** 2 } });
  const core = new CoordinationCore(store), actor = { scope: "test", actor: "alice" };
  let rejected = false;
  try {
    for (let i = 0; i < 100; i++) {
      try { store.execute({ ...actor, id: `fill-${i}`, type: "fixture", payload: {} }, tx => {
        tx.event("fixture", "bytes", { body: "x".repeat(50000) }); return { body: "x".repeat(50000) };
      }); } catch (error) { expect((error as any).code).toBe("storage_full"); rejected = true; break; }
    }
    expect(rejected).toBe(true);
    const before = core.events(actor).cursor;
    expect(() => core.commandBatch(Array.from({ length: 32 }, (_, i) => ({ context: actor, command: {
      id: `batch-${i}`, type: "message.send" as const, payload: { recipient: "bob", kind: "question", body: "x".repeat(16000) },
    } })))).toThrow("Database limit");
    expect(core.events(actor).cursor).toBe(before);
    expect(core.inbox({ ...actor, actor: "bob" }).items).toEqual([]);
    await expect(store.artifactFiles.capture(actor.scope, Buffer.alloc(1024 ** 2 + 1))).rejects.toMatchObject({ code: "storage_full" });
    expect(await store.artifactFiles.capture(actor.scope, Buffer.from("small"))).toMatchObject({ bytes: 5 });
  } finally { store.close(); }
});
