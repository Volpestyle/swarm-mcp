import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cli = join(repoRoot, "src", "cli.ts");
const decoder = new TextDecoder();

function makeEnv(dbPath: string, extra: Record<string, string> = {}) {
  const personalRoots = [tmpdir(), "/tmp", process.env.SWARM_MCP_PERSONAL_ROOTS]
    .filter(Boolean)
    .join(":");
  return {
    ...process.env,
    SWARM_DB_PATH: dbPath,
    SWARM_MCP_PERSONAL_ROOTS: personalRoots,
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

describe("CLI registration adoption", () => {
  test("register uses SWARM_MCP_SCOPE when --scope is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-register-env-scope-"));
    const dbPath = join(dir, "swarm.db");
    const scope = join(dir, "shared-scope");

    const registered = runCli(
      dbPath,
      [
        "register",
        dir,
        "--label",
        "identity:personal role:researcher",
        "--json",
      ],
      { SWARM_MCP_SCOPE: scope },
    );

    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({ scope });
  });

  test("bootstrap recreates a pruned preassigned instance from env", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-bootstrap-env-instance-"));
    const dbPath = join(dir, "swarm.db");
    const id = "11111111-2222-4333-8444-555555555555";
    const label = "identity:personal role:researcher session:envscope";

    const boot = runCli(dbPath, ["bootstrap", dir, "--json"], {
      SWARM_MCP_INSTANCE_ID: id,
      SWARM_MCP_LABEL: label,
      SWARM_MCP_SCOPE: dir,
      SWARM_MCP_FILE_ROOT: dir,
    });

    expect(boot.exitCode).toBe(0);
    const payload = JSON.parse(boot.stdout) as {
      instance: { id: string; scope: string; label: string };
    };
    expect(payload.instance).toMatchObject({ id, scope: dir, label });
  });

  test("register --adopt-instance-id adopts the lease row and keeps identity rows keyed to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-adopt-register-"));
    const dbPath = join(dir, "swarm.db");
    const lease = runCli(dbPath, [
      "register",
      dir,
      "--label",
      "identity:personal codex platform:cli origin:codex session:abc12345",
      "--scope",
      dir,
      "--lease-seconds",
      "86400",
      "--json",
    ]);
    expect(lease.exitCode).toBe(0);
    const leased = JSON.parse(lease.stdout) as { id: string };

    const key = `identity/workspace/herdr/${leased.id}`;
    const setIdentity = runCli(dbPath, [
      "kv",
      "set",
      key,
      JSON.stringify({ backend: "herdr", handle: "pane-1" }),
      "--scope",
      dir,
      "--as",
      leased.id,
      "--json",
    ]);
    expect(setIdentity.exitCode).toBe(0);

    const adopted = runCli(dbPath, [
      "register",
      dir,
      "--label",
      "identity:personal role:researcher session:abc12345",
      "--scope",
      dir,
      "--adopt-instance-id",
      leased.id,
      "--json",
    ]);
    expect(adopted.exitCode).toBe(0);
    expect((JSON.parse(adopted.stdout) as { id: string }).id).toBe(leased.id);

    const instances = runCli(dbPath, ["instances", "--scope", dir, "--json"]);
    expect(instances.exitCode).toBe(0);
    expect(JSON.parse(instances.stdout)).toHaveLength(1);

    const identities = runCli(dbPath, [
      "kv",
      "list",
      "--scope",
      dir,
      "--prefix",
      "identity/workspace/herdr/",
      "--json",
    ]);
    expect(identities.exitCode).toBe(0);
    expect(JSON.parse(identities.stdout)).toEqual([
      expect.objectContaining({ key }),
    ]);
  });

  test("register --adopt-instance-id falls through when the lease is in another scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-adopt-wrong-scope-"));
    const dbPath = join(dir, "swarm.db");
    const scopeA = join(dir, "scope-a");
    const scopeB = join(dir, "scope-b");
    const lease = register(
      dbPath,
      dir,
      scopeA,
      "identity:personal codex platform:cli origin:codex session:abc12345",
    );

    const adopted = runCli(dbPath, [
      "register",
      dir,
      "--label",
      "identity:personal codex platform:cli origin:codex session:def67890",
      "--scope",
      scopeB,
      "--adopt-instance-id",
      lease.id,
      "--json",
    ]);

    expect(adopted.exitCode).toBe(0);
    expect((JSON.parse(adopted.stdout) as { id: string }).id).not.toBe(lease.id);
    const inScopeA = runCli(dbPath, ["instances", "--scope", scopeA, "--json"]);
    const inScopeB = runCli(dbPath, ["instances", "--scope", scopeB, "--json"]);
    expect(JSON.parse(inScopeA.stdout)).toHaveLength(1);
    expect(JSON.parse(inScopeB.stdout)).toHaveLength(1);
  });

  test("bootstrap --adopt-instance-id returns a snapshot for the adopted lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-adopt-bootstrap-"));
    const dbPath = join(dir, "swarm.db");
    const lease = register(
      dbPath,
      dir,
      dir,
      "identity:personal codex platform:cli origin:codex session:abc12345",
    );

    const boot = runCli(dbPath, [
      "bootstrap",
      dir,
      "--scope",
      dir,
      "--adopt-instance-id",
      lease.id,
      "--json",
    ]);

    expect(boot.exitCode).toBe(0);
    const payload = JSON.parse(boot.stdout) as {
      instance: { id: string };
      peers: unknown[];
      unread_messages: unknown[];
      tasks: unknown;
    };
    expect(payload.instance.id).toBe(lease.id);
    expect(payload.peers).toEqual([]);
    expect(payload.unread_messages).toEqual([]);
    expect(payload.tasks).toBeTruthy();
  });

  test("bootstrap includes configured same-identity work tracker", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-bootstrap-tracker-"));
    const dbPath = join(dir, "swarm.db");
    const inst = register(
      dbPath,
      dir,
      dir,
      "identity:personal codex platform:cli origin:codex session:abc12345",
    );
    const tracker = {
      schema_version: 1,
      identity: "personal",
      provider: "github_issues",
      mcp: "github_personal",
      repo: "Volpestyle/swarm-mcp",
    };
    const set = runCli(dbPath, [
      "kv",
      "set",
      "config/work_tracker/personal",
      JSON.stringify(tracker),
      "--scope",
      dir,
      "--as",
      inst.id,
      "--json",
    ]);
    expect(set.exitCode).toBe(0);

    const boot = runCli(dbPath, [
      "bootstrap",
      dir,
      "--scope",
      dir,
      "--as",
      inst.id,
      "--json",
    ]);

    expect(boot.exitCode).toBe(0);
    const payload = JSON.parse(boot.stdout) as {
      work_tracker: { key: string; value: typeof tracker } | null;
    };
    expect(payload.work_tracker?.key).toBe("config/work_tracker/personal");
    expect(payload.work_tracker?.value).toEqual(tracker);
  });
});

describe("CLI task notifications", () => {
  test("worker commands use SWARM_MCP_SCOPE when --scope is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-env-scope-"));
    const dbPath = join(dir, "swarm.db");
    const planner = register(
      dbPath,
      dir,
      dir,
      "identity:personal mode:gateway role:planner",
    );
    const worker = register(dbPath, dir, dir, "identity:personal role:researcher");

    const requested = runCli(dbPath, [
      "request-task",
      "research",
      "Scoped task",
      "--scope",
      dir,
      "--as",
      planner.id,
      "--json",
    ]);
    expect(requested.exitCode).toBe(0);
    const taskId = JSON.parse(requested.stdout).id as string;

    const env = { SWARM_MCP_SCOPE: dir };
    const claimed = runCli(
      dbPath,
      [
        "claim",
        taskId,
        "--as",
        worker.id,
        "--force",
        "--json",
      ],
      env,
    );
    expect(claimed.exitCode).toBe(0);

    const updated = runCli(
      dbPath,
      [
        "update-task",
        taskId,
        "--status",
        "done",
        "--note",
        "completed through env scope",
        "--as",
        worker.id,
        "--json",
      ],
      env,
    );
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      status: "done",
      task_id: taskId,
    });
  });

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

  test("dispatch --wait-for-completion returns a completion timeout snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-completion-wait-"));
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
      "--wait-for-completion",
      "0.01",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      task: { status: string };
      completion: { status: string; task: { status: string } };
    };
    expect(payload.status).toBe("no_worker");
    expect(payload.task.status).toBe("open");
    expect(payload.completion.status).toBe("timeout");
    expect(payload.completion.task.status).toBe("open");
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
      harness: "clowd",
      role: "implementer",
      label: "identity:personal",
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
        "printf 'HERDR_SOCKET_PATH=%s\\n' \"$HERDR_SOCKET_PATH\" >> \"$HERDR_LOG\"",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"split\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-test\"}}}'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"pane\" ] && [ \"$2\" = \"get\" ]; then",
        "  printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"pane-test\",\"agent_status\":\"idle\"}}}'",
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
    const personalRoot = resolve(repoRoot, "..");

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
        HERDR_SOCKET_PATH: "",
        HERDR_LOG: herdrLog,
        HERDR_PANE_ID: "pane-root",
        SWARM_HERDR_BIN: fakeHerdr,
        SWARM_MCP_PERSONAL_ROOTS: personalRoot,
      },
    );

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      spawner: string;
      task_id: string;
      expected_instance: string;
      launch_token: string;
      ui_command_id?: number;
      kickstart_prompt?: { message_sent?: boolean; nudged?: boolean; recipient?: string };
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
    expect(payload.workspace_handle).toMatchObject({
      backend: "herdr",
      handle_kind: "pane",
      handle: "pane-test",
      pane_id: "pane-test",
    });

    const log = readFileSync(herdrLog, "utf8");
    const expectedSocket = join(
      process.env.HERMES_HOST_HOME || process.env.HOME || homedir(),
      ".config",
      "herdr",
      "sessions",
      "personal",
      "herdr.sock",
    );
    expect(log).toContain("pane split pane-root --direction right");
    expect(log).toContain("pane run pane-test /bin/sh");
    expect(log).toContain("pane get pane-test");
    expect(log).toContain("A peer sent you a swarm message for task");
    expect(payload.kickstart_prompt).toMatchObject({
      message_sent: true,
      nudged: true,
      recipient: payload.expected_instance,
    });
    expect(log).toContain(`HERDR_SOCKET_PATH=${expectedSocket}`);
    const launchScriptPath = log.match(/pane run pane-test \/bin\/sh '([^']+)'/)?.[1];
    expect(launchScriptPath).toBeTruthy();
    const launchScript = readFileSync(launchScriptPath!, "utf8");
    expect(launchScript).toContain(`HERDR_SOCKET_PATH='${expectedSocket}'`);
    expect(launchScript).toContain("SWARM_MCP_SCOPE=");
    expect(launchScript).toContain("SWARM_MCP_LABEL=");
    expect(launchScript).toContain(`SWARM_DB_PATH='${dbPath}'`);
    expect(launchScript).toContain(`SWARM_MCP_PERSONAL_ROOTS='${personalRoot}'`);
    expect(launchScript).toContain("AGENT_IDENTITY='personal'");
    expect(launchScript).toContain("SWARM_CC_LABEL=");
    expect(launchScript).toContain("identity:personal");
    expect(launchScript).toContain(`launch:${payload.launch_token}`);
    expect(launchScript).toContain("exec clowd");
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

    const rows = runCli(dbPath, ["locks", "--scope", dir, "--json"]);
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

    const after = runCli(dbPath, ["locks", "--scope", dir, "--json"]);
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

describe("CLI doctor", () => {
  test("doctor reports OK on a fresh db and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-doctor-"));
    const dbPath = join(dir, "swarm.db");
    const result = runCli(dbPath, ["doctor", "--scope", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("swarm-mcp doctor");
    expect(result.stdout).toContain("binary:");
    expect(result.stdout).toContain("database:");
    expect(result.stdout).toContain("scope:");
    expect(result.stdout).toContain("live_instances:");
    expect(result.stdout).toContain("stale_instances:");
    expect(result.stdout).toContain("skill_discovery:");
    expect(result.stdout).toContain("plugin_discovery:");
    expect(result.stdout).toContain("env:");
    expect(result.stdout).toContain("All FAIL-class checks passed.");
  });

  test("doctor --json emits a structured report with checks array", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-cmd-doctor-json-"));
    const dbPath = join(dir, "swarm.db");
    const result = runCli(dbPath, ["doctor", "--scope", dir, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      failed: number;
      scope: string;
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.failed).toBe(0);
    expect(payload.scope).toBe(dir);
    const names = payload.checks.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "binary",
        "database",
        "env",
        "live_instances",
        "plugin_discovery",
        "scope",
        "skill_discovery",
        "stale_instances",
      ].sort(),
    );
    const db = payload.checks.find((c) => c.name === "database");
    expect(db?.status).toBe("ok");
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
