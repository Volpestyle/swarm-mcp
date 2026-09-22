import { expect, test } from "bun:test";
import { changedResources } from "../src/coordination/notifications";
import type { Event, Json } from "../src/coordination/store";
const event = (type: string, payload: Json): Event => ({
  id: 1,
  scope: "test",
  actor: "sender",
  type,
  entity_id: "entity",
  payload,
  created_at: 1,
});

test("notification hints never forward another recipient's inbox activity", () => {
  const events = [
    event("message.accepted", { recipients: ["bob"] }),
    event("delivery.leased", { recipient: "bob" }),
    event("task.claimed", {}),
    event("task.progress", {}),
  ];
  expect(changedResources(events, "alice")).toEqual(["swarm://tasks"]);
  expect(changedResources(events, "bob")).toEqual([
    "swarm://inbox",
    "swarm://tasks",
  ]);
  expect(
    changedResources(
      [
        event("message.accepted", { recipients: ["alice", "bob"] }),
        event("delivery.acknowledged", { recipient: "alice" }),
      ],
      "alice",
    ),
  ).toEqual(["swarm://inbox"]);
  expect(changedResources([event("unknown", null)], "alice")).toEqual([]);
});
