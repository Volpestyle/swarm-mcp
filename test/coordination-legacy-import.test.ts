import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backupLegacy, restoreLegacy } from "../src/coordination/legacy-snapshot";
import { importLegacy, type LegacyImportPlan } from "../src/coordination/legacy-import";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";

const plan: LegacyImportPlan = { version: 1, scopes: [{ from: "old", to: "new", taskController: "new-bob", recipients: { bob: "new-bob" }, broadcastRecipients: ["new-bob", "new-alice"] }] };
async function fixture(revision: string) {
  const root = mkdtempSync(join(tmpdir(), "legacy-import-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "sql"));
  const pinned = resolve("test/fixtures/legacy-baselines", revision);
  const script = join(root, "src", "db.ts"), path = join(root, "legacy.db");
  writeFileSync(script, readFileSync(join(pinned, "db.ts")));
  if (revision === "b95f607") for (const name of ["swarm_db_bootstrap.sql", "swarm_db_finalize.sql"])
    writeFileSync(join(root, "sql", name), readFileSync(join(pinned, name)));
  const child = Bun.spawn({ cmd: [process.execPath, script], env: { ...process.env, SWARM_DB_PATH: path }, stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(stderr);
  const db = new Database(path);
  db.exec(`INSERT INTO messages(scope,sender,recipient,content,read) VALUES
    ('old','alice','bob','pending',0),('old','alice',NULL,'announcement',0),('old','alice','bob','previously read',1);
    INSERT INTO tasks(id,scope,type,title,requester,assignee,status,depends_on) VALUES
    ('t','old','code','unfinished','alice','bob','in_progress','["done","cleaned-up"]'),
    ('done','old','code','historical result','alice','bob','done',NULL);
    INSERT INTO context(id,scope,instance_id,file,type,content) VALUES
    ('lock','old','bob','a.ts','lock','prior lock'),('note','old','bob','a.ts','note','retained finding');
    INSERT INTO kv(scope,key,value) VALUES('old','runtime:lease','"old authority hint"');`);
  db.close();
  const snapshot = join(root, "snapshot"); await backupLegacy(path, snapshot);
  return { root, path, snapshot };
}

for (const revision of ["b446c18", "b95f607"]) test(`${revision}: import preserves data without resurrecting ownership`, async () => {
  const { root, snapshot } = await fixture(revision), destination = join(root, "coordinator");
  const summary = await importLegacy(snapshot, destination, plan);
  expect(summary.pendingMessages).toBe(2); expect(summary.deliveries).toBe(3);
  expect(summary.archivedReadMessages).toBe(1); expect(summary.reviewTasks).toBe(1);
  expect(summary.legacyLocks).toBe(1); expect(summary.annotations).toBe(1);
  expect(summary.unresolvedDependencies).toEqual([{ legacyTaskId: "t", dependency: "cleaned-up" }]);
  const path = join(destination, "coordination.db"), db = new Database(path, { readonly: true });
  try {
    for (const table of ["agents", "sessions", "task_attempts", "reservations"])
      expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM legacy_records").get()).toEqual({ n: summary.retainedRows });
    expect(db.query("SELECT key FROM shared_kv").get()).toEqual({ key: "legacy/runtime:lease" });
    expect(db.query("SELECT status FROM tasks WHERE id=?").get(summary.holds[0]!.taskId)).toEqual({ status: "blocked" });
  } finally { db.close(); }
  const store = await CoordinationStore.open({ path }), core = new CoordinationCore(store);
  try {
    const session = store.openSession({ scope: "new", agentId: "new-bob", requestId: "new", resumeToken: randomBytes(32).toString("hex") });
    const actor = store.authorize(session.capability);
    const peer = store.openSession({ scope: "new", agentId: "new-alice", requestId: "peer", resumeToken: randomBytes(32).toString("hex") });
    expect(() => core.command(peer, { id: "peer-cancel", type: "task.cancel", payload: { taskId: summary.holds[0]!.reviewTaskId, expectedVersion: 1 } })).toThrow("Only the task creator");
    expect(() => core.command(actor, { id: "claim-held", type: "task.claim", payload: { taskId: summary.holds[0]!.taskId, expectedVersion: 1 } })).toThrow();
    const fetch = core.command(actor, { id: "fetch", type: "inbox.fetch", payload: { consumer: "new", limit: 10 } }) as any;
    expect(fetch.value.deliveries).toHaveLength(2);
    for (const lease of fetch.value.deliveries)
      core.command(actor, { id: `ack-${lease.message.id}`, type: "inbox.ack", payload: { messageId: lease.message.id, leaseToken: lease.leaseToken } });
    const review = core.command(actor, { id: "review", type: "task.claim", payload: { taskId: summary.holds[0]!.reviewTaskId, expectedVersion: 1 } }) as any;
    core.command(actor, { id: "review-done", type: "task.finish", payload: { taskId: summary.holds[0]!.reviewTaskId,
      attemptId: review.value.attemptId, fence: review.value.fence, outcome: "completed",
      result: { evidence: "Fixture old writers stopped; side effects and missing predecessor reconciled" } } });
    const claimed = core.command(actor, { id: "claim-reviewed", type: "task.claim", payload: { taskId: summary.holds[0]!.taskId, expectedVersion: 2 } }) as any;
    const failed = core.command(actor, { id: "fail-reviewed", type: "task.finish", payload: { taskId: summary.holds[0]!.taskId,
      attemptId: claimed.value.attemptId, fence: claimed.value.fence, outcome: "failed" } }) as any;
    const retried = core.command(actor, { id: "controller-retry", type: "task.retry", payload: { taskId: summary.holds[0]!.taskId, expectedVersion: failed.value.task.version } }) as any;
    expect(retried.value.task.status).toBe("open");
  } finally { store.close(); }
  await expect(importLegacy(snapshot, destination, plan)).rejects.toThrow();
  await restoreLegacy(snapshot, join(root, "rollback.db"));
});

test("unmapped recipient and interrupted import never publish a usable candidate", async () => {
  const { root, snapshot } = await fixture("b95f607");
  const bad = join(root, "unmapped");
  await expect(importLegacy(snapshot, bad, { version: 1, scopes: [{ from: "old", to: "new", taskController: "new-bob", recipients: {} }] })).rejects.toThrow("Unresolved");
  expect(existsSync(bad)).toBe(false);
  const failed = join(root, "failed");
  await expect(importLegacy(snapshot, failed, plan, () => { throw new Error("injected crash before commit"); })).rejects.toThrow("injected crash");
  expect(existsSync(join(failed, "coordination.db"))).toBe(false);
  expect(existsSync(join(failed, "import.json"))).toBe(false);
  const db = new Database(join(failed, "importing.db"), { readonly: true });
  try { expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
  await expect(CoordinationStore.open({ path: join(failed, "coordination.db") })).rejects.toThrow("Import did not finish");
});

test("Node import and abrupt exits before commit/publication preserve the cutover boundary", async () => {
  const { root, snapshot } = await fixture("b95f607");
  mkdirSync(resolve("dist/test"), { recursive: true });
  const worker = join(mkdtempSync(resolve("dist/test/legacy-import-")), "worker.mjs");
  await build({ entryPoints: ["test/fixtures/legacy-import-worker.ts"], bundle: true,
    platform: "node", format: "esm", target: "node22", packages: "external", outfile: worker });
  const planPath = join(root, "plan.json"); writeFileSync(planPath, JSON.stringify(plan));
  for (const crash of ["before_import_commit", "before_import_publish", "success"]) {
    const destination = join(root, crash);
    const child = Bun.spawn({ cmd: ["node", worker, snapshot, destination, planPath, crash], stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(crash === "success" ? 0 : 73);
    if (crash === "success") {
      expect(JSON.parse(stdout).pendingMessages).toBe(2);
      expect(existsSync(join(destination, "import.pending"))).toBe(false);
      const store = await CoordinationStore.open({ path: join(destination, "coordination.db") }); store.close();
    } else {
      expect(existsSync(join(destination, "coordination.db"))).toBe(false);
      expect(existsSync(join(destination, "import.json"))).toBe(crash === "before_import_publish");
      await expect(CoordinationStore.open({ path: join(destination, "coordination.db") })).rejects.toThrow("Import did not finish");
      const db = new Database(join(destination, "importing.db"), { readonly: true });
      try { expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: crash === "before_import_commit" ? 0 : 3 }); }
      finally { db.close(); }
    }
  }
});
