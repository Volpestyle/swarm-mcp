import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Inspect without applying pragmas, migrations or creating a missing database. */
export async function assertLegacyDatabase(path: string) {
  if (!isAbsolute(path)) throw new Error("Legacy database path must be absolute");
  if (!existsSync(path)) return;
  const db: { prepare(sql: string): { get(): unknown }; close(): void } = typeof Bun !== "undefined"
    ? new (await import("bun:sqlite")).Database(path, { readonly: true, create: false })
    : new (await import("better-sqlite3")).default(path, { readonly: true, fileMustExist: true });
  try {
    const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (application.application_id !== 0 || ![0, 1].includes(version.user_version))
      throw new Error("legacy_database_incompatible: refusing coordinator, foreign or newer database; restore/use a separate legacy snapshot");
  } finally { db.close(); }
}
