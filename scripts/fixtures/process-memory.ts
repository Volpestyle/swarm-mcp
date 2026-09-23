import { execFileSync } from "node:child_process";
import { cpus, totalmem, release } from "node:os";
import { createHash } from "node:crypto";

/** Point-in-time working/private memory for explicit fixture-owned processes. */
export function processMemory(pids: number[]) {
  if (process.platform !== "win32") return { supported: false, platform: process.platform };
  if (!pids.length || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0))
    throw new Error("Invalid fixture process IDs");
  const rows = [JSON.parse(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-Process -Id ${pids.join(",")} -ErrorAction Stop | Select-Object Id,WorkingSet64,PrivateMemorySize64,PeakWorkingSet64 | ConvertTo-Json -Compress`,
  ], { encoding: "utf8" }))].flat();
  if (rows.length !== pids.length) throw new Error("Missing fixture process sample");
  return { supported: true, platform: process.platform, observedAt: Date.now(), processes: rows,
    environment: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, physicalMemoryBytes: totalmem(), release: release() },
    source: { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      diffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--"])).digest("hex") },
    totalWorkingSetBytes: rows.reduce((sum, row) => sum + row.WorkingSet64, 0),
    totalPrivateBytes: rows.reduce((sum, row) => sum + row.PrivateMemorySize64, 0),
    limitation: "Point-in-time Windows working/private memory, not unique physical memory. Peaks belong to each process lifetime, not necessarily this workload." };
}
