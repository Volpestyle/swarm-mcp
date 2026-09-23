import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
import { CoordinationError } from "../../src/coordination/errors";
import { randomBytes } from "node:crypto";
import { launcherEnrollment } from "../../src/coordination/enrollment";
import { dirname } from "node:path";
import { existingPeerProvider } from "../../src/coordination/dispatch-runner";
import {
  CoordinationClient,
  localEndpoint,
  serveCoordination,
} from "../../src/coordination/ipc";
const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("Missing fixture path");
const store = await CoordinationStore.open({ path });
const session =
  mode === "sessions" || mode === "dispatch"
    ? store.openSession({
        scope: "test",
        agentId: "alice",
        requestId: "fixture-enroll",
        resumeToken: randomBytes(32).toString("hex"),
        worktree: { root: dirname(path), repository: dirname(path) },
      })
    : undefined;
const peer =
  mode === "dispatch"
    ? store.openSession({
        scope: "test",
        agentId: "peer",
        requestId: "peer-enroll",
        resumeToken: randomBytes(32).toString("hex"),
        worktree: { root: dirname(path), repository: dirname(path) },
      })
    : undefined;
const options = {
  enroll:
    mode === "sessions"
      ? launcherEnrollment(store, "fixture-launcher-secret-32-characters")
      : undefined,
  endpoint: localEndpoint(path),
  core: new CoordinationCore(
    store,
    peer
      ? (requester) => ({
          policy: {
            active: 0,
            maximum: 1,
            observationMaxAgeMs: 60000,
            routes: [
              {
                id: "peer",
                path: "peer",
                scope: "test",
                host: "node",
                worktree: dirname(path),
                capabilities: ["code"],
                durable: true,
                availability: "idle",
                observedAt: Date.now(),
                active: 0,
                capacity: 1,
                overhead: 0,
                authorized: true,
              },
            ],
          },
          providers: [
            existingPeerProvider({
              store,
              requester,
              routeId: "peer",
              worker: peer,
              authorized: () => true,
            }),
          ],
        })
      : undefined,
  ),
  authorize: (capability: string) => {
    if (session) return store.authorize(capability);
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
  console.log(
    JSON.stringify({
      endpoint: service.endpoint,
      worktreeRoot: dirname(path),
      capability: session?.capability,
    }),
  );
  process.on("SIGTERM", async () => {
    await service.close();
    store.close();
    process.exit(0);
  });
}
