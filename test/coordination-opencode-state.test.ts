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
  state.event({
    type: "session.status",
    properties: { sessionID: "one", status: { type: "retry" } },
  });
  expect(state.observe("one").state).toBe("busy");
  state.event({ type: "session.deleted", properties: { info: { id: "one" } } });
  expect(state.observe("one").state).toBe("disconnected");
});
