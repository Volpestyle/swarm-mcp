import type { ChildProcess } from "node:child_process";
import { codexInteractiveWorker } from "../../src/coordination/codex-interactive-worker";
import { stopOwnedWorker } from "../../src/coordination/worker-stop";

const [root, command] = process.argv.slice(2);
const children: ChildProcess[] = [];
const worker = codexInteractiveWorker({ command, args: [], cwd: root,
  worker: { scope: "fixture", actor: "fixture", sessionId: "fixture", generation: 1 }, token: "fixture", environment: {},
}, { owned: child => children.push(child), busy() {}, settled() {}, failed() {}, identity() {}, log() {} }, { requestTimeoutMs: 1000 });
try {
  await worker.start();
  await worker.prompt("one input");
  console.log(JSON.stringify({ error: null }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
} finally {
  await Promise.all(children.map(stopOwnedWorker));
  await worker.close();
}
