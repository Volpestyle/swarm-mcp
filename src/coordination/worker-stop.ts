import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

/** Launch-local stop latch is durable: even a delayed wrapper may not start
 * after cancellation. Only the owning wrapper publishes termination proof. */
export function requestWorkerStop(path: string) {
  try { writeFileSync(`${path}.stop`, "stop\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
export function workerStopRequested(path: string) { return existsSync(`${path}.stop`); }
export function publishWorkerStopped(path: string, record: HerdrWorkerRecord) {
  const target = `${path}.stopped`, temporary = `${target}.${process.pid}.next`;
  writeFileSync(temporary, JSON.stringify({ token: record.token, sessionId: record.worker.sessionId,
    generation: record.worker.generation, routeFingerprint: record.routeFingerprint }), { mode: 0o600 });
  renameSync(temporary, target);
}
export function workerStopped(path: string, record: HerdrWorkerRecord): boolean {
  if (!workerStopRequested(path)) return false;
  try {
    const receipt = JSON.parse(readFileSync(`${path}.stopped`, "utf8"));
    return receipt.token === record.token && receipt.sessionId === record.worker.sessionId &&
      receipt.generation === record.worker.generation && receipt.routeFingerprint === record.routeFingerprint;
  } catch { return false; }
}

/** Only call with a child this wrapper spawned as a new POSIX process group.
 * Missing panes/PIDs from previous runs are never used as stop evidence. */
export async function stopOwnedWorker(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  child.stdin?.end();
  if (process.platform === "win32") { child.kill(); return false; }
  const pid = child.pid;
  const alive = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!alive()) return true;
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (!alive()) return true;
      await delay(25);
    }
  }
  return !alive();
}
