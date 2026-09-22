import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Operation } from "./ipc";
import { wakeState } from "./launcher-state";

type Result = {
  status: "accepted" | "deferred" | "uncertain";
  messageId?: string;
};

/** Trusted host-side wake admission. Does not fetch/ack inbox work, grant
 * permissions, create sessions, cancel tools, or retry an uncertain POST. */
export class OpenCodeWake {
  private pending?: Promise<Result>;
  constructor(
    private readonly options: {
      api: OpencodeClient;
      request: (operation: Operation) => Promise<unknown>;
      actor: string;
      scope: string;
      hostSessionId: string;
      stateDirectory: string;
    },
  ) {}

  notify(messageId: string): Promise<Result> {
    if (this.pending) return this.pending;
    this.pending = this.admit(messageId)
      .catch((): Result => ({ status: "uncertain" }))
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async admit(messageId: string): Promise<Result> {
    const o = this.options;
    const delivery = (await o.request({ op: "message_status", messageId })) as {
      deliveries: Array<{ recipient: string; state: string }>;
    };
    if (
      !delivery.deliveries.some(
        (d) => d.recipient === o.actor && d.state === "pending",
      )
    )
      return { status: "deferred" };
    const signal = AbortSignal.timeout(5000);
    const request = { signal, throwOnError: true as const };
    const [session, status, permissions, questions] = await Promise.all([
      o.api.session.get({ sessionID: o.hostSessionId }, request),
      o.api.session.status({}, request),
      o.api.permission.list({}, request),
      o.api.question.list({}, request),
    ]);
    if (
      session.data.time.archived ||
      (status.data[o.hostSessionId]?.type ?? "idle") !== "idle" ||
      [...permissions.data, ...questions.data].some(
        (p) => p.sessionID === o.hostSessionId,
      )
    )
      return { status: "deferred" };
    const intent = wakeState(
      o.stateDirectory,
      o.scope,
      o.hostSessionId,
      messageId,
    );
    const existing = await o.api.session.message(
      { sessionID: o.hostSessionId, messageID: intent.messageId },
      { signal },
    );
    if (existing.data)
      return { status: "accepted", messageId: intent.messageId };
    if (existing.response.status !== 404 || !intent.fresh)
      return { status: "uncertain", messageId: intent.messageId };
    await o.api.session.promptAsync(
      {
        sessionID: o.hostSessionId,
        messageID: intent.messageId,
        parts: [
          {
            id: intent.partId,
            type: "text",
            text: "Swarm inbox has pending work. Process peer messages at a safe boundary and acknowledge only after processing.",
          },
        ],
      },
      request,
    );
    // 204 admits the asynchronous request; it is not evidence of processing.
    return { status: "accepted", messageId: intent.messageId };
  }
}
