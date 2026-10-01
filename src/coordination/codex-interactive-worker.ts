import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

/** Native Codex owns the thread, approvals and terminal. This client submits
 * Swarm context to that same thread; it never answers a native approval request.
 * Protocol: https://developers.openai.com/codex/app-server/ */
export function codexInteractiveWorker(record: HerdrWorkerRecord, callbacks: {
  owned(child: ChildProcess): void;
  busy(): void;
  settled(): void;
  failed(error: Error): void;
  identity(threadId: string): void;
  log(message: string): void;
}, options: { requestTimeoutMs?: number } = {}) {
  let socket: WebSocket | undefined;
  let directory: string | undefined;
  let failure: Error | undefined;
  let closing = false;
  let threadId: string | undefined;
  let subscribed = false;
  let revision = 0;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    if (!closing) callbacks.failed(error);
  };
  const request = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    if (failure || !socket || socket.readyState !== WebSocket.OPEN) { reject(failure ?? new Error("Codex transport is not connected")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery is uncertain`)); }, options.requestTimeoutMs ?? 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(error); });
  });
  const observe = (event: any) => {
    if (event.params?.threadId !== threadId) return;
    if (event.method === "turn/started") { revision++; callbacks.busy(); }
    if (event.method === "turn/completed") {
      revision++;
      if (event.params.turn?.status === "failed") fail(new Error(`Codex turn failed: ${JSON.stringify(event.params.turn.error ?? {})}`));
      else callbacks.settled();
    }
    if (event.method === "thread/status/changed") {
      revision++;
      if (event.params.status?.type === "idle") callbacks.settled();
      else if (event.params.status?.type === "active") callbacks.busy();
    }
    // Bidirectional requests are also delivered to the native TUI. Leave every
    // approval/elicitation unanswered here; no automatic response or retry.
    if (event.id !== undefined && event.method) callbacks.busy();
  };
  const subscribe = async (wait: boolean) => {
    if (subscribed) return;
    const deadline = Date.now() + 5000;
    for (;;) {
      const snapshotRevision = revision;
      try {
        const result = await request("thread/resume", { threadId });
        if (result.thread?.id !== threadId) throw new Error("Codex subscribed to a different native thread");
        subscribed = true;
        const turn = result.thread.turns?.at(-1);
        if (turn && revision === snapshotRevision) observe({ method: turn.status === "inProgress" ? "turn/started" : "turn/completed", params: { threadId, turn } });
        return;
      } catch (error) {
        if (!/no rollout found|rollout at .* is empty/.test(String(error))) throw error;
        if (!wait) return;
        if (Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
  };
  return {
    async start() {
      if (process.platform === "win32") throw new Error("Interactive Codex workers require a private Unix socket");
      directory = await mkdtemp(join(tmpdir(), "swarm-codex-"));
      const socketPath = join(directory, "rpc.sock"), endpoint = `unix://${socketPath}`;
      const environment = { ...process.env, ...record.environment };
      const server = spawn(record.command, [...record.args, "app-server", "--listen", endpoint], {
        cwd: record.cwd, env: environment, detached: true, stdio: ["ignore", "ignore", "pipe"],
      });
      callbacks.owned(server);
      server.stderr!.on("data", bytes => callbacks.log(String(bytes).slice(-8192)));
      server.once("error", fail);
      server.once("exit", code => fail(new Error(`Codex app-server exited (${code})`)));
      const deadline = Date.now() + 15000;
      while (!socket) {
        if (failure) throw failure;
        if (closing || Date.now() >= deadline) throw new Error("Codex app-server did not open its private socket");
        socket = await new Promise<WebSocket | undefined>(done => {
          const attempt = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 1000, maxPayload: 16 * 1024 * 1024 });
          attempt.once("open", () => done(attempt));
          attempt.once("error", () => { attempt.terminate(); done(undefined); });
        });
        if (!socket) await delay(50);
      }
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("Codex worker transport disconnected")));
      socket.on("message", bytes => {
        try {
          const event = JSON.parse(String(bytes));
          if (event.method) { observe(event); return; }
          const call = pending.get(event.id);
          if (!call) return;
          pending.delete(event.id); clearTimeout(call.timer);
          if (event.error) call.reject(new Error(event.error.message ?? "Codex request rejected"));
          else call.resolve(event.result);
        } catch (error) { fail(new Error(`Invalid Codex frame: ${String(error)}`)); }
      });
      await request("initialize", { clientInfo: { name: "swarm-interactive-worker", version: "1" } });
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      if (closing || failure) throw failure ?? new Error("Worker stopped during startup");
      const view = spawn(record.command, [...record.args, "--remote", endpoint], {
        cwd: record.cwd, env: environment, detached: true, stdio: "inherit",
      });
      callbacks.owned(view);
      view.once("error", fail);
      view.once("exit", code => fail(new Error(`Native Codex TUI exited (${code})`)));
      // An app-server-created empty thread has no rollout. Let the native TUI
      // create it; require exactly one root before any model input or claim.
      const threadDeadline = Date.now() + 15000;
      while (!threadId) {
        if (closing || failure) throw failure ?? new Error("Worker stopped during startup");
        const loaded = await request("thread/loaded/list", {});
        if (!Array.isArray(loaded.data) || loaded.nextCursor || loaded.data.length > 1) throw new Error("Codex initial native thread inventory is incomplete or ambiguous");
        if (typeof loaded.data[0] === "string") threadId = loaded.data[0];
        else { if (Date.now() >= threadDeadline) throw new Error("Native Codex TUI did not create its thread"); await delay(50); }
      }
      const read = await request("thread/read", { threadId, includeTurns: false });
      if (read.thread?.id !== threadId || resolve(read.thread.cwd) !== resolve(record.cwd)) throw new Error("Codex native thread identity/workspace mismatch");
      callbacks.identity(threadId);
    },
    async prompt(message: string) {
      await subscribe(false);
      const result = await request("turn/start", { threadId, input: [{ type: "text", text: message, text_elements: [] }] });
      if (typeof result.turn?.id !== "string") throw new Error("Codex did not confirm delivery; do not replay");
      await subscribe(true);
    },
    async close() {
      closing = true;
      fail(new Error("Codex worker closed"));
      socket?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
