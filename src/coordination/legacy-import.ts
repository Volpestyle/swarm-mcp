import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync, fsyncSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { openSqlite, type Sqlite } from "./sqlite";
import { migrate } from "./migrations";
import { readLegacySnapshotRows } from "./legacy-snapshot";
import { requireText } from "./errors";

export type LegacyImportPlan = { version: 1; scopes: Array<{
  from: string; to: string; taskController: string; recipients: Record<string, string>;
  broadcastRecipients?: string[];
}> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, label: string, empty = false): string => {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 4096)
    throw new Error(`Invalid import ${label}`);
  return value;
};
const json = (value: unknown) => JSON.stringify(value, (_key, v) =>
  typeof v === "bigint" ? { legacyInteger: String(v) } : v);

/** Offline import into a new directory only. No historical sessions are revived. */
export async function importLegacy(directory: string, destination: string, input: LegacyImportPlan,
  fault?: (point: "before_import_commit" | "before_import_publish") => void) {
  if (!isAbsolute(destination)) throw new Error("Import destination must be absolute");
  const { manifest, tables } = await readLegacySnapshotRows(directory);
  if (input?.version !== 1 || !Array.isArray(input.scopes) || !input.scopes.length)
    throw new Error("Unsupported import plan");
  const plan: LegacyImportPlan = JSON.parse(JSON.stringify(input));
  const scopes = new Map<string, LegacyImportPlan["scopes"][number]>();
  const targets = new Set<string>();
  for (const scope of plan.scopes) {
    text(scope.from, "source scope", true); requireText(scope.to, "destination scope");
    requireText(scope.taskController, "task controller");
    if (scopes.has(scope.from) || targets.has(scope.to)) throw new Error("Import scope mappings must be one-to-one");
    if (!scope.recipients || typeof scope.recipients !== "object" || Array.isArray(scope.recipients))
      throw new Error("Import recipient mapping is required");
    for (const [old, actor] of Object.entries(scope.recipients)) { text(old, "legacy recipient"); requireText(actor, "recipient"); }
    if (scope.broadcastRecipients !== undefined) {
      if (!Array.isArray(scope.broadcastRecipients)) throw new Error("Invalid broadcast audience");
      scope.broadcastRecipients.forEach(actor => requireText(actor, "broadcast recipient"));
    }
    scopes.set(scope.from, scope); targets.add(scope.to);
  }
  for (const table of ["messages", "tasks", "context", "kv", "instances"])
    for (const row of tables[table] ?? [])
      if (!scopes.has(String(row.scope ?? ""))) throw new Error(`Unmapped legacy scope in ${table}: ${row.scope ?? ""}`);
  const routes = (row: Record<string, unknown>) => {
    const scope = scopes.get(String(row.scope ?? ""))!;
    const recipients = row.recipient === null || row.recipient === undefined
      ? scope.broadcastRecipients ?? [] : [Object.hasOwn(scope.recipients, String(row.recipient))
        ? scope.recipients[String(row.recipient)] : undefined];
    if (!recipients.length || recipients.some(actor => !actor))
      throw new Error(`Unresolved pending message recipient/audience: ${row.id}`);
    return [...new Set(recipients)] as string[];
  };
  for (const row of tables.messages ?? []) if (row.read === 0) {
    routes(row);
    requireText(row.content, `legacy message ${row.id} body`, 16384);
    // Leave space for the envelope in a one-item bounded inbox response.
    if (Buffer.byteLength(json(row.content)) > 48 * 1024)
      throw new Error(`Legacy message ${row.id} needs explicit artifact migration before import`);
  }
  for (const row of tables.tasks ?? []) requireText(row.title, `legacy task ${row.id} title`, 990);
  const importId = digest(manifest.sha256 + json(plan));
  const id = (kind: string, scope: unknown, old: unknown) => `legacy-${digest(`${manifest.sha256}:${kind}:${scope ?? ""}:${old}`).slice(0, 32)}`;
  const summary = { importId, snapshotHash: manifest.sha256, tasks: 0, reviewTasks: 0,
    pendingMessages: 0, deliveries: 0, archivedReadMessages: 0, annotations: 0,
    legacyLocks: 0, sharedKeys: 0, retainedRows: 0,
    unresolvedDependencies: [] as Array<{ legacyTaskId: string; dependency: string }>,
    holds: [] as Array<{ scope: string; legacyTaskId: string; taskId: string; reviewTaskId: string }> };
  mkdirSync(destination, { mode: 0o700 }); // Never merge into a live or prior import.
  const marker = join(destination, "import.pending");
  const markerFd = openSync(marker, "wx", 0o600);
  try { writeFileSync(markerFd, importId + "\n"); fsyncSync(markerFd); } finally { closeSync(markerFd); }
  const pending = join(destination, "importing.db"), final = join(destination, "coordination.db");
  const connection = await openSqlite(pending);
  // Bun's uncached prepared statements outlive close() unless finalized. Keep
  // this offline import's finite SQL set and release it before publishing files.
  const statements = new Map<string, ReturnType<Sqlite["prepare"]> & { finalize?: () => void }>();
  const db: Sqlite = {
    exec: sql => connection.exec(sql),
    prepare: sql => {
      let statement = statements.get(sql);
      if (!statement) { statement = connection.prepare(sql); statements.set(sql, statement); }
      return statement;
    },
    close: () => {
      try { for (const statement of statements.values()) statement.finalize?.(); }
      finally { connection.close(); }
    },
  };
  const now = Date.now();
  try {
    migrate(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO legacy_imports VALUES(?,?,?,?,?)").run(importId, manifest.sha256, json(plan), now, "{}");
      for (const [table, rows] of Object.entries(tables)) for (const [ordinal, row] of rows.entries()) {
        const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
          value instanceof Uint8Array ? { sqliteBlobBase64: Buffer.from(value).toString("base64") } : value]));
        db.prepare("INSERT INTO legacy_records VALUES(?,?,?,?)").run(importId, table, ordinal, json(record));
        summary.retainedRows++;
      }
      const event = (scope: string, type: string, entity: string, payload: unknown) =>
        db.prepare("INSERT INTO events(scope,actor,type,entity_id,payload,created_at) VALUES(?,?,?,?,?,?)")
          .run(scope, "legacy-import", type, entity, json(payload), now);
      for (const row of tables.tasks ?? []) {
        const mapping = scopes.get(String(row.scope ?? ""))!;
        const scope = mapping.to;
        const taskId = id("task", row.scope, row.id);
        const status = row.status === "done" || row.status === "completed" ? "completed"
          : row.status === "failed" ? "failed" : row.status === "cancelled" ? "cancelled" : "blocked";
        const provenance = { legacyStatus: row.status, legacyRequester: row.requester, legacyAssignee: row.assignee ?? null,
          legacyTaskId: row.id, resultSource: "legacy_records", importId, verifiedProcessing: false };
        db.prepare("INSERT INTO tasks(id,scope,creator,title,status,version,created_at,updated_at,result,reason) VALUES(?,?,?,?,?,1,?,?,?,?)")
          .run(taskId, scope, mapping.taskController, String(row.title), status, now, now,
            json(provenance), status === "blocked" ? "legacy_reconciliation_required" : "legacy_terminal_record_unverified");
        if (status === "blocked") {
          const reviewTaskId = id("review", row.scope, row.id);
          db.prepare("INSERT INTO tasks(id,scope,creator,title,status,version,created_at,updated_at,reason,result) VALUES(?,?,?,?, 'open',1,?,?,?,?)")
            .run(reviewTaskId, scope, mapping.taskController, `Reconcile imported task: ${row.title}`, now, now,
              "Check old writers, completed side effects, dependencies and new work contract before releasing this task", json(provenance));
          db.prepare("INSERT INTO task_dependencies VALUES(?,?)").run(taskId, reviewTaskId);
          summary.holds.push({ scope, legacyTaskId: String(row.id), taskId, reviewTaskId });
          summary.reviewTasks++;
          event(scope, "task.created", reviewTaskId, { importId, reconciliationFor: taskId });
        }
        event(scope, "task.imported", taskId, { importId, legacyId: row.id, status });
        summary.tasks++;
      }
      for (const row of tables.tasks ?? []) {
        if (!row.depends_on) continue;
        const dependencies = typeof row.depends_on === "string" ? JSON.parse(row.depends_on) : row.depends_on;
        if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== "string"))
          throw new Error(`Invalid legacy task dependencies: ${row.id}`);
        for (const dependency of new Set(dependencies)) {
          const target = (tables.tasks ?? []).find(candidate => candidate.id === dependency);
          if (!target) {
            summary.unresolvedDependencies.push({ legacyTaskId: String(row.id), dependency });
            continue; // Legacy cleanup can remove completed prerequisites; review hold remains.
          }
          if (target.scope !== row.scope) throw new Error(`Cross-scope legacy dependency ${dependency} for ${row.id}`);
          db.prepare("INSERT INTO task_dependencies VALUES(?,?)")
            .run(id("task", row.scope, row.id), id("task", row.scope, dependency));
        }
      }
      for (const row of tables.messages ?? []) {
        if (row.read !== 0) { summary.archivedReadMessages++; continue; }
        const scope = scopes.get(String(row.scope ?? ""))!.to;
        const messageId = id("message", row.scope, row.id), recipients = routes(row);
        db.prepare("INSERT INTO inbox_messages(id,scope,sender,envelope_version,kind,body,created_at,idempotency_key,audience,max_attempts,backoff_ms) VALUES(?,?,?,1,?,?,?,?,?,5,1000)")
          .run(messageId, scope, `legacy:${row.sender}`, "legacy.message", String(row.content), now, messageId,
            row.recipient == null ? "announcement" : "direct");
        for (const recipient of recipients) {
          db.prepare("INSERT INTO inbox_deliveries(message_id,recipient,state,next_attempt_at) VALUES(?,?,'pending',?)")
            .run(messageId, recipient, now);
          summary.deliveries++;
        }
        event(scope, "message.accepted", messageId, { importId, recipients, legacyId: row.id });
        summary.pendingMessages++;
      }
      for (const row of tables.context ?? []) {
        const scope = scopes.get(String(row.scope ?? ""))!.to, findingId = id("context", row.scope, row.id);
        const locked = row.type === "lock";
        db.prepare("INSERT INTO findings(id,scope,kind,summary,author,revision,files,verification,created_at) VALUES(?,?,'annotation',?,?,?,?,?,?)")
          .run(findingId, scope, `${locked ? '[Historical lock; no active reservation] ' : ''}${row.content}`,
            `legacy:${row.instance_id}`, manifest.sha256, json(row.file ? [row.file] : []),
            json({ importId, legacyType: row.type, historical: true }), now);
        if (locked) summary.legacyLocks++; else summary.annotations++;
        event(scope, "finding.imported", findingId, { importId, legacyId: row.id, historicalLock: locked });
      }
      for (const row of tables.kv ?? []) {
        const scope = scopes.get(String(row.scope ?? ""))!.to;
        // Namespace historical keys so old runtime/control hints cannot become current authority.
        const key = `legacy/${row.key}`, value = json({ legacyValue: row.value, importId });
        db.prepare("INSERT INTO shared_kv(scope,key,version,value,deleted,author,updated_at) VALUES(?,?,1,?,0,'legacy-import',?)")
          .run(scope, key, value, now);
        db.prepare("INSERT INTO shared_kv_history(scope,key,version,value,deleted,author,updated_at) VALUES(?,?,1,?,0,'legacy-import',?)")
          .run(scope, key, value, now);
        summary.sharedKeys++;
      }
      db.prepare("UPDATE legacy_imports SET summary=? WHERE id=?").run(json(summary), importId);
      fault?.("before_import_commit");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // Publish one self-contained file; a renamed WAL database needs new sidecars
    // before read-only clients can inspect it. Normal owner startup enables WAL.
    db.exec("PRAGMA journal_mode=DELETE");
  } finally { db.close(); }
  const fd = openSync(join(destination, "import.json"), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ version: 1, ...summary, plan }, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  // The final database is the publication marker. A stopped import can retain
  // its report and importing.db, but cannot expose a candidate before both exist.
  fault?.("before_import_publish");
  if (existsSync(final)) throw new Error("Import destination appeared unexpectedly");
  renameSync(pending, final);
  unlinkSync(marker);
  return summary;
}
