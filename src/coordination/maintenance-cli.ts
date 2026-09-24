import { resolve } from "node:path";
import { readOwnerConfig } from "./owner-config";
import { localEndpoint } from "./ipc";
import { withEndpointLock } from "./endpoint";
import { openSqlite } from "./sqlite";
import { APPLICATION_ID, SCHEMA_VERSION } from "./migrations";
import { maintain } from "./maintenance";

async function main() {
  const [path, ...flags] = process.argv.slice(2);
  const daysAt = flags.indexOf("--retain-days");
  const days = daysAt < 0 ? 30 : Number(flags[daysAt + 1]);
  const rest = flags.filter((_, index) => daysAt < 0 || (index !== daysAt && index !== daysAt + 1));
  if (!path || rest.some(flag => flag !== "--apply") || !Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error("Usage: swarm-coordinator-maintenance <private-config.json> [--retain-days 30] [--apply]");
  const config = readOwnerConfig(resolve(path));
  await withEndpointLock(localEndpoint(config.databasePath), async live => {
    if (live) throw new Error("Stop the coordinator owner before offline maintenance; no changes made");
    const db = await openSqlite(config.databasePath);
    try {
      if ((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id !== APPLICATION_ID
          || (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== SCHEMA_VERSION)
        throw new Error("Maintenance requires a current coordinator database; start the selected owner to migrate it first");
      console.log(JSON.stringify(maintain(db, config.databasePath + ".artifacts", Date.now() - days * 86400000, rest.includes("--apply"))));
    } finally { db.close(); }
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
