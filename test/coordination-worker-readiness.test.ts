import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import { runDispatchIntent } from "../src/coordination/dispatch-runner";
import type { DispatchPolicy, DispatchIntent } from "../src/coordination/dispatch";

test("only pinned worker claims readiness; lost reply reconciles same fence and health does not release it", async () => {
  let now = Date.now();
  const store = await CoordinationStore.open({ path: join(mkdtempSync(join(tmpdir(), "worker-ready-")), "db"), clock: () => now });
  const core = new CoordinationCore(store);
  const enroll = (actor: string) => store.openSession({ scope: "scope", agentId: actor, requestId: actor,
    resumeToken: `${actor}-a-long-resume-token-for-this-test-only` });
  const lead = enroll("lead"), worker = enroll("worker"), other = enroll("other");
  const intent: DispatchIntent = { intentId: "one", title: "Work", durable: false, capabilities: ["code"],
    contract: { objective: "Work", worktree: "/work", acceptanceCriteria: ["Done"], constraints: [], expectedArtifacts: [] } };
  const policy: DispatchPolicy = { active: 0, maximum: 1, observationMaxAgeMs: 60000, routes: [{ id: "herdr", path: "peer", scope: "scope", host: "claude", worktree: "/work", capabilities: ["code"], durable: false, authorized: true, availability: "idle", observedAt: now, active: 0, capacity: 1, overhead: 1 }] };
  const execute = <T extends import("../src/coordination/store").Json>(id: string, fn: (tx: import("../src/coordination/store").WriteTransaction) => T) => store.execute({ ...lead, id, type: id, payload: {} }, fn).value;
  try {
    execute("reserve", tx => tx.dispatch.reserve(intent, policy));
    const begun = execute("begin", tx => tx.dispatch.begin(intent.intentId));
    const token = begun.token!;
    execute("pin", tx => tx.dispatch.expectWorker({ intentId: intent.intentId, token, worker }));
    expect(() => execute("false-bind", tx => tx.dispatch.bind({ intentId: intent.intentId, token, worker, routeId: "herdr", externalId: "pane" }))).toThrow("own authenticated MCP");
    const premature = await runDispatchIntent({ store, requester: lead, intent, policy, providers: [{ routeId: "herdr", requiresWorkerReady: true,
      authorized: () => true, start: async () => { throw new Error("must not relaunch"); },
      find: async () => ({ externalId: "pane", worker }) }] });
    expect(premature).toMatchObject({ status: "uncertain", reasons: ["worker_claim_failed"] });
    const command = { id: "ready", type: "dispatch.workerReady" as const, payload: { intentId: intent.intentId, token, externalId: "pane" } };
    expect(() => core.command(other, command)).toThrow("pinned worker");
    const first = core.command(worker, command);
    const replay = core.command(worker, command);
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual(first.value);
    const claim = first.value as { taskId: string; attemptId: string; fence: number };
    // Coordinator lost the original launch/readiness response: no second start.
    const result = await runDispatchIntent({ store, requester: lead, intent, policy, providers: [{ routeId: "herdr", requiresWorkerReady: true,
      authorized: () => true, start: async () => { throw new Error("must not relaunch"); },
      find: async () => ({ externalId: "pane", worker }) }] });
    expect(result).toMatchObject({ status: "bound", attemptId: claim.attemptId, fence: claim.fence });
    const before = core.taskDetail(worker, claim.taskId);
    core.command(worker, { id: "health", type: "dispatch.workerHealth", payload: { intentId: intent.intentId, token, reason: "mcp_disconnected" } });
    expect(core.taskDetail(worker, claim.taskId).owner).toEqual(before.owner);
    const inbox = core.command(lead, { id: "fetch", type: "inbox.fetch", payload: { consumer: "lead" } }).value;
    expect(JSON.stringify(inbox)).toContain("blocked:mcp_disconnected");
    // Lease renewal is not progress; the lead's diagnostic still alarms.
    now += 10000;
    core.command(worker, { id: "renew", type: "task.renew", payload: claim });
    now += 900001;
    expect(core.inspect(lead).tasks.items[0]).toMatchObject({ signal: "stale_progress" });
    expect(core.taskDetail(worker, claim.taskId).owner?.progressDeadline).toBe(before.owner?.progressDeadline);
    core.command(worker, { id: "stale-health", type: "dispatch.workerHealth", payload: { intentId: intent.intentId, token, reason: "stale_progress" } });
    expect(JSON.stringify(core.command(lead, { id: "fetch-again", type: "inbox.fetch", payload: { consumer: "lead" } }).value)).toContain("blocked:stale_progress");
  } finally { store.close(); }
});

test("a worker can finish its exact fenced attempt before the requester observes readiness", async () => {
  const store = await CoordinationStore.open({ path: join(mkdtempSync(join(tmpdir(), "worker-fast-ready-")), "db") });
  const core = new CoordinationCore(store);
  const lead = store.openSession({ scope: "scope", agentId: "lead", requestId: "lead", resumeToken: "lead-long-resume-token-for-this-test" });
  const worker = store.openSession({ scope: "scope", agentId: "worker", requestId: "worker", resumeToken: "worker-long-resume-token-for-this-test" });
  const intent: DispatchIntent = { intentId: "fast", title: "Fast native turn", durable: true, capabilities: [], contract: { objective: "Finish", worktree: "/work", acceptanceCriteria: ["Done"], constraints: [], expectedArtifacts: [] } };
  const policy: DispatchPolicy = { active: 0, maximum: 1, observationMaxAgeMs: 60000, routes: [{ id: "herdr", path: "peer", scope: "scope", host: "pi", worktree: "/work", capabilities: [], durable: true, authorized: true, availability: "idle", observedAt: Date.now(), active: 0, capacity: 1, overhead: 1 }] };
  const execute = (id: string, fn: (tx: import("../src/coordination/store").WriteTransaction) => any) => store.execute({ ...lead, id, type: id, payload: {} }, fn).value;
  try {
    execute("reserve", tx => tx.dispatch.reserve(intent, policy));
    const begun = execute("begin", tx => tx.dispatch.begin(intent.intentId));
    execute("pin", tx => tx.dispatch.expectWorker({ intentId: intent.intentId, token: begun.token, worker }));
    const ready = core.command(worker, { id: "ready", type: "dispatch.workerReady", payload: { intentId: intent.intentId, token: begun.token, externalId: "pane" } }).value as any;
    core.command(worker, { id: "finish", type: "task.finish", payload: { taskId: ready.taskId, attemptId: ready.attemptId, fence: ready.fence, outcome: "completed", result: { summary: "Finished before observation", evidence: [], limitations: [] } } });
    const result = await runDispatchIntent({ store, requester: lead, intent, policy, providers: [{ routeId: "herdr", requiresWorkerReady: true, authorized: () => true, start: async () => { throw new Error("never relaunch"); }, find: async () => ({ externalId: "pane", worker }) }] });
    expect(result).toMatchObject({ status: "bound", attemptId: ready.attemptId, fence: ready.fence });
    expect(core.taskDetail(worker, ready.taskId).status).toBe("completed");
  } finally { store.close(); }
});
