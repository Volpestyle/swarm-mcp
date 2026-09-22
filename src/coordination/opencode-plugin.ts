import { observeInbox } from "./inbox-observer";
import { listOpenCodeSessions } from "./opencode-snapshot";
import { hasOpenCodeContext, OPENCODE_PEER_PREFIX } from "./opencode-context";
import { OpenCodeWake } from "./opencode-wake";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { enrollRuntime } from "./runtime-launcher";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery, type DeliveryBoundary } from "./runtime-delivery";
import { OpenCodeAvailability, type OpenCodeEvent } from "./opencode-state";
import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";

type Options = Omit<
  Parameters<typeof enrollRuntime>[0],
  "host" | "hostSessionId" | "incarnation"
>;
type Enrollment = Awaited<ReturnType<typeof enrollRuntime>>;
type HostEvent = OpenCodeEvent;

/** Subscribe before taking the startup snapshot. The host's connected event is
 * emitted after its subscription is installed, so later mutations are queued.
 * Call without awaiting done from plugin initialization (host APIs need init). */
export function observeOpenCode(
  host: {
    subscribe(
      signal: AbortSignal,
    ): Promise<{ stream: AsyncIterable<HostEvent> }>;
    list(signal: AbortSignal): Promise<Array<{ id: string }>>;
    states(signal: AbortSignal): Promise<HostEvent[]>;
  },
  hooks: { event(input: { event: HostEvent }): Promise<void> },
  report: (state: "reconciled" | "disconnected") => void,
) {
  const controller = new AbortController();
  const backoff = [150, 500, 1500];
  const done = (async () => {
    for (let attempt = 0; !controller.signal.aborted; attempt++) {
      const connection = new AbortController();
      const signal = AbortSignal.any([controller.signal, connection.signal]);
      const startup = setTimeout(() => connection.abort(), 10000);
      startup.unref();
      let disposed = false;
      try {
        const { stream } = await host.subscribe(signal);
        for await (const event of stream) {
          if (signal.aborted) break;
          if (event.type === "server.connected") {
            clearTimeout(startup);
            await hooks.event({ event });
            const snapshotSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(10000),
            ]);
            const sessions = await host.list(snapshotSignal);
            for (const info of sessions) {
              snapshotSignal.throwIfAborted();
              await hooks.event({
                event: { type: "session.updated", properties: { info } },
              });
            }
            for (const event of await host.states(snapshotSignal)) {
              snapshotSignal.throwIfAborted();
              await hooks.event({ event });
            }
            snapshotSignal.throwIfAborted();
            await hooks.event({ event: { type: "swarm.snapshot.ready" } });
            report("reconciled");
          } else if (event.type === "server.instance.disposed") {
            disposed = true;
            await hooks.event({ event });
            break;
          } else await hooks.event({ event });
        }
      } catch {
        // Unknown connection/snapshot state defers delivery. Retry below is
        // bounded and never invokes a model or starts a replacement host.
      } finally {
        clearTimeout(startup);
        connection.abort();
        await hooks.event({ event: { type: "swarm.stream.disconnected" } });
        report("disconnected");
      }
      if (disposed || controller.signal.aborted || attempt >= backoff.length)
        return;
      await delay(backoff[attempt], undefined, { signal: controller.signal });
    }
  })().catch(() => {
    // Explicit stop aborts a pending backoff; state was already disconnected.
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
  hooks: {
    event(input: { event: HostEvent }): Promise<void>;
    configureWake?(api: OpencodeClient): void;
  },
  report: (state: "reconciled" | "disconnected") => void,
) {
  // The installed host's injected V1 SDK lacks permission/question listing.
  // Use the same-version public HTTP SDK; this is not a V2 plugin API change.
  const api = createOpencodeClient({
    baseUrl: input.serverUrl.href,
    directory: input.directory,
    headers: process.env.OPENCODE_SERVER_PASSWORD
      ? {
          Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
        }
      : undefined,
  });
  hooks.configureWake?.(api);
  let listedSessionIds: string[] = [];
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
        const sessions = await listOpenCodeSessions(
          api,
          input.directory,
          signal,
        );
        listedSessionIds = sessions.map((s) => s.id);
        return sessions;
      },
      states: async (signal) => {
        const requests = { signal, throwOnError: true as const };
        const [status, permissions, questions] = await Promise.all([
          api.session.status({ directory: input.directory }, requests),
          api.permission.list({ directory: input.directory }, requests),
          api.question.list({ directory: input.directory }, requests),
        ]);
        return [
          ...listedSessionIds.map((sessionID) => ({
            type: "session.status",
            properties: {
              sessionID,
              status: status.data[sessionID] ?? { type: "idle" },
            },
          })),
          ...permissions.data.map((properties) => ({
            type: "permission.asked",
            properties,
          })),
          ...questions.data.map((properties) => ({
            type: "question.asked",
            properties,
          })),
        ];
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
    errorCode?: string;
    errorOperation?: string;
  }) => void,
) {
  const incarnation = randomUUID();
  const sessions = new Map<string, Enrollment>();
  const pending = new Map<string, Promise<void>>();
  const deleted = new Set<string>();
  const deliveredCalls = new Map<string, Set<string>>();
  const availability = new OpenCodeAvailability();
  let wakeApi: OpencodeClient | undefined;
  const observers = new Map<string, ReturnType<typeof observeInbox>>();
  const reportError = (hostSessionId: string, error: unknown) => {
    const code = (error as { code?: unknown })?.code;
    const operation = (error as { syscall?: unknown })?.syscall;
    report({
      type: "error",
      hostSessionId,
      errorCode:
        typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code)
          ? code
          : "unknown",
      errorOperation:
        typeof operation === "string" &&
        /^[a-zA-Z0-9_. -]{1,120}$/.test(operation)
          ? operation
          : undefined,
    });
  };
  const startInbox = (id: string, session: Enrollment) => {
    if (!wakeApi || observers.has(id)) return;
    const endpoint = session.environment.SWARM_COORDINATOR_ENDPOINT;
    const capability = session.environment.SWARM_SESSION_CAPABILITY;
    const wake = new OpenCodeWake({
      api: wakeApi,
      actor: session.actor,
      scope: session.scope,
      hostSessionId: id,
      stateDirectory: options.stateDirectory,
      request: async (operation) => {
        const client = await CoordinationClient.connect(endpoint, capability);
        try {
          return await client.request(operation);
        } finally {
          client.close();
        }
      },
    });
    observers.set(
      id,
      observeInbox({
        endpoint,
        capability,
        ready: () => availability.observe(id).state === "idle",
        notify: (messageId, signal) => wake.notify(messageId, signal),
        failed: (error) => reportError(id, error),
      }),
    );
  };

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
      startInbox(id, session);
      report({ type: "enrolled", hostSessionId: id, actor: session.actor });
    }
    return session;
  };

  const publishAvailability = (id: string) =>
    serialize(id, async () => {
      const session = sessions.get(id);
      if (!session) return;
      const observed = availability.observe(id);
      const runtime =
        observed.state === "idle"
          ? "available"
          : ["busy", "blocked"].includes(observed.state)
            ? "busy"
            : "unavailable";
      const client = await CoordinationClient.connect(
        session.environment.SWARM_COORDINATOR_ENDPOINT,
        session.environment.SWARM_SESSION_CAPABILITY,
      );
      try {
        await client.request({
          op: "command",
          command: {
            id: randomUUID(),
            type: "session.observe",
            payload: { runtime },
          },
        });
      } finally {
        client.close();
      }
    }).catch((error) => reportError(id, error));

  const admit = async (
    id: string,
    key: string,
    boundary: DeliveryBoundary,
    append: (text: string) => void,
  ) => {
    await serialize(id, async () => {
      const calls = deliveredCalls.get(id) ?? new Set<string>();
      if (calls.has(key)) return;
      const session = await adopt(id);
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
            boundaries: [boundary],
            observe: () =>
              boundary === "tool_complete"
                ? availability.toolBoundary(id)
                : availability.observe(id),
            deliver: async (lease, _boundary, signal) => {
              if (
                signal.aborted ||
                deleted.has(id) ||
                ["blocked", "disconnected"].includes(
                  availability.observe(id).state,
                )
              )
                return "deferred";
              if (!wakeApi)
                throw new Error("OpenCode context API is unavailable");
              const alreadyPresent = await hasOpenCodeContext(
                wakeApi,
                id,
                lease.message,
                signal,
              );
              signal.throwIfAborted();
              const text = alreadyPresent
                ? "\n\nSwarm delivery lease renewed for a peer message already in this context. Use this token only after processing that message; do not repeat completed effects.\n" +
                  JSON.stringify({
                    messageId: lease.message.id,
                    leaseToken: lease.leaseToken,
                    leaseUntil: lease.leaseUntil,
                    attempt: lease.attempt,
                  })
                : OPENCODE_PEER_PREFIX +
                  JSON.stringify({
                    message: lease.message,
                    leaseToken: lease.leaseToken,
                    leaseUntil: lease.leaseUntil,
                  });
              append(text);
              return "admitted";
            },
          },
        );
        const result = await delivery.atBoundary(boundary);
        if (result.status !== "deferred") {
          calls.add(key);
          deliveredCalls.set(id, calls);
        }
      } finally {
        client.close();
      }
    });
  };

  return {
    configureWake(api: OpencodeClient) {
      wakeApi = api;
      for (const [id, session] of sessions) startInbox(id, session);
    },
    async "chat.message"(
      input: { sessionID: string; messageID?: string },
      output: {
        message: { id: string };
        parts: Array<{ type: string; text?: string }>;
      },
    ) {
      const part = output.parts.find(
        (part) => part.type === "text" && typeof part.text === "string",
      );
      if (!part) return;
      await admit(
        input.sessionID,
        `message:${output.message.id}`,
        "turn_start",
        (text) => {
          part.text += text;
        },
      );
    },
    observe: (id: string) => availability.observe(id),
    // OpenCode's event publisher does not await plugin callbacks. Handle every
    // rejection here; tool hooks below remain fail-closed and are awaited.
    async event({ event }: { event: HostEvent }) {
      availability.event(event);
      const globalState = [
        "server.connected",
        "swarm.snapshot.ready",
        "server.instance.disposed",
        "swarm.stream.disconnected",
      ].includes(event.type);
      const sessionState = [
        "session.status",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "question.replied",
        "question.rejected",
      ].includes(event.type);
      const observedIds = globalState
        ? [...sessions.keys()]
        : sessionState && event.properties?.sessionID
          ? [event.properties.sessionID]
          : [];
      await Promise.all(observedIds.map(publishAvailability));
      if (event.type === "server.instance.disposed") {
        for (const observer of observers.values()) observer.stop();
        observers.clear();
      } else if (event.type === "swarm.snapshot.ready") {
        for (const observer of observers.values()) observer.kick();
      } else if (
        event.type === "session.status" &&
        event.properties?.sessionID
      ) {
        observers.get(event.properties.sessionID)?.kick();
      }
      const id = event.properties?.info?.id;
      if (
        !id ||
        !["session.created", "session.updated", "session.deleted"].includes(
          event.type,
        )
      )
        return;
      if (event.type === "session.deleted") {
        deleted.add(id);
        observers.get(id)?.stop();
        observers.delete(id);
      }
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
      }).catch((error) => reportError(id, error));
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
      await admit(
        input.sessionID,
        `tool:${input.callID}`,
        "tool_complete",
        (text) => {
          if (typeof output.output === "string") output.output += text;
          else output.content!.push({ type: "text", text });
        },
      );
    },
  };
}
