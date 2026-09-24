import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { CoordinationError } from "./errors";
import type { Sqlite } from "./sqlite";

export const DEFAULT_STORAGE = { databaseBytes: 1024 ** 3, artifactBytes: 1024 ** 3 };
export type StorageLimits = typeof DEFAULT_STORAGE;
export function storageLimits(input: Partial<StorageLimits> = {}): StorageLimits {
  const limits = { ...DEFAULT_STORAGE, ...input };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1024 * 1024)
      throw new CoordinationError("invalid_input", `${key} must be at least 1 MiB`);
  return limits;
}
export function limitDatabase(db: Sqlite, bytes: number) {
  const size = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const pages = Math.floor(bytes / size);
  const actual = db.prepare(`PRAGMA max_page_count=${pages}`).get() as { max_page_count: number };
  if (actual.max_page_count > pages)
    throw new CoordinationError("storage_full", "Database exceeds its configured limit; run offline maintenance or raise the limit");
}
export function storageError(error: unknown): unknown {
  return (error as { code?: string })?.code === "SQLITE_FULL"
    ? new CoordinationError("storage_full", "Database limit reached; run offline maintenance or raise the limit") : error;
}

/** ponytail: scan the two-level blob store; persist accounting if capture
 * frequency makes filesystem metadata scans material. Never follow symlinks. */
export function artifactFiles(root: string) {
  const files: Array<{ path: string; directory: string; name: string; bytes: number; modified: number }> = [];
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return files; throw error; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
    for (const file of readdirSync(join(root, dir.name), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const path = join(root, dir.name, file.name), stat = lstatSync(path);
      files.push({ path, directory: dir.name, name: file.name, bytes: stat.size, modified: stat.mtimeMs });
    }
  }
  return files;
}
