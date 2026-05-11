import * as context from "../context";
import type { SpawnerBackend } from "../spawner_backend";
import * as ui from "../ui";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUiCommand(id: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let row = ui.get(id);
  while (
    row &&
    row.status !== "done" &&
    row.status !== "failed" &&
    Date.now() < deadline
  ) {
    await sleep(100);
    row = ui.get(id);
  }
  return row;
}

function parseJsonMaybe(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export const swarmUiSpawnerBackend: SpawnerBackend = {
  name: "swarm-ui",
  defaultWaitSeconds: 5,
  defaultHarness() {
    return "claude";
  },
  async spawn(input) {
    const commandId = ui.enqueue(
      input.scope,
      "spawn_shell",
      {
        cwd: input.cwd,
        harness: input.harness,
        role: input.role,
        label: input.label ?? null,
        name: input.name ?? null,
      },
      input.requester,
    );
    context.lock(
      input.requester,
      input.scope,
      input.lock_path,
      JSON.stringify({
        ...input.lock_note,
        ui_command_id: commandId,
        harness: input.harness,
        identity: input.identity,
      }),
    );

    const row =
      input.wait_seconds <= 0
        ? ui.get(commandId)
        : await waitForUiCommand(commandId, input.wait_seconds * 1000);
    const payload = { ui_command_id: commandId, ui_command: row };

    if (!row || row.status === "pending" || row.status === "running") {
      return { status: "spawn_in_flight", ...payload };
    }
    if (row.status === "failed") {
      return { status: "spawn_failed", ...payload };
    }

    const spawnResult = parseJsonMaybe(row.result) as { instance_id?: unknown } | null;
    const spawnedInstance =
      spawnResult && typeof spawnResult.instance_id === "string"
        ? spawnResult.instance_id
        : "";
    return {
      status: "spawned",
      ...payload,
      spawned_instance: spawnedInstance || null,
    };
  },
};
