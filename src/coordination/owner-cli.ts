import { CoordinationStore } from "./store";
import { CoordinationCore } from "./core";
import { localEndpoint, serveCoordination } from "./ipc";
import { launcherEnrollment } from "./enrollment";
import { readOwnerConfig } from "./owner-config";
import { ownerDispatch } from "./owner-dispatch";

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error("Usage: swarm-coordinator-owner <private-config.json>");
  const config = readOwnerConfig(path);
  const store = await CoordinationStore.open({ path: config.databasePath });
  try {
    const service = await serveCoordination({
      endpoint: localEndpoint(config.databasePath),
      core: new CoordinationCore(
        store,
        config.dispatch ? ownerDispatch(store, config.dispatch) : undefined,
      ),
      authorize: (capability) => store.authorize(capability),
      enroll: launcherEnrollment(store, config.launcherSecret),
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await service.close();
      store.close();
    };
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
    console.log(
      JSON.stringify({ endpoint: service.endpoint, pid: process.pid }),
    );
  } catch (error) {
    store.close();
    throw error;
  }
}
main().catch((error) => {
  console.error("swarm coordinator owner:", error.message);
  process.exitCode = 1;
});
