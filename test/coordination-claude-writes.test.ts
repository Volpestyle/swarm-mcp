import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareClaudeLaunch } from "../src/coordination/claude-launcher";
import { CoordinationClient } from "../src/coordination/ipc";

test("Claude write hooks use the trusted launcher binding", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const bundles = mkdtempSync(resolve("dist/test/claude-legacy-"));
  for (const [source, file] of [
    ["owner-cli", "owner.mjs"],
    ["client-cli", "client.mjs"],
    ["mcp-cli", "mcp.mjs"],
    ["claude-hook-cli", "hook.mjs"],
  ])
    await build({
      entryPoints: [`src/coordination/${source}.ts`],
      outfile: join(bundles, file!),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
    });
  const root = mkdtempSync(join(tmpdir(), "claude-legacy-"));
  const sessionId = randomUUID();
  const marker = join(root, "legacy-was-called");
  const trap = join(root, "legacy-trap.mjs");
  writeFileSync(
    trap,
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"called");`,
  );
  const launch = await prepareClaudeLaunch({
    stateDirectory: join(root, "private"),
    nodePath: Bun.which("node")!,
    ownerPath: join(bundles, "owner.mjs"),
    hookPath: join(bundles, "hook.mjs"),
    clientPath: join(bundles, "client.mjs"),
    mcpPath: join(bundles, "mcp.mjs"),
    hostSessionId: sessionId,
    incarnation: "test",
    identity: {
      projectRoot: root,
      directory: root,
      fileRoot: root,
      allowedRoots: [root],
      profile: "fixture",
    },
  });
  const client = await CoordinationClient.connect(
    launch.environment.SWARM_COORDINATOR_ENDPOINT,
    launch.environment.SWARM_SESSION_CAPABILITY,
  );
  const quoted = (path: string) =>
    "'" + path.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("SWARM_")),
    ),
    ...launch.environment,
    AGENT_IDENTITY: "fixture",
    SWARM_MCP_BIN: `${quoted(Bun.which("node")!)} ${quoted(trap)}`,
  };
  const payload = {
    session_id: sessionId,
    tool_use_id: "write-fixture",
    tool_name: "Write",
    tool_input: { file_path: join(root, "target.txt") },
    cwd: root,
    source: "startup",
  };
  const run = async (file: string) => {
    const child = Bun.spawn({
      cmd: [
        (Bun.which("python3") ?? Bun.which("python"))!,
        resolve(`integrations/claude-code/hooks/${file}.py`),
      ],
      cwd: root,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return stdout;
  };
  try {
    expect(launch.arguments.join(" ")).not.toContain(
      launch.environment.SWARM_SESSION_CAPABILITY,
    );
    expect(await client.request({ op: "bootstrap" })).toMatchObject({
      actor: launch.actor,
    });
    expect(await run("pre_tool_use")).toBe("");
    const active = (await client.request({ op: "reservations" })) as unknown[];
    expect(active.length).toBe(1);
    expect(await run("post_tool_use")).toBe("");
    expect(await client.request({ op: "reservations" })).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  } finally {
    client.close();
    if (launch.launchedOwner) {
      launch.launchedOwner.ref();
      const exited = once(launch.launchedOwner, "exit");
      launch.launchedOwner.kill();
      await exited;
    }
  }
}, 15000);
