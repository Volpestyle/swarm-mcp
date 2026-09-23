import type { RuntimeObservation, RuntimeState } from "./runtime-delivery";

export type OpenCodeEvent = {
  type: string;
  properties?: {
    info?: { id?: string };
    sessionID?: string;
    id?: string;
    requestID?: string;
    status?: { type: string };
  };
};

/** Host evidence only. Permission/question replies do not establish idle. */
export class OpenCodeAvailability {
  private observations = new Map<string, RuntimeObservation>();
  private waiting = new Map<string, Set<string>>();
  private disconnected = false;
  private recovering = false;

  observe(id: string): RuntimeObservation {
    if (this.disconnected)
      return {
        state: "disconnected",
        evidence: "host event stream disconnected",
        observedAt: Date.now(),
      };
    if (this.recovering)
      return {
        state: "unsupported",
        evidence: "Host snapshot in progress",
        observedAt: Date.now(),
      };
    return (
      this.observations.get(id) ?? {
        state: "unsupported",
        evidence: "No verified host state",
        observedAt: Date.now(),
      }
    );
  }

  private set(id: string, state: RuntimeState, evidence: string) {
    this.observations.set(id, { state, evidence, observedAt: Date.now() });
  }

  event(event: OpenCodeEvent) {
    if (event.type === "server.connected") {
      this.disconnected = false;
      this.recovering = true;
      this.observations.clear();
      this.waiting.clear();
      return;
    }
    if (event.type === "swarm.snapshot.ready") {
      this.recovering = false;
      return;
    }
    if (
      event.type === "server.instance.disposed" ||
      event.type === "swarm.stream.disconnected"
    ) {
      this.disconnected = true;
      return;
    }
    const p = event.properties;
    const id = p?.sessionID ?? p?.info?.id;
    if (!id) return;
    if (event.type === "session.created") {
      // New sessions have no running prompt. Do not overwrite a newer status
      // or permission event if creation is delivered again or out of order.
      if (!this.observations.has(id)) this.set(id, "idle", event.type);
    } else if (event.type === "session.deleted") {
      this.waiting.delete(id);
      this.set(id, "disconnected", event.type);
    } else if (
      event.type === "permission.asked" ||
      event.type === "question.asked"
    ) {
      if (!p?.id) return;
      const waiting = this.waiting.get(id) ?? new Set<string>();
      waiting.add(`${event.type.split(".")[0]}:${p.id}`);
      this.waiting.set(id, waiting);
      this.set(id, "blocked", event.type);
    } else if (
      ["permission.replied", "question.replied", "question.rejected"].includes(
        event.type,
      )
    ) {
      if (!p?.requestID) return;
      const waiting = this.waiting.get(id);
      waiting?.delete(`${event.type.split(".")[0]}:${p.requestID}`);
      this.set(id, waiting?.size ? "blocked" : "busy", event.type);
    } else if (event.type === "session.status") {
      if (this.waiting.get(id)?.size)
        this.set(id, "blocked", "Pending host permission/question");
      else if (p?.status?.type === "idle") this.set(id, "idle", event.type);
      else if (["busy", "retry"].includes(p?.status?.type ?? ""))
        this.set(id, "busy", event.type);
      else this.set(id, "unsupported", "Unknown host status");
    }
  }

  toolBoundary(id: string) {
    const current = this.observe(id);
    if (this.recovering) return current;
    if (current.state === "blocked" || current.state === "disconnected")
      return current;
    this.set(id, "busy", "tool.execute.after");
    return this.observe(id);
  }
}
