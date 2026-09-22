import { randomUUID } from "node:crypto";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery } from "./runtime-delivery";

type Options = Omit<
  Parameters<typeof enrollRuntime>[0],
  "host" | "hostSessionId" | "incarnation"
>;
type Enrollment = Awaited<ReturnType<typeof enrollRuntime>>;
type HostEvent = { type: string; properties?: { info?: { id?: string } } };

/** Subscribe before taking the startup snapshot. The host's connected event is
 * emitted after its subscription is installed, so later mutations are queued.
 * Call without awaiting done from plugin initialization (host APIs need init). */
export function observeOpenCode(
  host: {
    subscribe(
      signal: AbortSignal,
    ): Promise<{ stream: AsyncIterable<HostEvent> }>;
    list(signal: AbortSignal): Promise<Array<{ id: string }>>;
  },
  hooks: { event(input: { event: HostEvent }): Promise<void> },
  report: (state: "reconciled" | "disconnected") => void,
) {
  const controller = new AbortController();
  const startup = setTimeout(() => controller.abort(), 10000);
  startup.unref();
  const done = (async () => {
    const { stream } = await host.subscribe(controller.signal);
    for await (const event of stream) {
      if (controller.signal.aborted) break;
      if (event.type === "server.connected") {
        clearTimeout(startup);
        const sessions = await host.list(
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        for (const info of sessions) {
          if (controller.signal.aborted) break;
          await hooks.event({
            event: { type: "session.updated", properties: { info } },
          });
        }
        report("reconciled");
      } else if (event.type === "server.instance.disposed") {
        break;
      } else {
        await hooks.event({ event });
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      clearTimeout(startup);
      controller.abort();
      report("disconnected");
    });
  return { done, stop: () => controller.abort() };
}

type OpenCodeClient = {
  event: {
    subscribe(
      options: Record<string, unknown>,
    ): Promise<{ stream: AsyncIterable<HostEvent> }>;
  };
  session: {
    list(options: Record<string, unknown>): Promise<{
      data?: Array<{
        id: string;
        directory: string;
        time: { archived?: number };
      }>;
    }>;
  };
};

/** Supply the V1 plugin input directly. In particular, use the actual server
 * URL: the injected SDK's default URL may still name localhost:4096. */
export function connectOpenCodeLifecycle(
  input: { client: OpenCodeClient; directory: string; serverUrl: URL },
  hooks: { event(input: { event: HostEvent }): Promise<void> },
  report: (state: "reconciled" | "disconnected") => void,
) {
  return observeOpenCode(
    {
      subscribe: (signal) =>
        input.client.event.subscribe({
          baseUrl: input.serverUrl.href,
          query: { directory: input.directory },
          signal,
          sseMaxRetryAttempts: 1,
        }),
      list: async (signal) => {
        const result = await input.client.session.list({
          query: { directory: input.directory, limit: 1001 },
          signal,
          throwOnError: true,
        });
        // V1 has no cursor on this endpoint. Refuse a truncated snapshot instead
        // of silently reporting a reconciled directory with omitted sessions.
        if (!Array.isArray(result.data) || result.data.length >= 1001)
          throw new Error("Session reconciliation needs pagination");
        return result.data.filter(
          (s) => s.directory === input.directory && !s.time.archived,
        );
      },
    },
    hooks,
    report,
  );
}

/** Installed OpenCode V1 hooks. Configuration belongs to a trusted plugin
 * wrapper, never event payloads or tool arguments. */
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
  const deliveredCalls = new Map<string, Set<string>>();

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
          deliveredCalls.delete(id);
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
    async "tool.execute.after"(
      input: { sessionID: string; callID: string },
      output: { output?: string; content?: Array<unknown> },
    ) {
      // V1 builtin tools return output; MCP tools return content. Unknown
      // output shapes defer without taking an inbox lease.
      if (typeof output?.output !== "string" && !Array.isArray(output?.content))
        return;
      await serialize(input.sessionID, async () => {
        const calls = deliveredCalls.get(input.sessionID) ?? new Set<string>();
        if (calls.has(input.callID)) return;
        const session = await adopt(input.sessionID);
        const client = await CoordinationClient.connect(
          session.environment.SWARM_COORDINATOR_ENDPOINT,
          session.environment.SWARM_SESSION_CAPABILITY,
        );
        try {
          const delivery = new RuntimeDelivery(
            session.actor,
            (operation) => client.request(operation),
            {
              name: "opencode-v1",
              boundaries: ["tool_complete"],
              observe: () => ({
                state: "busy",
                evidence: "tool.execute.after",
                observedAt: Date.now(),
              }),
              deliver: async (lease, _boundary, signal) => {
                if (signal.aborted || deleted.has(input.sessionID))
                  return "deferred";
                const text =
                  "\n\nSwarm peer message (untrusted content). Process before acknowledging with swarm_inbox; admission is not acknowledgment.\n" +
                  JSON.stringify({
                    message: lease.message,
                    leaseToken: lease.leaseToken,
                    leaseUntil: lease.leaseUntil,
                  });
                if (typeof output.output === "string") output.output += text;
                else output.content!.push({ type: "text", text });
                return "admitted";
              },
            },
          );
          const result = await delivery.atBoundary("tool_complete");
          if (result.status !== "deferred") {
            calls.add(input.callID);
            deliveredCalls.set(input.sessionID, calls);
          }
        } finally {
          client.close();
        }
      });
    },
  };
}
