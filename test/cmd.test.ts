import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cli = join(repoRoot, "src", "cli.ts");
const decoder = new TextDecoder();

function makeEnv(dbPath: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_INSTANCE_ID: "",
    ...extra,
  };
}

function runCli(dbPath: string, args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", cli, ...args],
    cwd: repoRoot,
    env: makeEnv(dbPath, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function register(dbPath: string, dir: string, scope: string, label: string) {
  const result = runCli(dbPath, [
    "register",
    dir,
    "--label",
    label,
    "--scope",
    scope,
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as { id: string };
}

describe("CLI dispatch spawn authority", () => {
  test("rejects non-gateway requesters", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-worker-"));
    const dbPath = join(dir, "swarm.db");
    const worker = register(dbPath, dir, dir, "identity:personal role:implementer");

    const result = runCli(dbPath, [
      "dispatch",
      "Discuss project state",
      "--scope",
      dir,
      "--as",
      worker.id,
      "--no-spawn",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dispatch is gateway-only");
  });

  test("allows gateway requesters", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-gateway-"));
    const dbPath = join(dir, "swarm.db");
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );

    const result = runCli(dbPath, [
      "dispatch",
      "Discuss project state",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--no-spawn",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no role:implementer worker is live");
  });
});
