import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backupLegacy, restoreLegacy, verifyLegacySnapshot } from "../src/coordination/legacy-snapshot";

let nodeCli: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeCli = join(mkdtempSync(resolve("dist/test/migration-")), "migrate.mjs");
  await build({ entryPoints: ["src/coordination/migration-cli.ts"], outfile: nodeCli,
    bundle: true, platform: "node", format: "esm", packages: "external" });
});

async function fixture(revision: string) {
  const root = mkdtempSync(join(tmpdir(), "legacy-snapshot-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "sql"));
  const pinned = resolve("test/fixtures/legacy-baselines", revision);
  const script = join(root, "src", "db.ts"), path = join(root, "source.db");
  writeFileSync(script, readFileSync(join(pinned, "db.ts")));
  if (revision === "b95f607") for (const name of ["swarm_db_bootstrap.sql", "swarm_db_finalize.sql"])
    writeFileSync(join(root, "sql", name), readFileSync(join(pinned, name)));
  const child = Bun.spawn({ cmd: [process.execPath, script], env: { ...process.env, SWARM_DB_PATH: path }, stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(stderr);
  const writer = new Database(path);
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.run("INSERT INTO messages(sender,recipient,content) VALUES('alice','bob','pending committed in WAL')");
  writer.run("INSERT INTO tasks(id,type,title,requester,assignee,status) VALUES('t','code','unfinished','alice','bob','in_progress')");
  writer.run("INSERT INTO context(id,instance_id,file,type,content) VALUES('c','bob','a.ts','lock','legacy lock')");
  return { root, path, writer };
}

for (const revision of ["b446c18", "b95f607"]) {
  test(`${revision}: WAL-consistent backup and fresh-path restore preserve historical state`, async () => {
    const { root, path, writer } = await fixture(revision);
    try {
      expect(existsSync(path + "-wal")).toBe(true);
      const directory = join(root, "snapshot");
      const manifest = await backupLegacy(path, directory);
      expect(manifest.inventory.pendingMessages).toBe(1);
      expect(manifest.inventory.tasksByStatus).toEqual([{ status: "in_progress", count: 1 }]);
      expect(manifest.inventory.contextByType).toEqual([{ type: "lock", count: 1 }]);
      writer.run("INSERT INTO messages(sender,recipient,content) VALUES('alice','bob','after snapshot')");
      const destination = join(root, "restored.db");
      await restoreLegacy(directory, destination);
      const restored = new Database(destination, { readonly: true });
      try {
        expect(restored.query("SELECT content FROM messages").all()).toEqual([{ content: "pending committed in WAL" }]);
        expect(restored.query("SELECT assignee,status FROM tasks").get()).toEqual({ assignee: "bob", status: "in_progress" });
      } finally { restored.close(); }
      await expect(backupLegacy(path, directory)).rejects.toThrow();
      await expect(restoreLegacy(directory, destination)).rejects.toThrow();
      expect((writer.query("SELECT count(*) AS n FROM messages").get() as any).n).toBe(2);
    } finally { writer.close(); }
  });
}

test("Node CLI backs up; corruption, incomplete manifests and stray sidecars fail closed", async () => {
  const { root, path, writer } = await fixture("b95f607");
  writer.close();
  const directory = join(root, "snapshot");
  const child = Bun.spawn({ cmd: [Bun.which("node")!, nodeCli, "backup", path, directory], stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(stderr);
  expect(JSON.parse(stdout).inventory.pendingMessages).toBe(1);
  const destination = join(root, "restore.db");
  writeFileSync(destination + "-wal", "stale");
  await expect(restoreLegacy(directory, destination)).rejects.toThrow("sidecars");
  expect(existsSync(destination)).toBe(false);
  const backup = join(directory, "legacy.db"), data = readFileSync(backup);
  data[data.length - 1] ^= 1; writeFileSync(backup, data);
  await expect(verifyLegacySnapshot(directory)).rejects.toThrow("checksum mismatch");
  const missing = join(root, "partial"); mkdirSync(missing);
  await expect(restoreLegacy(missing, join(root, "other.db"))).rejects.toThrow();
  expect(existsSync(join(root, "other.db"))).toBe(false);
});
