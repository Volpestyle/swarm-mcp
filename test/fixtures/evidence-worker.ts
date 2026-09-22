import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
const [path, capability, input, crash] = process.argv.slice(2);
if (!path || !capability || !input) throw new Error("Missing worker arguments");
const store = await CoordinationStore.open({
  path,
  clock: () => 1000,
  fault: (point) => {
    if (point === crash) process.exit(73);
  },
});
console.log(
  JSON.stringify(
    await new CoordinationCore(store).importArtifact(
      store.authorize(capability),
      JSON.parse(input),
    ),
  ),
);
store.close();
