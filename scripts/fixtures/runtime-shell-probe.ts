import { CoordinationClient } from "../../src/coordination/ipc";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// Run by the actual host shell. Never print a capability or inherited secrets.
const endpoint = process.env.SWARM_COORDINATOR_ENDPOINT;
const capability = process.env.SWARM_SESSION_CAPABILITY;
if (!endpoint || !capability)
  throw new Error("Missing runtime session environment");
const client = await CoordinationClient.connect(endpoint, capability);
try {
  const snapshot = await client.request({ op: "bootstrap" });
  const barrier = process.argv[2];
  if (barrier) {
    writeFileSync(barrier + ".ready", "ready");
    const deadline = Date.now() + 10000;
    while (!existsSync(barrier + ".release")) {
      if (Date.now() >= deadline)
        throw new Error("Fixture shell release timed out");
      await delay(25);
    }
    writeFileSync(barrier + ".completed", String(Date.now()));
  }
  console.log(
    JSON.stringify({
      marker: "swarm-shell-probe",
      snapshot,
      keys: Object.keys(process.env)
        .filter((key) => key.startsWith("SWARM_"))
        .sort(),
    }),
  );
} finally {
  client.close();
}
