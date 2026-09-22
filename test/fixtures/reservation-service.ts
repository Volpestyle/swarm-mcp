import { randomBytes } from "node:crypto";
import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";
import { localEndpoint, serveCoordination } from "../../src/coordination/ipc";
import { discoverWorktree } from "../../src/coordination/worktrees";
const [path, main, peer] = process.argv.slice(2);
if (!path || !main || !peer) throw new Error("Missing fixture arguments");
const store = await CoordinationStore.open({ path });
const enroll = (agentId: string, root: string) =>
  store.openSession({
    scope: "test",
    agentId,
    requestId: `enroll-${agentId}`,
    resumeToken: randomBytes(32).toString("hex"),
    worktree: discoverWorktree(root),
  });
const alice = enroll("alice", main),
  bob = enroll("bob", main),
  carol = enroll("carol", peer);
const service = await serveCoordination({
  endpoint: localEndpoint(path),
  core: new CoordinationCore(store),
  authorize: (cap) => store.authorize(cap),
});
console.log(
  JSON.stringify({
    endpoint: service.endpoint,
    alice: alice.capability,
    bob: bob.capability,
    carol: carol.capability,
  }),
);
process.on("SIGTERM", async () => {
  await service.close();
  store.close();
  process.exit(0);
});
