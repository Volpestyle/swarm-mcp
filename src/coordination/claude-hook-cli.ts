import { claudeHook } from "./claude-hook";

let body = "";
try {
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Hook input exceeds limit");
  }
  const result = await claudeHook(JSON.parse(body), {
    sessionId: process.env.SWARM_NATIVE_SESSION_ID ?? "",
    endpoint: process.env.SWARM_COORDINATOR_ENDPOINT ?? "",
    capability: process.env.SWARM_SESSION_CAPABILITY ?? "",
  });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write(
    "Swarm hook unavailable; delivery remains unacknowledged.\n",
  );
  process.exitCode = 1;
}
