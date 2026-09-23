import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoordinationClient, localEndpoint } from "./ipc";
import { readOwnerConfig } from "./owner-config";
import { assertCompatibleOwner } from "./compatibility";
import { CoordinationError } from "./errors";

/** Connect before starting anything. The pipe is the ownership arbiter: racing
 * Node owners may start, but only one binds and survives. Existing owners are
 * never killed or adopted on the strength of a stale PID file.
 */
export async function ensureCoordinator(options: {
  configPath: string;
  nodePath: string;
  ownerPath: string;
  timeoutMs?: number;
}): Promise<{ client: CoordinationClient; launched?: ChildProcess }> {
  const configPath = resolve(options.configPath);
  const config = readOwnerConfig(configPath);
  const endpoint = localEndpoint(config.databasePath);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("Owner startup timeout must be 1..30000 milliseconds");
  const deadline = Date.now() + timeoutMs;
  let launched: ChildProcess | undefined;
  let spawnError: Error | undefined;
  let exited: number | undefined;
  let backoff = 25;
  try {
    while (true) {
      try {
        const client = await CoordinationClient.connect(
          endpoint,
          config.launcherSecret,
        );
        try {
          let descriptor;
          try { descriptor = await client.request({ op: "compatibility" }); }
          catch (error) {
            if ((error as { code?: string }).code === "invalid_input")
              throw new CoordinationError("coordinator_version_mismatch", "Owner predates compatibility discovery; explicitly restart it from the selected candidate");
            throw error;
          }
          assertCompatibleOwner(descriptor);
        } catch (error) { client.close(); throw error; }
        launched?.unref();
        return { client, launched };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      }
      if (spawnError) throw spawnError;
      // A candidate that lost the endpoint race exits non-zero while the
      // winner may not accept connections yet; keep connecting until the
      // deadline and report the exit only if no owner ever answers.
      if (launched?.exitCode != null) exited ??= launched.exitCode;
      if (Date.now() >= deadline)
        throw new Error(
          exited == null
            ? "Coordinator owner startup timed out"
            : `Coordinator owner exited during startup (${exited}) and no owner answered before the deadline`,
        );
      if (!launched) {
        launched = spawn(
          options.nodePath,
          [resolve(options.ownerPath), configPath],
          {
            detached: true,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        launched.once("error", (error) => {
          spawnError = error;
        });
      }
      await delay(Math.min(backoff, Math.max(1, deadline - Date.now())));
      backoff = Math.min(200, backoff * 2);
    }
  } catch (error) {
    // Only the process this invocation created is ours to clean up.
    if (launched && launched.exitCode === null) launched.kill();
    throw error;
  }
}
