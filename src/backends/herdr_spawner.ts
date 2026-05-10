import { spawnSync } from "node:child_process";
import * as context from "../context";
import * as registry from "../registry";
import type { SpawnerBackend } from "../spawner_backend";

type InstanceRef = {
  id: string;
  label: string | null;
  adopted?: boolean | number;
};

function isAdopted(inst: InstanceRef) {
  return inst.adopted === true || inst.adopted === 1;
}

function identityDefaultHarness() {
  const identity = (
    process.env.AGENT_IDENTITY ??
    process.env.SWARM_IDENTITY ??
    process.env.SWARM_CC_IDENTITY ??
    process.env.SWARM_CODEX_IDENTITY ??
    ""
  ).trim().toLowerCase();
  if (identity === "personal") return "clowd";
  if (identity === "work") return "clawd";
  return "claude";
}

function cleanLabelValue(value: string, fallback: string) {
  const clean = value.trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  return clean || fallback;
}

function labelWithLaunchToken(opts: {
  role: string;
  harness: string;
  launchToken: string;
  extra?: string | null;
}) {
  const tokens = [
    `role:${cleanLabelValue(opts.role, "worker")}`,
    `provider:${cleanLabelValue(opts.harness, "agent")}`,
    `launch:${opts.launchToken}`,
  ];
  if (opts.extra?.trim()) tokens.push(...opts.extra.trim().split(/\s+/));
  return Array.from(new Set(tokens)).join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runHerdrCommand(args: string[], timeout = 10_000) {
  const bin = process.env.SWARM_HERDR_BIN?.trim() || "herdr";
  return spawnSync(bin, args, {
    encoding: "utf8",
    env: process.env,
    timeout,
  });
}

function outputText(value: string | Buffer | null | undefined) {
  return typeof value === "string" ? value : (value?.toString("utf8") ?? "");
}

function processError(proc: ReturnType<typeof spawnSync>) {
  return (
    proc.error?.message ||
    outputText(proc.stderr).trim() ||
    outputText(proc.stdout).trim() ||
    `command exited ${proc.status ?? "unknown"}`
  );
}

function paneIdFromSplit(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    const pane =
      payload?.result?.pane?.pane_id ??
      payload?.result?.pane?.id ??
      payload?.pane_id ??
      payload?.id;
    return typeof pane === "string" && pane.trim() ? pane.trim() : "";
  } catch {
    return "";
  }
}

function parentPane() {
  return (
    process.env.SWARM_HERDR_PARENT_PANE?.trim() ||
    process.env.HERDR_PANE_ID?.trim() ||
    process.env.HERDR_PANE?.trim() ||
    ""
  );
}

function launchCommand(opts: {
  scope: string;
  cwd: string;
  role: string;
  label: string;
  harness: string;
  instanceId: string;
}) {
  const env: Record<string, string> = {
    SWARM_MCP_INSTANCE_ID: opts.instanceId,
    SWARM_MCP_SCOPE: opts.scope,
    SWARM_MCP_FILE_ROOT: opts.cwd,
    SWARM_MCP_DIRECTORY: opts.cwd,
    SWARM_AGENT_ROLE: opts.role,
    SWARM_CC_AGENT_ROLE: opts.role,
    SWARM_CODEX_AGENT_ROLE: opts.role,
    SWARM_CC_LABEL: opts.label,
    SWARM_CODEX_LABEL: opts.label,
    SWARM_HERMES_LABEL: opts.label,
  };
  if (process.env.SWARM_MCP_BIN?.trim()) {
    env.SWARM_MCP_BIN = process.env.SWARM_MCP_BIN.trim();
  }
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `cd ${shellQuote(opts.cwd)} && ${assignments} ${opts.harness}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLaunchInstanceForTesting(opts: {
  scope: string;
  launchToken: string;
  expectedInstance: string;
  timeoutSeconds: number;
}) {
  const { scope, launchToken, expectedInstance, timeoutSeconds } = opts;
  const deadline = Date.now() + Math.max(0, timeoutSeconds * 1000);
  const token = `launch:${launchToken}`;
  do {
    const found = (registry.list(scope) as InstanceRef[]).find(
      (inst) =>
        inst.id === expectedInstance &&
        isAdopted(inst) &&
        (inst.label ?? "").split(/\s+/).includes(token),
    );
    if (found) return found;
    if (timeoutSeconds <= 0) return null;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

export const herdrSpawnerBackend: SpawnerBackend = {
  name: "herdr",
  defaultWaitSeconds: 30,
  defaultHarness() {
    return identityDefaultHarness();
  },
  async spawn(input) {
    const pane = parentPane();
    if (!pane) {
      return {
        status: "spawn_failed",
        error: "herdr spawner requires HERDR_PANE_ID, HERDR_PANE, or SWARM_HERDR_PARENT_PANE",
      };
    }

    const direction = process.env.SWARM_HERDR_SPLIT_DIRECTION?.trim() || "right";
    const split = runHerdrCommand([
      "pane",
      "split",
      pane,
      "--direction",
      direction,
      "--cwd",
      input.cwd,
      "--no-focus",
    ]);
    if (split.error || split.status !== 0) {
      return { status: "spawn_failed", error: `herdr pane split failed: ${processError(split)}` };
    }

    const paneId = paneIdFromSplit(split.stdout);
    if (!paneId) {
      return {
        status: "spawn_failed",
        error: "herdr pane split returned no pane id",
        herdr_stdout: split.stdout,
      };
    }

    const label = labelWithLaunchToken({
      role: input.role,
      harness: input.harness,
      launchToken: input.launch_token,
      extra: input.label,
    });
    const leased = registry.register(input.cwd, label, input.scope, input.cwd);
    registry.setLease(
      leased.id,
      Math.floor(Date.now() / 1000) + Math.max(60, input.wait_seconds + 30),
    );
    const command = launchCommand({
      scope: input.scope,
      cwd: input.cwd,
      role: input.role,
      label,
      harness: input.harness,
      instanceId: leased.id,
    });
    const run = runHerdrCommand(["pane", "run", paneId, command]);
    const workspaceHandle = {
      backend: "herdr",
      handle_kind: "pane",
      handle: paneId,
      pane_id: paneId,
    };
    if (run.error || run.status !== 0) {
      registry.deregister(leased.id);
      return {
        status: "spawn_failed",
        workspace_handle: workspaceHandle,
        error: `herdr pane run failed: ${processError(run)}`,
      };
    }

    context.lock(
      input.requester,
      input.scope,
      input.lock_path,
      JSON.stringify({
        ...input.lock_note,
        launch_token: input.launch_token,
        pane_id: paneId,
        instance_id: leased.id,
        harness: input.harness,
      }),
    );

    const spawned = await waitForLaunchInstanceForTesting({
      scope: input.scope,
      launchToken: input.launch_token,
      expectedInstance: leased.id,
      timeoutSeconds: input.wait_seconds,
    });
    if (!spawned) {
      return {
        status: "spawn_in_flight",
        launch_token: input.launch_token,
        expected_instance: leased.id,
        workspace_handle: workspaceHandle,
      };
    }

    return {
      status: "spawned",
      spawned_instance: spawned.id,
      expected_instance: leased.id,
      launch_token: input.launch_token,
      workspace_handle: workspaceHandle,
    };
  },
};
