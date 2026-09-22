import { randomUUID } from "node:crypto";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";

type Options = Omit<
  Parameters<typeof enrollRuntime>[0],
  "host" | "hostSessionId" | "incarnation"
>;
type Enrollment = Awaited<ReturnType<typeof enrollRuntime>>;
type HostEvent = { type: string; properties?: { info?: { id?: string } } };

/** Installed OpenCode V1 hooks. Configuration belongs to a trusted plugin
 * wrapper, never event payloads or tool arguments. Lifecycle only for now. */
export function opencodeLifecycle(
  options: Options,
  report: (event: {
    type: "enrolled" | "closed" | "error";
    hostSessionId: string;
    actor?: string;
  }) => void,
) {
  const incarnation = randomUUID();
  const sessions = new Map<string, Enrollment>();
  const pending = new Map<string, Promise<void>>();
  const deleted = new Set<string>();

  const serialize = (id: string, action: () => Promise<void>) => {
    const next = (pending.get(id) ?? Promise.resolve()).then(action);
    const tail = next.catch(() => {});
    pending.set(id, tail);
    return next.finally(() => {
      // Do not remove a newer queued operation.
      if (pending.get(id) === tail) pending.delete(id);
    });
  };

  const adopt = async (id: string) => {
    if (deleted.has(id)) throw new Error("Host session has ended");
    let session = sessions.get(id);
    if (!session) {
      session = await enrollRuntime({
        ...options,
        host: "opencode",
        hostSessionId: id,
        incarnation,
      });
      sessions.set(id, session);
      report({ type: "enrolled", hostSessionId: id, actor: session.actor });
    }
    return session;
  };

  return {
    // OpenCode's event publisher does not await plugin callbacks. Handle every
    // rejection here; tool hooks below remain fail-closed and are awaited.
    async event({ event }: { event: HostEvent }) {
      const id = event.properties?.info?.id;
      if (
        !id ||
        !["session.created", "session.updated", "session.deleted"].includes(
          event.type,
        )
      )
        return;
      if (event.type === "session.deleted") deleted.add(id);
      await serialize(id, async () => {
        if (event.type !== "session.deleted") {
          if (!deleted.has(id)) await adopt(id);
          return;
        }
        const session = sessions.get(id);
        if (!session) return;
        const client = await CoordinationClient.connect(
          session.environment.SWARM_COORDINATOR_ENDPOINT,
          session.environment.SWARM_SESSION_CAPABILITY,
        );
        try {
          await client.request({
            op: "command",
            command: { id: randomUUID(), type: "session.close", payload: {} },
          });
          sessions.delete(id);
          report({ type: "closed", hostSessionId: id, actor: session.actor });
        } finally {
          client.close();
        }
      }).catch(() => report({ type: "error", hostSessionId: id }));
    },
    async "shell.env"(
      input: { sessionID?: string },
      output: { env: Record<string, string> },
    ) {
      if (!input.sessionID) return;
      await serialize(input.sessionID, async () => {
        const session = await adopt(input.sessionID!);
        Object.assign(output.env, session.environment);
      });
    },
  };
}
