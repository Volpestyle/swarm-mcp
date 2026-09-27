import { claudeHook, claudeLifecycleHook } from "./claude-hook";

let body = "";
try {
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Hook input exceeds limit");
  }
  const binding = {
    sessionId: process.env.SWARM_NATIVE_SESSION_ID ?? "",
    endpoint: process.env.SWARM_COORDINATOR_ENDPOINT ?? "",
    capability: process.env.SWARM_SESSION_CAPABILITY ?? "",
  };
  const result = process.env.SWARM_STREAM_WORKER === "1" ? {}
    : process.env.SWARM_MCP_CHANNEL === "1"
      ? await claudeLifecycleHook(JSON.parse(body), { ...binding, launchPath: process.env.SWARM_WORKER_LAUNCH ?? "" })
      : await claudeHook(JSON.parse(body), binding);
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write(
    "Swarm hook unavailable; delivery remains unacknowledged.\n",
  );
  process.exitCode = 1;
}
