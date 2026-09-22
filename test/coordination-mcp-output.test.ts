import { expect, test } from "bun:test";
import { outputSchema } from "../src/coordination/mcp-output";

test("success schemas require receipt metadata and reject error-only results", () => {
  const schema = outputSchema("swarm_assign");
  expect(
    schema.safeParse({
      ok: true,
      data: { value: { task: { id: "task" } }, cursor: 1, replayed: false },
      error: null,
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      ok: true,
      data: { value: {}, replayed: false },
      error: null,
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ok: false,
      data: null,
      error: { code: "conflict", message: "Claim lost", retryable: false },
    }).success,
  ).toBe(false);
});

test("wait schema requires a resumable reference and a recognized outcome", () => {
  const data = {
    taskId: "task",
    uri: "swarm://tasks/task",
    waitState: "timeout",
    task: { id: "task", status: "running", version: 2 },
  };
  const schema = outputSchema("swarm_wait");
  expect(schema.safeParse({ ok: true, data, error: null }).success).toBe(true);
  expect(
    schema.safeParse({
      ok: true,
      data: { ...data, uri: undefined },
      error: null,
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      ok: true,
      data: { ...data, waitState: "cancelled_by_timeout" },
      error: null,
    }).success,
  ).toBe(false);
});
