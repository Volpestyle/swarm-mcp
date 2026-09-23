import { CoordinationStore } from "../../src/coordination/store";
const [path, encoded] = process.argv.slice(2);
const { context, input, policy, begin } = JSON.parse(encoded!);
const store = await CoordinationStore.open({ path: path! });
try {
  const result = store.execute(
    {
      ...context,
      id: begin ? "begin" : "dispatch",
      type: begin ? "dispatch.begin" : "dispatch.reserve",
      payload: input,
    },
    (tx) =>
      begin
        ? tx.dispatch.begin(input.intentId)
        : tx.dispatch.reserve(input, policy),
  );
  console.log(JSON.stringify(result.value));
} finally {
  store.close();
}
