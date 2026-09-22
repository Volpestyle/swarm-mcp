import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import type { Sqlite } from "./sqlite";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function readOnly(path: string): Promise<Sqlite> {
  if (!isAbsolute(path)) throw new Error("Snapshot paths must be absolute");
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true, create: false }) as unknown as Sqlite;
  }
  const { default: Database } = await import("better-sqlite3");
  return new Database(path, { readonly: true, fileMustExist: true }) as Sqlite;
}

function inspect(db: Sqlite) {
  const applicationId = (db.prepare("PRAGMA application_id").get() as any).application_id;
  const schemaVersion = (db.prepare("PRAGMA user_version").get() as any).user_version;
  if (applicationId !== 0 || ![0, 1].includes(schemaVersion))
    throw new Error("Not a supported legacy database");
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
    throw new Error("Legacy snapshot integrity check failed");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  for (const required of ["instances", "messages", "tasks", "context", "kv"])
    if (!tables.includes(required)) throw new Error(`Legacy table missing: ${required}`);
  const counts = Object.fromEntries(tables.map(name => [name,
    (db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n]));
  const pendingMessages = (db.prepare("SELECT count(*) AS n FROM messages WHERE read=0").get() as { n: number }).n;
  const tasksByStatus = db.prepare("SELECT status,count(*) AS count FROM tasks GROUP BY status ORDER BY status").all();
  const contextByType = db.prepare("SELECT type,count(*) AS count FROM context GROUP BY type ORDER BY type").all();
  return { applicationId, schemaVersion, tables, counts, pendingMessages, tasksByStatus, contextByType };
}

function durableWrite(path: string, bytes: string | Uint8Array) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** SQLite performs a consistent snapshot including committed WAL pages. */
export async function backupLegacy(source: string, directory: string) {
  if (!isAbsolute(directory)) throw new Error("Snapshot directory must be absolute");
  const db = await readOnly(source);
  try {
    inspect(db);
    mkdirSync(directory, { mode: 0o700 }); // Exclusive reservation, never overwrite.
    db.prepare("VACUUM INTO ?").run(join(directory, "legacy.db"));
  } finally { db.close(); }
  const backupPath = join(directory, "legacy.db");
  const snapshot = await readOnly(backupPath);
  let inventory: ReturnType<typeof inspect>;
  try { inventory = inspect(snapshot); } finally { snapshot.close(); }
  const fd = openSync(backupPath, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const bytes = readFileSync(backupPath);
  const manifest = { format: "swarm-legacy-snapshot", version: 1,
    createdAt: new Date().toISOString(), source, database: "legacy.db",
    bytes: bytes.length, sha256: hash(bytes), inventory,
    authority: "Historical identities, tasks and leases are retained data, not live coordinator authority",
  };
  // Manifest is the completion marker. A partial directory is never restorable.
  durableWrite(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function verifyLegacySnapshot(directory: string) {
  if (!isAbsolute(directory)) throw new Error("Snapshot directory must be absolute");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.format !== "swarm-legacy-snapshot" || manifest.version !== 1 || manifest.database !== "legacy.db")
    throw new Error("Unsupported legacy snapshot manifest");
  const bytes = readFileSync(join(directory, "legacy.db"));
  if (manifest.bytes !== bytes.length || manifest.sha256 !== hash(bytes))
    throw new Error("Legacy snapshot checksum mismatch");
  const db = await readOnly(join(directory, "legacy.db"));
  try {
    const inventory = inspect(db);
    if (JSON.stringify(inventory) !== JSON.stringify(manifest.inventory))
      throw new Error("Legacy snapshot inventory mismatch");
  } finally { db.close(); }
  return { manifest, bytes };
}

/** Restore to a fresh path; never replace a live or newer database. */
export async function restoreLegacy(directory: string, destination: string) {
  if (!isAbsolute(destination)) throw new Error("Restore destination must be absolute");
  if (["-wal", "-shm", "-journal"].some(suffix => existsSync(destination + suffix)))
    throw new Error("Restore destination has existing SQLite sidecars");
  const { manifest, bytes } = await verifyLegacySnapshot(directory);
  durableWrite(destination, bytes);
  return { destination, sha256: manifest.sha256, bytes: bytes.length };
}
