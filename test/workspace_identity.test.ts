import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WorkspaceBackend,
  WorkspaceHandleInfo,
  WorkspaceIdentity,
} from "../src/workspace_backend";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-workspace-identity-")),
  "swarm.db",
);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const { db } = await import("../src/db");
const dispatch = await import("../src/dispatch");
const kv = await import("../src/kv");
const registry = await import("../src/registry");
const workspaceBackend = await import("../src/workspace_backend");
const workspaceIdentity = await import("../src/workspace_identity");

type WakeCall = {
  backend: string;
  handle: string;
  prompt: string;
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

function syntheticBackend(name: string, wakeCalls: WakeCall[] = []): WorkspaceBackend {
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
        agent_status: "idle",
      };
      return { ok: true, value: info };
    },

    wakeHandle({ handle, prompt }) {
      wakeCalls.push({ backend: name, handle, prompt });
      return { ok: true, value: {} };
    },

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
  db.exec("DELETE FROM context");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM kv");
  db.exec("DELETE FROM kv_scope_updates");
  db.exec("DELETE FROM instances");
  workspaceIdentity.clearBackendsForTesting();
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
});
