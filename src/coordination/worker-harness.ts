import { spawn } from "node:child_process";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

export const workerInstructions = (skill: string) =>
  `Read the swarm-mcp skill at ${skill}. You are not alone in the checkout; preserve other agents' edits. Receive assignments and peer replies through Swarm. Read every contract.instructions artifact before acting. Check current task ownership. Acknowledge each processed envelope using swarm_inbox. Report progress before its deadline, finish tasks with evidence and send the requester a completion notice. If blocked, send a question and let this turn finish; the host delivers the reply. Never poll in a model loop.`;

/** Harness protocol is independent of the managed lifecycle and worker mode. */
export function streamHarness(record: HerdrWorkerRecord, callbacks: {
  settled(): void;
  failed(error: Error): void;
}) {
  const harness = record.harness ?? "claude-code";
  const instructions = workerInstructions(record.environment.SWARM_SKILL_PATH!);
  const args = harness === "claude-code" ? [...record.args,
    "--permission-mode", "auto", "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--append-system-prompt", instructions]
    : harness === "pi" ? [...record.args, "--append-system-prompt", instructions] : record.args;
  const child = spawn(record.command, args, { cwd: record.cwd, env: { ...process.env, ...record.environment },
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "inherit"] });
  let sequence = 0, threadId: string | undefined, buffer = "";
  const pending = new Map<string | number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const write = (message: unknown) => { child.stdin.write(JSON.stringify(message) + "\n"); };
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker ${harness} ${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    write(harness === "codex" ? { id, method, params } : { id, type: method, ...params });
  });
  child.once("exit", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Worker harness exited")); }
    pending.clear();
  });
  // Split LF only: pi RPC permits Unicode line separators inside JSON strings.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { callbacks.failed(new Error("Worker protocol frame exceeds 16 MiB")); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const response = pending.get(event.id);
        if (response && (harness === "pi" ? event.type === "response" : !event.method)) {
          pending.delete(event.id); clearTimeout(response.timer);
          if (event.error || event.success === false) response.reject(new Error(event.error?.message ?? event.error ?? "Worker request rejected"));
          else response.resolve(harness === "pi" ? event.data : event.result);
          continue;
        }
        if (harness === "codex" && event.method && event.id !== undefined) {
          write({ id: event.id, error: { code: -32601, message: "Managed worker cannot answer interactive requests" } });
          callbacks.failed(new Error(`Worker requires unsupported interaction: ${event.method}`));
        }
        if (harness === "claude-code") {
          if (event.type === "assistant") for (const block of event.message?.content ?? []) if (block.type === "text") console.log(block.text);
          if (event.type === "result") callbacks.settled();
        } else if (harness === "pi") {
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
          if (event.type === "agent_end") callbacks.settled();
        } else {
          if (event.method === "item/agentMessage/delta") process.stdout.write(event.params.delta);
          if (event.method === "turn/completed") callbacks.settled();
        }
      } catch (error) { callbacks.failed(new Error(`Invalid ${harness} worker output: ${String(error)}`)); }
    }
  });
  return {
    child,
    async start() {
      if (harness !== "codex") return;
      await request("initialize", { clientInfo: { name: "swarm-managed-worker", version: "1" }, capabilities: null });
      write({ method: "initialized", params: {} });
      const result = await request("thread/start", { cwd: record.cwd, model: record.model ?? "gpt-6-astra",
        approvalPolicy: "never", sandbox: "workspace-write", developerInstructions: instructions });
      if (typeof result?.thread?.id !== "string") throw new Error("Codex did not return a worker thread");
      threadId = result.thread.id;
    },
    async prompt(message: string) {
      if (harness === "claude-code") write({ type: "user", message: { role: "user", content: message } });
      else if (harness === "pi") await request("prompt", { message });
      else await request("turn/start", { threadId, input: [{ type: "text", text: message, text_elements: [] }] });
    },
  };
}
