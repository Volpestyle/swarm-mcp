import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  };
  close(): void;
}

export async function openSqlite(path: string): Promise<Sqlite> {
  if (!isAbsolute(path))
    throw new Error("Coordinator database path must be absolute");
  mkdirSync(dirname(path), { recursive: true });
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path) as unknown as Sqlite;
  }
  const { default: Database } = await import("better-sqlite3");
  return new Database(path) as unknown as Sqlite;
}
