import { CoordinationStore } from "../../src/coordination/store";
const [path, encoded] = process.argv.slice(2);
const { context, input, policy } = JSON.parse(encoded!);
const store = await CoordinationStore.open({ path: path! });
try {
  const result = store.execute(
    { ...context, id: "dispatch", type: "dispatch.reserve", payload: input },
    (tx) => tx.dispatch.reserve(input, policy),
  );
  console.log(JSON.stringify(result.value));
} finally {
  store.close();
}
