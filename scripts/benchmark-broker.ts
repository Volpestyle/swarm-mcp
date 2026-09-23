// Disposable loopback-only architecture experiment; not an installed service.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const count = Number(process.argv[2]);
if (![2, 8, 32].includes(count)) throw new Error("Expected 2, 8 or 32 workers");
const holdMs = Number(process.env.SWARM_BENCH_HOLD_MS ?? 30000);
if (!Number.isFinite(holdMs) || holdMs < 100) throw new Error("Invalid hold duration");
const worker = process.argv[3] === "--worker";
const fixture = worker ? process.argv[4]! : mkdtempSync(join(tmpdir(), "swarm-broker-bench-"));
process.env.SWARM_DB_PATH = join(fixture, "swarm.db");
if (worker) {
  const index = Number(process.argv[5]);
  const url = process.env.SWARM_BENCH_URL!;
  const agents = JSON.parse(readFileSync(join(fixture, "agents.json"), "utf8"));
  const id = agents[index];
  const peer = agents[(index + 1) % count];
  const latencies: number[] = [];
  const errors: string[] = [];
  let accepted = 0;
  let polls = 0;
  let stopped = false;
  const controller = new AbortController();
  const readLoop = async () => {
    while (!stopped) {
      try {
        polls++;
        const response = await fetch(`${url}/poll/${id}`, { signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const rows = await response.json() as Array<{ content: string }>;
        for (const row of rows) latencies.push(Date.now() - JSON.parse(row.content).sentAt);
      } catch (error) { if (!stopped) errors.push(String(error)); }
    }
  };
  writeFileSync(join(fixture, `ready-${index}`), "ready");
  const deadline = Date.now() + 30000;
  while (!existsSync(join(fixture, "go"))) {
    if (Date.now() > deadline) throw new Error("Start barrier timed out");
    await sleep(20);
  }
  const reading = readLoop();
  // Separate first HTTP connections/JIT from the steady-state idle sample.
  await sleep(2000);
  const startCpu = process.cpuUsage();
  const startIdle = performance.now();
  await sleep(4200);
  const idleCpu = process.cpuUsage(startCpu);
  const idleWallMs = performance.now() - startIdle;
  const rssBytes = process.memoryUsage().rss;
  const sendStart = Date.now();
  for (let sequence = 0; sequence < 12; sequence++) {
    try {
      const response = await fetch(`${url}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sender: id, recipient: peer, content: JSON.stringify({ sentAt: Date.now(), sequence, body: "x".repeat(256) }) }) });
      if (!response.ok) throw new Error(await response.text());
      await response.text();
      accepted++;
    } catch (error) { errors.push(String(error)); }
    await sleep(73);
  }
  while (latencies.length < 12 && Date.now() - sendStart < 8000) await sleep(30);
  stopped = true;
  controller.abort();
  await reading;
  console.log(JSON.stringify({ index, latencies, accepted, received: latencies.length, errors, polls, rssBytes, idleWallMs, idleCpuUs: idleCpu.user + idleCpu.system, sendStart, finished: Date.now() }));
} else {
  const { db } = await import("../src/db");
  const registry = await import("../src/registry");
  const scope = "broker-experiment";
  const agents = Array.from({length:count}, (_, index) => registry.register(fixture, `identity:benchmark worker:${index}`, scope).id);
  writeFileSync(join(fixture, "agents.json"), JSON.stringify(agents));
  const waiting = new Map<string, () => void>();
  const atomic = <T>(fn: () => T) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const peek = (id: string) => db.query("SELECT id, sender, content, created_at FROM messages WHERE recipient = ? AND read = 0 ORDER BY id LIMIT 50").all(id) as Array<{id:number}>;
  const server = Bun.serve({hostname:"127.0.0.1", port:0, async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/send" && request.method === "POST") {
        const input = await request.json() as {sender:string;recipient:string;content:string};
        if (!agents.includes(input.sender) || !agents.includes(input.recipient)) return new Response("unknown fixture agent", {status:400});
        atomic(() => {
          db.run("INSERT INTO messages (scope,sender,recipient,content) VALUES (?,?,?,?)", [scope,input.sender,input.recipient,input.content]);
          db.run("INSERT INTO events (scope,type,actor,subject,payload) VALUES (?,?,?,?,?)", [scope,"message.sent",input.sender,input.recipient,JSON.stringify({content:input.content,length:input.content.length})]);
        });
        waiting.get(input.recipient)?.();
        return Response.json({accepted:true});
      }
      const id = path.slice("/poll/".length);
      if (!path.startsWith("/poll/") || !agents.includes(id)) return new Response("not found",{status:404});
      if (!peek(id).length) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); waiting.delete(id); resolve(); };
        const timer = setTimeout(done, holdMs);
        waiting.set(id, done);
      });
      const rows = atomic(() => {
        const rows = peek(id);
        if (rows.length) db.run(`UPDATE messages SET read=1 WHERE id IN (${rows.map(()=>"?").join(",")})`,rows.map(row=>row.id));
        return rows;
      });
      return Response.json(rows);
    } catch (error) { return new Response(String(error),{status:500}); }
  }});
  const children = Array.from({length:count}, (_, index) => Bun.spawn({cmd:[process.execPath,import.meta.path,String(count),"--worker",fixture,String(index)],env:{...process.env,SWARM_BENCH_URL:`http://127.0.0.1:${server.port}`},stdout:"pipe",stderr:"pipe"}));
  const outputs = children.map(async child => {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  });
  const deadline = Date.now()+20000;
  while (!children.every((_,i)=>existsSync(join(fixture,`ready-${i}`)))) {
    if (Date.now()>deadline) { children.forEach(child=>child.kill()); server.stop(true); throw new Error("Worker startup timed out"); }
    await sleep(20);
  }
  writeFileSync(join(fixture,"go"),"start");
  await sleep(2100);
  const brokerCpu = process.cpuUsage();
  const brokerIdleStart = performance.now();
  await sleep(4000);
  const brokerIdleCpu = process.cpuUsage(brokerCpu);
  const brokerIdleWallMs = performance.now()-brokerIdleStart;
  const brokerRssBytes = process.memoryUsage().rss;
  const workers = await Promise.all(outputs);
  for (const done of waiting.values()) done();
  server.stop(true);
  const values = workers.flatMap(row=>row.latencies).sort((a,b)=>a-b);
  const sum = (key:string)=>workers.reduce((n,row)=>n+row[key],0);
  console.log(JSON.stringify({count,mode:"single-writer-long-poll",warmupMs:2000,fixture,accepted:sum("accepted"),received:sum("received"),unread:db.query("SELECT count(*) AS n FROM messages WHERE read=0").get(),deliveryMs:{p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1]},deliveredPerSecond:sum("received")/((Math.max(...workers.map(row=>row.finished))-Math.min(...workers.map(row=>row.sendStart)))/1000),aggregateWorkerRssBytes:sum("rssBytes"),brokerRssBytes,aggregateIdleCpuPercentOfOneCore:workers.reduce((n,row)=>n+row.idleCpuUs/(row.idleWallMs*10),0)+(brokerIdleCpu.user+brokerIdleCpu.system)/(brokerIdleWallMs*10),errors:workers.flatMap(row=>row.errors),limitations:"Single disposable local writer, lean atomic message/event writes, destructive polling retained for comparability. Not a reliability implementation. No durable acknowledgements, authentication, service recovery or real host. Same hardware and ring workload as benchmark-baseline; workers omit imported coordination modules.",workers},null,2));
}
