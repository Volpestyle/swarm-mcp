import { backupLegacy, restoreLegacy, verifyLegacySnapshot } from "./legacy-snapshot";
import { importLegacy, type LegacyImportPlan } from "./legacy-import";
import { readFileSync } from "node:fs";

const [action, source, destination, planPath] = process.argv.slice(2);
if (!source || !["backup", "verify", "restore", "import"].includes(action ?? ""))
  throw new Error("Usage: swarm-coordinator-migrate backup <legacy-db> <new-snapshot-dir> | verify <snapshot-dir> | restore <snapshot-dir> <new-legacy-db> | import <snapshot-dir> <new-coordinator-dir> <plan.json>");
const result = action === "verify" ? (await verifyLegacySnapshot(source)).manifest
  : action === "backup" && destination ? await backupLegacy(source, destination)
  : action === "restore" && destination ? await restoreLegacy(source, destination)
  : action === "import" && destination && planPath ? await importLegacy(source, destination, JSON.parse(readFileSync(planPath, "utf8")) as LegacyImportPlan)
  : (() => { throw new Error("Missing destination"); })();
console.log(JSON.stringify(result, null, 2));
