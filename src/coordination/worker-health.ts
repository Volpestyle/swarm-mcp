import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { HerdrWorkerRecord } from "./herdr-dispatch";

export type WorkerHealth = { token: string; sessionId: string; generation: number; pid: number;
  at: number; state: "connected" | "ready" | "blocked"; reason?: string };
export function workerFailure(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return code === "coordinator_version_mismatch" || code === "coordinator_build_mismatch"
    ? "coordinator_version_mismatch" : "worker_mcp_unavailable";
}
/** Private launch-local health seam. It is observation, never a substitute for the DB claim. */
export function publishWorkerHealth(path: string | undefined, state: WorkerHealth["state"], reason?: string) {
  if (!path) return;
  const record: HerdrWorkerRecord = JSON.parse(readFileSync(path, "utf8"));
  const health: WorkerHealth = { token: record.token, sessionId: record.worker.sessionId,
    generation: record.worker.generation, pid: process.pid, at: Date.now(), state, ...(reason ? { reason } : {}) };
  const target = `${path}.mcp-health`, temporary = `${target}.${process.pid}.next`;
  writeFileSync(temporary, JSON.stringify(health), { mode: 0o600 });
  renameSync(temporary, target);
}
export function readWorkerHealth(path: string, record: HerdrWorkerRecord): WorkerHealth | undefined {
  try {
    const health: WorkerHealth = JSON.parse(readFileSync(`${path}.mcp-health`, "utf8"));
    if (health.token === record.token && health.sessionId === record.worker.sessionId &&
        health.generation === record.worker.generation) return health;
  } catch { /* Missing/partial health is not readiness. */ }
  return undefined;
}

/** Native turn state for a channel worker, written only by its own lifecycle
 * hooks. The channel projection defers fetching while a turn is known busy. */
export type WorkerTurn = { sessionId: string; state: "busy" | "idle"; at: number };
export function publishWorkerTurn(path: string, turn: WorkerTurn) {
  const target = `${path}.turn`, temporary = `${target}.${process.pid}.next`;
  writeFileSync(temporary, JSON.stringify(turn), { mode: 0o600 });
  renameSync(temporary, target);
}
export function readWorkerTurn(path: string, sessionId: string): WorkerTurn | undefined {
  try {
    const turn: WorkerTurn = JSON.parse(readFileSync(`${path}.turn`, "utf8"));
    if (turn.sessionId === sessionId) return turn;
  } catch { /* No turn has started yet. */ }
  return undefined;
}
