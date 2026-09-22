import { expect, test } from "bun:test";
import { OpenCodeAvailability } from "../src/coordination/opencode-state";

test("multiple host waits override status and a reply never authorizes idle wake", () => {
  const state = new OpenCodeAvailability();
  expect(state.observe("one").state).toBe("unsupported");
  state.event({
    type: "session.status",
    properties: { sessionID: "one", status: { type: "idle" } },
  });
  expect(state.observe("one").state).toBe("idle");
  for (const id of ["a", "a", "b"])
    state.event({
      type: "permission.asked",
      properties: { sessionID: "one", id },
    });
  state.event({
    type: "session.status",
    properties: { sessionID: "one", status: { type: "idle" } },
  });
  expect(state.toolBoundary("one").state).toBe("blocked");
  state.event({
    type: "permission.replied",
    properties: { sessionID: "one", requestID: "a" },
  });
  expect(state.observe("one").state).toBe("blocked");
  state.event({
    type: "permission.replied",
    properties: { sessionID: "one", requestID: "b" },
  });
  expect(state.observe("one").state).toBe("busy");
  state.event({ type: "swarm.stream.disconnected" });
  expect(state.toolBoundary("one").state).toBe("disconnected");
  state.event({ type: "server.connected" });
  expect(state.toolBoundary("one").state).toBe("unsupported");
  state.event({
    type: "session.status",
    properties: { sessionID: "one", status: { type: "retry" } },
  });
  state.event({ type: "swarm.snapshot.ready" });
  expect(state.observe("one").state).toBe("busy");
  state.event({ type: "session.deleted", properties: { info: { id: "one" } } });
  expect(state.observe("one").state).toBe("disconnected");
});

test("reconnection discards stale idle and rebuilds pending waits before delivery", () => {
  const state = new OpenCodeAvailability();
  state.event({
    type: "session.status",
    properties: { sessionID: "one", status: { type: "idle" } },
  });
  state.event({ type: "swarm.stream.disconnected" });
  state.event({ type: "server.connected" });
  expect(state.toolBoundary("one").state).toBe("unsupported");
  state.event({
    type: "permission.asked",
    properties: { sessionID: "one", id: "retained" },
  });
  state.event({ type: "swarm.snapshot.ready" });
  expect(state.toolBoundary("one").state).toBe("blocked");
});
