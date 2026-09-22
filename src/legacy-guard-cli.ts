import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertLegacyDatabase } from "./legacy-database-guard";

const [database, separator, executable, ...args] = process.argv.slice(2);
if (!database || separator !== "--" || !executable || !isAbsolute(executable))
  throw new Error("Usage: swarm-legacy-guard <absolute-db> -- <absolute-executable> [args...]");
await assertLegacyDatabase(database);
const child = spawn(executable, args, {
  stdio: "inherit", env: { ...process.env, SWARM_DB_PATH: database }, shell: false,
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = code ?? 1;
});
