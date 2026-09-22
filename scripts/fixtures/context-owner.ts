import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
import { localEndpoint, serveCoordination } from "../../src/coordination/ipc";

const [path, rawCount] = process.argv.slice(2);
if (!path) throw new Error("Missing disposable database path");
const count = Number(rawCount);
if (![2, 8, 32].includes(count)) throw new Error("Invalid agent count");
const store = await CoordinationStore.open({ path });
const capabilities = Array.from(
  { length: count },
  (_, agent) =>
    store.openSession({
      scope: "measurement",
      agentId: `agent-${agent}`,
      requestId: `enroll-${agent}`,
      resumeToken: randomBytes(32).toString("hex"),
      worktree: { root: dirname(path), repository: dirname(path) },
    }).capability,
);
const service = await serveCoordination({
  endpoint: localEndpoint(path),
  core: new CoordinationCore(store),
  authorize: (capability) => store.authorize(capability),
});
console.log(JSON.stringify({ endpoint: service.endpoint, capabilities }));
process.on("SIGTERM", async () => {
  await service.close();
  store.close();
  process.exit(0);
});
