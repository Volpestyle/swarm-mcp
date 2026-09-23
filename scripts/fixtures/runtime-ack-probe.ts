import { CoordinationClient } from "../../src/coordination/ipc";
const [messageId, leaseToken] = process.argv.slice(2);
if (
  ![messageId, leaseToken].every((value) => /^[a-zA-Z0-9-]+$/.test(value ?? ""))
)
  throw new Error("Invalid fixture lease");
const client = await CoordinationClient.connect(
  process.env.SWARM_COORDINATOR_ENDPOINT!,
  process.env.SWARM_SESSION_CAPABILITY!,
);
try {
  await client.request({
    op: "command",
    command: {
      id: `fixture-ack-${messageId}`,
      type: "inbox.ack",
      payload: { messageId, leaseToken },
    },
  });
  console.log("swarm-fixture-acknowledged");
} finally {
  client.close();
}
