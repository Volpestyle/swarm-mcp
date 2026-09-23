import { expect, test } from "bun:test";
import {
  selectExecutionRoute,
  type ExecutionRoute,
} from "../src/coordination/routing";

const native: ExecutionRoute = {
  id: "native",
  path: "native",
  scope: "personal",
  host: "codex",
  worktree: "/work",
  capabilities: ["code"],
  durable: false,
  availability: "idle",
  observedAt: 1000,
  active: 0,
  capacity: 2,
  overhead: 1,
  authorized: true,
};
const peer: ExecutionRoute = {
  ...native,
  id: "peer",
  path: "peer",
  host: "claude",
  durable: true,
  capabilities: ["code", "render"],
  overhead: 3,
};
const requirement = {
  scope: "personal",
  worktree: "/work",
  capabilities: ["code"],
  durable: false,
};
const budget = { active: 0, maximum: 2, observationMaxAgeMs: 100 };

test("routing chooses the least overhead path meeting lifetime, host and capability constraints", () => {
  expect(
    selectExecutionRoute(requirement, [peer, native], budget, 1000),
  ).toEqual({ status: "selected", routeId: "native", path: "native" });
  expect(
    selectExecutionRoute(
      { ...requirement, durable: true },
      [native, peer],
      budget,
      1000,
    ),
  ).toEqual({ status: "selected", routeId: "peer", path: "peer" });
  expect(
    selectExecutionRoute(
      { ...requirement, capabilities: ["render"] },
      [native, peer],
      budget,
      1000,
    ),
  ).toEqual({ status: "selected", routeId: "peer", path: "peer" });
  expect(
    selectExecutionRoute(
      requirement,
      [{ ...peer, overhead: 0 }, native],
      budget,
      1000,
    ),
  ).toEqual({ status: "selected", routeId: "peer", path: "peer" });
});

test("routing preserves blockers and refuses stale, unauthorized and cross-scope candidates", () => {
  const result = selectExecutionRoute(
    requirement,
    [
      { ...native, scope: "other" },
      { ...peer, authorized: false, observedAt: 100, availability: "blocked" },
    ],
    budget,
    1000,
  );
  expect(result).toEqual({
    status: "blocked",
    reasons: ["availability:blocked", "stale_availability", "unauthorized"],
  });
  expect(
    selectExecutionRoute(
      { ...requirement, capabilities: ["missing"] },
      [native],
      budget,
      1000,
    ),
  ).toEqual({ status: "blocked", reasons: ["capability:missing"] });
  expect(
    selectExecutionRoute(requirement, [native], { ...budget, active: 2 }, 1000),
  ).toEqual({ status: "blocked", reasons: ["concurrency_budget"] });
  expect(
    selectExecutionRoute(requirement, [{ ...native, active: 2 }], budget, 1000),
  ).toEqual({ status: "blocked", reasons: ["route_capacity"] });
  expect(() =>
    selectExecutionRoute(requirement, [native, native], budget, 1000),
  ).toThrow("Duplicate route identity");
});
