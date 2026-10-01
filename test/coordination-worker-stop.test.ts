import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { requestWorkerStop, workerStopRequested, publishWorkerStopped, workerStopped, stopOwnedWorker } from "../src/coordination/worker-stop";
import type { HerdrWorkerRecord } from "../src/coordination/herdr-dispatch";
import { validateTaskContract } from "../src/coordination/task-contract";

test("stop proof is launch-bound and never inferred from missing or malformed files", () => {
  const path = join(mkdtempSync(join(tmpdir(), "worker-stop-")), "launch.json");
  const record = { token: "one", routeFingerprint: "runtime", worker: { sessionId: "session", generation: 1 } } as HerdrWorkerRecord;
  expect(workerStopped(path, record)).toBe(false);
  requestWorkerStop(path);
  requestWorkerStop(path);
  expect(workerStopRequested(path)).toBe(true);
  expect(workerStopped(path, record)).toBe(false);
  writeFileSync(`${path}.stopped`, "{");
  expect(workerStopped(path, record)).toBe(false);
  publishWorkerStopped(path, record);
  expect(workerStopped(path, record)).toBe(true);
  expect(workerStopped(path, { ...record, token: "replacement" })).toBe(false);
  expect(workerStopped(path, { ...record, routeFingerprint: "retargeted" })).toBe(false);
  expect(workerStopped(path, { ...record, worker: { ...record.worker, generation: 2 } })).toBe(false);
});

test("owned process-group stop waits for a TERM-resistant descendant", async () => {
  if (process.platform === "win32") return;
  const child = spawn(Bun.which("node")!, ["-e", `
    const {spawn} = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {stdio:['ignore','pipe','inherit']});
    descendant.stdout.once('data',()=>console.log('ready'));
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    expect(await stopOwnedWorker(child)).toBe(true);
    expect(() => process.kill(-child.pid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      process.kill(-child.pid!, "SIGKILL");
      await ended;
    }
  }
});

test("task contract rejects progress timeouts outside its bounded policy", () => {
  const contract = { objective: "long build", worktree: "/work", acceptanceCriteria: ["done"], expectedArtifacts: [], constraints: [] };
  for (const value of [0, 59999, 86400001, 1.5, NaN, Infinity])
    expect(() => validateTaskContract({ ...contract, progressTimeoutMs: value })).toThrow("Progress timeout");
  expect(validateTaskContract({ ...contract, progressTimeoutMs: 3600000 }).progressTimeoutMs).toBe(3600000);
});


test("permission-denied group probes cannot fabricate termination proof", async () => {
  if (process.platform === "win32") return;
  const kill = spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  try {
    const child = { pid: 123, stdin: { end() {} } } as unknown as ReturnType<typeof spawn>;
    expect(await stopOwnedWorker(child)).toBe(false);
  } finally { kill.mockRestore(); }
});
