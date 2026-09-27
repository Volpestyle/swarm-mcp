import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient, localEndpoint, serveCoordination } from "../../src/coordination/ipc";
import { CoordinationStore } from "../../src/coordination/store";
import { CoordinationCore } from "../../src/coordination/core";

const path = join(mkdtempSync(join(tmpdir(), "owner-pending-")), "db");
const store = await CoordinationStore.open({ path });
let finish!: () => void, started!: () => void;
const pending = new Promise<void>(resolve => { finish = resolve; });
const admitted = new Promise<void>(resolve => { started = resolve; });
const service = await serveCoordination({ endpoint: localEndpoint(path), core: new CoordinationCore(store),
  authorize: () => ({ scope: "test", actor: "launcher" }),
  enroll: async () => { started(); await pending; return {}; },
});
const client = await CoordinationClient.connect(service.endpoint, "test-launcher");
try {
  const request = client.request({ op: "enroll", input: {} as never }).catch(() => undefined);
  await admitted; client.close(); await request; await delay(30);
  assert.equal(service.idleForMs, 0);
  finish(); await delay(30);
  assert.ok(service.idleForMs > 0);
  console.log(JSON.stringify({ pendingProtected: true }));
} finally { finish(); client.close(); await service.close(); store.close(); }
