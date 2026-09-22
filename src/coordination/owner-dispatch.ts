import { z } from "zod";
import type { DispatchConfiguration } from "./core";
import type { CoordinationStore } from "./store";
import { existingPeerProvider } from "./dispatch-runner";
import { canonicalPath } from "./worktrees";
import { CoordinationError } from "./errors";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { openCodeDispatchProvider } from "./opencode-dispatch";
import { retainedAgentId } from "./launcher-state";
import { isAbsolute } from "node:path";
import type { ExecutionRoute } from "./routing";

const id = z.string().min(1).max(128);
const identity = z
  .object({
    scope: id,
    actor: id,
    sessionId: id,
    generation: z.number().int().positive(),
  })
  .strict();
export const ownerDispatchSchema = z
  .object({
    maximum: z.number().int().min(0).max(64),
    observationMaxAgeMs: z.number().int().min(1).max(60000),
    opencode: z
      .array(
        z
          .object({
            id,
            parent: identity,
            parentSessionId: id,
            baseUrl: z
              .string()
              .url()
              .refine((value) =>
                ["http:", "https:"].includes(new URL(value).protocol),
              ),
            stateDirectory: z.string().max(4096).refine(isAbsolute),
            capabilities: z.array(id).max(64),
            durable: z.boolean(),
            capacity: z.number().int().min(0).max(64),
            overhead: z.number().nonnegative().finite(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    peers: z
      .array(
        z
          .object({
            id,
            worker: z
              .object({
                scope: id,
                actor: id,
                sessionId: id,
                generation: z.number().int().positive(),
              })
              .strict(),
            host: id,
            capabilities: z.array(id).max(64),
            durable: z.boolean(),
            capacity: z.number().int().min(0).max(64),
            overhead: z.number().nonnegative().finite(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set([...config.peers, ...config.opencode].map((peer) => peer.id))
        .size !==
      config.peers.length + config.opencode.length
    )
      context.addIssue({
        code: "custom",
        message: "Dispatch route IDs must be unique",
      });
    if (
      new Set(config.peers.map((peer) => peer.worker.sessionId)).size !==
      config.peers.length
    )
      context.addIssue({
        code: "custom",
        message: "A worker session may have only one route",
      });
  });
export type OwnerDispatch = z.input<typeof ownerDispatchSchema>;

export function ownerDispatch(
  store: CoordinationStore,
  input: OwnerDispatch,
): DispatchConfiguration {
  const config = ownerDispatchSchema.parse(input);
  return (requester) => {
    const peers = config.peers.filter(
      (peer) => peer.worker.scope === requester.scope,
    );
    const routes: ExecutionRoute[] = peers.map((peer) => {
      const session = store.session(requester.scope, peer.worker.sessionId);
      let worktree = "unavailable",
        current = false;
      try {
        worktree = canonicalPath(store.worktree(peer.worker).root);
        current = true;
      } catch (error) {
        if (!(error instanceof CoordinationError)) throw error;
      }
      return {
        id: peer.id,
        path: "peer" as const,
        scope: peer.worker.scope,
        host: peer.host,
        worktree,
        capabilities: peer.capabilities,
        durable: peer.durable,
        capacity: peer.capacity,
        overhead: peer.overhead,
        active: 0,
        authorized: current,
        availability:
          current && session?.runtime_state === "available"
            ? ("idle" as const)
            : ("disconnected" as const),
        observedAt: session?.runtime_at ?? 0,
      };
    });
    const native = config.opencode.filter(
      (route) => route.parent.scope === requester.scope,
    );
    const nativeProviders = native.map((route) => {
      let directory = "unavailable",
        current = false;
      try {
        directory = canonicalPath(store.worktree(route.parent).root);
        current = true;
      } catch (error) {
        if (!(error instanceof CoordinationError)) throw error;
      }
      const session = store.session(requester.scope, route.parent.sessionId);
      routes.push({
        id: route.id,
        path: "native",
        scope: requester.scope,
        host: "opencode",
        worktree: directory,
        capabilities: route.capabilities,
        durable: route.durable,
        capacity: route.capacity,
        overhead: route.overhead,
        active: 0,
        authorized: current,
        availability:
          current && session?.runtime_state !== "unavailable"
            ? "idle"
            : "disconnected",
        observedAt: session?.runtime_at ?? 0,
      });
      return openCodeDispatchProvider({
        store,
        requester,
        routeId: route.id,
        directory,
        parentSessionId: route.parentSessionId,
        api: createOpencodeClient({ baseUrl: route.baseUrl }),
        authorized: () => {
          try {
            store.assertContext(route.parent);
            return true;
          } catch {
            return false;
          }
        },
        resolveWorker: async (hostSessionId, signal) => {
          signal.throwIfAborted();
          const actor = await retainedAgentId(
            route.stateDirectory,
            requester.scope,
            "opencode",
            hostSessionId,
          );
          signal.throwIfAborted();
          const worker = actor
            ? store.currentSession(requester.scope, actor)
            : null;
          if (
            !worker ||
            canonicalPath(store.worktree(worker).root) !== directory
          )
            return null;
          return worker;
        },
      });
    });
    return {
      policy: {
        routes,
        maximum: config.maximum,
        active: 0,
        observationMaxAgeMs: config.observationMaxAgeMs,
      },
      providers: [
        ...nativeProviders,
        ...peers.map((peer) =>
          existingPeerProvider({
            store,
            requester,
            routeId: peer.id,
            worker: peer.worker,
            authorized: () => {
              try {
                store.assertContext(peer.worker);
                return true;
              } catch {
                return false;
              }
            },
          }),
        ),
      ],
    };
  };
}
