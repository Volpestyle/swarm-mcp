import { CoordinationClient } from "../../src/coordination/ipc";

// Run by the actual host shell. Never print a capability or inherited secrets.
const endpoint = process.env.SWARM_COORDINATOR_ENDPOINT;
const capability = process.env.SWARM_SESSION_CAPABILITY;
if (!endpoint || !capability)
  throw new Error("Missing runtime session environment");
const client = await CoordinationClient.connect(endpoint, capability);
try {
  const snapshot = await client.request({ op: "bootstrap" });
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
