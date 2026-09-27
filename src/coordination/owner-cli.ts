import { CoordinationStore } from "./store";
import { CoordinationCore } from "./core";
import { localEndpoint, serveCoordination } from "./ipc";
import { launcherEnrollment, launcherCredential } from "./enrollment";
import { readOwnerConfig } from "./owner-config";
import { ownerDispatch } from "./owner-dispatch";

async function main() {
  const path = process.argv[2];
  if (!path)
    throw new Error("Usage: swarm-coordinator-owner <private-config.json>");
  const config = readOwnerConfig(path);
  const store = await CoordinationStore.open({ path: config.databasePath, storage: config.storage });
  const isLauncher = launcherCredential(config.launcherSecret);
  try {
    const service = await serveCoordination({
      endpoint: localEndpoint(config.databasePath),
      dispatchConfigReload: true,
      executionWorkspaces: true,
      unlimitedDispatch: true,
      core: new CoordinationCore(
        store,
        requester => {
          const current = readOwnerConfig(path);
          if (current.databasePath !== config.databasePath || current.launcherSecret !== config.launcherSecret)
            throw new Error("Owner identity changed; dispatch configuration refused");
          return ownerDispatch(store, current.dispatch ?? { maximum: 0, observationMaxAgeMs: 60000, peers: [] })(requester);
        },
      ),
      authorize: (capability) => store.authorize(capability),
      enroll: launcherEnrollment(store, config.launcherSecret),
      authorizeProbe: capability => { if (!isLauncher(capability)) store.authorize(capability); },
    });
    let closing = false;
    let idleTimer: ReturnType<typeof setInterval> | undefined;
    const close = async () => {
      if (closing) return;
      closing = true;
      clearInterval(idleTimer);
      await service.close();
      store.close();
    };
    if (config.idleTimeoutMs !== null) {
      idleTimer = setInterval(() => {
        if (service.idleForMs >= config.idleTimeoutMs!)
          void close().catch(error => { console.error("Owner idle shutdown:", error.message); process.exitCode = 1; });
      }, Math.min(config.idleTimeoutMs, 1000));
    }
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
