import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
import { CoordinationError } from "../../src/coordination/errors";
import {
  CoordinationClient,
  localEndpoint,
  serveCoordination,
} from "../../src/coordination/ipc";
const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Missing fixture path");
const store = await CoordinationStore.open({ path });
const options = {
  endpoint: localEndpoint(path),
  core: new CoordinationCore(store),
  authorize: (capability: string) => {
    if (capability === "alice-secret") return { scope: "test", actor: "alice" };
    if (capability === "bob-secret") return { scope: "other", actor: "bob" };
    throw new CoordinationError("unauthorized", "Invalid capability");
  },
};
const service = await serveCoordination(options);
if (mode === "duplicate") {
  let code = "unexpected_success";
  try {
    const duplicate = await serveCoordination(options);
    await duplicate.close();
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? "unknown";
  }
  console.log(JSON.stringify({ code }));
  await service.close();
  store.close();
} else if (mode === "roundtrip") {
  const client = await CoordinationClient.connect(
    service.endpoint,
    "alice-secret",
  );
  const result = await client.request({
    op: "command",
    command: {
      id: "node-command",
      type: "task.create",
      payload: { title: "Node client" },
    },
  });
  console.log(JSON.stringify(result));
  client.close();
  await service.close();
  store.close();
} else {
  console.log(JSON.stringify({ endpoint: service.endpoint }));
  process.on("SIGTERM", async () => {
    await service.close();
    store.close();
    process.exit(0);
  });
}
