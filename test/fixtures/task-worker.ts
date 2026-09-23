import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
const [path, capability, encoded, faultPoint] = process.argv.slice(2);
if (!path || !capability || !encoded)
  throw new Error("Missing worker arguments");
const store = await CoordinationStore.open({
  path,
  clock: () => 1000,
  fault: (point) => {
    if (point === faultPoint) process.exit(73);
  },
});
try {
  const result = new CoordinationCore(store).command(
    store.authorize(capability),
    JSON.parse(encoded),
  );
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify({ error: (error as { code: string }).code }));
} finally {
  store.close();
}
