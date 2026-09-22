import { backupLegacy, restoreLegacy, verifyLegacySnapshot } from "./legacy-snapshot";

const [action, source, destination] = process.argv.slice(2);
if (!source || !["backup", "verify", "restore"].includes(action ?? ""))
  throw new Error("Usage: swarm-coordinator-migrate backup <legacy-db> <new-snapshot-dir> | verify <snapshot-dir> | restore <snapshot-dir> <new-legacy-db>");
const result = action === "verify" ? (await verifyLegacySnapshot(source)).manifest
  : action === "backup" && destination ? await backupLegacy(source, destination)
  : action === "restore" && destination ? await restoreLegacy(source, destination)
  : (() => { throw new Error("Missing destination"); })();
console.log(JSON.stringify(result, null, 2));
