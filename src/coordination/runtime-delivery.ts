import { randomUUID } from "node:crypto";
import type { Operation } from "./ipc";

export type RuntimeState =
  | "busy"
  | "idle"
  | "blocked"
  | "disconnected"
  | "unsupported";
export type DeliveryBoundary = "turn_start" | "tool_complete";
export interface RuntimeObservation {
  state: RuntimeState;
  evidence: string;
  observedAt: number;
}
export interface RuntimeDeliveryLease {
  message: {
    id: string;
    recipient: string;
    body: string;
    kind: string;
    [key: string]: unknown;
  };
  leaseToken: string;
  leaseUntil: number;
  attempt: number;
}
/** Implemented by trusted host integrations, never by model-supplied callbacks.
 * A successful delivery means host admission, not completed processing.
 * The host must atomically check its safe boundary when admitting context.
 */
export interface RuntimeAdapter {
  readonly name: string;
  readonly boundaries: readonly DeliveryBoundary[];
  observe(): RuntimeObservation;
  deliver(
    lease: RuntimeDeliveryLease,
    boundary: DeliveryBoundary,
    signal: AbortSignal,
  ): Promise<"admitted" | "deferred">;
  /** Wake an existing idle session only. There is intentionally no spawn API. */
  wake?: (signal: AbortSignal) => Promise<boolean>;
}
type Request = (operation: Operation) => Promise<unknown>;
type BoundaryResult = {
  status: "empty" | "deferred" | "admitted" | "uncertain";
  messageId?: string;
};

/** One instance per authenticated runtime session. Durable inbox leases remain
 * authoritative across instance loss; hosts deduplicate by message ID.
 */
export class RuntimeDelivery {
  private boundaryPending?: Promise<BoundaryResult>;
  private wakePending?: Promise<boolean>;
  private wakeRequested = false;
  private retryAfter = 0;
  constructor(
    private readonly actor: string,
    private readonly request: Request,
    private readonly adapter: RuntimeAdapter,
    private readonly now = Date.now,
    private readonly hostTimeoutMs = 5000,
  ) {}

  private hostCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error("Host callback timed out; admission may be uncertain"),
        );
      }, this.hostTimeoutMs);
      Promise.resolve()
        .then(() => run(controller.signal))
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  async notifyAccepted(messageId: string): Promise<boolean> {
    // Query durable state before even considering a wake. A transport hint alone
    // is insufficient, and an already processed delivery needs no wake.
    const status = (await this.request({
      op: "message_status",
      messageId,
    })) as {
      deliveries: Array<{ recipient: string; state: string }>;
    };
    if (
      !status.deliveries.some(
        (d) => d.recipient === this.actor && d.state === "pending",
      )
    )
      return false;
    if (this.wakePending) return this.wakePending;
    if (
      this.wakeRequested ||
      this.now() < this.retryAfter ||
      !this.adapter.wake ||
      this.adapter.observe().state !== "idle"
    )
      return false;
    this.retryAfter = this.now() + 1000;
    this.wakePending = (async () => {
      try {
        const accepted = await this.hostCall((signal) =>
          this.adapter.wake!(signal),
        );
        this.wakeRequested = accepted;
        return accepted;
      } catch {
        return false;
      }
    })();
    try {
      return await this.wakePending;
    } finally {
      this.wakePending = undefined;
    }
  }

  atBoundary(boundary: DeliveryBoundary): Promise<BoundaryResult> {
    if (this.boundaryPending) return this.boundaryPending;
    this.wakeRequested = false;
    const state = this.adapter.observe().state;
    // Post-tool admission is safe only at an actual supported host callback,
    // never from a timer that merely guesses that a running tool has finished.
    const safeState =
      state === "idle" || (state === "busy" && boundary === "tool_complete");
    if (!this.adapter.boundaries.includes(boundary) || !safeState)
      return Promise.resolve({ status: "deferred" });
    this.boundaryPending = this.deliver(boundary).finally(() => {
      this.boundaryPending = undefined;
    });
    return this.boundaryPending;
  }

  private async deliver(boundary: DeliveryBoundary): Promise<BoundaryResult> {
    const commandId = randomUUID();
    const receipt = (await this.request({
      op: "command",
      command: {
        id: commandId,
        type: "inbox.fetch",
        payload: { consumer: this.adapter.name, limit: 1 },
      },
    })) as { value: { deliveries: RuntimeDeliveryLease[] } };
    const lease = receipt.value.deliveries[0];
    if (!lease) return { status: "empty" };
    if (lease.message.recipient !== this.actor)
      throw new Error(
        "Runtime actor does not match authenticated inbox recipient",
      );
    try {
      const result = await this.hostCall((signal) =>
        this.adapter.deliver(lease, boundary, signal),
      );
      if (result === "deferred") {
        await this.request({
          op: "command",
          command: {
            id: `${commandId}-reject`,
            type: "inbox.reject",
            payload: {
              messageId: lease.message.id,
              leaseToken: lease.leaseToken,
              reason: "Host boundary unavailable",
            },
          },
        });
      }
      return { status: result, messageId: lease.message.id };
    } catch {
      // Admission may have happened before the error. Keep the lease rather
      // than immediately retrying and injecting a duplicate into the host.
      return { status: "uncertain", messageId: lease.message.id };
    }
  }
}
