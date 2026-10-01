import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, SCHEMA_VERSION } from "../src/coordination/migrations";
import type { Sqlite } from "../src/coordination/sqlite";

test.each(["harness", "execution_mode"])("schema 15 (%s lineage) keeps data and migrates atomically", column => {
  const db = new Database(":memory:");
  const sql = db as unknown as Sqlite;
  try {
    migrate(sql);
    const missing = column === "harness" ? "execution_mode" : "harness";
    db.exec(`ALTER TABLE dispatch_intents DROP COLUMN ${missing}; PRAGMA user_version=15`);
    const retained = column === "harness" ? "codex" : "interactive";
    db.exec("INSERT INTO tasks(id,scope,creator,title,status,version,created_at,updated_at) VALUES ('task','scope','lead','Retained', 'open',1,1,1)");
    db.prepare(`INSERT INTO dispatch_intents(scope,intent_id,fingerprint,task_id,route_id,path,state,creator,created_at,${column}) VALUES ('scope','intent','fingerprint','task','herdr','peer','reserved','lead',1,?)`).run(retained);
    expect(() => migrate(sql, point => { if (point === "before_migration_commit") throw new Error("interrupted"); })).toThrow("interrupted");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    expect(db.query("PRAGMA table_info(dispatch_intents)").all().map((entry: any) => entry.name)).not.toContain(missing);
    migrate(sql);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.query("PRAGMA table_info(dispatch_intents)").all().map((entry: any) => entry.name)).toEqual(expect.arrayContaining(["harness", "execution_mode"]));
    expect(db.query(`SELECT ${column} AS value, fingerprint FROM dispatch_intents`).get()).toEqual({ value: retained, fingerprint: "fingerprint" });
    expect(db.query(`SELECT ${missing} AS value FROM dispatch_intents`).get()).toEqual({ value: null });
    migrate(sql);
  } finally { db.close(); }
});
