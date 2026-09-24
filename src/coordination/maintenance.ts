import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { artifactFiles } from "./storage";
import type { Sqlite } from "./sqlite";

/** Offline only: the caller holds the endpoint lock and has refused a live owner.
 * Keep command identities/fingerprints and control records; only response bodies,
 * old event prefixes and unreferenced expired/orphan blobs are disposable. */
export function maintain(db: Sqlite, artifactRoot: string, before: number, apply = false, now = Date.now()) {
  if (!Number.isSafeInteger(before) || before < 0 || before > now)
    throw new Error("Retention cutoff must be a past timestamp");
  const scopes = db.prepare(`SELECT scope,coalesce(min(CASE WHEN created_at>=? THEN id END)-1,max(id)) AS floor
    FROM events GROUP BY scope`).all(before) as Array<{ scope: string; floor: number }>;
  const receipts = (db.prepare("SELECT count(*) AS n FROM commands WHERE created_at<? AND pruned=0 AND type<>'session.open'").get(before) as { n: number }).n;
  const protectedDigests = new Set((db.prepare(`SELECT DISTINCT a.scope,a.digest FROM artifacts a WHERE a.collected_at IS NULL AND (
    a.expires_at IS NULL OR a.expires_at>? OR a.created_at>=?
    OR EXISTS (SELECT 1 FROM finding_artifacts r JOIN findings f ON f.id=r.finding_id WHERE r.artifact_id=a.id AND (f.expires_at IS NULL OR f.expires_at>?))
    OR EXISTS (SELECT 1 FROM tasks t WHERE t.scope=a.scope AND (t.expires_at IS NULL OR t.expires_at>?) AND (instr(coalesce(t.contract,''),a.id)>0 OR instr(coalesce(t.result,''),a.id)>0))
    OR EXISTS (SELECT 1 FROM task_attempts x JOIN tasks t ON t.id=x.task_id WHERE t.scope=a.scope AND (t.expires_at IS NULL OR t.expires_at>?) AND instr(coalesce(x.result,''),a.id)>0)
    OR EXISTS (SELECT 1 FROM inbox_messages m WHERE m.scope=a.scope AND (m.expires_at IS NULL OR m.expires_at>?) AND instr(m.body,a.id)>0)
    OR EXISTS (SELECT 1 FROM shared_kv s WHERE s.scope=a.scope AND s.deleted=0 AND (s.expires_at IS NULL OR s.expires_at>?) AND instr(coalesce(s.value,''),a.id)>0)
    OR EXISTS (SELECT 1 FROM shared_kv_history s WHERE s.scope=a.scope AND s.deleted=0 AND (s.expires_at IS NULL OR s.expires_at>?) AND instr(coalesce(s.value,''),a.id)>0)
    OR EXISTS (SELECT 1 FROM commands c WHERE c.scope=a.scope AND c.pruned=0 AND c.created_at>=? AND instr(c.result,a.id)>0)
  )`).all(now, before, now, now, now, now, now, now, before) as Array<{ scope: string; digest: string }>).map(row =>
    `${createHash("sha256").update(row.scope).digest("hex")}/${row.digest}`));
  const candidates = artifactFiles(artifactRoot).filter(file => file.modified < before
    && (/^[a-f0-9]{64}$/.test(file.name) || /^\.capture-[a-f0-9-]{36}$/.test(file.name))
    && !protectedDigests.has(`${file.directory}/${file.name}`));
  const events = scopes.reduce((n, row) => n + (db.prepare("SELECT count(*) AS n FROM events WHERE scope=? AND id<=?").get(row.scope, row.floor) as { n: number }).n, 0);
  if (apply) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE commands SET result='null',pruned=1 WHERE created_at<? AND pruned=0 AND type<>'session.open'").run(before);
      for (const row of scopes) {
        db.prepare("INSERT INTO event_retention(scope,floor) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET floor=max(floor,excluded.floor)").run(row.scope, row.floor);
        db.prepare("DELETE FROM events WHERE scope=? AND id<=?").run(row.scope, row.floor);
      }
      // Record irreversible collection before deleting bytes. A crash leaves
      // reclaimable garbage, never a restored reference to deleted content.
      const artifacts = db.prepare("SELECT id,scope,digest FROM artifacts").all() as Array<{ id: string; scope: string; digest: string }>;
      const removing = new Set(candidates.map(file => `${file.directory}/${file.name}`));
      for (const row of artifacts) if (removing.has(`${createHash("sha256").update(row.scope).digest("hex")}/${row.digest}`))
        db.prepare("UPDATE artifacts SET collected_at=? WHERE id=?").run(now, row.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    for (const file of candidates) unlinkSync(file.path);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
  }
  return { applied: apply, before, receipts, events, blobs: candidates.length,
    blobBytes: candidates.reduce((n, file) => n + file.bytes, 0),
    retained: "Command IDs/fingerprints, enrollment receipts, inboxes, task/session fences, findings and shared history" };
}
