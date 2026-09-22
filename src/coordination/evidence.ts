import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { CoordinationError, requireText } from "./errors";
import type { CapturedArtifact } from "./artifact-files";
import type { Sqlite } from "./sqlite";
import type { Command, Json } from "./store";
import type { Attempt } from "./tasks";

export type ArtifactImport = {
  id: string;
  path: string;
  summary: string;
  mediaType?: string;
  ttlMs?: number;
};
export type FindingPayload = {
  kind: "result" | "decision" | "annotation";
  summary: string;
  revision: string;
  files: string[];
  verification: string;
  artifactIds: string[];
  taskId?: string;
  attemptId?: string;
  ttlMs?: number;
};
export type EvidenceCommand =
  | { id: string; type: "finding.record"; payload: FindingPayload }
  | {
      id: string;
      type: "retention.set";
      payload: {
        kind: "message" | "task" | "finding" | "artifact";
        entityId: string;
        expiresAt: number | null;
      };
    };
export type ArtifactRow = {
  seq: number;
  id: string;
  scope: string;
  digest: string;
  bytes: number;
  summary: string;
  media_type: string;
  author: string;
  source_path: string;
  created_at: number;
  expires_at: number | null;
};
type FindingRow = {
  seq: number;
  id: string;
  scope: string;
  kind: FindingPayload["kind"];
  summary: string;
  task_id: string | null;
  attempt_id: string | null;
  author: string;
  session_id: string | null;
  revision: string;
  files: string;
  verification: string;
  created_at: number;
  expires_at: number | null;
};
export type FindingFilter = {
  taskId?: string;
  file?: string;
  kind?: FindingPayload["kind"];
  currentRevision?: string;
  cursor?: number;
  limit?: number;
};
export function expiry(at: number, ttlMs?: number) {
  if (ttlMs === undefined) return null;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 365 * 24 * 3600000)
    throw new CoordinationError(
      "invalid_input",
      "TTL must be 1 millisecond to 365 days",
    );
  return at + ttlMs;
}
function pagination(cursor = 0, limit = 50) {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new CoordinationError(
      "invalid_input",
      "Invalid cursor or page limit (1..100)",
    );
  return { cursor, limit };
}
function revision(value: string) {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
  )
    throw new CoordinationError(
      "invalid_input",
      "Supply a full 40- or 64-character repository revision, not a branch name",
    );
}
function filePath(value: string) {
  requireText(value, "file", 4096);
  const path = value.replaceAll("\\", "/");
  if (
    path === "." ||
    path.startsWith("/") ||
    path.includes(":") ||
    path.split("/").includes("..")
  )
    throw new CoordinationError(
      "invalid_input",
      "Finding files must be repository-relative paths without traversal",
    );
  return posix.normalize(path);
}
export function artifactRow(db: Sqlite, scope: string, id: string) {
  requireText(id, "artifact ID");
  return (
    (db
      .prepare("SELECT * FROM artifacts WHERE scope=? AND id=?")
      .get(scope, id) as ArtifactRow | undefined) ?? null
  );
}
export function artifactRows(
  db: Sqlite,
  scope: string,
  cursor = 0,
  limit = 50,
) {
  pagination(cursor, limit);
  return db
    .prepare(
      "SELECT * FROM artifacts WHERE scope=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .all(scope, cursor, limit) as ArtifactRow[];
}
export function readFindings(
  db: Sqlite,
  scope: string,
  at: number,
  filter: FindingFilter = {},
) {
  const { cursor, limit } = pagination(filter.cursor, filter.limit);
  const where = ["scope=?", "seq>?"];
  const params: unknown[] = [scope, cursor];
  if (filter.taskId !== undefined) {
    requireText(filter.taskId, "taskId");
    where.push("task_id=?");
    params.push(filter.taskId);
  }
  if (filter.kind !== undefined) {
    if (!["result", "decision", "annotation"].includes(filter.kind))
      throw new CoordinationError("invalid_input", "Unknown finding kind");
    where.push("kind=?");
    params.push(filter.kind);
  }
  if (filter.file !== undefined) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(findings.files) WHERE value=?)",
    );
    params.push(filePath(filter.file));
  }
  if (filter.currentRevision !== undefined) revision(filter.currentRevision);
  const rows = db
    .prepare(
      `SELECT * FROM findings WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`,
    )
    .all(...params, limit) as FindingRow[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      author: row.author,
      sessionId: row.session_id,
      revision: row.revision,
      files: JSON.parse(row.files) as string[],
      verification: row.verification,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status:
        row.expires_at !== null && row.expires_at <= at
          ? "expired"
          : "retained",
      freshness:
        row.kind !== "annotation"
          ? "not_applicable"
          : filter.currentRevision === undefined
            ? "unknown"
            : row.revision === filter.currentRevision.toLowerCase()
              ? "current"
              : "stale",
      artifactIds: (
        db
          .prepare(
            "SELECT artifact_id FROM finding_artifacts WHERE finding_id=? ORDER BY artifact_id",
          )
          .all(row.id) as { artifact_id: string }[]
      ).map((r) => r.artifact_id),
    })),
    cursor: rows.at(-1)?.seq ?? cursor,
  };
}

export class EvidenceTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}
  artifact(
    input: ArtifactImport,
    captured: CapturedArtifact,
    sourcePath: string,
  ) {
    requireText(input.summary, "summary", 2048);
    const mediaType = input.mediaType ?? "application/octet-stream";
    requireText(mediaType, "mediaType", 128);
    if (
      !/^[a-f0-9]{64}$/.test(captured.digest) ||
      !Number.isSafeInteger(captured.bytes) ||
      captured.bytes < 0
    )
      throw new CoordinationError("invalid_input", "Invalid captured artifact");
    const id = randomUUID(),
      expiresAt = expiry(this.at, input.ttlMs);
    this.db
      .prepare(
        "INSERT INTO artifacts(id,scope,digest,bytes,summary,media_type,author,source_path,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        this.command.scope,
        captured.digest,
        captured.bytes,
        input.summary,
        mediaType,
        this.command.actor,
        sourcePath,
        this.at,
        expiresAt,
      );
    this.change("artifact.captured", id, {
      digest: captured.digest,
      bytes: captured.bytes,
      expiresAt,
    });
    return {
      artifactId: id,
      uri: `swarm://artifacts/${id}`,
      digest: captured.digest,
      bytes: captured.bytes,
      summary: input.summary,
      expiresAt,
    };
  }
  record(input: FindingPayload) {
    if (!["result", "decision", "annotation"].includes(input.kind))
      throw new CoordinationError("invalid_input", "Invalid finding kind");
    requireText(input.summary, "summary", 2048);
    requireText(input.verification, "verification", 2048);
    revision(input.revision);
    if (
      !Array.isArray(input.files) ||
      input.files.length > 100 ||
      !Array.isArray(input.artifactIds) ||
      input.artifactIds.length > 20
    )
      throw new CoordinationError(
        "invalid_input",
        "At most 100 relevant files and 20 artifacts are allowed",
      );
    const files = [...new Set(input.files.map(filePath))].sort(),
      artifacts = [...new Set(input.artifactIds)];
    if (input.kind === "annotation" && !files.length)
      throw new CoordinationError(
        "invalid_input",
        "Annotations require at least one file",
      );
    if (input.taskId) {
      requireText(input.taskId, "taskId");
      if (
        !this.db
          .prepare("SELECT 1 FROM tasks WHERE scope=? AND id=?")
          .get(this.command.scope, input.taskId)
      )
        throw new CoordinationError("not_found", "Task is outside this scope");
    }
    if (input.attemptId) {
      requireText(input.attemptId, "attemptId");
      const attempt = this.db
        .prepare(
          "SELECT a.* FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND t.scope=?",
        )
        .get(input.attemptId, this.command.scope) as Attempt | undefined;
      if (!attempt || attempt.task_id !== input.taskId)
        throw new CoordinationError(
          "not_found",
          "Attempt does not belong to the referenced task",
        );
      if (
        input.kind === "result" &&
        (attempt.actor !== this.command.actor ||
          attempt.session_id !== this.command.sessionId ||
          attempt.generation !== this.command.generation ||
          attempt.state === "abandoned" ||
          (attempt.state === "running" && attempt.lease_until <= this.at))
      )
        throw new CoordinationError(
          "stale_attempt",
          "Only the attempt's current session may publish its result",
        );
    }
    if (input.kind === "result" && (!input.taskId || !input.attemptId))
      throw new CoordinationError(
        "invalid_input",
        "Results require task and attempt provenance",
      );
    for (const artifactId of artifacts) {
      const artifact = artifactRow(this.db, this.command.scope, artifactId);
      if (!artifact)
        throw new CoordinationError(
          "not_found",
          "Artifact is outside this scope",
        );
    }
    const id = randomUUID(),
      expiresAt = expiry(this.at, input.ttlMs);
    this.db
      .prepare(
        "INSERT INTO findings(id,scope,kind,summary,task_id,attempt_id,author,session_id,revision,files,verification,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        this.command.scope,
        input.kind,
        input.summary,
        input.taskId ?? null,
        input.attemptId ?? null,
        this.command.actor,
        this.command.sessionId ?? null,
        input.revision.toLowerCase(),
        JSON.stringify(files),
        input.verification,
        this.at,
        expiresAt,
      );
    for (const artifactId of artifacts)
      this.db
        .prepare(
          "INSERT INTO finding_artifacts(finding_id,artifact_id) VALUES(?,?)",
        )
        .run(id, artifactId);
    this.change("finding.recorded", id, {
      kind: input.kind,
      taskId: input.taskId ?? null,
      revision: input.revision.toLowerCase(),
      expiresAt,
    });
    return { findingId: id, createdAt: this.at, expiresAt };
  }
  retention(
    input: Extract<EvidenceCommand, { type: "retention.set" }>["payload"],
  ) {
    requireText(input.entityId, "entityId");
    if (
      input.expiresAt !== null &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)
    )
      throw new CoordinationError(
        "invalid_input",
        "Expiry must be null or an epoch timestamp in milliseconds",
      );
    const definitions = {
      message: { table: "inbox_messages", owner: "sender" },
      task: { table: "tasks", owner: "creator" },
      finding: { table: "findings", owner: "author" },
      artifact: { table: "artifacts", owner: "author" },
    } as const;
    const definition = Object.hasOwn(definitions, input.kind)
      ? definitions[input.kind]
      : undefined;
    if (!definition)
      throw new CoordinationError("invalid_input", "Unknown retention entity");
    const row = this.db
      .prepare(`SELECT * FROM ${definition.table} WHERE scope=? AND id=?`)
      .get(this.command.scope, input.entityId) as
      | Record<string, unknown>
      | undefined;
    if (!row)
      throw new CoordinationError(
        "not_found",
        "Retention entity does not exist in this scope",
      );
    if (row[definition.owner] !== this.command.actor)
      throw new CoordinationError(
        "forbidden",
        "Only the author/creator may change retention",
      );
    if (
      input.kind === "task" &&
      !["completed", "failed", "cancelled"].includes(row.status as string)
    )
      throw new CoordinationError(
        "invalid_transition",
        "Active tasks cannot expire",
      );
    this.db
      .prepare(
        `UPDATE ${definition.table} SET expires_at=? WHERE scope=? AND id=?`,
      )
      .run(input.expiresAt, this.command.scope, input.entityId);
    this.change("retention.changed", input.entityId, {
      kind: input.kind,
      expiresAt: input.expiresAt,
    });
    return {
      kind: input.kind,
      entityId: input.entityId,
      expiresAt: input.expiresAt,
    };
  }
}
