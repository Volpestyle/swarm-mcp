import { CoordinationStore } from "../../src/coordination/store";
const [path, encoded, outcome = "completed"] = process.argv.slice(2);
const context = JSON.parse(encoded!);
const store = await CoordinationStore.open({ path: path! });
try {
  const fetched = store.execute(
    { ...context, id: "fetch-assignment", type: "inbox.fetch", payload: {} },
    (tx) => tx.inbox.fetch({ consumer: "node-peer" }),
  ).value;
  if (fetched.deliveries.length !== 1)
    throw new Error("Expected one assignment");
  const delivery = fetched.deliveries[0]!;
  if (
    delivery.message.kind !==
    (outcome === "cancelled" ? "task.cancel_requested" : "task.assigned")
  )
    throw new Error("Expected task assignment");
  const assignment = JSON.parse(delivery.message.body);
  store.execute(
    {
      ...context,
      id: "finish-assignment",
      type: "task.finish",
      payload: assignment,
    },
    (tx) =>
      tx.tasks.finish({
        taskId: assignment.taskId,
        attemptId: assignment.attemptId,
        fence: assignment.fence,
        outcome: outcome === "cancelled" ? "cancelled" : "completed",
        result:
          outcome === "cancelled"
            ? undefined
            : { objective: assignment.contract.objective },
      }),
  );
  store.execute(
    { ...context, id: "ack-assignment", type: "inbox.ack", payload: {} },
    (tx) =>
      tx.inbox.acknowledge({
        messageId: delivery.message.id,
        leaseToken: delivery.leaseToken,
      }),
  );
  console.log(
    JSON.stringify({
      taskId: assignment.taskId,
      attemptId: assignment.attemptId,
      acknowledged: true,
    }),
  );
} finally {
  store.close();
}
