import { randomUUID } from "node:crypto";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { CoordinationStore } from "./store";
import type { SessionContext } from "./sessions";
import type { DispatchProvider } from "./dispatch-runner";
import { canonicalPath } from "./worktrees";

/** Trusted OpenCode child-session provider. Creation never submits a prompt;
 * the coordinator's atomic binding/inbox delivery admits work afterward. */
export function openCodeDispatchProvider(options: {
  store: CoordinationStore;
  requester: SessionContext;
  api: OpencodeClient;
  parentSessionId: string;
  directory: string;
  routeId: string;
  authorized: () => boolean;
  resolveWorker: (
    hostSessionId: string,
    signal: AbortSignal,
  ) => Promise<SessionContext | null>;
}): DispatchProvider {
  const { store, requester, api, routeId } = options;
  const resolve = async (externalId: string, signal: AbortSignal) => {
    const child = (
      await api.session.get(
        { sessionID: externalId, directory: options.directory },
        { signal, throwOnError: true },
      )
    ).data;
    if (
      child.id !== externalId ||
      child.parentID !== options.parentSessionId ||
      canonicalPath(child.directory) !== canonicalPath(options.directory) ||
      child.time.archived !== undefined
    )
      throw new Error(
        "Native child no longer matches the configured parent/workspace",
      );
    const worker = await options.resolveWorker(externalId, signal);
    if (!worker) return null;
    return { externalId, worker };
  };
  const lookup = (token: string) =>
    store.execute(
      {
        ...requester,
        id: randomUUID(),
        type: "dispatch.provisionLookup",
        payload: { token, routeId },
      },
      (tx) => tx.dispatch.provisionLookup(token, routeId),
    ).value;
  return {
    routeId,
    authorized: options.authorized,
    async start({ token, intent }, signal) {
      if (!options.authorized())
        throw new Error("Native launch authorization was revoked");
      if (
        canonicalPath(intent.contract.worktree) !==
        canonicalPath(options.directory)
      )
        throw new Error("Native workspace does not satisfy the contract");
      const parent = (
        await api.session.get(
          { sessionID: options.parentSessionId, directory: options.directory },
          { signal, throwOnError: true },
        )
      ).data;
      if (
        parent.id !== options.parentSessionId ||
        parent.time.archived !== undefined ||
        canonicalPath(parent.directory) !== canonicalPath(options.directory)
      )
        throw new Error(
          "Native parent is unavailable or outside the configured workspace",
        );
      signal.throwIfAborted();
      const child = (
        await api.session.create(
          {
            directory: options.directory,
            parentID: parent.id,
            title: intent.title,
            permission: parent.permission ?? [],
          },
          { signal, throwOnError: true },
        )
      ).data;
      // Persist the returned identity before waiting for plugin enrollment. If
      // create's response is lost, no title/label search can substitute for it.
      store.execute(
        {
          ...requester,
          id: randomUUID(),
          type: "dispatch.provisioned",
          payload: { token, externalId: child.id },
        },
        (tx) =>
          tx.dispatch.provisioned({
            intentId: intent.intentId,
            token,
            routeId,
            externalId: child.id,
          }),
      );
      const bound = await resolve(child.id, signal);
      if (!bound) throw new Error("Native child enrollment is pending");
      return bound;
    },
    async find(token, signal) {
      const record = lookup(token);
      return record?.externalId ? resolve(record.externalId, signal) : null;
    },
    async stop(token, signal) {
      const record = lookup(token);
      if (!record?.externalId) return { stopped: false };
      const child = await resolve(record.externalId, signal);
      if (!child) return { stopped: false };
      return store.execute(
        {
          ...requester,
          id: randomUUID(),
          type: "dispatch.peerStopped",
          payload: { token },
        },
        (tx) =>
          tx.dispatch.peerStopped({ token, routeId, worker: child.worker }),
      ).value;
    },
  };
}
