import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient, type Operation } from "../src/coordination/ipc";

const worker = process.argv[2] === "--worker";
const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;
const until = async (check: () => boolean, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture barrier timed out");
    await delay(20);
  }
};

if (worker) {
  const config = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  const {
    root,
    index,
    endpoint,
    capability,
    actor,
    recipient,
    idleMs,
    messagesPerAgent,
    slowMs,
    disconnectMs,
  } = config;
  const clients = await Promise.all(
    [0, 1, 2].map(() => CoordinationClient.connect(endpoint, capability)),
  );
  const [reader, writer, watcher] = clients as [
    CoordinationClient,
    CoordinationClient,
    CoordinationClient,
  ];
  let requestBytes = 0,
    responseBytes = 0,
    requests = 0,
    stopped = false,
    accepted = 0;
  const errors: string[] = [],
    samples: any[] = [],
    operations: number[] = [];
  const request = async (client: CoordinationClient, input: Operation) => {
    requests++;
    requestBytes += Buffer.byteLength(JSON.stringify(input));
    const start = performance.now();
    try {
      const result = await client.request(input);
      responseBytes += Buffer.byteLength(JSON.stringify(result));
      return result as any;
    } finally {
      if (input.op !== "watch") operations.push(performance.now() - start);
    }
  };
  const snapshot = await request(reader, { op: "bootstrap" });
  let cursor = snapshot.eventCursor;
  let resumeAt = 0;
  const consume = async () => {
    if (resumeAt > Date.now()) await delay(resumeAt - Date.now());
    const fetched = await request(reader, {
      op: "command",
      command: {
        id: randomUUID(),
        type: "inbox.fetch",
        payload: { consumer: actor, limit: 50, leaseMs: 30000 },
      },
    });
    for (const lease of fetched.value.deliveries) {
      const receivedAt = Date.now(),
        body = JSON.parse(lease.message.body);
      if (slowMs) await delay(slowMs);
      await request(reader, {
        op: "command",
        command: {
          id: `ack-${lease.message.id}`,
          type: "inbox.ack",
          payload: {
            messageId: lease.message.id,
            leaseToken: lease.leaseToken,
          },
        },
      });
      samples.push({
        messageId: lease.message.id,
        sequence: body.sequence,
        sentAt: body.sentAt,
        createdAt: lease.message.createdAt,
        receivedAt,
        ackResponseAt: Date.now(),
      });
    }
  };
  const reading = (async () => {
    while (!stopped) {
      const page = await request(watcher, {
        op: "watch",
        cursor,
        timeoutMs: 30000,
        limit: 100,
      });
      cursor = page.cursor;
      if (
        page.items.some(
          (e: any) =>
            e.type === "message.accepted" &&
            e.payload.recipients.includes(actor),
        )
      )
        await consume();
    }
  })().catch((error) => {
    if (!stopped) errors.push(String(error));
  });
  writeFileSync(
    join(root, `ready-${index}`),
    JSON.stringify({ pid: process.pid }),
  );
  try {
    await until(() => existsSync(join(root, "idle-go")));
    const idleStart = performance.now(),
      cpuStart = process.cpuUsage(),
      idleRequests = requests;
    await delay(idleMs);
    const idleCpu = process.cpuUsage(cpuStart),
      idleWallMs = performance.now() - idleStart;
    const idle = {
      idleWallMs,
      idleCpuUs: idleCpu.user + idleCpu.system,
      idleRequests: requests - idleRequests,
      rssBytes: process.memoryUsage().rss,
    };
    writeFileSync(join(root, `idle-${index}`), JSON.stringify(idle));
    await until(() => existsSync(join(root, "send-go")));
    const sendStart = Date.now();
    resumeAt = sendStart + disconnectMs;
    for (let sequence = 0; sequence < messagesPerAgent; sequence++) {
      try {
        await request(writer, {
          op: "command",
          command: {
            id: `send-${index}-${sequence}`,
            type: "message.send",
            payload: {
              recipient,
              kind: "benchmark",
              body: JSON.stringify({
                sentAt: Date.now(),
                sequence,
                body: "x".repeat(256),
              }),
            },
          },
        });
        accepted++;
      } catch (error) {
        errors.push(String(error));
      }
      await delay(73);
    }
    await until(
      () => samples.length === messagesPerAgent,
      Math.max(15000, disconnectMs + 10000),
    ).catch((error) => errors.push(String(error)));
    const finished = Date.now();
    stopped = true;
    clients.forEach((client) => client.close());
    await reading;
    console.log(
      JSON.stringify({
        index,
        pid: process.pid,
        accepted,
        received: samples.length,
        sendStart,
        finished,
        ...idle,
        requests,
        requestBytes,
        responseBytes,
        operations,
        errors,
        samples,
      }),
    );
  } finally {
    stopped = true;
    clients.forEach((client) => client.close());
  }
} else {
  const count = Number(process.argv[2]),
    output = process.argv[3];
  const idleMs = Number(process.env.SWARM_BENCH_IDLE_MS ?? 4200);
  const messagesPerAgent = Number(process.env.SWARM_BENCH_MESSAGES ?? 12);
  const slowMs = Number(process.env.SWARM_BENCH_SLOW_MS ?? 0);
  const disconnectMs = Number(process.env.SWARM_BENCH_DEFER_MS ?? 0);
  if (
    ![0, 1, 2, 8, 32].includes(count) ||
    !output ||
    ![idleMs, messagesPerAgent, slowMs, disconnectMs].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error(
      "Usage: bun scripts/benchmark-coordination.ts 0|1|2|8|32 output.json",
    );
  const root = mkdtempSync(join(tmpdir(), "coordination-bench-")),
    secret = randomBytes(32).toString("hex"),
    config = join(root, "owner.json");
  const source = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    diffSha256: createHash("sha256")
      .update(execFileSync("git", ["diff", "HEAD", "--"]))
      .digest("hex"),
    ownerBundleSha256: createHash("sha256")
      .update(readFileSync(resolve("dist/coordination/owner-cli.js")))
      .digest("hex"),
    harnessSha256: createHash("sha256")
      .update(readFileSync(import.meta.path))
      .digest("hex"),
  };
  writeFileSync(
    config,
    JSON.stringify({ databasePath: join(root, "db"), launcherSecret: secret }),
  );
  const owner = Bun.spawn({
    cmd: [
      Bun.which("node")!,
      ...(process.env.SWARM_BENCH_PROFILE === "1"
        ? ["--inspect=127.0.0.1:0"]
        : []),
      resolve("dist/coordination/owner-cli.js"),
      config,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  let inspectorUrl: string | undefined;
  const ownerError = (async () => {
    let text = "";
    for await (const chunk of owner.stderr) {
      text += new TextDecoder().decode(chunk);
      inspectorUrl = text.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/)?.[0];
    }
    return text;
  })();
  let profiler: WebSocket | undefined;
  let profileRequest: ((method: string) => Promise<any>) | undefined;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let launcher: CoordinationClient | undefined,
    observer: CoordinationClient | undefined;
  const metrics = async (pids: number[]) => {
    if (process.platform !== "win32") return null;
    if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
      throw new Error("Invalid fixture PID");
    const command = `Get-Process -Id ${pids.join(",")} | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`;
    const child = Bun.spawn({
      cmd: ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw new Error(err);
    return { at: Date.now(), processes: [JSON.parse(out)].flat() };
  };
  try {
    const readyReader = owner.stdout.getReader(),
      first = await readyReader.read();
    readyReader.releaseLock();
    if (!first.value) throw new Error(await ownerError);
    const { endpoint, pid: ownerPid } = JSON.parse(
      new TextDecoder().decode(first.value),
    );
    launcher = await CoordinationClient.connect(endpoint, secret);
    const enroll = async (agentId: string) =>
      (await launcher!.request({
        op: "enroll",
        input: {
          scope: "benchmark",
          agentId,
          requestId: "initial",
          resumeToken: randomBytes(32).toString("hex"),
        },
      })) as any;
    const controller = await enroll("benchmark-controller");
    observer = await CoordinationClient.connect(
      endpoint,
      controller.capability,
    );
    const identities = [];
    for (let index = 0; index < count; index++)
      identities.push(await enroll(`worker-${index}`));
    const outputs: Promise<any>[] = [];
    for (let index = 0; index < count; index++) {
      const path = join(root, `worker-${index}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          root,
          index,
          endpoint,
          capability: identities[index].capability,
          actor: `worker-${index}`,
          recipient: `worker-${(index + 1) % count}`,
          idleMs,
          messagesPerAgent,
          slowMs: index === 0 ? slowMs : 0,
          disconnectMs: index === 0 ? disconnectMs : 0,
        }),
      );
      const child = Bun.spawn({
        cmd: [process.execPath, import.meta.path, "--worker", path],
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      outputs.push(
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]).then(([code, out, err]) => {
          if (code !== 0) throw new Error(String(err));
          return JSON.parse(String(out));
        }),
      );
    }
    await until(() =>
      children.every((_, i) => existsSync(join(root, `ready-${i}`))),
    );
    await delay(2000);
    const ownerStart = await metrics([ownerPid]);
    writeFileSync(join(root, "idle-go"), "go");
    if (!count) await delay(idleMs);
    await until(
      () => children.every((_, i) => existsSync(join(root, `idle-${i}`))),
      idleMs + 10000,
    );
    const endMetrics = await metrics([
      ownerPid,
      ...children.map((child) => child.pid),
    ]);
    if (process.env.SWARM_BENCH_PROFILE === "1") {
      await until(() => !!inspectorUrl);
      profiler = new WebSocket(inspectorUrl!);
      await new Promise<void>((resolve, reject) => {
        profiler!.onopen = () => resolve();
        profiler!.onerror = () =>
          reject(new Error("Profiler connection failed"));
      });
      let seq = 0;
      const pending = new Map<
        number,
        { resolve: (value: any) => void; reject: (error: Error) => void }
      >();
      profiler.onmessage = (event) => {
        const data = JSON.parse(String(event.data));
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(JSON.stringify(data.error)));
        else request.resolve(data.result);
      };
      profileRequest = (method) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          profiler!.send(JSON.stringify({ id, method }));
        });
      await profileRequest("Profiler.enable");
      await profileRequest("Profiler.start");
    }
    writeFileSync(join(root, "send-go"), "go");
    const workers = await Promise.all(outputs);
    if (profileRequest) {
      const data = await profileRequest("Profiler.stop");
      mkdirSync(resolve(output, ".."), { recursive: true });
      writeFileSync(output + ".cpuprofile", JSON.stringify(data.profile));
      profiler?.close();
    }
    const diagnostics = (await observer.request({
      op: "inspect",
      filter: { limit: 1 },
    })) as any;
    const samples = workers.flatMap((w) => w.samples),
      sum = (key: string) => workers.reduce((n, w) => n + w[key], 0);
    const delivery = samples.map((s) => s.receivedAt - s.createdAt),
      ack = samples.map((s) => s.ackResponseAt - s.createdAt),
      endToEnd = samples.map((s) => s.receivedAt - s.sentAt);
    const ownerEnd = endMetrics?.processes.find((p) => p.Id === ownerPid);
    const ownerCpuPercent =
      ownerStart && endMetrics
        ? ((ownerEnd.CPU - ownerStart.processes[0].CPU) * 100000) /
          (endMetrics.at - ownerStart.at)
        : null;
    const result = {
      source,
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      hardware: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        physicalMemoryBytes: totalmem(),
        platform: platform(),
        release: release(),
        bun: Bun.version,
        node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
      },
      workload: {
        profiled: !!profileRequest,
        count,
        messagesPerAgent,
        bodyBytes: 256,
        spacingMs: 73,
        idleMs,
        warmupMs: 2000,
        slowMs,
        deferredConsumerMs: disconnectMs,
        root,
      },
      accepted: sum("accepted"),
      received: sum("received"),
      deliveryMs: {
        p50: percentile(delivery, 0.5),
        p95: percentile(delivery, 0.95),
        p99: percentile(delivery, 0.99),
      },
      acknowledgeMs: { p50: percentile(ack, 0.5), p95: percentile(ack, 0.95) },
      sendToDeliverMs: {
        p50: percentile(endToEnd, 0.5),
        p95: percentile(endToEnd, 0.95),
      },
      deliveredPerSecond:
        count && samples.length
          ? sum("received") /
            ((Math.max(...workers.map((w) => w.finished)) -
              Math.min(...workers.map((w) => w.sendStart))) /
              1000)
          : 0,
      aggregateIdleCpuPercentOfOneCore:
        workers.reduce((n, w) => n + w.idleCpuUs / (w.idleWallMs * 10), 0) +
        (ownerCpuPercent ?? 0),
      ownerCpuPercent,
      ownerPid,
      ownerWorkingSetBytes: ownerEnd?.WorkingSet64 ?? null,
      ownerPrivateBytes: ownerEnd?.PrivateMemorySize64 ?? null,
      processMemory: endMetrics,
      aggregateWorkerRssBytes: sum("rssBytes"),
      explicitRequestBytes: sum("requestBytes"),
      explicitResponseBytes: sum("responseBytes"),
      transportRequests: sum("requests"),
      errors: workers.flatMap((w) => w.errors),
      diagnostics,
      workers,
      limitations:
        "Production Node owner and independent Bun IPC clients; no model inference or MCP serialization. JSON volumes omit transport framing. First-delivery timestamp is transaction timestamp (includes commit time); acknowledgment is measured through response. Windows memory includes shared working-set pages. Deferred consumer stays connected; not a process-disconnect/restart proof. No processing side effects beyond fixture acknowledgment.",
    };
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(output);
  } finally {
    profiler?.close();
    launcher?.close();
    observer?.close();
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    owner.kill();
    await owner.exited;
    await ownerError;
  }
}
