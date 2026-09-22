// Baseline production-module workload, not a live-model or full MCP-host benchmark.
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const count = Number(process.argv[2]);
if (![1, 2, 8, 32].includes(count)) throw new Error("Expected agent count 1, 2, 8, or 32");
const worker = process.argv[3] === "--worker";
const fixture = worker ? process.argv[4]! : mkdtempSync(join(tmpdir(), "swarm-bench-"));
process.env.SWARM_DB_PATH = join(fixture, "swarm.db");
const mode = process.env.SWARM_BENCH_MODE ?? "baseline";
if (!["baseline", "no-cleanup", "atomic"].includes(mode)) throw new Error("Unknown experiment mode");
const pollMs = Number(process.env.SWARM_BENCH_POLL_MS ?? 2000);
if (!Number.isFinite(pollMs) || pollMs < 20) throw new Error("Invalid poll interval");
const messagesPerAgent = Number(process.env.SWARM_BENCH_MESSAGES ?? 12);
const idleMs = Number(process.env.SWARM_BENCH_IDLE_MS ?? 4200);
if (![messagesPerAgent, idleMs].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid benchmark duration or message count");

if (worker) {
  const index = Number(process.argv[5]);
  const { db } = await import("../src/db");
  const registry = await import("../src/registry");
  const messages = await import("../src/messages");
  const events = await import("../src/events");
  const scope = "baseline-benchmark";
  const agent = registry.register(fixture, `identity:benchmark worker:${index}`, scope);
  writeFileSync(join(fixture, `ready-${index}`), agent.id);
  const deadline = Date.now() + 30000;
  while (!existsSync(join(fixture, "go"))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for start barrier");
    await sleep(20);
  }
  const peer = readFileSync(join(fixture, `ready-${(index + 1) % count}`), "utf8");
  const operationMs: number[] = [];
  const errors: string[] = [];
  const latencies: number[] = [];
  const receivedIds = new Set<number>();
  let responseBytes = 0;
  let requestBytes = 0;
  let polls = 0;
  let accepted = 0;
  let duplicateDeliveries = 0;
  // Experimental paths only. Production remains unchanged. 'no-cleanup' keeps
  // separate mutation/event statements; 'atomic' also makes each transition atomic.
  const atomic = <T>(fn: () => T): T => {
    if (mode !== "atomic") return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const send = (content: string) => {
    if (mode === "baseline") return messages.send(agent.id, scope, peer, content);
    return atomic(() => {
      db.run("INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)", [scope, agent.id, peer, content]);
      events.emit({ scope, type: "message.sent", actor: agent.id, subject: peer, payload: { content, length: content.length } });
    });
  };
  const poll = () => {
    if (mode === "baseline") return messages.poll(agent.id, scope);
    return atomic(() => {
      const rows = db.query("SELECT id, sender, content, created_at FROM messages WHERE scope = ? AND recipient = ? AND read = 0 ORDER BY created_at, id LIMIT 50").all(scope, agent.id) as Array<{id:number;content:string}>;
      if (rows.length) db.run(`UPDATE messages SET read = 1 WHERE id IN (${rows.map(() => "?").join(",")})`, rows.map(row => row.id));
      return rows;
    });
  };
  const timed = <T>(fn: () => T): T | undefined => {
    const start = performance.now();
    try { return fn(); }
    catch (error) { errors.push(String(error)); return undefined; }
    finally { operationMs.push(performance.now() - start); }
  };
  const read = () => {
    polls++;
    requestBytes += Buffer.byteLength(JSON.stringify({ name: "poll_messages", arguments: {} }));
    const rows = timed(poll) as Array<{id:number;content:string}> | undefined;
    responseBytes += Buffer.byteLength(JSON.stringify(rows ?? []));
    for (const row of rows ?? []) {
      if (receivedIds.has(row.id)) duplicateDeliveries++;
      receivedIds.add(row.id);
      latencies.push(Date.now() - JSON.parse(row.content).sentAt);
    }
  };
  const polling = setInterval(read, pollMs);
  const heartbeat = setInterval(() => timed(() => registry.heartbeat(agent.id)), 10000);
  const idleCpuStart = process.cpuUsage();
  const idleStart = performance.now();
  await sleep(idleMs);
  const idleCpu = process.cpuUsage(idleCpuStart);
  const idleWallMs = performance.now() - idleStart;
  const rssBytes = process.memoryUsage().rss;
  const sendStart = Date.now();
  let payloadBytes = 0;
  for (let n = 0; n < messagesPerAgent; n++) {
    const content = JSON.stringify({ sentAt: Date.now(), sequence: n, body: "x".repeat(256) });
    payloadBytes += Buffer.byteLength(content);
    requestBytes += Buffer.byteLength(JSON.stringify({ name: "send_message", arguments: { recipient: peer, content } }));
    timed(() => { send(content); accepted++; });
    await sleep(73);
  }
  while (latencies.length < messagesPerAgent && Date.now() - sendStart < 8000) await sleep(30);
  const finished = Date.now();
  clearInterval(polling);
  clearInterval(heartbeat);
  console.log(JSON.stringify({ index, accepted, received: latencies.length, duplicateDeliveries,
    latencies, sendStart, finished, idleWallMs, idleCpuUs: idleCpu.user + idleCpu.system,
    rssBytes, operationMs, errors, payloadBytes, requestBytes, responseBytes, polls,
    readMarkCount: db.query("SELECT count(*) AS n FROM messages WHERE recipient = ? AND read = 1").get(agent.id),
  }));
} else {
  // Initialize once so startup migration races do not dominate this steady-state workload.
  await import("../src/db");
  const children = Array.from({ length: count }, (_, index) => Bun.spawn({
    cmd: [process.execPath, import.meta.path, String(count), "--worker", fixture, String(index)],
    env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  }));
  const outputs = children.map(async (child) => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { code, stderr, result: code === 0 ? JSON.parse(stdout) : null };
  });
  const deadline = Date.now() + 20000;
  while (!children.every((_, i) => existsSync(join(fixture, `ready-${i}`)))) {
    if (Date.now() > deadline) {
      children.forEach((child) => child.kill());
      throw new Error(`Registration barrier failed: ${JSON.stringify(await Promise.all(outputs))}`);
    }
    await sleep(30);
  }
  writeFileSync(join(fixture, "go"), "start");
  const results = await Promise.all(outputs);
  if (results.some((row) => row.code !== 0)) throw new Error(JSON.stringify(results));
  const workers = results.map((row) => row.result);
  const sum = (key: string) => workers.reduce((total, row) => total + row[key], 0);
  const latencies = workers.flatMap((row) => row.latencies);
  const durationMs = Math.max(...workers.map((row) => row.finished)) - Math.min(...workers.map((row) => row.sendStart));
  const inspection = new Database(process.env.SWARM_DB_PATH!, { readonly: true });
  const unread = inspection.query("SELECT count(*) AS n FROM messages WHERE read = 0").get();
  inspection.close();
  console.log(JSON.stringify({
    hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, physicalMemoryBytes: totalmem(), platform: platform(), release: release(), bun: Bun.version },
    workload: { count, mode, pollMs, messagesPerAgent, bodyBytes: 256, idleMs, fixture },
    accepted: sum("accepted"), received: sum("received"), unread, duplicateDeliveries: sum("duplicateDeliveries"),
    deliveryMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
    deliveredPerSecond: sum("received") / (durationMs / 1000),
    aggregateIdleCpuPercentOfOneCore: workers.reduce((total, row) => total + row.idleCpuUs / (row.idleWallMs * 10), 0),
    aggregateWorkerRssBytes: sum("rssBytes"),
    productionOperationMs: { p50: percentile(workers.flatMap((row) => row.operationMs), .5), p95: percentile(workers.flatMap((row) => row.operationMs), .95) },
    errors: workers.flatMap((row) => row.errors), payloadBytes: sum("payloadBytes"),
    serializedRequestBytes: sum("requestBytes"), serializedResponseBytes: sum("responseBytes"),
    simulatedToolCalls: sum("polls") + sum("accepted") + count,
    tokenEstimateCharsDivFour: null,
    limitations: "Production modules with periodic inbox reads; excludes MCP serialization, model tokenization, host wake and full server notification timer. RSS includes each worker's shared pages. Operation latency includes SQLite contention but does not isolate lock wait. Startup initialized before worker barrier. No injected failures.",
    workers,
  }, null, 2));
}
