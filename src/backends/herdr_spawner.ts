import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as context from "../context";
import { herdrEnvWithSocket, resolvedHerdrSocketPath } from "../herdr_socket";
import { identityNameFromToken, identityTokenFromName } from "../launcher_identity";
import * as kv from "../kv";
import * as registry from "../registry";
import type { SpawnRequest, SpawnerBackend } from "../spawner_backend";
import { identityKey } from "../workspace_backend";

type InstanceRef = {
  id: string;
  label: string | null;
  adopted?: boolean | number;
};

type LayoutTab = {
  tab_id?: string;
  parent_pane_id: string;
  pane_count: number;
};

type HerdrLayout = {
  schema_version: 1;
  backend: "herdr";
  identity?: string;
  scope: string;
  cwd: string;
  workspace_id: string;
  tabs: Record<string, LayoutTab[]>;
};

type PanePlacement = {
  paneId: string;
  paneInfo: Record<string, unknown>;
  reason: string;
  group?: string;
  maxPanesPerTab?: number;
  reusedWorkspace?: boolean;
  reusedTab?: boolean;
};

function isAdopted(inst: InstanceRef) {
  return inst.adopted === true || inst.adopted === 1;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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
  identity?: string | null;
  role: string;
  harness: string;
  launchToken: string;
  extra?: string | null;
}) {
  const tokens = [
    identityTokenFromName(opts.identity),
    `role:${cleanLabelValue(opts.role, "worker")}`,
    `provider:${cleanLabelValue(opts.harness, "agent")}`,
    `launch:${opts.launchToken}`,
  ].filter(Boolean);
  if (opts.extra?.trim()) tokens.push(...opts.extra.trim().split(/\s+/));
  return Array.from(new Set(tokens)).join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeFilename(value: string, fallback: string) {
  return cleanLabelValue(value, fallback).slice(0, 96);
}

function envForHerdrCommand(identity?: string | null) {
  const env = { ...process.env };
  const cleanIdentity = identityNameFromToken(identity);
  if (cleanIdentity) {
    env.AGENT_IDENTITY = cleanIdentity;
    env.SWARM_IDENTITY = cleanIdentity;
    env.SWARM_CC_IDENTITY = cleanIdentity;
    env.SWARM_CODEX_IDENTITY = cleanIdentity;
    env.SWARM_HERMES_IDENTITY = cleanIdentity;
  }
  return herdrEnvWithSocket(env);
}

function runHerdrCommand(args: string[], timeout = 10_000, identity?: string | null) {
  const bin = process.env.SWARM_HERDR_BIN?.trim() || "herdr";
  return spawnSync(bin, args, {
    encoding: "utf8",
    env: envForHerdrCommand(identity),
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

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultObject(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    return objectValue(payload?.result) ?? objectValue(payload) ?? {};
  } catch {
    return {};
  }
}

function paneFromSplit(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    const pane =
      objectValue(payload?.result)?.pane ??
      payload?.pane ??
      payload;
    return objectValue(pane);
  } catch {
    return null;
  }
}

function paneFromWorkspaceCreate(stdout: string) {
  try {
    const payload = JSON.parse(stdout || "{}");
    const result = objectValue(payload?.result);
    const pane = result?.root_pane ?? result?.pane ?? payload?.root_pane ?? payload?.pane;
    return objectValue(pane);
  } catch {
    return null;
  }
}

function paneFromTabCreate(stdout: string) {
  const result = resultObject(stdout);
  return objectValue(result.root_pane) ?? objectValue(result.pane);
}

function tabFromTabCreate(stdout: string) {
  const result = resultObject(stdout);
  return objectValue(result.tab) ?? objectValue(result);
}

function paneIdFromPane(pane: Record<string, unknown> | null) {
  return stringValue(pane?.pane_id) || stringValue(pane?.id);
}

function workspaceIdFromPane(pane: Record<string, unknown> | null) {
  return stringValue(pane?.workspace_id);
}

function tabIdFromPane(pane: Record<string, unknown> | null) {
  return stringValue(pane?.tab_id);
}

function parentPane() {
  return (
    process.env.SWARM_HERDR_PARENT_PANE?.trim() ||
    process.env.HERDR_PANE_ID?.trim() ||
    process.env.HERDR_PANE?.trim() ||
    ""
  );
}

function placementParentPane(input: SpawnRequest) {
  return stringValue(input.placement?.parent_pane_id) || parentPane();
}

function splitDirection(input: SpawnRequest) {
  const requested = stringValue(input.placement?.split_direction);
  if (requested === "right" || requested === "down") return requested;
  const configured = process.env.SWARM_HERDR_SPLIT_DIRECTION?.trim();
  return configured === "down" ? "down" : "right";
}

function hashKey(parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function cleanLayoutToken(value: string, fallback: string) {
  return cleanLabelValue(value, fallback).slice(0, 64);
}

function layoutGroup(input: SpawnRequest) {
  const placement = input.placement;
  const explicit = stringValue(placement?.group);
  if (explicit) return cleanLayoutToken(explicit, "default");

  const tab = stringValue(placement?.tab);
  if (tab && !["reuse_group", "new", "current"].includes(tab)) {
    return cleanLayoutToken(tab, "default");
  }
  return cleanLayoutToken(input.role, "worker");
}

function maxPanesPerTab(input: SpawnRequest) {
  const requested = input.placement?.max_panes_per_tab;
  const configured = Number(process.env.SWARM_HERDR_MAX_PANES_PER_TAB);
  const value = Number.isFinite(requested)
    ? Number(requested)
    : Number.isFinite(configured)
      ? configured
      : 3;
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function layoutKey(input: SpawnRequest) {
  const identity = identityNameFromToken(input.identity) || "default";
  return `layout/herdr/${identity}/${hashKey([input.scope, input.cwd])}`;
}

function layoutLockPath(input: SpawnRequest) {
  const identity = identityNameFromToken(input.identity) || "default";
  return `/__swarm/layout/herdr/${identity}/${hashKey([input.scope, input.cwd, layoutGroup(input)])}`;
}

function readLayout(input: SpawnRequest): HerdrLayout | null {
  const row = kv.get(input.scope, layoutKey(input), input.requester);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as HerdrLayout;
    if (
      parsed?.schema_version === 1 &&
      parsed.backend === "herdr" &&
      stringValue(parsed.workspace_id)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function writeLayout(input: SpawnRequest, layout: HerdrLayout) {
  kv.set(input.scope, layoutKey(input), JSON.stringify(layout), input.requester);
}

async function acquireLayoutLock(input: SpawnRequest) {
  const path = layoutLockPath(input);
  const deadline = Date.now() + 2_000;
  do {
    const result = context.lock(
      input.requester,
      input.scope,
      path,
      JSON.stringify({ cwd: input.cwd, group: layoutGroup(input), backend: "herdr" }),
      { exclusive: true },
    );
    if (!("error" in result)) return path;
    await sleep(100);
  } while (Date.now() < deadline);
  return null;
}

function splitPane(input: SpawnRequest, pane: string, reason: string): PanePlacement | { error: string; stdout?: string } {
  const direction = splitDirection(input);
  const split = runHerdrCommand(
    [
      "pane",
      "split",
      pane,
      "--direction",
      direction,
      "--cwd",
      input.cwd,
      "--no-focus",
    ],
    10_000,
    input.identity,
  );
  if (split.error || split.status !== 0) {
    return { error: `herdr pane split failed: ${processError(split)}` };
  }
  const paneInfo = paneFromSplit(split.stdout);
  const paneId = paneIdFromPane(paneInfo);
  if (!paneId || !paneInfo) {
    return { error: "herdr pane split returned no pane id", stdout: split.stdout };
  }
  return { paneId, paneInfo, reason };
}

function createWorkspacePane(input: SpawnRequest, reason: string): PanePlacement | { error: string; stdout?: string } {
  const args = ["workspace", "create", "--cwd", input.cwd, "--no-focus"];
  const group = layoutGroup(input);
  if (group) args.push("--label", group);
  const created = runHerdrCommand(args, 10_000, input.identity);
  if (created.error || created.status !== 0) {
    return { error: `herdr workspace create failed: ${processError(created)}` };
  }
  const paneInfo = paneFromWorkspaceCreate(created.stdout);
  const paneId = paneIdFromPane(paneInfo);
  if (!paneId || !paneInfo) {
    return { error: "herdr workspace create returned no root pane id", stdout: created.stdout };
  }
  return { paneId, paneInfo, reason };
}

function createTabPane(
  input: SpawnRequest,
  workspaceId: string,
  reason: string,
): PanePlacement | { error: string; stdout?: string } {
  const group = layoutGroup(input);
  const created = runHerdrCommand(
    [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      input.cwd,
      "--label",
      group,
      "--no-focus",
    ],
    10_000,
    input.identity,
  );
  if (created.error || created.status !== 0) {
    return { error: `herdr tab create failed: ${processError(created)}` };
  }
  const tabInfo = tabFromTabCreate(created.stdout);
  const paneInfo = paneFromTabCreate(created.stdout);
  const paneId = paneIdFromPane(paneInfo);
  if (!paneId || !paneInfo) {
    return { error: "herdr tab create returned no root pane id", stdout: created.stdout };
  }
  const tabId = stringValue(tabInfo?.tab_id) || tabIdFromPane(paneInfo);
  return {
    paneId,
    paneInfo: tabId ? { ...paneInfo, tab_id: tabId } : paneInfo,
    reason,
  };
}

async function placePane(input: SpawnRequest): Promise<PanePlacement | { error: string; stdout?: string }> {
  const explicitParent = placementParentPane(input);
  if (explicitParent) {
    return splitPane(input, explicitParent, "split explicit parent pane");
  }

  if (stringValue(input.placement?.workspace) === "new") {
    return createWorkspacePane(input, "created new workspace by placement request");
  }

  const lockPath = await acquireLayoutLock(input);
  try {
    const group = layoutGroup(input);
    const max = maxPanesPerTab(input);
    const identity = identityNameFromToken(input.identity) || undefined;
    let layout = readLayout(input);
    const explicitWorkspace = stringValue(input.placement?.workspace);
    if (explicitWorkspace && !["reuse_scope", "current", "new"].includes(explicitWorkspace)) {
      layout = {
        schema_version: 1,
        backend: "herdr",
        ...(identity ? { identity } : {}),
        scope: input.scope,
        cwd: input.cwd,
        workspace_id: explicitWorkspace,
        tabs: layout?.tabs ?? {},
      };
    }

    if (layout) {
      const tabs = layout.tabs[group] ?? [];
      const reusable = tabs.find((tab) => tab.parent_pane_id && tab.pane_count < max);
      if (reusable) {
        const split = splitPane(input, reusable.parent_pane_id, "reused scope workspace/tab");
        if (!("error" in split)) {
          reusable.pane_count += 1;
          writeLayout(input, layout);
          return {
            ...split,
            group,
            maxPanesPerTab: max,
            reusedWorkspace: true,
            reusedTab: true,
          };
        }
      }

      const tab = createTabPane(input, layout.workspace_id, "created new tab in reused scope workspace");
      if (!("error" in tab)) {
        const nextTab: LayoutTab = {
          tab_id: tabIdFromPane(tab.paneInfo),
          parent_pane_id: tab.paneId,
          pane_count: 1,
        };
        layout.tabs[group] = [...tabs, nextTab];
        writeLayout(input, layout);
        return {
          ...tab,
          group,
          maxPanesPerTab: max,
          reusedWorkspace: true,
          reusedTab: false,
        };
      }
    }

    const created = createWorkspacePane(input, "created scope workspace");
    if ("error" in created) return created;
    const workspaceId = workspaceIdFromPane(created.paneInfo);
    if (workspaceId) {
      const next: HerdrLayout = {
        schema_version: 1,
        backend: "herdr",
        ...(identity ? { identity } : {}),
        scope: input.scope,
        cwd: input.cwd,
        workspace_id: workspaceId,
        tabs: {
          [group]: [
            {
              tab_id: tabIdFromPane(created.paneInfo),
              parent_pane_id: created.paneId,
              pane_count: 1,
            },
          ],
        },
      };
      writeLayout(input, next);
    }
    return {
      ...created,
      group,
      maxPanesPerTab: max,
      reusedWorkspace: false,
      reusedTab: false,
    };
  } finally {
    if (lockPath) context.clearLocks(input.requester, input.scope, lockPath);
  }
}

type LaunchCommandOpts = {
  scope: string;
  cwd: string;
  role: string;
  label: string;
  harness: string;
  identity?: string | null;
  instanceId: string;
  paneId: string;
  workspaceId?: string;
  tabId?: string;
};

function launchEnv(opts: LaunchCommandOpts) {
  const env: Record<string, string> = {
    SWARM_MCP_INSTANCE_ID: opts.instanceId,
    SWARM_MCP_SCOPE: opts.scope,
    SWARM_MCP_FILE_ROOT: opts.cwd,
    SWARM_MCP_DIRECTORY: opts.cwd,
    SWARM_MCP_LABEL: opts.label,
    SWARM_AGENT_ROLE: opts.role,
    SWARM_CC_AGENT_ROLE: opts.role,
    SWARM_CODEX_AGENT_ROLE: opts.role,
    SWARM_CC_LABEL: opts.label,
    SWARM_CODEX_LABEL: opts.label,
    SWARM_HERMES_LABEL: opts.label,
    HERDR_PANE_ID: opts.paneId,
    HERDR_PANE: opts.paneId,
  };
  if (opts.workspaceId) env.HERDR_WORKSPACE_ID = opts.workspaceId;
  if (opts.tabId) env.HERDR_TAB_ID = opts.tabId;
  const identity = identityNameFromToken(opts.identity);
  if (identity) {
    env.AGENT_IDENTITY = identity;
    env.SWARM_IDENTITY = identity;
    env.SWARM_CC_IDENTITY = identity;
    env.SWARM_CODEX_IDENTITY = identity;
    env.SWARM_HERMES_IDENTITY = identity;
  }
  const socketPath = resolvedHerdrSocketPath({
    ...process.env,
    ...(identity ? { AGENT_IDENTITY: identity } : {}),
  });
  if (socketPath) {
    env.HERDR_SOCKET_PATH = socketPath;
  }
  for (const key of [
    "HERMES_HOST_HOME",
    "SWARM_DB_PATH",
    "SWARM_MCP_PERSONAL_ROOTS",
    "SWARM_MCP_WORK_ROOTS",
  ]) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  if (process.env.SWARM_MCP_BIN?.trim()) {
    env.SWARM_MCP_BIN = process.env.SWARM_MCP_BIN.trim();
  }
  return env;
}

function launchScriptDir() {
  const dir = process.env.SWARM_MCP_LAUNCH_DIR?.trim() || join(tmpdir(), "swarm-mcp-launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeLaunchScript(opts: LaunchCommandOpts) {
  const path = join(launchScriptDir(), `launch-${safeFilename(opts.instanceId, "worker")}.sh`);
  const exports = Object.entries(launchEnv(opts))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const script = [
    "#!/bin/sh",
    "set -eu",
    'rm -f "$0"',
    `cd ${shellQuote(opts.cwd)}`,
    exports,
    `exec ${opts.harness}`,
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function launchCommand(opts: LaunchCommandOpts) {
  return `/bin/sh ${shellQuote(writeLaunchScript(opts))}`;
}

function workspaceIdentityPayload(
  paneId: string,
  pane: Record<string, unknown> | null,
  identity?: string | null,
  placement?: PanePlacement | null,
) {
  const cleanIdentity = identityNameFromToken(identity);
  const socketPath = resolvedHerdrSocketPath({
    ...process.env,
    ...(cleanIdentity ? { AGENT_IDENTITY: cleanIdentity } : {}),
  });
  const workspaceId = stringValue(pane?.workspace_id);
  const tabId = stringValue(pane?.tab_id);
  return {
    schema_version: 1,
    backend: "herdr",
    handle_kind: "pane",
    handle: paneId,
    pane_id: paneId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(tabId ? { tab_id: tabId } : {}),
    ...(socketPath ? { socket_path: socketPath } : {}),
    ...(placement
      ? {
          placement: {
            reason: placement.reason,
            ...(placement.group ? { group: placement.group } : {}),
            ...(placement.maxPanesPerTab ? { max_panes_per_tab: placement.maxPanesPerTab } : {}),
            reused_workspace: placement.reusedWorkspace ?? false,
            reused_tab: placement.reusedTab ?? false,
          },
        }
      : {}),
  };
}

function herdrIdentityKeys(instanceId: string) {
  return [identityKey("herdr", instanceId), `identity/herdr/${instanceId}`];
}

function publishWorkspaceIdentity(opts: {
  scope: string;
  instanceId: string;
  actor: string;
  value: Record<string, unknown>;
}) {
  const payload = JSON.stringify(opts.value);
  for (const key of herdrIdentityKeys(opts.instanceId)) {
    kv.set(opts.scope, key, payload, opts.actor);
  }
}

function deleteWorkspaceIdentity(scope: string, instanceId: string, actor: string) {
  for (const key of herdrIdentityKeys(instanceId)) {
    kv.del(scope, key, actor);
  }
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
    const placement = await placePane(input);
    if ("error" in placement) {
      return {
        status: "spawn_failed",
        error: placement.error,
        ...(placement.stdout ? { herdr_stdout: placement.stdout } : {}),
      };
    }

    const paneId = placement.paneId;
    const paneInfo = placement.paneInfo;

    const label = labelWithLaunchToken({
      identity: input.identity,
      role: input.role,
      harness: input.harness,
      launchToken: input.launch_token,
      extra: input.label,
    });
    const leaseUntil =
      Math.floor(Date.now() / 1000) + Math.max(60, input.wait_seconds + 30);
    const leased = registry.precreateInstanceLease(
      input.cwd,
      label,
      input.scope,
      input.cwd,
      leaseUntil,
    );
    const workspaceHandle = workspaceIdentityPayload(
      paneId,
      paneInfo,
      input.identity,
      placement,
    );
    publishWorkspaceIdentity({
      scope: leased.scope,
      instanceId: leased.id,
      actor: input.requester,
      value: workspaceHandle,
    });
    const command = launchCommand({
      scope: leased.scope,
      cwd: input.cwd,
      role: input.role,
      label,
      harness: input.harness,
      identity: input.identity,
      instanceId: leased.id,
      paneId,
      workspaceId: stringValue(workspaceHandle.workspace_id),
      tabId: stringValue(workspaceHandle.tab_id),
    });
    const run = runHerdrCommand(["pane", "run", paneId, command], 10_000, input.identity);
    if (run.error || run.status !== 0) {
      deleteWorkspaceIdentity(leased.scope, leased.id, input.requester);
      registry.deregister(leased.id);
      return {
        status: "spawn_failed",
        workspace_handle: workspaceHandle,
        error: `herdr pane run failed: ${processError(run)}`,
      };
    }

    context.lock(
      input.requester,
      leased.scope,
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
      scope: leased.scope,
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
