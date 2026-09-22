import { CoordinationClient } from "../../src/coordination/ipc";

const [recipient, taskId, attemptId, fenceText, messageId, leaseToken] = process.argv.slice(2);
if (![recipient, taskId, attemptId, fenceText, messageId, leaseToken]
  .every(value => /^[a-zA-Z0-9-]+$/.test(value ?? "")))
  throw new Error("Invalid mixed-host fixture input");
const client = await CoordinationClient.connect(
  process.env.SWARM_COORDINATOR_ENDPOINT!, process.env.SWARM_SESSION_CAPABILITY!,
);
try {
  await client.request({ op: "command", command: {
    id: `question-${attemptId}`, type: "message.send",
    payload: { recipient: recipient!, kind: "question", taskId: taskId!, threadId: taskId!,
      body: JSON.stringify({ taskId, attemptId, fence: Number(fenceText) }) },
  } });
  await client.request({ op: "command", command: {
    id: `assignment-ack-${messageId}`, type: "inbox.ack",
    payload: { messageId: messageId!, leaseToken: leaseToken! },
  } });
  console.log("swarm-mixed-question-sent");
} finally { client.close(); }
