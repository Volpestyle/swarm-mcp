import { CoordinationClient, type Operation } from "./ipc";
const endpoint = process.env.SWARM_COORDINATOR_ENDPOINT;
const capability = process.env.SWARM_SESSION_CAPABILITY;
async function main() {
  if (!endpoint || !capability)
    throw new Error("Coordinator endpoint and session capability are required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 65536) throw new Error("Request exceeds 64 KiB");
    chunks.push(bytes);
  }
  const operation = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as Operation;
  const client = await CoordinationClient.connect(endpoint, capability);
  try {
    console.log(JSON.stringify(await client.request(operation)));
  } finally {
    client.close();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: { code: error.code ?? "client_error", message: error.message },
    }),
  );
  process.exitCode = 1;
});
