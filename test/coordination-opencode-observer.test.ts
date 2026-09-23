import { expect, test } from "bun:test";
import { observeOpenCode } from "../src/coordination/opencode-plugin";

test("observer bounds repeated snapshot failure and never reports readiness", async () => {
  let subscriptions = 0;
  const reports: string[] = [];
  const observer = observeOpenCode(
    {
      async subscribe() {
        subscriptions++;
        return {
          stream: (async function* () {
            yield { type: "server.connected" };
          })(),
        };
      },
      async list() {
        throw new Error("snapshot unavailable");
      },
      async states() {
        throw new Error("must not reach state snapshot");
      },
    },
    { async event() {} },
    (state) => reports.push(state),
  );
  await observer.done;
  expect(subscriptions).toBe(4);
  expect(reports).toEqual(Array(4).fill("disconnected"));
});

test("host disposal is terminal even after successful reconciliation", async () => {
  let subscriptions = 0;
  const reports: string[] = [];
  const observer = observeOpenCode(
    {
      async subscribe() {
        subscriptions++;
        return {
          stream: (async function* () {
            yield { type: "server.connected" };
            yield { type: "server.instance.disposed" };
          })(),
        };
      },
      async list() {
        return [];
      },
      async states() {
        return [];
      },
    },
    { async event() {} },
    (state) => reports.push(state),
  );
  await observer.done;
  expect(subscriptions).toBe(1);
  expect(reports).toEqual(["reconciled", "disconnected"]);
});

test("explicit stop cancels reconnect without starting another subscription", async () => {
  let subscriptions = 0;
  const observer = observeOpenCode(
    {
      async subscribe() {
        subscriptions++;
        return { stream: (async function* () {})() };
      },
      async list() {
        return [];
      },
      async states() {
        return [];
      },
    },
    { async event() {} },
    () => queueMicrotask(() => observer.stop()),
  );
  await observer.done;
  expect(subscriptions).toBe(1);
});
