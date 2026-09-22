import { CoordinationStore } from "../../src/coordination/store";
import {
  CoordinationCore,
  type CoreCommand,
} from "../../src/coordination/core";
const [path, encoded, timestamp, crash] = process.argv.slice(2);
if (!path || !encoded || !timestamp)
  throw new Error("Missing worker arguments");
const store = await CoordinationStore.open({
  path,
  clock: () => Number(timestamp),
  fault: (point) => {
    if (point === crash) process.exit(73);
  },
});
const result = new CoordinationCore(store).command(
  { scope: "test", actor: "bob" },
  JSON.parse(encoded) as CoreCommand,
);
console.log(JSON.stringify(result));
store.close();
