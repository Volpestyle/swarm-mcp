import type { Event } from "./store";

/** Content-free hints. Inbox notifications are restricted to this recipient. */
export function changedResources(events: Event[], actor: string): string[] {
  const uris = new Set<string>();
  for (const event of events) {
    const payload =
      event.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    if (event.type.startsWith("task.")) uris.add("swarm://tasks");
    else if (event.type.startsWith("context.")) uris.add("swarm://context");
    else if (
      event.type.startsWith("finding.") ||
      event.type.startsWith("artifact.")
    )
      uris.add("swarm://findings");
    else if (
      event.type === "message.accepted" &&
      Array.isArray(payload.recipients) &&
      payload.recipients.includes(actor)
    )
      uris.add("swarm://inbox");
    else if (event.type.startsWith("delivery.") && payload.recipient === actor)
      uris.add("swarm://inbox");
    else if (event.type === "retention.changed") {
      // Visibility changed; re-read the affected class without sending its content.
      if (payload.kind === "task") uris.add("swarm://tasks");
      else if (payload.kind === "finding" || payload.kind === "artifact")
        uris.add("swarm://findings");
    }
  }
  return [...uris];
}
