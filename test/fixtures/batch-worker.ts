import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
const [path, point] = process.argv.slice(2);
const store = await CoordinationStore.open({
  path: path!,
  fault: (at) => {
    if (at === point) process.exit(73);
  },
});
const core = new CoordinationCore(store);
const results = core.commandBatch(
  [0, 1].map((index) => ({
    context: { scope: "test", actor: "alice" },
    command: {
      id: `batch-${index}`,
      type: "task.create" as const,
      payload: { title: `work-${index}` },
    },
  })),
);
console.log(JSON.stringify(results));
store.close();
