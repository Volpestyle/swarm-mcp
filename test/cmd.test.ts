import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  test("dispatch --help prints help instead of failing flag parsing", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-help-"));
    const result = runCli(join(dir, "swarm.db"), ["dispatch", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("swarm-mcp dispatch");
    expect(result.stderr).toBe("");
  });

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

  test("dispatch falls back to a live generalist before spawning", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-generalist-"));
    const dbPath = join(dir, "swarm.db");
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    const generalist = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:generalist",
    );

    const result = runCli(dbPath, [
      "dispatch",
      "Discuss project state",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      recipient: string;
      spawner?: string;
    };
    expect(payload.status).toBe("dispatched");
    expect(payload.recipient).toBe(generalist.id);
    expect(payload.spawner).toBeUndefined();
  });

  test("dispatch prefers an exact role over a generalist", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-exact-role-"));
    const dbPath = join(dir, "swarm.db");
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    register(dbPath, dir, dir, "identity:personal role:generalist");
    const implementer = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:implementer",
    );

    const result = runCli(dbPath, [
      "dispatch",
      "Discuss project state",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { status: string; recipient: string };
    expect(payload.status).toBe("dispatched");
    expect(payload.recipient).toBe(implementer.id);
  });

  test("dispatch can explicitly use the legacy swarm-ui spawner", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-ui-spawner-"));
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
      "--spawner",
      "swarm-ui",
      "--wait",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      spawner: string;
      ui_command_id?: number;
      ui_command?: { payload: string };
    };
    expect(payload.status).toBe("spawn_in_flight");
    expect(payload.spawner).toBe("swarm-ui");
    expect(payload.ui_command_id).toBeGreaterThan(0);
    expect(JSON.parse(payload.ui_command?.payload ?? "{}")).toMatchObject({
      harness: "claude",
      role: "implementer",
    });
  });

  test("dispatch defaults to the herdr spawner", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-herdr-spawner-"));
    const dbPath = join(dir, "swarm.db");
    const herdrLog = join(dir, "herdr.log");
    const fakeHerdr = join(dir, "fake-herdr");
    writeFileSync(
      fakeHerdr,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$HERDR_LOG\"",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"split\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-test\"}}}'",
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
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );

    const result = runCli(
      dbPath,
      [
        "dispatch",
        "Discuss project state",
        "--scope",
        dir,
        "--as",
        gateway.id,
        "--wait",
        "0",
        "--json",
      ],
      {
        AGENT_IDENTITY: "personal",
        HERDR_LOG: herdrLog,
        HERDR_PANE_ID: "pane-root",
        SWARM_HERDR_BIN: fakeHerdr,
      },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      spawner: string;
      launch_token: string;
      ui_command_id?: number;
      workspace_handle?: { backend: string; pane_id: string };
    };
    expect(payload.status).toBe("spawn_in_flight");
    expect(payload.spawner).toBe("herdr");
    expect(payload.ui_command_id).toBeUndefined();
    expect(payload.workspace_handle).toEqual({ backend: "herdr", pane_id: "pane-test" });

    const log = readFileSync(herdrLog, "utf8");
    expect(log).toContain("pane split pane-root --direction right");
    expect(log).toContain("pane run pane-test");
    expect(log).toContain("SWARM_MCP_SCOPE=");
    expect(log).toContain("SWARM_CC_LABEL=");
    expect(log).toContain(`launch:${payload.launch_token}`);
    expect(log).toContain("clowd");
  });

  test("dispatch rejects unknown spawner before creating work", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-bad-spawner-"));
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
      "--spawner",
      "unknown",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown dispatch spawner "unknown"');

    const tasks = runCli(dbPath, ["tasks", "--scope", dir, "--json"]);
    expect(tasks.exitCode).toBe(0);
    expect(JSON.parse(tasks.stdout)).toEqual([]);
  });
});
