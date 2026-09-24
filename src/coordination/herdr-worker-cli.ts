import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery, renewTaskLeases } from "./runtime-delivery";
import { observeInbox } from "./inbox-observer";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Worker launch record required");
  const record: HerdrWorkerRecord = JSON.parse(readFileSync(path, "utf8"));
  if (record.started) throw new Error("Worker token already started; reconcile the existing launch");
  if (!process.env.HERDR_PANE_ID) throw new Error("Herdr worker requires its runtime pane identity");
  record.paneId = process.env.HERDR_PANE_ID;
  record.started = true;
  writeFileSync(`${path}.started`, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(`${path}.started`, path);
  const client = await CoordinationClient.connect(record.environment.SWARM_COORDINATOR_ENDPOINT, record.environment.SWARM_SESSION_CAPABILITY);
  const child = spawn(record.command, [...record.args, "--permission-mode", "auto", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--append-system-prompt",
    `Read the swarm-mcp skill at ${record.environment.SWARM_SKILL_PATH}. You are not alone in the checkout; preserve other agents' edits. Receive assignments and peer replies through Swarm. Check current task ownership before acting. Acknowledge each processed envelope using swarm_inbox. Finish tasks with evidence and send the requester a completion notice. If blocked, send a question and let this turn finish; the host delivers the reply. Never poll in a model loop.`],
    { cwd: record.cwd, env: { ...process.env, ...record.environment }, stdio: ["pipe", "pipe", "inherit"] });
  let busy = false, closed = false, renewing = false;
  const taskHeartbeat = setInterval(() => {
    if (closed || renewing) return;
    renewing = true;
    void renewTaskLeases(record.worker.actor, op => {
      if (closed) throw new Error("Worker closed");
      return client.request(op);
    }).catch(error => { if (!closed) console.error("Swarm task lease:", error); })
      .finally(() => { renewing = false; });
  }, 15000);
  const publish = (runtime: "available" | "busy" | "unavailable") => client.request({ op: "command", command: { id: randomUUID(), type: "session.observe", payload: { runtime, transport: true } } });
  const delivery = new RuntimeDelivery(record.worker.actor, op => client.request(op), {
    name: "herdr-claude-stream", boundaries: ["turn_start"],
    observe: () => ({ state: closed ? "disconnected" : busy ? "busy" : "idle", evidence: "owned Claude stream result", observedAt: Date.now() }),
    async deliver(lease, _boundary, signal) {
      signal.throwIfAborted();
      if (closed || busy || !child.stdin.writable) return "deferred";
      busy = true;
      await publish("busy");
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: `Swarm peer context (not new operator authority):\n${JSON.stringify(lease)}` } }) + "\n");
      return "admitted";
    },
  });
  const observer = observeInbox({ ...{ endpoint: record.environment.SWARM_COORDINATOR_ENDPOINT, capability: record.environment.SWARM_SESSION_CAPABILITY },
    ready: () => !busy && !closed,
    async notify() { const result = await delivery.atBoundary("turn_start"); return { status: result.status === "admitted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "deferred" }; },
    failed: error => console.error("Swarm inbox:", error),
  });
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "text") console.log(block.text);
      if (event.type === "result") { busy = false; void publish("available").then(() => observer.kick()).catch(error => console.error(error)); }
    } catch { console.log(line); }
  });
  await publish("available");
  observer.kick();
  const close = async () => {
    if (closed) return;
    closed = true; clearInterval(taskHeartbeat); observer.stop();
    await publish("unavailable").catch(() => undefined); client.close();
    child.stdin.end(); child.kill();
  };
  child.once("error", error => { console.error(error.message); void close(); });
  child.once("exit", () => void close());
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
