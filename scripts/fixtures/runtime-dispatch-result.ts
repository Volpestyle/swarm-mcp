import { CoordinationClient } from "../../src/coordination/ipc";
const [taskId, attemptId, fenceText, messageId, leaseToken] =
  process.argv.slice(2);
if (
  ![taskId, attemptId, fenceText, messageId, leaseToken].every((value) =>
    /^[a-zA-Z0-9-]+$/.test(value ?? ""),
  )
)
  throw new Error("Invalid fixture assignment");
const client = await CoordinationClient.connect(
  process.env.SWARM_COORDINATOR_ENDPOINT!,
  process.env.SWARM_SESSION_CAPABILITY!,
);
try {
  await client.request({
    op: "command",
    command: {
      id: `fixture-result-${attemptId}`,
      type: "task.finish",
      payload: {
        taskId: taskId!,
        attemptId: attemptId!,
        fence: Number(fenceText),
        outcome: "completed",
        result: {
          summary: "Native dispatch fixture completed",
          evidence: ["Actual OpenCode shell.env authenticated worker result"],
          limitations: ["Scripted local model endpoint"],
        },
      },
    },
  });
  await client.request({
    op: "command",
    command: {
      id: `fixture-ack-${messageId}`,
      type: "inbox.ack",
      payload: { messageId: messageId!, leaseToken: leaseToken! },
    },
  });
  console.log("swarm-dispatch-completed");
} finally {
  client.close();
}
