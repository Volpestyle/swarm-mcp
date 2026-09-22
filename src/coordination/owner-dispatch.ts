import { z } from "zod";
import type { DispatchConfiguration } from "./core";
import type { CoordinationStore } from "./store";
import { existingPeerProvider } from "./dispatch-runner";
import { canonicalPath } from "./worktrees";
import { CoordinationError } from "./errors";

const id = z.string().min(1).max(128);
export const ownerDispatchSchema = z
  .object({
    maximum: z.number().int().min(0).max(64),
    observationMaxAgeMs: z.number().int().min(1).max(60000),
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
      new Set(config.peers.map((peer) => peer.id)).size !== config.peers.length
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
export type OwnerDispatch = z.infer<typeof ownerDispatchSchema>;

export function ownerDispatch(
  store: CoordinationStore,
  input: OwnerDispatch,
): DispatchConfiguration {
  const config = ownerDispatchSchema.parse(input);
  return (requester) => {
    const peers = config.peers.filter(
      (peer) => peer.worker.scope === requester.scope,
    );
    const routes = peers.map((peer) => {
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
    return {
      policy: {
        routes,
        maximum: config.maximum,
        active: 0,
        observationMaxAgeMs: config.observationMaxAgeMs,
      },
      providers: peers.map((peer) =>
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
    };
  };
}
