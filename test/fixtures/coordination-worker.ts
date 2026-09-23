import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
const [path, action] = process.argv.slice(2);
if (!path) throw new Error("Missing fixture path");
const store = await CoordinationStore.open({
  path,
  fault: (point) => {
    if (action === point) process.exit(73);
  },
});
if (action !== "open") {
  new CoordinationCore(store).command(
    { scope: "test", actor: "alice" },
    {
      id: "shared-command",
      type: "task.create",
      payload: { title: "durable work" },
    },
  );
}
console.log(JSON.stringify(store.events("test")));
store.close();
