import { createConnection, type Server } from "node:net";
import { lstatSync, unlinkSync } from "node:fs";
import { openSqlite } from "./sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** SQLite supplies a process-death-safe OS lock. Never unlink the lock file:
 * every starter must lock the same inode while probing/removing/binding. */
export async function withEndpointLock<T>(endpoint: string, run: (live: boolean) => Promise<T>): Promise<T> {
  const lockPath = process.platform === "win32"
    ? join(tmpdir(), `swarm-owner-${createHash("sha256").update(endpoint).digest("hex")}.lock`)
    : `${endpoint}.lock`;
  const lock = await openSqlite(lockPath);
  try {
    if (lock) {
      lock.exec("PRAGMA busy_timeout=0");
      const deadline = performance.now() + 5000;
      for (;;) {
        try { lock.exec("BEGIN EXCLUSIVE"); break; }
        catch (error) {
          if (!(error as { code?: string }).code?.startsWith("SQLITE_BUSY") || performance.now() >= deadline) throw error;
          await delay(25);
        }
      }
    }
    const live = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(endpoint);
        probe.setTimeout(1000, () => probe.destroy(new Error("Owner endpoint probe timed out")));
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
          else reject(error);
        });
    });
    return await run(live);
  } finally {
    lock?.close();
  }
}

export async function listenLocal(server: Server, endpoint: string) {
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(endpoint, () => { server.off("error", failed); resolve(); });
  });
  return withEndpointLock(endpoint, async live => {
    if (!live && process.platform !== "win32") {
        try {
          if (!lstatSync(endpoint).isSocket()) throw new Error("Refusing to replace a non-socket owner endpoint");
          unlinkSync(endpoint);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    await listen();
  });
}
