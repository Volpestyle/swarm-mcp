import { expect, test } from "bun:test";
import { CodexLifecycle } from "../src/coordination/codex-lifecycle";
import type { Operation } from "../src/coordination/ipc";

test("Codex status distinguishes blocked from busy and never closes on disconnection", async () => {
  const operations: Operation[] = [];
  const lifecycle = new CodexLifecycle("native", async (op) => {
    operations.push(op);
  });
  const status = (value: unknown) =>
    lifecycle.notify("thread/status/changed", {
      threadId: "native",
      status: value,
    });
  await status({ type: "idle" });
  expect(lifecycle.observe().state).toBe("idle");
  await status({ type: "active", activeFlags: [] });
  expect(lifecycle.observe().state).toBe("busy");
  await status({ type: "active", activeFlags: ["waitingOnApproval"] });
  expect(lifecycle.observe().state).toBe("blocked");
  await status({ type: "active", activeFlags: ["futureFlag"] });
  expect(lifecycle.observe().state).toBe("unsupported");
  await status({ type: "notLoaded" });
  await lifecycle.disconnected();
  await lifecycle.notify("thread/archived", { threadId: "other" });
  expect(
    operations.every(
      (op) => op.op === "command" && op.command.type === "session.observe",
    ),
  ).toBe(true);
  await lifecycle.notify("thread/archived", { threadId: "native" });
  await status({ type: "idle" });
  await lifecycle.notify("thread/closed", { threadId: "native" });
  expect(
    operations.filter(
      (op) => op.op === "command" && op.command.type === "session.close",
    ),
  ).toHaveLength(1);
  expect(lifecycle.observe().state).toBe("disconnected");
});
