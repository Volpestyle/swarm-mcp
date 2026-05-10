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

describe("CLI task notifications", () => {
  test("request-task prompts an explicit assignee", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-request-task-prompt-"));
    const dbPath = join(dir, "swarm.db");
    const planner = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    const worker = register(dbPath, dir, dir, "identity:personal role:implementer");

    const result = runCli(dbPath, [
      "request-task",
      "implement",
      "Assigned task",
      "--scope",
      dir,
      "--as",
      planner.id,
      "--assignee",
      worker.id,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      prompt?: { message_sent: boolean; nudged: boolean };
    };
    expect(payload.status).toBe("claimed");
    expect(payload.prompt).toMatchObject({ message_sent: true, nudged: false });

    const messages = runCli(dbPath, [
      "messages",
      "--scope",
      dir,
      "--to",
      worker.id,
      "--json",
    ]);
    expect(messages.exitCode).toBe(0);
    const rows = JSON.parse(messages.stdout) as Array<{ content: string; read: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("[task:");
    expect(rows[0].content).toContain("New implement task assigned to you");
    expect(rows[0].read).toBe(0);
  });
});

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

  test("dispatch --force-spawn bypasses live worker matching", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-force-spawn-"));
    const dbPath = join(dir, "swarm.db");
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    register(dbPath, dir, dir, "identity:personal role:generalist");

    const result = runCli(dbPath, [
      "dispatch",
      "Discuss project state",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--spawner",
      "swarm-ui",
      "--force-spawn",
      "--wait",
      "0",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      spawner: string;
      recipient?: string;
      ui_command_id?: number;
    };
    expect(payload.status).toBe("spawn_in_flight");
    expect(payload.spawner).toBe("swarm-ui");
    expect(payload.recipient).toBeUndefined();
    expect(payload.ui_command_id).toBeGreaterThan(0);
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
      workspace_handle?: {
        backend: string;
        handle_kind: string;
        handle: string;
        pane_id: string;
      };
    };
    expect(payload.status).toBe("spawn_in_flight");
    expect(payload.spawner).toBe("herdr");
    expect(payload.ui_command_id).toBeUndefined();
    expect(payload.workspace_handle).toEqual({
      backend: "herdr",
      handle_kind: "pane",
      handle: "pane-test",
      pane_id: "pane-test",
    });

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

describe("CLI workspace identity bridge", () => {
  function writeFakeHerdr(dir: string) {
    const fakeHerdr = join(dir, "fake-herdr");
    const herdrLog = join(dir, "herdr.log");
    writeFileSync(
      fakeHerdr,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$HERDR_LOG\"",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"get\" ]; then",
        "  case \"$3\" in",
        "    pane-alias|pane-canonical)",
        "      printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-canonical\",\"agent_status\":\"idle\",\"workspace_id\":\"workspace-1\",\"tab_id\":\"workspace-1:1\"}}}'",
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"run\" ]; then",
        "  if [ \"$3\" = \"pane-canonical\" ]; then exit 0; fi",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(fakeHerdr, 0o755);
    return { fakeHerdr, herdrLog };
  }

  test("prompt-peer repairs stale workspace handle aliases before nudging", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-prompt-herdr-"));
    const dbPath = join(dir, "swarm.db");
    const { fakeHerdr, herdrLog } = writeFakeHerdr(dir);
    const sender = register(dbPath, dir, dir, "identity:personal role:reviewer");
    const recipient = register(dbPath, dir, dir, "identity:personal role:implementer");
    const key = `identity/workspace/herdr/${recipient.id}`;

    const set = runCli(dbPath, [
      "kv",
      "set",
      key,
      JSON.stringify({
        backend: "herdr",
        handle_kind: "pane",
        handle: "pane-alias",
        socket_path: "/tmp/herdr.sock",
      }),
      "--scope",
      dir,
      "--as",
      recipient.id,
    ]);
    expect(set.exitCode).toBe(0);

    const result = runCli(
      dbPath,
      [
        "prompt-peer",
        "--to",
        recipient.id,
        "--message",
        "check your swarm inbox",
        "--scope",
        dir,
        "--as",
        sender.id,
        "--json",
      ],
      { SWARM_HERDR_BIN: fakeHerdr, HERDR_LOG: herdrLog },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      nudged: boolean;
      pane_id: string;
      workspace_handle: string;
      identity_repaired: boolean;
    };
    expect(payload.nudged).toBe(true);
    expect(payload.workspace_handle).toBe("pane-canonical");
    expect(payload.pane_id).toBe("pane-canonical");
    expect(payload.identity_repaired).toBe(true);

    const row = runCli(dbPath, ["kv", "get", key, "--scope", dir, "--json"]);
    expect(row.exitCode).toBe(0);
    const value = JSON.parse(JSON.parse(row.stdout).value) as {
      pane_id: string;
      handle: string;
      handle_aliases: string[];
      pane_aliases: string[];
      workspace_id: string;
      tab_id: string;
    };
    expect(value.handle).toBe("pane-canonical");
    expect(value.handle_aliases).toContain("pane-alias");
    expect(value.pane_id).toBe("pane-canonical");
    expect(value.pane_aliases).toContain("pane-alias");
    expect(value.workspace_id).toBe("workspace-1");
    expect(value.tab_id).toBe("workspace-1:1");

    const log = readFileSync(herdrLog, "utf8");
    expect(log).toContain("pane get pane-alias");
    expect(log).toContain("pane run pane-canonical");
  });

  test("resolve-workspace-handle maps a backend handle back to a swarm instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-resolve-workspace-"));
    const dbPath = join(dir, "swarm.db");
    const { fakeHerdr, herdrLog } = writeFakeHerdr(dir);
    const recipient = register(dbPath, dir, dir, "identity:personal role:implementer");
    const key = `identity/workspace/herdr/${recipient.id}`;
    const set = runCli(dbPath, [
      "kv",
      "set",
      key,
      JSON.stringify({
        backend: "herdr",
        handle_kind: "pane",
        handle: "pane-alias",
        socket_path: "/tmp/herdr.sock",
      }),
      "--scope",
      dir,
      "--as",
      recipient.id,
    ]);
    expect(set.exitCode).toBe(0);

    const result = runCli(
      dbPath,
      [
        "resolve-workspace-handle",
        "pane-canonical",
        "--backend",
        "herdr",
        "--kind",
        "pane",
        "--scope",
        dir,
        "--json",
      ],
      { SWARM_HERDR_BIN: fakeHerdr, HERDR_LOG: herdrLog },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      instance_id: string;
      canonical_handle: string;
      matches: Array<{ instance_id: string; handle: string; identity_repaired: boolean }>;
    };
    expect(payload.instance_id).toBe(recipient.id);
    expect(payload.canonical_handle).toBe("pane-canonical");
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]).toMatchObject({
      instance_id: recipient.id,
      handle: "pane-canonical",
      identity_repaired: true,
    });

    const log = readFileSync(herdrLog, "utf8");
    expect(log).toContain("pane get pane-canonical");
    expect(log).toContain("pane get pane-alias");
  });
});

describe("CLI file path normalization", () => {
  test("lock and unlock normalize relative paths through the registered instance root", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-lock-paths-"));
    const dbPath = join(dir, "swarm.db");
    const worker = register(dbPath, dir, dir, "identity:personal role:implementer");
    const expectedFile = join(dir, "src/index.ts");

    const lock = runCli(dbPath, [
      "lock",
      "src/index.ts",
      "--scope",
      dir,
      "--as",
      worker.id,
      "--json",
    ]);
    expect(lock.exitCode).toBe(0);

    const rows = runCli(dbPath, ["context", "--scope", dir, "--json"]);
    expect(rows.exitCode).toBe(0);
    expect(JSON.parse(rows.stdout)).toMatchObject([
      { type: "lock", instance_id: worker.id, file: expectedFile },
    ]);

    const unlock = runCli(dbPath, [
      "unlock",
      "src/index.ts",
      "--scope",
      dir,
      "--as",
      worker.id,
      "--json",
    ]);
    expect(unlock.exitCode).toBe(0);
    expect(JSON.parse(unlock.stdout)).toMatchObject({ ok: true, file: expectedFile });

    const after = runCli(dbPath, ["context", "--scope", dir, "--json"]);
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual([]);
  });

  test("request-task and dispatch normalize --file paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-task-paths-"));
    const dbPath = join(dir, "swarm.db");
    const gateway = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    const expectedFile = join(dir, "src/index.ts");

    const requested = runCli(dbPath, [
      "request-task",
      "fix",
      "Fix bug",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--file",
      "src/index.ts",
      "--json",
    ]);
    expect(requested.exitCode).toBe(0);
    expect(JSON.parse(requested.stdout).task.files).toEqual([expectedFile]);

    const dispatched = runCli(dbPath, [
      "dispatch",
      "Fix other bug",
      "--scope",
      dir,
      "--as",
      gateway.id,
      "--file",
      "src/index.ts",
      "--no-spawn",
      "--json",
    ]);
    expect(dispatched.exitCode).toBe(0);
    expect(JSON.parse(dispatched.stdout).task.files).toEqual([expectedFile]);
  });
});

describe("CLI claim and update-task", () => {
  test("claim transitions an open task to in_progress and update-task moves it to a terminal status", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cli-claim-"));
    const dbPath = join(dir, "swarm.db");
    const requester = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:planner",
    );
    const worker = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:implementer",
    );

    const requestResult = runCli(dbPath, [
      "request-task",
      "implement",
      "test work",
      "--scope",
      dir,
      "--as",
      requester.id,
      "--json",
    ]);
    expect(requestResult.exitCode).toBe(0);
    const taskId = (JSON.parse(requestResult.stdout) as { id: string }).id;

    const claimResult = runCli(dbPath, [
      "claim",
      taskId,
      "--scope",
      dir,
      "--as",
      worker.id,
      "--json",
    ]);
    expect(claimResult.exitCode).toBe(0);
    const claimPayload = JSON.parse(claimResult.stdout) as { ok: boolean };
    expect(claimPayload.ok).toBe(true);

    const tasksAfterClaim = JSON.parse(
      runCli(dbPath, ["tasks", "--scope", dir, "--json"]).stdout,
    ) as Array<{ id: string; status: string; assignee: string | null }>;
    const taskAfterClaim = tasksAfterClaim.find((t) => t.id === taskId);
    expect(taskAfterClaim?.status).toBe("in_progress");
    expect(taskAfterClaim?.assignee).toBe(worker.id);

    const updateResult = runCli(dbPath, [
      "update-task",
      taskId,
      "--status",
      "done",
      "--note",
      "all good",
      "--scope",
      dir,
      "--as",
      worker.id,
      "--json",
    ]);
    expect(updateResult.exitCode).toBe(0);

    const tasksAfterUpdate = JSON.parse(
      runCli(dbPath, ["tasks", "--scope", dir, "--json"]).stdout,
    ) as Array<{ id: string; status: string }>;
    const taskAfterUpdate = tasksAfterUpdate.find((t) => t.id === taskId);
    expect(taskAfterUpdate?.status).toBe("done");
  });

  test("claim fails with a non-zero exit code for a non-existent task (text mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cli-claim-missing-"));
    const dbPath = join(dir, "swarm.db");
    const worker = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:implementer",
    );

    const result = runCli(dbPath, [
      "claim",
      "00000000-0000-0000-0000-000000000000",
      "--scope",
      dir,
      "--as",
      worker.id,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Task not found");
  });

  test("update-task requires a valid --status flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cli-update-bad-"));
    const dbPath = join(dir, "swarm.db");
    const worker = register(
      dbPath,
      dir,
      dir,
      "identity:personal role:implementer",
    );

    const result = runCli(dbPath, [
      "update-task",
      "any-id",
      "--scope",
      dir,
      "--as",
      worker.id,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--status one of done|failed|cancelled");
  });
});
