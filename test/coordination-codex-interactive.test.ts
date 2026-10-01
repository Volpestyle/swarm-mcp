import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { herdrDispatchProvider } from "../src/coordination/herdr-dispatch";

// The shipped worker runs on Node. Bun replaces `ws` with a different transport
// that does not support its ws+unix endpoint, so exercise the real Node client.
let probeBuild: Promise<void> | undefined;
async function nativeProbe(environment: Record<string, string>) {
  const probe = resolve("dist/test/codex-native-probe.mjs");
  await (probeBuild ??= (async () => {
    await mkdir(resolve("dist/test"), { recursive: true });
    await build({ entryPoints: ["test/fixtures/codex-native-probe.ts"], outfile: probe, bundle: true, platform: "node", format: "esm", packages: "external" });
  })());
  const root = realpathSync(await mkdtemp("/tmp/swarm-codex-native-"));
  const command = join(root, "codex-fixture");
  await writeFile(command, "#!/usr/bin/env node\n" + await readFile("test/fixtures/codex-native-worker-harness.cjs", "utf8"), { mode: 0o700 });
  try {
    const child = spawn(Bun.which("node")!, [probe, root, command], { env: { ...process.env, FIXTURE_LOG: join(root, "observations.jsonl"), SWARM_TEST_NODE_MODULES: resolve("node_modules"), SWARM_TEST_FIXTURES: resolve("test/fixtures"), ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { errors += bytes; });
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    expect(code, errors).toBe(0);
    return { result: JSON.parse(output), observations: await readFile(join(root, "observations.jsonl"), "utf8") };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test.each(["FIXTURE_CODEX_WRONG_DIRECTORY", "FIXTURE_CODEX_TWO_THREADS"])("native Codex refuses %s before any model input", async flag => {
  if (process.platform === "win32") return;
  const fixture = await nativeProbe({ [flag]: "1" });
  expect(fixture.result.error).toMatch(/mismatch|ambiguous/);
  expect(fixture.observations).not.toContain('"turn_start"');
});

test("lost native Codex delivery reply stays uncertain and sends only one turn", async () => {
  if (process.platform === "win32") return;
  const fixture = await nativeProbe({ FIXTURE_LOST_TURN_REPLY: "1", FIXTURE_SKIP_MODEL: "1" });
  expect(fixture.result.error).toMatch(/delivery is uncertain/);
  expect(fixture.observations.match(/"turn_start"/g)).toHaveLength(1);
});

test("a retained stream route cannot start a new headless Herdr worker", async () => {
  const provider = herdrDispatchProvider({} as never, {} as never, { id: "legacy", workerMode: "stream", stateDirectory: "/tmp", profile: "p", socketPath: "/tmp/socket", herdrPath: "/bin/h", nodePath: "/bin/n", workerPath: "/bin/w", claudePath: "/bin/c", capabilities: [], capacity: 1 });
  await expect(provider.start({ token: "fixture", taskId: "fixture", intent: {} as never, executionMode: "stream" }, new AbortController().signal)).rejects.toMatchObject({ code: "headless_workers_retired" });
});
