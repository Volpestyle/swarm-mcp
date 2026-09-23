import { CoordinationClient } from "./ipc";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

type Options = {
  endpoint: string;
  capability: string;
  ready: () => boolean;
  notify: (
    messageId: string,
    signal: AbortSignal,
  ) => Promise<{ status: "accepted" | "deferred" | "uncertain" } | void>;
  failed: (error?: unknown) => void;
};

/** Reconnect transports with the existing capability; never reenroll, start an
 * owner, or replace a fenced session. Each attempt snapshots the durable inbox. */
export function observeInbox(options: Options) {
  const lifetime = new AbortController();
  const backoff = [150, 500, 1500];
  let current: ReturnType<typeof observeConnection> | undefined;
  const done = (async () => {
    for (let attempt = 0; !lifetime.signal.aborted; attempt++) {
      let failure: unknown;
      current = observeConnection({
        ...options,
        failed(error) {
          failure = error;
          options.failed(error);
        },
      });
      await current.done;
      const code = (failure as { code?: string } | undefined)?.code;
      if (
        lifetime.signal.aborted ||
        attempt >= backoff.length ||
        !code ||
        ![
          "disconnected",
          "timeout",
          "ECONNRESET",
          "EPIPE",
          "ENOENT",
          "ECONNREFUSED",
        ].includes(code)
      )
        return;
      await delay(backoff[attempt], undefined, { signal: lifetime.signal });
    }
  })().catch((error) => {
    if (!lifetime.signal.aborted) options.failed(error);
  });
  return {
    done,
    kick: () => current?.kick(),
    stop() {
      lifetime.abort();
      current?.stop();
    },
  };
}

/** Runtime-side observer: held event waits consume no model calls. The inbox
 * remains authoritative; notifications only cause a fresh read and wake check. */
function observeConnection(options: Options) {
  let stopped = false;
  const controller = new AbortController();
  let events: CoordinationClient | undefined;
  let reads: CoordinationClient | undefined;
  let dirty = false;
  let scanning: Promise<void> | undefined;
  let retryAt = Infinity;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (at: number) => {
    if (at >= retryAt) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryAt = at;
    retryTimer = setTimeout(
      () => {
        retryAt = Infinity;
        retryTimer = undefined;
        kick();
      },
      Math.min(2147483647, Math.max(1, at - Date.now())),
    );
  };
  const kick = () => {
    dirty = true;
    if (scanning || !reads || stopped) return;
    scanning = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        if (!options.ready()) continue;
        let cursor = 0;
        let wakeAccepted = false;
        for (;;) {
          if (stopped || !options.ready()) break;
          // One bounded envelope per frame; terminal history stays in SQLite.
          const page = (await reads!.request({
            op: "inbox",
            cursor,
            limit: 1,
            activeOnly: true,
          })) as {
            items: Array<{
              message: { id: string };
              state: string;
              nextAttemptAt?: number;
              expiresAt?: number | null;
              leaseUntil?: number | null;
            }>;
            cursor: number;
          };
          if (!page.items.length) break;
          const now = Date.now();
          const due = page.items.some(
            (item) =>
              (item.expiresAt != null && item.expiresAt <= now) ||
              (item.state === "leased" &&
                item.leaseUntil != null &&
                item.leaseUntil <= now),
          );
          if (due) {
            // Recovery changes only this authenticated recipient's deliveries.
            // The coordinator applies retry backoff and attempt/TTL limits.
            await reads!.request({
              op: "command",
              command: { id: randomUUID(), type: "inbox.sweep", payload: {} },
            });
            dirty = true;
            break;
          }
          for (const item of page.items) {
            if (item.expiresAt != null) schedule(item.expiresAt);
            if (item.state === "leased" && item.leaseUntil != null)
              schedule(item.leaseUntil);
          }
          const pending = page.items.find((item) => {
            if (
              item.state !== "pending" ||
              (item.expiresAt != null && item.expiresAt <= Date.now())
            )
              return false;
            if ((item.nextAttemptAt ?? 0) > Date.now()) {
              schedule(item.nextAttemptAt!);
              return false;
            }
            return true;
          });
          if (pending && !wakeAccepted) {
            let failure: unknown;
            const result = await options
              .notify(pending.message.id, controller.signal)
              .catch((error) => {
                failure = error;
                return { status: "uncertain" as const };
              });
            // Diagnostic self-report only; it never leases or acknowledges work.
            // Awaiting the same connection retains correlation with this session.
            await reads!.request({
              op: "command",
              command: {
                id: randomUUID(),
                type: "inbox.wake_observed",
                payload: {
                  messageId: pending.message.id,
                  status: result?.status ?? "uncertain",
                },
              },
            });
            if (failure) throw failure;
            // An uncertain hint must not starve unrelated work. Once a wake is
            // accepted (or the host defers), continue deadline maintenance but
            // do not request more turns in this scan. Recheck readiness above.
            wakeAccepted = result?.status !== "uncertain";
          }
          if (page.cursor <= cursor)
            throw new Error("Inbox cursor did not advance");
          cursor = page.cursor;
        }
      }
    })()
      .catch((error) => {
        if (!stopped) {
          options.failed(error);
          stopped = true;
          controller.abort();
          events?.close();
          reads?.close();
        }
      })
      .finally(() => {
        scanning = undefined;
      });
  };
  const done = (async () => {
    events = await CoordinationClient.connect(
      options.endpoint,
      options.capability,
    );
    if (stopped) return;
    reads = await CoordinationClient.connect(
      options.endpoint,
      options.capability,
    );
    if (stopped) return;
    const snapshot = (await reads.request({ op: "bootstrap" })) as {
      eventCursor: number;
    };
    let cursor = snapshot.eventCursor;
    kick();
    while (!stopped) {
      const page = (await events.request({
        op: "watch",
        cursor,
        timeoutMs: 30000,
        limit: 20,
      })) as { items: Array<{ type?: string }>; cursor: number };
      cursor = page.cursor;
      // Our own telemetry must not form an endless wake/watch feedback loop.
      if (page.items.some((item) => item.type !== "runtime.wake")) kick();
    }
  })()
    .catch((error) => {
      if (!stopped) options.failed(error);
    })
    .finally(async () => {
      stopped = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      events?.close();
      reads?.close();
      await scanning;
    });
  return {
    done,
    kick,
    stop() {
      stopped = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      events?.close();
      reads?.close();
    },
  };
}
