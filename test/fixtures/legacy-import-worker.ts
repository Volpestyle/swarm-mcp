import { readFileSync } from "node:fs";
import { importLegacy } from "../../src/coordination/legacy-import";

const [snapshot, destination, plan, crash] = process.argv.slice(2);
if (!snapshot || !destination || !plan) throw new Error("Missing fixture arguments");
const summary = await importLegacy(snapshot, destination, JSON.parse(readFileSync(plan, "utf8")), point => {
  if (point === crash) process.exit(73);
});
console.log(JSON.stringify(summary));
