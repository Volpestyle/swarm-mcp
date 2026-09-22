import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import {
  RuntimeDelivery,
  type RuntimeAdapter,
  type RuntimeDeliveryLease,
  type RuntimeState,
} from "../src/coordination/runtime-delivery";
const stores: CoordinationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  let now = 1000;
  const store = await CoordinationStore.open({
    path: join(mkdtempSync(join(tmpdir(), "runtime-delivery-")), "db"),
    clock: () => now,
  });
  stores.push(store);
  const core = new CoordinationCore(store);
  const sender = { scope: "test", actor: "alice" },
    recipient = { scope: "test", actor: "bob" };
  const sent = core.command(sender, {
    id: "send",
    type: "message.send",
    payload: { recipient: "bob", kind: "question", body: "durable request" },
  }) as any;
  let state: RuntimeState = "idle",
    wakeCalls = 0;
  const admitted: RuntimeDeliveryLease[] = [];
  const adapter: RuntimeAdapter = {
    name: "test-host",
    boundaries: ["turn_start"],
    observe: () => ({ state, evidence: "test boundary", observedAt: now }),
    deliver: async (lease) => {
      admitted.push(lease);
      return "admitted";
    },
    wake: async () => {
      wakeCalls++;
      return true;
    },
  };
  const request = async (operation: any) =>
    operation.op === "command"
      ? core.command(recipient, operation.command)
      : core.messageStatus(recipient, operation.messageId);
  const runtime = new RuntimeDelivery("bob", request, adapter, () => now);
  return {
    core,
    recipient,
    messageId: sent.value.messageId as string,
    runtime,
    adapter,
    admitted,
    wakeCalls: () => wakeCalls,
    state: (value: RuntimeState) => {
      state = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    request,
  };
}

test("only committed pending work wakes an idle peer; duplicate hints coalesce", async () => {
  const f = await fixture();
  for (const state of [
    "busy",
    "blocked",
    "disconnected",
    "unsupported",
  ] as const) {
    f.state(state);
    expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
    expect(await f.runtime.atBoundary("turn_start")).toEqual({
      status: "deferred",
    });
  }
  expect(f.wakeCalls()).toBe(0);
  f.state("idle");
  await Promise.all([
    f.runtime.notifyAccepted(f.messageId),
    f.runtime.notifyAccepted(f.messageId),
  ]);
  expect(f.wakeCalls()).toBe(1);
  expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
  const missing = await f.runtime
    .notifyAccepted("not-persisted")
    .catch((error) => error);
  expect(missing.code).toBe("not_found");
  expect(f.wakeCalls()).toBe(1);
});

test("host admission does not acknowledge processing and concurrent boundaries share one lease", async () => {
  const f = await fixture();
  expect(await f.runtime.atBoundary("tool_complete")).toEqual({
    status: "deferred",
  });
  const results = await Promise.all([
    f.runtime.atBoundary("turn_start"),
    f.runtime.atBoundary("turn_start"),
  ]);
  expect(results).toEqual([
    { status: "admitted", messageId: f.messageId },
    { status: "admitted", messageId: f.messageId },
  ]);
  expect(f.admitted).toHaveLength(1);
  expect(
    f.core.messageStatus(f.recipient, f.messageId).deliveries[0]!.state,
  ).toBe("leased");
  const lease = f.admitted[0]!;
  f.core.command(f.recipient, {
    id: "processed",
    type: "inbox.ack",
    payload: { messageId: f.messageId, leaseToken: lease.leaseToken },
  });
  expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
  expect(await f.runtime.atBoundary("turn_start")).toEqual({ status: "empty" });
});

test("wake failure and uncertain admission retain work for recovery", async () => {
  const f = await fixture();
  let attempts = 0;
  f.adapter.wake = async () => {
    attempts++;
    throw new Error("Host unavailable");
  };
  expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
  expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
  expect(attempts).toBe(1);
  f.advance(1001);
  expect(await f.runtime.notifyAccepted(f.messageId)).toBe(false);
  expect(attempts).toBe(2);
  f.adapter.deliver = async () => {
    throw new Error("Unknown admission outcome");
  };
  expect(await f.runtime.atBoundary("turn_start")).toEqual({
    status: "uncertain",
    messageId: f.messageId,
  });
  expect(
    f.core.messageStatus(f.recipient, f.messageId).deliveries[0]!.state,
  ).toBe("leased");
  f.advance(31000);
  f.adapter.deliver = async (lease) => {
    f.admitted.push(lease);
    return "admitted";
  };
  const resumed = new RuntimeDelivery("bob", f.request, f.adapter);
  expect(await resumed.atBoundary("turn_start")).toEqual({
    status: "admitted",
    messageId: f.messageId,
  });
  expect(f.admitted[0]!.attempt).toBe(2);
});

test("stalled host admission times out without acknowledging or losing the lease", async () => {
  const f = await fixture();
  let signal: AbortSignal | undefined;
  f.adapter.deliver = async (_lease, _boundary, receivedSignal) => {
    signal = receivedSignal;
    return new Promise(() => {});
  };
  const runtime = new RuntimeDelivery("bob", f.request, f.adapter, Date.now, 5);
  expect(await runtime.atBoundary("turn_start")).toEqual({
    status: "uncertain",
    messageId: f.messageId,
  });
  expect(signal?.aborted).toBe(true);
  expect(
    f.core.messageStatus(f.recipient, f.messageId).deliveries[0]!.state,
  ).toBe("leased");
});

test("busy turns admit only at a supported post-tool boundary without waking", async () => {
  const f = await fixture();
  f.state("busy");
  const adapter: RuntimeAdapter = {
    ...f.adapter,
    boundaries: ["tool_complete"],
  };
  const runtime = new RuntimeDelivery("bob", f.request, adapter);
  expect(await runtime.notifyAccepted(f.messageId)).toBe(false);
  expect(await runtime.atBoundary("turn_start")).toEqual({
    status: "deferred",
  });
  expect(await runtime.atBoundary("tool_complete")).toEqual({
    status: "admitted",
    messageId: f.messageId,
  });
  expect(f.wakeCalls()).toBe(0);
});

test("explicit host deferral requeues the lease and preserves a delivery backlog", async () => {
  const f = await fixture();
  f.core.command(
    { scope: "test", actor: "alice" },
    {
      id: "second",
      type: "message.send",
      payload: {
        recipient: "bob",
        kind: "question",
        body: "second durable request",
      },
    },
  );
  f.adapter.deliver = async () => "deferred";
  expect(await f.runtime.atBoundary("turn_start")).toEqual({
    status: "deferred",
    messageId: f.messageId,
  });
  expect(
    f.core.messageStatus(f.recipient, f.messageId).deliveries[0]!.state,
  ).toBe("pending");
  f.adapter.deliver = async (lease) => {
    f.admitted.push(lease);
    return "admitted";
  };
  expect((await f.runtime.atBoundary("turn_start")).status).toBe("admitted");
  expect(f.admitted[0]!.message.body).toBe("second durable request");
  f.advance(1001);
  expect(await f.runtime.atBoundary("turn_start")).toEqual({
    status: "admitted",
    messageId: f.messageId,
  });
});
