import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { backupLegacy, restoreLegacy } from "../src/coordination/legacy-snapshot";
import { importLegacy } from "../src/coordination/legacy-import";
import { CoordinationClient } from "../src/coordination/ipc";
import type { CoreCommand } from "../src/coordination/core";

// Disposable data and real production Node owner; no installed host or live profile.
const output = resolve(process.argv[2] ?? "dist/verification/migration-canary.json");
const root = mkdtempSync(join(tmpdir(), "swarm-migration-canary-"));
const report: Record<string, unknown> = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--"])).digest("hex"),
  workingTree: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  harnessSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
  ownerBundleSha256: createHash("sha256").update(readFileSync(resolve("dist/coordination/owner-cli.js"))).digest("hex"),
  startedAt: new Date().toISOString(), platform: process.platform, node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  bun: Bun.version, root, method: "isolated imported fixture over production Node owner IPC",
};
let child: ReturnType<typeof Bun.spawn> | undefined;
const clients: CoordinationClient[] = [];
async function stop() {
  for (const client of clients.splice(0)) client.close();
  if (child) { child.kill(); await child.exited; child = undefined; }
}
async function run(cmd: string[], env = process.env) {
  const child = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr); return stdout;
}
async function connect(endpoint: string, capability: string) {
  const client = await CoordinationClient.connect(endpoint, capability); clients.push(client); return client;
}
const command = async (client: CoordinationClient, command: CoreCommand): Promise<any> => client.request({ op: "command", command });
try {
  const source = join(root, "legacy.db"), snapshot = join(root, "snapshot"), destination = join(root, "candidate");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "sql"));
  const pinned = resolve("test/fixtures/legacy-baselines/b95f607");
  writeFileSync(join(root, "src/db.ts"), readFileSync(join(pinned, "db.ts")));
  for (const file of ["swarm_db_bootstrap.sql", "swarm_db_finalize.sql"])
    writeFileSync(join(root, "sql", file), readFileSync(join(pinned, file)));
  await run([process.execPath, join(root, "src/db.ts")], { ...process.env, SWARM_DB_PATH: source });
  const legacy = new Database(source);
  legacy.exec(`INSERT INTO messages(scope,sender,recipient,content,read) VALUES
    ('old','lead','worker','first pending message',0),('old','lead','worker','second pending message',0);
    INSERT INTO tasks(id,scope,type,title,requester,assignee,status) VALUES('work','old','code','canary work','lead','worker','in_progress');
    INSERT INTO context(id,scope,instance_id,file,type,content) VALUES('lock','old','worker','result.txt','lock','old ownership');`);
  legacy.close();
  const manifest = await backupLegacy(source, snapshot);
  const imported = await importLegacy(snapshot, destination, { version: 1, scopes: [{ from: "old", to: "canary", recipients: { worker: "worker" } }] });
  const hold = imported.holds[0]!;
  const launcherSecret = randomBytes(32).toString("hex"), config = join(root, "owner.json");
  writeFileSync(config, JSON.stringify({ databasePath: join(destination, "coordination.db"), launcherSecret }), { mode: 0o600 });
  async function start() {
    child = Bun.spawn({ cmd: ["node", resolve("dist/coordination/owner-cli.js"), config], stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let ready = "";
    while (!ready.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(await new Response(child.stderr).text());
      ready += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return JSON.parse(ready).endpoint as string;
  }
  let endpoint = await start();
  const launcher = await connect(endpoint, launcherSecret);
  const session: any = await launcher.request({ op: "enroll", input: { scope: "canary", agentId: "worker", requestId: "canary-enroll",
    resumeToken: randomBytes(32).toString("hex"), worktree: { root, repository: root } } });
  let worker = await connect(endpoint, session.capability);
  await assert.rejects(command(worker, { id: "held", type: "task.claim", payload: { taskId: hold.taskId, expectedVersion: 1 } }));
  const first = (await command(worker, { id: "fetch-1", type: "inbox.fetch", payload: { consumer: "canary", limit: 1 } })).value.deliveries[0];
  const ackFirst: CoreCommand = { id: "ack-1", type: "inbox.ack", payload: { messageId: first.message.id, leaseToken: first.leaseToken } };
  await command(worker, ackFirst);
  const second = (await command(worker, { id: "fetch-2", type: "inbox.fetch", payload: { consumer: "canary", limit: 1, leaseMs: 50 } })).value.deliveries[0];
  const review = (await command(worker, { id: "review", type: "task.claim", payload: { taskId: hold.reviewTaskId, expectedVersion: 1 } })).value;
  await command(worker, { id: "review-finish", type: "task.finish", payload: { taskId: hold.reviewTaskId, attemptId: review.attemptId,
    fence: review.fence, outcome: "completed", result: { evidence: "Fixture writers stopped; no old side effects; no unresolved dependency" } } });
  const oldAttempt = (await command(worker, { id: "claim", type: "task.claim", payload: { taskId: hold.taskId, expectedVersion: 2, leaseMs: 50 } })).value;
  await stop(); // Abrupt owner loss; no session-close or processing acknowledgment.
  await delay(1200); // Real delivery lease plus default retry backoff, not a fake clock.
  endpoint = await start(); worker = await connect(endpoint, session.capability);
  assert.equal((await command(worker, ackFirst)).replayed, true);
  const retry = (await command(worker, { id: "fetch-after-restart", type: "inbox.fetch", payload: { consumer: "canary", limit: 1 } })).value.deliveries[0];
  assert.equal(retry.message.id, second.message.id); assert.notEqual(retry.leaseToken, second.leaseToken);
  await assert.rejects(command(worker, { id: "stale-ack", type: "inbox.ack", payload: { messageId: second.message.id, leaseToken: second.leaseToken } }));
  worker.close(); worker = await connect(endpoint, session.capability); // Physical consumer disconnect.
  await command(worker, { id: "ack-2", type: "inbox.ack", payload: { messageId: retry.message.id, leaseToken: retry.leaseToken } });
  await command(worker, { id: "recover", type: "task.recover", payload: { taskId: hold.taskId } });
  const recovered: any = await worker.request({ op: "task", taskId: hold.taskId });
  const fresh = (await command(worker, { id: "claim-recovered", type: "task.claim", payload: { taskId: hold.taskId, expectedVersion: recovered.version } })).value;
  assert.ok(fresh.fence > oldAttempt.fence);
  await assert.rejects(command(worker, { id: "stale-finish", type: "task.finish", payload: { taskId: hold.taskId, attemptId: oldAttempt.attemptId, fence: oldAttempt.fence, outcome: "completed" } }));
  const artifact = join(root, "result.txt"); writeFileSync(artifact, "one reconciled canary effect\n", { flag: "wx" });
  const finish: CoreCommand = { id: "finish", type: "task.finish", payload: { taskId: hold.taskId, attemptId: fresh.attemptId, fence: fresh.fence,
    outcome: "completed", result: { artifact: "result.txt", evidence: "exclusive creation after reconciliation", limitations: ["fixture effect"] } } };
  await command(worker, finish); assert.equal((await command(worker, finish)).replayed, true);
  const inbox: any = await worker.request({ op: "inbox" });
  assert.equal(inbox.items.length, 2); assert.ok(inbox.items.every((item: any) => item.state === "acknowledged"));
  const attempts: any = await worker.request({ op: "attempts", taskId: hold.taskId });
  assert.deepEqual(attempts.map((attempt: any) => attempt.state), ["abandoned", "completed"]);
  report.delivery = { messages: 2, acknowledged: 2, staleLeaseRejected: true, reconnectAcknowledged: true, acknowledgmentReplay: true };
  report.execution = { oldFence: oldAttempt.fence, newFence: fresh.fence, staleFinishRejected: true, finishReplay: true, attempts };
  await stop();
  const rollback = join(root, "rollback.db"); await restoreLegacy(snapshot, rollback);
  const restored = new Database(rollback);
  assert.equal((restored.query("SELECT status FROM tasks WHERE id='work'").get() as any).status, "in_progress");
  // Explicit canary rollback reconciliation. The generic restore never guesses
  // which post-snapshot effects were accepted; keep the effect and record it.
  restored.exec("BEGIN IMMEDIATE; UPDATE tasks SET status='done',result='Canary result.txt retained and reconciled' WHERE id='work'; UPDATE messages SET read=1; COMMIT");
  restored.close();
  await run(["node", resolve("dist/legacy-guard-cli.js"), rollback, "--", process.execPath, join(root, "src/db.ts")]);
  assert.equal(readFileSync(artifact, "utf8"), "one reconciled canary effect\n");
  const verified = new Database(rollback, { readonly: true });
  assert.equal((verified.query("SELECT status FROM tasks WHERE id='work'").get() as any).status, "done");
  assert.equal((verified.query("SELECT count(*) AS n FROM messages WHERE read=0").get() as any).n, 0); verified.close();
  assert.equal(createHash("sha256").update(readFileSync(join(snapshot, "legacy.db"))).digest("hex"), manifest.sha256);
  report.rollback = { freshRestore: true, postSnapshotEffectExplicitlyReconciled: true, checkedLegacyLaunch: true, snapshotUnchanged: true };
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = String(error); process.exitCode = 1;
} finally {
  await stop(); report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n"); console.log(output);
}
