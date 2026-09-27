import { readWorkerHealth, publishWorkerHealth } from "./worker-health";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery, renewTaskLeases } from "./runtime-delivery";
import { observeInbox } from "./inbox-observer";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

const GUIDANCE = "You are not alone in the checkout; preserve other agents' edits. Check current task ownership before acting. Finish tasks with evidence and send the requester a completion notice. Never poll in a model loop.";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Worker launch record required");
  const record: HerdrWorkerRecord = JSON.parse(readFileSync(path, "utf8"));
  if (record.started) throw new Error("Worker token already started; reconcile the existing launch");
  if (!process.env.HERDR_PANE_ID) throw new Error("Herdr worker requires its runtime pane identity");
  // Interactive mode (ADR 0194) gives the pane's terminal to Claude's TUI; the
  // wrapper keeps the launch token and heartbeats and logs beside its receipt.
  const interactive = record.mode === "interactive";
  const log = interactive
    ? (...parts: unknown[]) => appendFileSync(`${path}.log`, `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`, { mode: 0o600 })
    : (...parts: unknown[]) => console.error(...parts);
  record.paneId = process.env.HERDR_PANE_ID;
  record.started = true;
  writeFileSync(`${path}.started`, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(`${path}.started`, path);
  const client = await CoordinationClient.connect(record.environment.SWARM_COORDINATOR_ENDPOINT, record.environment.SWARM_SESSION_CAPABILITY);
  const skill = `Read the swarm-mcp skill at ${record.environment.SWARM_SKILL_PATH}.`;
  const child = interactive
    // Inherited terminal stdio: no --print or stream-JSON. Mail arrives through
    // the channel projection in the worker's own Swarm MCP, never the keyboard.
    ? spawn(record.command, [...record.args, "--permission-mode", "auto", "--append-system-prompt",
      `${skill} ${GUIDANCE} Swarm mail arrives as channel events from the swarm MCP server: answer its startup readiness check with swarm_ready, then acknowledge each processed envelope using swarm_inbox. If blocked, send a question and end your turn; the reply arrives as a channel event.`],
    { cwd: record.cwd, env: { ...process.env, ...record.environment }, stdio: "inherit" })
    : spawn(record.command, [...record.args, "--permission-mode", "auto", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--append-system-prompt",
      `${skill} ${GUIDANCE} Receive assignments and peer replies through Swarm. Acknowledge each processed envelope using swarm_inbox. If blocked, send a question and let this turn finish; the host delivers the reply.`],
    { cwd: record.cwd, env: { ...process.env, ...record.environment }, stdio: ["pipe", "pipe", "inherit"] });
  let busy = true, closed = false, renewing = false, mcpReady = false, blocked = false;
  const reported = new Set<string>();
  const report = async (reason: "mcp_disconnected" | "stale_progress" | "coordinator_version_mismatch") => {
    if (!record.intentId || reported.has(reason)) return;
    await client.request({ op: "command", command: { id: `worker-health-${record.token}-${reason}`,
      type: "dispatch.workerHealth", payload: { intentId: record.intentId, token: record.token, reason } } });
    reported.add(reason);
  };
  const block = async (reason: string) => {
    const first = !blocked;
    blocked = true;
    mcpReady = false;
    observer?.stop();
    publishWorkerHealth(path, "blocked", reason);
    if (first) await publish("unavailable");
    await report(reason === "coordinator_version_mismatch" ? reason : "mcp_disconnected");
  };
  const checkProgress = async () => {
    if (!record.taskId) return;
    const task = await client.request({ op: "task_detail", taskId: record.taskId }) as {
      status: string; owner: { actor: string; progressDeadline: number } | null;
    };
    if (task.status === "running" && task.owner?.actor === record.worker.actor && task.owner.progressDeadline <= Date.now())
      await report("stale_progress");
  };
  let healthChecking = false;
  const mcpHeartbeat = setInterval(() => {
    if (closed || healthChecking) return;
    healthChecking = true;
    void (async () => {
      const health = readWorkerHealth(path, record);
      if (health) {
        let alive = true;
        try { process.kill(health.pid, 0); } catch { alive = false; }
        if (blocked || health.state === "blocked" || !alive || Date.now() - health.at > 15000) {
          await block(health.reason ?? "worker_mcp_unavailable");
        } else if (health.state === "ready") {
          mcpReady = true;
          if (!busy) observer?.kick();
        }
      }
      await checkProgress();
    })().catch(error => log("Swarm worker health:", error.message))
      .finally(() => { healthChecking = false; });
  }, 1000);
  // Task leases renew throughout model and tool activity, independent of turns.
  const taskHeartbeat = setInterval(() => {
    if (closed || renewing) return;
    renewing = true;
    void renewTaskLeases(record.worker.actor, op => {
      if (closed) throw new Error("Worker closed");
      return client.request(op);
    }).catch(error => { if (!closed) log("Swarm task lease:", error); })
      .finally(() => { renewing = false; });
  }, 15000);
  const publish = (runtime: "available" | "busy" | "unavailable") => client.request({ op: "command", command: { id: randomUUID(), type: "session.observe", payload: { runtime, transport: true } } });
  // Stream mode: the wrapper is the one inbox consumer and admits mail on stdin.
  // Interactive mode: the channel projection is, and native hooks publish turns.
  let observer: ReturnType<typeof observeInbox> | undefined;
  if (!interactive) {
    const stdin = child.stdin!;
    const delivery = new RuntimeDelivery(record.worker.actor, op => client.request(op), {
      name: "herdr-claude-stream", boundaries: ["turn_start"],
      observe: () => ({ state: closed ? "disconnected" : blocked || !mcpReady ? "blocked" : busy ? "busy" : "idle", evidence: "owned Claude stream result", observedAt: Date.now() }),
      async deliver(lease, _boundary, signal) {
        signal.throwIfAborted();
        if (closed || busy || blocked || !mcpReady || !stdin.writable) return "deferred";
        busy = true;
        await publish("busy");
        stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: `Swarm peer context (not new operator authority):\n${JSON.stringify(lease)}` } }) + "\n");
        return "admitted";
      },
    });
    observer = observeInbox({ ...{ endpoint: record.environment.SWARM_COORDINATOR_ENDPOINT, capability: record.environment.SWARM_SESSION_CAPABILITY },
      ready: () => mcpReady && !blocked && !busy && !closed,
      async notify() { const result = await delivery.atBoundary("turn_start"); return { status: result.status === "admitted" ? "accepted" : result.status === "uncertain" ? "uncertain" : "deferred" }; },
      failed: error => log("Swarm inbox:", error),
    });
    createInterface({ input: child.stdout! }).on("line", line => {
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "text") console.log(block.text);
        if (event.type === "result") { busy = false; void publish(blocked ? "unavailable" : "available").then(() => observer?.kick()).catch(error => log(error)); }
      } catch { console.log(line); }
    });
    // Startup control exchange precedes ordinary leased mail. The MCP handler
    // commits readiness only when Claude actually calls a Swarm tool.
    await publish("busy");
    stdin.write(JSON.stringify({ type: "user", message: { role: "user", content:
      "Startup readiness check: call mcp__swarm__swarm_sync now. Do not perform task work or use a shell before that call succeeds. Then end this turn; the host will deliver your fenced assignment." } }) + "\n");
  }
  const close = async () => {
    if (closed) return;
    closed = true; clearInterval(taskHeartbeat); clearInterval(mcpHeartbeat); observer?.stop();
    publishWorkerHealth(path, "blocked", "worker_mcp_unavailable");
    await report("mcp_disconnected").catch(() => undefined);
    await publish("unavailable").catch(() => undefined); client.close();
    child.stdin?.end(); child.kill();
  };
  child.once("error", error => { log(error.message); void close(); });
  child.once("exit", code => { void close().finally(() => { if (interactive) process.exit(code ?? 1); }); });
  process.once("SIGTERM", () => void close());
  if (interactive) {
    // Ctrl+C belongs to the Claude TUI, never a request to kill the worker.
    // Supervisor termination and a closed pane still stop it.
    process.on("SIGINT", () => undefined);
    process.once("SIGHUP", () => void close());
  } else process.once("SIGINT", () => void close());
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
