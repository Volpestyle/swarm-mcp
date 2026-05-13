import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReadHandleSource,
  WorkspaceBackend,
  WorkspaceHandleInfo,
  WorkspaceIdentity,
} from "../src/workspace_backend";

const __fixtureDir = mkdtempSync(join(tmpdir(), "swarm-workspace-identity-"));
process.env.SWARM_DB_PATH = join(__fixtureDir, "swarm.db");
process.env.SWARM_MCP_PROFILE_DIR = __fixtureDir;
writeFileSync(
  join(__fixtureDir, "personal.env"),
  [
    "SWARM_HARNESS_CLAUDE=clowd",
    "SWARM_HARNESS_CODEX=cdx",
    "SWARM_HARNESS_OPENCODE=opc",
    "SWARM_HARNESS_HERMES=hermesp",
  ].join("\n"),
);
writeFileSync(
  join(__fixtureDir, "work.env"),
  [
    "SWARM_HARNESS_CLAUDE=clawd",
    "SWARM_HARNESS_CODEX=codex",
    "SWARM_HARNESS_OPENCODE=opencode",
    "SWARM_HARNESS_HERMES=hermesw",
  ].join("\n"),
);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const { db, dbPath } = await import("../src/db");
const context = await import("../src/context");
const dispatch = await import("../src/dispatch");
const herdrBackend = await import("../src/backends/herdr");
const herdrSpawner = await import("../src/backends/herdr_spawner");
const kv = await import("../src/kv");
const registry = await import("../src/registry");
const spawnerBackend = await import("../src/spawner_backend");
const taskStore = await import("../src/tasks");
const workspaceBackend = await import("../src/workspace_backend");
const workspaceIdentity = await import("../src/workspace_identity");

const originalPersonalRoots = process.env.SWARM_MCP_PERSONAL_ROOTS;
const originalHerdrBin = process.env.SWARM_HERDR_BIN;
const originalHerdrParentPane = process.env.SWARM_HERDR_PARENT_PANE;
const originalHerdrPaneId = process.env.HERDR_PANE_ID;
const originalHerdrPane = process.env.HERDR_PANE;
const originalHerdrFakeLog = process.env.HERDR_FAKE_LOG;
const originalHerdrFakeCommand = process.env.HERDR_FAKE_COMMAND;
const originalHerdrFakeRunPane = process.env.HERDR_FAKE_RUN_PANE;
const originalAgentIdentity = process.env.AGENT_IDENTITY;
const originalSwarmIdentity = process.env.SWARM_IDENTITY;
const originalSwarmHermesIdentity = process.env.SWARM_HERMES_IDENTITY;
const originalSwarmCcIdentity = process.env.SWARM_CC_IDENTITY;
const originalSwarmCodexIdentity = process.env.SWARM_CODEX_IDENTITY;
const originalSwarmDbPath = process.env.SWARM_DB_PATH;

type WakeCall = {
  backend: string;
  handle: string;
  prompt: string;
  force?: boolean;
};

type ReadCall = {
  backend: string;
  handle: string;
  source?: ReadHandleSource;
  lines?: number;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniqueStrings(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map(stringValue)
        .filter(Boolean),
    ),
  );
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function syntheticBackend(
  name: string,
  wakeCalls: WakeCall[] = [],
  agentStatus = "idle",
  readCalls?: ReadCall[],
): WorkspaceBackend {
  const canonical = (handle: string) =>
    handle.endsWith("-alias") ? `${handle.slice(0, -"alias".length)}canonical` : handle;

  return {
    name,
    defaultHandleKind: "unit",

    identityKeys(instanceId: string) {
      return [workspaceBackend.identityKey(name, instanceId)];
    },

    instanceIdFromIdentityKey(key: string) {
      const prefix = workspaceBackend.identityKey(name, "");
      return key.startsWith(prefix) ? key.slice(prefix.length) : null;
    },

    handlesForIdentity(identity: WorkspaceIdentity) {
      return uniqueStrings([identity.handle, identity.handle_aliases]);
    },

    getHandle({ handle, handleKind }) {
      const info: WorkspaceHandleInfo = {
        backend: name,
        handle_kind: handleKind || "unit",
        handle: canonical(handle),
        agent_status: agentStatus,
      };
      return { ok: true, value: info };
    },

    wakeHandle({ handle, prompt, force }) {
      wakeCalls.push({ backend: name, handle, prompt, force });
      if (agentStatus === "working" && !force) {
        return { ok: true, value: { skipped: "target workspace handle is working" } };
      }
      return { ok: true, value: {} };
    },

    ...(readCalls
      ? {
          readHandle({ handle, source, lines }) {
            readCalls.push({ backend: name, handle, source, lines });
            return {
              ok: true as const,
              value: {
                text: `${name} pane text`,
                source: source ?? "recent",
                lines,
              },
            };
          },
        }
      : {}),

    canonicalizeIdentity({ identity, handleInfo, requestedHandle }) {
      const aliases = uniqueStrings([
        identity.handle === handleInfo.handle ? "" : identity.handle,
        requestedHandle === handleInfo.handle ? "" : requestedHandle,
        identity.handle_aliases,
      ]);
      const next: WorkspaceIdentity = {
        ...identity,
        schema_version: 1,
        backend: name,
        handle_kind: stringValue(identity.handle_kind) || "unit",
        handle: handleInfo.handle,
      };
      if (aliases.length) next.handle_aliases = aliases;
      return next;
    },
  };
}

beforeEach(() => {
  process.env.SWARM_MCP_PERSONAL_ROOTS = ["/tmp", tmpdir()].join(":");
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
  workspaceIdentity.clearBackendsForTesting();
});

afterEach(() => {
  restoreEnv("SWARM_MCP_PERSONAL_ROOTS", originalPersonalRoots);
  restoreEnv("SWARM_HERDR_BIN", originalHerdrBin);
  restoreEnv("SWARM_HERDR_PARENT_PANE", originalHerdrParentPane);
  restoreEnv("HERDR_PANE_ID", originalHerdrPaneId);
  restoreEnv("HERDR_PANE", originalHerdrPane);
  restoreEnv("HERDR_FAKE_LOG", originalHerdrFakeLog);
  restoreEnv("HERDR_FAKE_COMMAND", originalHerdrFakeCommand);
  restoreEnv("HERDR_FAKE_RUN_PANE", originalHerdrFakeRunPane);
  restoreEnv("AGENT_IDENTITY", originalAgentIdentity);
  restoreEnv("SWARM_IDENTITY", originalSwarmIdentity);
  restoreEnv("SWARM_HERMES_IDENTITY", originalSwarmHermesIdentity);
  restoreEnv("SWARM_CC_IDENTITY", originalSwarmCcIdentity);
  restoreEnv("SWARM_CODEX_IDENTITY", originalSwarmCodexIdentity);
  restoreEnv("SWARM_DB_PATH", originalSwarmDbPath);
});

describe("workspace backend registry", () => {
  test("resolves published identities through registered synthetic backends", () => {
    workspaceIdentity.registerBackend(syntheticBackend("alpha"));
    workspaceIdentity.registerBackend(syntheticBackend("beta"));
    const scope = "scope-registry";
    const alpha = registry.register("/tmp/alpha", "identity:personal", scope);
    const beta = registry.register("/tmp/beta", "identity:personal", scope);

    kv.set(
      scope,
      workspaceBackend.identityKey("alpha", alpha.id),
      JSON.stringify({ backend: "alpha", handle_kind: "unit", handle: "alpha-alias" }),
      alpha.id,
    );
    kv.set(
      scope,
      workspaceBackend.identityKey("beta", beta.id),
      JSON.stringify({ backend: "beta", handle_kind: "unit", handle: "beta-alias" }),
      beta.id,
    );

    const alphaResolved = workspaceIdentity.resolvePublishedWorkspaceIdentity({
      scope,
      instanceId: alpha.id,
      backend: "alpha",
      actor: alpha.id,
    });
    const betaResolved = workspaceIdentity.resolvePublishedWorkspaceIdentity({
      scope,
      instanceId: beta.id,
      backend: "beta",
      actor: beta.id,
    });

    expect(alphaResolved).toMatchObject({
      ok: true,
      backend_name: "alpha",
      handle: "alpha-canonical",
      identity_repaired: true,
    });
    expect(betaResolved).toMatchObject({
      ok: true,
      backend_name: "beta",
      handle: "beta-canonical",
      identity_repaired: true,
    });

    const repaired = kv.get(scope, workspaceBackend.identityKey("alpha", alpha.id));
    expect(repaired).not.toBeNull();
    const repairedValue = JSON.parse(repaired!.value) as {
      backend: string;
      handle: string;
      handle_aliases: string[];
    };
    expect(repairedValue).toMatchObject({
      backend: "alpha",
      handle: "alpha-canonical",
    });
    expect(repairedValue.handle_aliases).toContain("alpha-alias");
  });

  test("prompt_peer finds recipients published under a non-default backend", () => {
    const alphaWakeCalls: WakeCall[] = [];
    const betaWakeCalls: WakeCall[] = [];
    workspaceIdentity.registerBackend(syntheticBackend("alpha", alphaWakeCalls));
    workspaceIdentity.registerBackend(syntheticBackend("beta", betaWakeCalls));
    const scope = "scope-prompt";
    const sender = registry.register("/tmp/sender", "identity:personal role:planner", scope);
    const recipient = registry.register(
      "/tmp/recipient",
      "identity:personal role:implementer",
      scope,
    );

    kv.set(
      scope,
      workspaceBackend.identityKey("beta", recipient.id),
      JSON.stringify({ backend: "beta", handle_kind: "unit", handle: "beta-alias" }),
      recipient.id,
    );

    const result = dispatch.promptPeerResult({
      scope,
      sender: sender.id,
      recipient: recipient.id,
      message: "check inbox",
      nudge: true,
      force: false,
    });

    expect(result).toMatchObject({
      message_sent: true,
      recipient: recipient.id,
      nudged: true,
      workspace_backend: "beta",
      workspace_handle: "beta-canonical",
      handle_kind: "unit",
    });
    expect(alphaWakeCalls).toHaveLength(0);
    expect(betaWakeCalls).toHaveLength(1);
    expect(betaWakeCalls[0]?.backend).toBe("beta");
    expect(betaWakeCalls[0]?.handle).toBe("beta-canonical");
  });

  test("peek_peer reads recipients through their published workspace backend", () => {
    const betaReadCalls: ReadCall[] = [];
    workspaceIdentity.registerBackend(syntheticBackend("alpha"));
    workspaceIdentity.registerBackend(syntheticBackend("beta", [], "idle", betaReadCalls));
    const scope = "scope-peek";
    const sender = registry.register("/tmp/sender", "identity:personal role:planner", scope);
    const recipient = registry.register(
      "/tmp/recipient",
      "identity:personal role:implementer",
      scope,
    );

    kv.set(
      scope,
      workspaceBackend.identityKey("beta", recipient.id),
      JSON.stringify({ backend: "beta", handle_kind: "unit", handle: "beta-alias" }),
      recipient.id,
    );

    const result = dispatch.peekPeerResult({
      scope,
      sender: sender.id,
      recipient: recipient.id,
      source: "recent-unwrapped",
      lines: 42,
    });

    expect(result).toMatchObject({
      peeked: true,
      recipient: recipient.id,
      workspace_backend: "beta",
      workspace_handle: "beta-canonical",
      handle_kind: "unit",
      source: "recent-unwrapped",
      lines: 42,
      text: "beta pane text",
    });
    expect(betaReadCalls).toEqual([
      {
        backend: "beta",
        handle: "beta-canonical",
        source: "recent-unwrapped",
        lines: 42,
      },
    ]);
  });

  test("herdr backend reads pane text through herdr pane read", () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-read-"));
    const fakeHerdr = join(fakeDir, "herdr");
    const logPath = join(fakeDir, "calls.log");
    writeFileSync(
      fakeHerdr,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$HERDR_FAKE_LOG\"",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"read\" ]; then",
        "  printf '%s\\n' 'peer output'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdr, 0o755);
    process.env.SWARM_HERDR_BIN = fakeHerdr;
    process.env.HERDR_FAKE_LOG = logPath;

    const result = herdrBackend.herdrWorkspaceBackend.readHandle?.({
      handle: "pane-7",
      source: "recent-unwrapped",
      lines: 12,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        text: "peer output\n",
        source: "recent-unwrapped",
        lines: 12,
      },
    });
    expect(readFileSync(logPath, "utf8").trim()).toBe(
      "pane read pane-7 --source recent-unwrapped --lines 12 --format text",
    );
  });

  test("instance annotations expose published herdr pane metadata without changing identity", () => {
    workspaceIdentity.registerBackend(syntheticBackend("herdr"));
    const scope = "scope-instance-pane";
    const viewer = registry.register("/tmp/viewer", "identity:personal role:planner", scope);
    const worker = registry.register("/tmp/worker", "identity:personal role:implementer", scope);

    kv.set(
      worker.scope,
      workspaceBackend.identityKey("herdr", worker.id),
      JSON.stringify({
        schema_version: 1,
        backend: "herdr",
        handle_kind: "pane",
        handle: "pane-17",
        pane_id: "pane-17",
      }),
      worker.id,
    );

    const annotated = workspaceIdentity.annotateInstancesWithPublishedHandles(
      viewer.scope,
      [viewer, worker],
      viewer.id,
    );

    expect(annotated.find((item) => item.id === worker.id)).toMatchObject({
      id: worker.id,
      workspace_backend: "herdr",
      workspace_handle: "pane-17",
      handle_kind: "pane",
      pane_id: "pane-17",
    });
  });

  test("lock conflicts include owner pane metadata when it is published", () => {
    workspaceIdentity.registerBackend(syntheticBackend("herdr"));
    const scope = "scope-lock-pane";
    const owner = registry.register("/tmp/owner", "identity:personal role:implementer", scope);
    const peer = registry.register("/tmp/peer", "identity:personal role:implementer", scope);
    const file = "/tmp/owner/src/index.ts";

    kv.set(
      owner.scope,
      workspaceBackend.identityKey("herdr", owner.id),
      JSON.stringify({
        schema_version: 1,
        backend: "herdr",
        handle_kind: "pane",
        handle: "pane-21",
        pane_id: "pane-21",
      }),
      owner.id,
    );

    expect(context.lock(owner.id, owner.scope, file, "editing")).toMatchObject({ ok: true });
    const result = context.lock(peer.id, peer.scope, file, "editing");

    expect(result).toMatchObject({ error: "File is already locked" });
    if ("error" in result) {
      expect(result.active).toMatchObject({
        owner: {
          label: "identity:personal role:implementer",
          pane_id: "pane-21",
          workspace_handle: "pane-21",
        },
        workspace: {
          backend: "herdr",
          pane_id: "pane-21",
        },
      });
    }
  });

  test("dispatch routes only to compatible identity workers and reserves the task", async () => {
    const scope = "scope-dispatch-identity";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    registry.register("/tmp/work", "identity:work role:implementer", scope);
    const personalWorker = registry.register(
      "/tmp/personal",
      "identity:personal role:implementer",
      scope,
    );

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Fix identity routing",
      role: "implementer",
      spawn: false,
      nudge: false,
    });

    expect(result).toMatchObject({
      status: "dispatched",
      recipient: personalWorker.id,
    });
    expect(result).not.toHaveProperty("completion");

    const taskId = String(result.task_id);
    const task = db
      .query("SELECT status, assignee FROM tasks WHERE id = ?")
      .get(taskId) as { status: string; assignee: string | null };
    expect(task).toEqual({ status: "claimed", assignee: personalWorker.id });
  });

  test("dispatch can wait for terminal task completion when requested", async () => {
    const scope = "scope-dispatch-completion";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const worker = registry.register(
      "/tmp/personal",
      "identity:personal role:implementer",
      scope,
    );
    const title = "Wait for terminal result";

    setTimeout(() => {
      const task = db
        .query("SELECT id FROM tasks WHERE scope = ? AND title = ?")
        .get(gateway.scope, title) as { id: string } | null;
      if (!task) return;
      taskStore.claim(task.id, gateway.scope, worker.id, { ignoreUnreadMessages: true });
      taskStore.update(task.id, gateway.scope, worker.id, "done", "{\"ok\":true}");
    }, 10);

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title,
      role: "implementer",
      spawn: false,
      nudge: false,
      completion_wait_seconds: 1,
      completion_poll_ms: 5,
    });

    expect(result).toMatchObject({
      status: "dispatched",
      recipient: worker.id,
      task: { status: "done", result: "{\"ok\":true}" },
      completion: {
        status: "completed",
        terminal_status: "done",
        task: { status: "done", result: "{\"ok\":true}" },
      },
    });
  });

  test("dispatch default idempotency survives prompt and harness drift", async () => {
    const scope = "scope-dispatch-stable-default-idempotency";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );

    const first = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Implement VUH-20 mobile bridge",
      message: "Initial handoff with cdx details.",
      role: "implementer",
      harness: "codex",
      spawn: false,
      nudge: false,
    });
    const retry = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Implement VUH-20 mobile bridge",
      message: "Recovered handoff with clowd details and extra context.",
      role: "implementer",
      harness: "claude",
      spawn: false,
      nudge: false,
    });

    expect(retry.task_id).toBe(first.task_id);
    const tasks = db
      .query("SELECT COUNT(*) AS count FROM tasks WHERE scope = ?")
      .get(gateway.scope) as { count: number };
    expect(tasks.count).toBe(1);
  });

  test("dispatch completion wait times out with the latest task snapshot", async () => {
    const scope = "scope-dispatch-completion-timeout";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Timeout waiting for completion",
      role: "implementer",
      spawn: false,
      nudge: false,
      completion_wait_seconds: 0.01,
      completion_poll_ms: 2,
    });

    expect(result).toMatchObject({
      status: "no_worker",
      task: { status: "open" },
      completion: {
        status: "timeout",
        task: { status: "open" },
      },
    });
  });

  test("dispatch does not cross identity boundary to reuse a live worker", async () => {
    const scope = "scope-dispatch-boundary";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    registry.register("/tmp/work", "identity:work role:implementer", scope);

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Needs personal worker",
      role: "implementer",
      spawn: false,
      nudge: false,
    });

    expect(result).toMatchObject({ status: "no_worker", role: "implementer" });
    const task = db
      .query("SELECT status, assignee FROM tasks WHERE id = ?")
      .get(String(result.task_id)) as { status: string; assignee: string | null };
    expect(task).toEqual({ status: "open", assignee: null });
  });

  test("dispatch does not cross identity boundary for generalist fallback", async () => {
    const scope = "scope-dispatch-generalist-boundary";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    registry.register("/tmp/work-generalist", "identity:work role:generalist", scope);

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Needs personal generalist",
      role: "implementer",
      spawn: false,
      nudge: false,
    });

    expect(result).toMatchObject({ status: "no_worker", role: "implementer" });
  });

  test("dispatch does not route identified work to an unlabeled worker", async () => {
    const scope = "scope-dispatch-unlabeled";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    registry.register("/tmp/unlabeled", "role:implementer", scope);

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Needs identified worker",
      role: "implementer",
      spawn: false,
      nudge: false,
    });

    expect(result).toMatchObject({ status: "no_worker", role: "implementer" });
  });

  test("dispatch maps personal requester launchers and passes identity to spawner", async () => {
    const scope = "scope-dispatch-personal-launchers";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const spawnerName = "test-personal-launchers";
    spawnerBackend.registerSpawner({
      name: spawnerName,
      defaultWaitSeconds: 0,
      defaultHarness() {
        return "claude";
      },
      spawn(input) {
        return {
          status: "spawn_in_flight",
          harness: input.harness,
          identity: input.identity,
          label: input.label,
        };
      },
    });

    const cases: Array<[string, string | undefined, string]> = [
      ["default", undefined, "clowd"],
      ["claude", "claude", "clowd"],
      ["codex", "codex", "cdx"],
      ["opencode", "opencode", "opc"],
      ["hermes", "hermesw", "hermesp"],
    ];

    for (const [title, harness, expected] of cases) {
      const result = await dispatch.runDispatch({
        scope: gateway.scope,
        requester: gateway.id,
        title: `Spawn ${title}`,
        role: "implementer",
        spawner: spawnerName,
        force_spawn: true,
        harness,
        nudge: false,
      });

      expect(result).toMatchObject({
        status: "spawn_in_flight",
        harness: expected,
        identity: "identity:personal",
        label: "identity:personal",
      });
    }
  });

  test("herdr default harness honors Hermes identity env", () => {
    delete process.env.AGENT_IDENTITY;
    delete process.env.SWARM_IDENTITY;
    delete process.env.SWARM_CC_IDENTITY;
    delete process.env.SWARM_CODEX_IDENTITY;

    process.env.SWARM_HERMES_IDENTITY = "personal";
    expect(herdrSpawner.herdrSpawnerBackend.defaultHarness()).toBe("clowd");

    process.env.SWARM_HERMES_IDENTITY = "work";
    expect(herdrSpawner.herdrSpawnerBackend.defaultHarness()).toBe("clawd");
  });

  test("dispatch rejects spawn labels with a conflicting identity", async () => {
    const scope = "scope-dispatch-conflicting-spawn-label";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );

    await expect(
      dispatch.runDispatch({
        scope: gateway.scope,
        requester: gateway.id,
        title: "Spawn wrong identity",
        role: "implementer",
        spawner: "herdr",
        force_spawn: true,
        label: "identity:work",
        nudge: false,
      }),
    ).rejects.toThrow(/does not match requester identity:personal/);
  });

  test("dispatch binds spawned workers before releasing the spawn mutex", async () => {
    const scope = "scope-dispatch-spawn-bind";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const spawned = registry.register(
      "/tmp/spawned",
      "identity:personal role:implementer launch:testtoken",
      scope,
    );
    const spawnerName = "test-bind";
    spawnerBackend.registerSpawner({
      name: spawnerName,
      defaultWaitSeconds: 0,
      defaultHarness() {
        return "test";
      },
      spawn(input) {
        const active = db
          .query("SELECT COUNT(*) AS count FROM context WHERE scope = ? AND file = ? AND type = 'lock'")
          .get(input.scope, input.lock_path) as { count: number };
        expect(active.count).toBe(1);
        return {
          status: "spawned",
          spawned_instance: spawned.id,
          saw_lock_while_spawning: true,
        };
      },
    });

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Bind spawned task",
      role: "implementer",
      spawner: spawnerName,
      force_spawn: true,
      nudge: false,
    });

    expect(result).toMatchObject({
      status: "spawned",
      spawned_instance: spawned.id,
      binding: { ok: true },
    });
    const task = db
      .query("SELECT status, assignee FROM tasks WHERE id = ?")
      .get(String(result.task_id)) as { status: string; assignee: string | null };
    expect(task).toEqual({ status: "claimed", assignee: spawned.id });
    const locks = db
      .query("SELECT COUNT(*) AS count FROM context WHERE scope = ? AND file LIKE '/__swarm/spawn/%'")
      .get(scope) as { count: number };
    expect(locks.count).toBe(0);
  });

  test("dispatch fails spawned handoff when worker cannot see the task", async () => {
    const scope = "scope-dispatch-spawn-health-fail";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const spawned = registry.register(
      "/tmp/spawned",
      "identity:work role:implementer launch:testtoken",
      scope,
    );
    const spawnerName = "test-health-fail";
    spawnerBackend.registerSpawner({
      name: spawnerName,
      defaultWaitSeconds: 0,
      defaultHarness() {
        return "test";
      },
      spawn() {
        return {
          status: "spawned",
          spawned_instance: spawned.id,
        };
      },
    });

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Reject invisible spawned task",
      role: "implementer",
      spawner: spawnerName,
      force_spawn: true,
      nudge: false,
    });

    expect(result).toMatchObject({
      status: "spawn_failed",
      failure: "worker_task_not_visible",
      dispatch_health: {
        status: "failed",
        checks: {
          gateway_task_exists: true,
          worker_instance_exists: true,
          worker_adopted: true,
          worker_scope_matches: true,
          worker_task_visible: false,
        },
      },
    });
    const task = db
      .query("SELECT status, assignee FROM tasks WHERE id = ?")
      .get(String(result.task_id)) as { status: string; assignee: string | null };
    expect(task).toEqual({ status: "open", assignee: null });
    const locks = db
      .query("SELECT COUNT(*) AS count FROM context WHERE scope = ? AND file LIKE '/__swarm/spawn/%'")
      .get(scope) as { count: number };
    expect(locks.count).toBe(0);
  });

  test("dispatch nudges a spawned worker by default", async () => {
    const scope = "scope-dispatch-spawn-nudge";
    const wakeCalls: WakeCall[] = [];
    workspaceIdentity.registerBackend(syntheticBackend("alpha", wakeCalls, "working"));
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const spawned = registry.register(
      "/tmp/spawned",
      "identity:personal role:implementer launch:testtoken",
      scope,
    );
    kv.set(
      gateway.scope,
      workspaceBackend.identityKey("alpha", spawned.id),
      JSON.stringify({ backend: "alpha", handle_kind: "unit", handle: "spawned-handle" }),
      gateway.id,
    );
    const spawnerName = "test-spawn-nudge";
    spawnerBackend.registerSpawner({
      name: spawnerName,
      defaultWaitSeconds: 0,
      defaultHarness() {
        return "test";
      },
      spawn() {
        return {
          status: "spawned",
          spawned_instance: spawned.id,
        };
      },
    });

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Wake spawned task",
      role: "implementer",
      spawner: spawnerName,
      force_spawn: true,
    });

    expect(result).toMatchObject({
      status: "spawned",
      spawned_instance: spawned.id,
      prompt: { message_sent: true, nudged: true, recipient: spawned.id },
    });
    expect(wakeCalls).toEqual([
      {
        backend: "alpha",
        handle: "spawned-handle",
        prompt: expect.stringContaining(`task ${result.task_id}`),
        force: true,
      },
    ]);
  });

  test("dispatch kickstarts a spawn-ready worker before the spawner wait returns", async () => {
    const scope = "scope-dispatch-spawn-ready-kickstart";
    const expectedInstance = "expected-spawn-ready-worker";
    const wakeCalls: WakeCall[] = [];
    const events: string[] = [];
    let messagesAfterReady = 0;
    workspaceIdentity.registerBackend(syntheticBackend("alpha", wakeCalls));
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const spawnerName = "test-spawn-ready-kickstart";
    spawnerBackend.registerSpawner({
      name: spawnerName,
      defaultWaitSeconds: 30,
      defaultHarness() {
        return "test";
      },
      async spawn(input) {
        kv.set(
          input.scope,
          workspaceBackend.identityKey("alpha", expectedInstance),
          JSON.stringify({ backend: "alpha", handle_kind: "unit", handle: "early-handle" }),
          input.requester,
        );
        events.push("ready");
        input.on_ready_to_prompt?.({
          expected_instance: expectedInstance,
          workspace_handle: { backend: "alpha", handle_kind: "unit", handle: "early-handle" },
        });
        messagesAfterReady = (
          db
            .query("SELECT COUNT(*) AS count FROM messages WHERE scope = ? AND recipient = ?")
            .get(input.scope, expectedInstance) as { count: number }
        ).count;
        events.push("after-ready");
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("return");
        return { status: "spawn_in_flight", expected_instance: expectedInstance };
      },
    });

    const result = await dispatch.runDispatch({
      scope: gateway.scope,
      requester: gateway.id,
      title: "Kickstart before wait",
      role: "implementer",
      spawner: spawnerName,
      force_spawn: true,
    });

    expect(events).toEqual(["ready", "after-ready", "return"]);
    expect(messagesAfterReady).toBe(1);
    expect(result).toMatchObject({
      status: "spawn_in_flight",
      expected_instance: expectedInstance,
      kickstart_prompt: {
        message_sent: true,
        nudged: true,
        recipient: expectedInstance,
      },
    });
    expect(wakeCalls).toEqual([
      {
        backend: "alpha",
        handle: "early-handle",
        prompt: expect.stringContaining(`task ${result.task_id}`),
        force: true,
      },
    ]);
    const finalMessages = db
      .query("SELECT COUNT(*) AS count FROM messages WHERE scope = ? AND recipient = ?")
      .get(gateway.scope, expectedInstance) as { count: number };
    expect(finalMessages.count).toBe(1);
  });

  test("herdr spawner pre-creates a leased instance and publishes pane identity", async () => {
    const scope = "scope-herdr-precreate";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
    const fakeHerdr = join(fakeDir, "herdr");
    const commandPath = join(fakeDir, "command.txt");
    const runPanePath = join(fakeDir, "run-pane.txt");
    const logPath = join(fakeDir, "calls.log");
    writeFileSync(
      fakeHerdr,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$HERDR_FAKE_LOG\"",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"split\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-123\",\"workspace_id\":\"workspace-1\",\"tab_id\":\"tab-1\"}}}'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"run\" ]; then",
        "  printf '%s\\n' \"$3\" > \"$HERDR_FAKE_RUN_PANE\"",
        "  printf '%s\\n' \"$4\" > \"$HERDR_FAKE_COMMAND\"",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdr, 0o755);
    process.env.SWARM_HERDR_BIN = fakeHerdr;
    process.env.SWARM_HERDR_PARENT_PANE = "parent-pane";
    process.env.HERDR_FAKE_LOG = logPath;
    process.env.HERDR_FAKE_COMMAND = commandPath;
    process.env.HERDR_FAKE_RUN_PANE = runPanePath;
    delete process.env.SWARM_DB_PATH;

    const result = await herdrSpawner.herdrSpawnerBackend.spawn({
      scope: gateway.scope,
      requester: gateway.id,
      cwd: "/tmp/herdr-worker",
      role: "implementer",
      harness: "cdx",
      identity: "identity:personal",
      label: "provider:codex-cli linear:VUH-19",
      name: null,
      launch_token: "launch123",
      lock_path: "/__swarm/spawn/implementer/launch123",
      lock_note: { task_id: "task-1" },
      wait_seconds: 0,
    });

    expect(result.status).toBe("spawn_in_flight");
    const expectedInstance = String(result.expected_instance);
    const row = db
      .query("SELECT label, adopted, lease_until FROM instances WHERE id = ?")
      .get(expectedInstance) as { label: string; adopted: number; lease_until: number };
    expect(row).toMatchObject({
      label: "identity:personal role:implementer provider:cdx launch:launch123 provider:codex-cli linear:VUH-19",
      adopted: 0,
    });
    expect(row.lease_until).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const published = kv.get(gateway.scope, workspaceBackend.identityKey("herdr", expectedInstance), gateway.id);
    expect(published).not.toBeNull();
    expect(JSON.parse(published!.value)).toMatchObject({
      backend: "herdr",
      handle_kind: "pane",
      handle: "pane-123",
      pane_id: "pane-123",
      workspace_id: "workspace-1",
      tab_id: "tab-1",
    });
    expect(kv.get(gateway.scope, `identity/herdr/${expectedInstance}`, gateway.id)).not.toBeNull();

    const command = readFileSync(commandPath, "utf8");
    expect(readFileSync(runPanePath, "utf8").trim()).toBe("pane-123");
    expect(command).toContain("/bin/sh");
    const launchScriptPath = command.match(/\/bin\/sh '([^']+)'/)?.[1];
    expect(launchScriptPath).toBeTruthy();
    const launchScript = readFileSync(launchScriptPath!, "utf8");
    expect(launchScript).toContain(`SWARM_MCP_INSTANCE_ID='${expectedInstance}'`);
    expect(launchScript).toContain(`SWARM_DB_PATH='${dbPath}'`);
    expect(launchScript).toContain("SWARM_MCP_LABEL='identity:personal role:implementer provider:cdx launch:launch123 provider:codex-cli linear:VUH-19'");
    expect(launchScript).toContain("HERDR_PANE_ID='pane-123'");
    expect(launchScript).toContain("HERDR_WORKSPACE_ID='workspace-1'");
  });

  test("herdr spawner reuses a scope workspace when no parent pane is known", async () => {
    const scope = "scope-herdr-layout-reuse";
    const gateway = registry.register(
      "/tmp/gateway",
      "identity:personal mode:gateway role:planner",
      scope,
    );
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-layout-"));
    const fakeHerdr = join(fakeDir, "herdr");
    const logPath = join(fakeDir, "calls.log");
    writeFileSync(
      fakeHerdr,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$HERDR_FAKE_LOG\"",
        "if [ \"$1\" = \"workspace\" ] && [ \"$2\" = \"create\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"workspace\":{\"workspace_id\":\"workspace-1\"},\"tab\":{\"tab_id\":\"tab-1\"},\"root_pane\":{\"pane_id\":\"pane-root\",\"workspace_id\":\"workspace-1\",\"tab_id\":\"tab-1\"}}}'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"split\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-2\",\"workspace_id\":\"workspace-1\",\"tab_id\":\"tab-1\"}}}'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"run\" ]; then",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdr, 0o755);
    process.env.SWARM_HERDR_BIN = fakeHerdr;
    delete process.env.SWARM_HERDR_PARENT_PANE;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_PANE;
    process.env.HERDR_FAKE_LOG = logPath;

    const base = {
      scope: gateway.scope,
      requester: gateway.id,
      cwd: "/tmp/herdr-worker",
      role: "implementer",
      harness: "cdx",
      identity: "identity:personal",
      label: "batch:vuh",
      name: null,
      wait_seconds: 0,
      placement: { group: "vuh-batch", max_panes_per_tab: 3 },
    };

    const first = await herdrSpawner.herdrSpawnerBackend.spawn({
      ...base,
      launch_token: "launch-layout-1",
      lock_path: "/__swarm/spawn/implementer/launch-layout-1",
      lock_note: { task_id: "task-1" },
    });
    const second = await herdrSpawner.herdrSpawnerBackend.spawn({
      ...base,
      launch_token: "launch-layout-2",
      lock_path: "/__swarm/spawn/implementer/launch-layout-2",
      lock_note: { task_id: "task-2" },
    });

    expect(first).toMatchObject({
      status: "spawn_in_flight",
      workspace_handle: {
        pane_id: "pane-root",
        workspace_id: "workspace-1",
        placement: {
          reason: "created scope workspace",
          group: "vuh-batch",
          reused_workspace: false,
          reused_tab: false,
        },
      },
    });
    expect(second).toMatchObject({
      status: "spawn_in_flight",
      workspace_handle: {
        pane_id: "pane-2",
        workspace_id: "workspace-1",
        placement: {
          reason: "reused scope workspace/tab",
          group: "vuh-batch",
          reused_workspace: true,
          reused_tab: true,
        },
      },
    });

    const log = readFileSync(logPath, "utf8");
    expect(log.match(/workspace create/g)?.length).toBe(1);
    expect(log).toContain("pane split pane-root --direction right");
    expect(log).toContain("pane run pane-root");
    expect(log).toContain("pane run pane-2");
  });

  test("herdr launch wait ignores unadopted leased placeholders", async () => {
    const scope = "scope-herdr-launch-wait";
    const leased = registry.register(
      "/tmp/spawned",
      "role:implementer launch:testtoken",
      scope,
      "/tmp/spawned",
    );
    registry.setLease(leased.id, Math.floor(Date.now() / 1000) + 60);

    await expect(
      herdrSpawner.waitForLaunchInstanceForTesting({
        scope: leased.scope,
        launchToken: "testtoken",
        expectedInstance: leased.id,
        timeoutSeconds: 0,
      }),
    ).resolves.toBeNull();

    registry.register(
      "/tmp/spawned",
      "role:implementer launch:testtoken",
      scope,
      "/tmp/spawned",
      leased.id,
    );
    expect(registry.get(leased.id)).toMatchObject({
      id: leased.id,
      scope: leased.scope,
      adopted: true,
      label: "role:implementer launch:testtoken",
    });
    expect(registry.list(leased.scope)).toContainEqual(
      expect.objectContaining({ id: leased.id, label: "role:implementer launch:testtoken" }),
    );

    await expect(
      herdrSpawner.waitForLaunchInstanceForTesting({
        scope: leased.scope,
        launchToken: "testtoken",
        expectedInstance: leased.id,
        timeoutSeconds: 0,
      }),
    ).resolves.toMatchObject({ id: leased.id, adopted: 1 });
  });

  test("workspace_identity does not own child process transport calls", () => {
    const source = readFileSync(join(repoRoot, "src", "workspace_identity.ts"), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("spawnSync");
  });

  test("deregister sweeps the instance's published identity rows", () => {
    workspaceIdentity.registerBackend(syntheticBackend("alpha"));
    const inst = registry.register("/tmp/sweep-de", "identity:personal", "scope-deregister-sweep");
    const peer = registry.register("/tmp/sweep-de-peer", "identity:personal", "scope-deregister-sweep");

    const key = workspaceBackend.identityKey("alpha", inst.id);
    const peerKey = workspaceBackend.identityKey("alpha", peer.id);
    kv.set(inst.scope, key, JSON.stringify({ backend: "alpha", handle: "alpha-1" }), inst.id);
    kv.set(peer.scope, peerKey, JSON.stringify({ backend: "alpha", handle: "alpha-2" }), peer.id);

    registry.deregister(inst.id);

    expect(kv.get(inst.scope, key)).toBeNull();
    expect(kv.get(peer.scope, peerKey)).not.toBeNull();
  });

  test("stale-reclaim cleanup also sweeps identity rows", async () => {
    const cleanup = await import("../src/cleanup");
    workspaceIdentity.registerBackend(syntheticBackend("alpha"));
    const inst = registry.register("/tmp/sweep-stale", "identity:personal", "scope-stale-sweep");

    const key = workspaceBackend.identityKey("alpha", inst.id);
    kv.set(inst.scope, key, JSON.stringify({ backend: "alpha", handle: "alpha-1" }), inst.id);

    db.run("UPDATE instances SET heartbeat = unixepoch() - 600 WHERE id = ?", [inst.id]);

    const result = cleanup.runCleanup({ mode: "manual" });
    expect(result.instances_reclaimed).toBeGreaterThanOrEqual(1);
    expect(result.identity_rows_deleted).toBeGreaterThanOrEqual(1);
    expect(kv.get(inst.scope, key)).toBeNull();
  });

  test("orphan identity rows older than orphanKvTtl are swept by cleanupOrphanKv", async () => {
    const cleanup = await import("../src/cleanup");
    workspaceIdentity.registerBackend(syntheticBackend("alpha"));
    const scope = "scope-identity-orphan-sweep";

    const orphanId = "ghost-instance-id";
    const orphanKey = workspaceBackend.identityKey("alpha", orphanId);
    kv.set(scope, orphanKey, JSON.stringify({ backend: "alpha", handle: "ghost" }), orphanId);

    const stalePast = Math.floor(Date.now() / 1000) - cleanup.CLEANUP_POLICY.orphanKvTtlSecs - 10;
    db.run(
      "UPDATE kv SET updated_at = ? WHERE scope = ? AND key = ?",
      [stalePast, scope, orphanKey],
    );

    const result = cleanup.runCleanup({ mode: "manual" });
    expect(result.kv_keys_deleted).toContain(`${scope}:${orphanKey}`);
    expect(kv.get(scope, orphanKey)).toBeNull();
  });
});
