import { CoordinationClient } from "./ipc";
import { setTimeout as delay } from "node:timers/promises";

type Options = {
  endpoint: string;
  capability: string;
  ready: () => boolean;
  notify: (messageId: string, signal: AbortSignal) => Promise<unknown>;
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
        for (;;) {
          if (stopped || !options.ready()) break;
          // One bounded envelope per frame; old history is read, never leased.
          const page = (await reads!.request({
            op: "inbox",
            cursor,
            limit: 1,
          })) as {
            items: Array<{
              message: { id: string };
              state: string;
              nextAttemptAt?: number;
              expiresAt?: number | null;
            }>;
            cursor: number;
          };
          if (!page.items.length) break;
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
          if (pending) {
            await options.notify(pending.message.id, controller.signal);
            break;
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
      })) as { items: unknown[]; cursor: number };
      cursor = page.cursor;
      if (page.items.length) kick();
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
