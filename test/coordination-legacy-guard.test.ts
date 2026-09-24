import { beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { assertLegacyDatabase } from "../src/legacy-database-guard";

let guard: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  guard = join(mkdtempSync(resolve("dist/test/legacy-guard-")), "guard.mjs");
  await build({ entryPoints: ["src/legacy-guard-cli.ts"], outfile: guard,
    bundle: true, platform: "node", format: "esm", packages: "external" });
});

const run = async (db: string, script: string, runtime = "node") => {
  const child = Bun.spawn({ cmd: [runtime === "node" ? Bun.which("node")! : process.execPath,
    runtime === "node" ? guard : resolve("src/legacy-guard-cli.ts"), db, "--", process.execPath, script],
    stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

test("read-only guard rejects coordinator identity even at a legacy version", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-guard-"));
  const path = join(root, "coordination.db");
  const store = await CoordinationStore.open({ path });
  store.close();
  const db = new Database(path); db.exec("PRAGMA user_version=1"); db.close();
  const before = readFileSync(path);
  await expect(assertLegacyDatabase(path)).rejects.toThrow("legacy_database_incompatible");
  expect(readFileSync(path)).toEqual(before);
});

for (const revision of ["b446c18", "b95f607"]) {
  test(`historical ${revision} initializes its fixture but cannot touch coordinator through guard`, async () => {
    const root = mkdtempSync(join(tmpdir(), "legacy-baseline-"));
    mkdirSync(join(root, "src")); mkdirSync(join(root, "sql"));
    const source = join(root, "src", "db.ts");
    const pinned = resolve("test/fixtures/legacy-baselines", revision);
    writeFileSync(source, readFileSync(join(pinned, "db.ts")));
    if (revision === "b95f607") for (const name of ["swarm_db_bootstrap.sql", "swarm_db_finalize.sql"])
      writeFileSync(join(root, "sql", name), readFileSync(join(pinned, name)));
    const legacy = join(root, "legacy.db");
    const initialized = await run(legacy, source);
    expect(initialized.code).toBe(0);
    const inspection = new Database(legacy, { readonly: true });
    expect(inspection.query("SELECT name FROM sqlite_master WHERE name='messages'").get()).toBeTruthy();
    inspection.close();
    const modern = join(root, "coordination.db");
    const store = await CoordinationStore.open({ path: modern }); store.close();
    const before = readFileSync(modern);
    for (const runtime of ["node", "bun"]) {
      const rejected = await run(modern, source, runtime);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("legacy_database_incompatible");
      expect(readFileSync(modern)).toEqual(before);
    }
  });
}
