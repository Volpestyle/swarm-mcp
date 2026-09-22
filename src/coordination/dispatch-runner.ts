import { randomUUID } from "node:crypto";
import { CoordinationStore, type Json } from "./store";
import type { SessionContext } from "./sessions";
import type { DispatchIntent, DispatchPolicy } from "./dispatch";

export interface ProvisionedWorker {
  externalId: string;
  worker: SessionContext;
}
/** Trusted provider: resolve the exact persisted token, never a role-label match.
 * start may provision a worker only under inherited launcher authorization.
 * find returning null is uncertainty, not permission for another start. */
export interface DispatchProvider {
  routeId: string;
  authorized(): boolean;
  start(
    input: { token: string; taskId: string; intent: DispatchIntent },
    signal: AbortSignal,
  ): Promise<ProvisionedWorker>;
  find(token: string, signal: AbortSignal): Promise<ProvisionedWorker | null>;
}

async function bounded<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Provider outcome is uncertain"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Trusted launcher entrypoint, not an unprivileged agent tool. All external
 * work occurs after the provisioning receipt commits and outside SQLite locks. */
export async function runDispatchIntent(options: {
  store: CoordinationStore;
  requester: SessionContext;
  intent: DispatchIntent;
  policy: DispatchPolicy;
  providers: readonly DispatchProvider[];
  timeoutMs?: number;
}) {
  const { store, requester, intent, policy } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error("Dispatch provider timeout must be 1..60000 ms");
  const reserved = store.execute(
    {
      ...requester,
      id: randomUUID(),
      type: "dispatch.reserve",
      payload: intent as unknown as Json,
    },
    (tx) => tx.dispatch.reserve(intent, policy),
  ).value;
  if (reserved.status === "blocked") return reserved;
  if (!("routeId" in reserved))
    throw new Error("Dispatch reservation has no route");
  const matches = options.providers.filter(
    (provider) => provider.routeId === reserved.routeId,
  );
  if (matches.length !== 1)
    return {
      status: "blocked",
      reasons: ["provider_unavailable"],
      taskId: reserved.taskId,
    };
  const provider = matches[0]!;
  if (
    !provider.authorized() ||
    !policy.routes.some(
      (route) =>
        route.id === reserved.routeId &&
        route.scope === requester.scope &&
        route.authorized,
    )
  )
    return {
      status: "blocked",
      reasons: ["unauthorized"],
      taskId: reserved.taskId,
    };
  const begun = store.execute(
    {
      ...requester,
      id: randomUUID(),
      type: "dispatch.begin",
      payload: { intentId: intent.intentId },
    },
    (tx) => tx.dispatch.begin(intent.intentId),
  );
  const provision = begun.value;
  if (!provision.token) throw new Error("Dispatch has no provisioning token");
  let external: ProvisionedWorker | null;
  try {
    external = await bounded(timeoutMs, (signal) =>
      !begun.replayed && provision.start
        ? provider.start(
            { token: provision.token!, taskId: provision.taskId, intent },
            signal,
          )
        : provider.find(provision.token!, signal),
    );
  } catch {
    return {
      status: "uncertain",
      taskId: provision.taskId,
      routeId: provision.routeId,
    };
  }
  if (!external)
    return {
      status: "uncertain",
      taskId: provision.taskId,
      routeId: provision.routeId,
    };
  // bind validates route, current worker session, scope and the recorded token.
  const binding = {
    intentId: intent.intentId,
    token: provision.token,
    routeId: provision.routeId,
    externalId: external.externalId,
    worker: external.worker,
  };
  const bound = store.execute(
    { ...requester, id: randomUUID(), type: "dispatch.bind", payload: binding },
    (tx) => tx.dispatch.bind(binding),
  ).value;
  return { status: "bound", ...bound };
}
