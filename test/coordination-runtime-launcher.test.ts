import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { CoordinationClient } from "../src/coordination/ipc";

test("runtime launcher composes private state, owner startup, replay and fenced resume", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const ownerPath = join(
    mkdtempSync(resolve("dist/test/runtime-launch-")),
    "owner.mjs",
  );
  await build({
    entryPoints: ["src/coordination/owner-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: ownerPath,
  });
  const root = mkdtempSync(join(tmpdir(), "runtime-launcher-"));
  const options = {
    stateDirectory: join(root, "private"),
    nodePath: Bun.which("node")!,
    ownerPath,
    identity: {
      projectRoot: root,
      profile: "fixture",
      directory: root,
      fileRoot: root,
      allowedRoots: [root],
    },
    host: "opencode" as const,
    hostSessionId: "native-session",
    incarnation: "first-launch",
  };
  const first = await enrollRuntime(options);
  const old = await CoordinationClient.connect(
    first.environment.SWARM_COORDINATOR_ENDPOINT,
    first.environment.SWARM_SESSION_CAPABILITY,
  );
  try {
    expect(first.environment.SWARM_SCOPE).toBe(first.scope);
    expect(Object.keys(first.environment).sort()).toEqual([
      "SWARM_COORDINATOR_ENDPOINT",
      "SWARM_SCOPE",
      "SWARM_SESSION_CAPABILITY",
    ]);
    const retry = await enrollRuntime(options);
    expect(retry.actor).toBe(first.actor);
    expect(retry.sessionId).toBe(first.sessionId);
    expect(retry.replayed).toBe(true);
    expect(retry.launchedOwner).toBeUndefined();
    const resumed = await enrollRuntime({
      ...options,
      incarnation: "second-launch",
    });
    expect(resumed.actor).toBe(first.actor);
    expect(resumed.generation).toBe(2);
    expect(resumed.environment.SWARM_SESSION_CAPABILITY).not.toBe(
      first.environment.SWARM_SESSION_CAPABILITY,
    );
    const stale = await old
      .request({ op: "bootstrap" })
      .catch((error) => error);
    expect(stale).toMatchObject({ code: "stale_session" });
    const other = await enrollRuntime({
      ...options,
      identity: { ...options.identity, profile: "other-profile" },
    });
    expect(other.scope).not.toBe(first.scope);
    expect(other.actor).not.toBe(first.actor);
  } finally {
    old.close();
    const child = first.launchedOwner!;
    if (child.exitCode === null && child.signalCode === null) {
      child.ref();
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
}, 30000);
