import { randomUUID } from "node:crypto";
import type { Operation } from "./ipc";
import type { RuntimeObservation, RuntimeState } from "./runtime-delivery";

/** Feed only notifications from the trusted app-server connection owning this
 * thread. Connection loss changes availability, never proves session closure. */
export class CodexLifecycle {
  private observation: RuntimeObservation = {
    state: "disconnected",
    evidence: "No native thread observation",
    observedAt: Date.now(),
  };
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly threadId: string,
    private readonly request: (operation: Operation) => Promise<unknown>,
  ) {}

  observe(): RuntimeObservation {
    return { ...this.observation };
  }

  private publish(state: RuntimeState, evidence: string, close = false) {
    this.observation = { state, evidence, observedAt: Date.now() };
    const operation: Operation = {
      op: "command",
      command: close
        ? { id: randomUUID(), type: "session.close", payload: {} }
        : {
            id: randomUUID(),
            type: "session.observe",
            payload: {
              transport: state !== "disconnected",
              runtime:
                state === "idle"
                  ? "available"
                  : state === "busy"
                    ? "busy"
                    : "unavailable",
            },
          },
    };
    const pending = this.tail.then(() => this.request(operation));
    this.tail = pending.catch(() => {
      this.observation = {
        state: "disconnected",
        evidence: "Coordinator observation failed",
        observedAt: Date.now(),
      };
    });
    return pending;
  }

  async notify(method: string, params: unknown) {
    if (this.closed || !params || typeof params !== "object") return;
    const event = params as {
      threadId?: unknown;
      status?: { type?: unknown; activeFlags?: unknown };
    };
    if (event.threadId !== this.threadId) return;
    if (
      method === "thread/closed" ||
      method === "thread/archived" ||
      method === "thread/deleted"
    ) {
      this.closed = true;
      await this.publish("disconnected", `Native ${method}`, true);
      return;
    }
    if (method !== "thread/status/changed") return;
    const status = event.status;
    let state: RuntimeState = "unsupported";
    if (status?.type === "idle") state = "idle";
    else if (status?.type === "notLoaded" || status?.type === "systemError")
      state = "disconnected";
    else if (status?.type === "active" && Array.isArray(status.activeFlags))
      state =
        status.activeFlags.length === 0
          ? "busy"
          : status.activeFlags.every(
                (flag) =>
                  flag === "waitingOnApproval" || flag === "waitingOnUserInput",
              )
            ? "blocked"
            : "unsupported";
    await this.publish(
      state,
      `Native thread/status/changed: ${String(status?.type)}`,
    );
  }

  async disconnected() {
    if (!this.closed)
      await this.publish("disconnected", "App-server transport disconnected");
  }
}
