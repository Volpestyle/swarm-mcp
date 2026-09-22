import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Sqlite } from "./sqlite";
import type { Command, Json } from "./store";
import type { Worktree } from "./worktrees";

export type SessionContext = {
  scope: string;
  actor: string;
  sessionId: string;
  generation: number;
};
export type SessionCommand =
  | {
      id: string;
      type: "session.observe";
      payload: {
        transport?: boolean;
        runtime?: "available" | "busy" | "unavailable";
        progress?: boolean;
        label?: string;
      };
    }
  | {
      id: string;
      type: "session.suspend" | "session.close";
      payload: Record<string, never>;
    };
export type Enrollment = {
  scope: string;
  agentId: string;
  requestId: string;
  resumeToken: string;
  label?: string;
  worktree?: Worktree;
};
type Agent = {
  scope: string;
  id: string;
  resume_hash: string;
  generation: number;
  label: string;
  created_at: number;
};
export type Session = {
  id: string;
  scope: string;
  agent_id: string;
  generation: number;
  state: "active" | "suspended" | "superseded" | "closed";
  runtime_state: "available" | "busy" | "unavailable";
  transport_at: number | null;
  runtime_at: number | null;
  progress_at: number | null;
  created_at: number;
  ended_at: number | null;
};
const publicColumns =
  "id,scope,agent_id,generation,state,runtime_state,transport_at,runtime_at,progress_at,created_at,ended_at";
export const secretHash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

// Both inputs come from trusted launcher configuration, never descriptive labels.
export function coordinationScope(project: string, profile: string) {
  requireText(project, "project", 4096);
  requireText(profile, "profile");
  return secretHash(JSON.stringify([project, profile]));
}

/** Resolve this from launcher configuration before enrollment. No label or
 * caller-provided profile may replace the configured boundary. */
export function launcherIdentity(input: {
  projectRoot: string;
  profile: string;
  directory: string;
  fileRoot: string;
  allowedRoots?: string[];
}) {
  const normalize = (path: string) => {
    const real = realpathSync(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const projectRoot = normalize(input.projectRoot),
    directory = normalize(input.directory),
    fileRoot = normalize(input.fileRoot);
  const roots = input.allowedRoots?.map(normalize) ?? [];
  for (const path of [projectRoot, directory, fileRoot]) {
    if (
      roots.length &&
      !roots.some((root) => {
        const rel = relative(root, path);
        return (
          rel === "" ||
          (!isAbsolute(rel) &&
            rel !== ".." &&
            !rel.startsWith("..\\") &&
            !rel.startsWith("../"))
        );
      })
    )
      throw new CoordinationError(
        "forbidden",
        "Launcher path is outside the profile's allowed roots",
      );
  }
  return {
    projectRoot,
    directory,
    fileRoot,
    profile: input.profile,
    scope: coordinationScope(projectRoot, input.profile),
  };
}
export function enrollmentCapability(input: Enrollment) {
  requireText(input.resumeToken, "resumeToken", 512);
  if (input.resumeToken.length < 32)
    throw new CoordinationError(
      "invalid_input",
      "Resume token must contain at least 32 characters of generated secret material",
    );
  requireText(input.requestId, "requestId");
  requireText(input.agentId, "agentId");
  requireText(input.scope, "scope");
  return createHmac("sha256", input.resumeToken)
    .update(JSON.stringify([input.scope, input.agentId, input.requestId]))
    .digest("hex");
}
export function checkEnrollment(db: Sqlite, input: Enrollment) {
  const agent = db
    .prepare("SELECT * FROM agents WHERE scope=? AND id=?")
    .get(input.scope, input.agentId) as Agent | undefined;
  if (
    agent &&
    !timingSafeEqual(
      Buffer.from(agent.resume_hash, "hex"),
      Buffer.from(secretHash(input.resumeToken), "hex"),
    )
  ) {
    throw new CoordinationError(
      "forbidden",
      "Stable identity requires its launcher-issued resume token",
    );
  }
  return agent;
}
export function readSession(
  db: Sqlite,
  scope: string,
  id: string,
): Session | null {
  return (
    (db
      .prepare(`SELECT ${publicColumns} FROM sessions WHERE scope=? AND id=?`)
      .get(scope, id) as Session | undefined) ?? null
  );
}
export function validateSession(db: Sqlite, context: SessionContext) {
  const row = db
    .prepare(
      `SELECT s.${publicColumns.split(",").join(",s.")} FROM sessions s JOIN agents a ON a.scope=s.scope AND a.id=s.agent_id WHERE s.id=? AND s.scope=? AND s.agent_id=? AND s.generation=? AND s.generation=a.generation AND s.state='active'`,
    )
    .get(
      context.sessionId,
      context.scope,
      context.actor,
      context.generation,
    ) as Session | undefined;
  if (!row)
    throw new CoordinationError(
      "stale_session",
      "Session is suspended, closed or superseded; resume through the trusted launcher",
    );
  return row;
}
export function authorizeSession(
  db: Sqlite,
  capability: string,
): SessionContext {
  requireText(capability, "capability", 512);
  const row = db
    .prepare(
      "SELECT scope,agent_id,id,generation FROM sessions WHERE capability_hash=?",
    )
    .get(secretHash(capability)) as
    | { scope: string; agent_id: string; id: string; generation: number }
    | undefined;
  if (!row)
    throw new CoordinationError("unauthorized", "Unknown session capability");
  const context = {
    scope: row.scope,
    actor: row.agent_id,
    sessionId: row.id,
    generation: row.generation,
  };
  validateSession(db, context);
  return context;
}

export class SessionTransaction {
  constructor(
    private readonly db: Sqlite,
    private readonly command: Command,
    private readonly at: number,
    private readonly change: (type: string, id: string, payload: Json) => void,
  ) {}
  open(input: Enrollment, capability: string) {
    const existing = checkEnrollment(this.db, input);
    const generation = (existing?.generation ?? 0) + 1;
    const label = input.label ?? existing?.label ?? "";
    if (label) requireText(label, "label", 1024);
    if (!existing)
      this.db
        .prepare(
          "INSERT INTO agents(scope,id,resume_hash,generation,label,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          input.scope,
          input.agentId,
          secretHash(input.resumeToken),
          generation,
          label,
          this.at,
        );
    else {
      this.db
        .prepare(
          "UPDATE agents SET generation=?,label=? WHERE scope=? AND id=?",
        )
        .run(generation, label, input.scope, input.agentId);
      this.db
        .prepare(
          "UPDATE sessions SET state='superseded',ended_at=? WHERE scope=? AND agent_id=? AND state IN ('active','suspended')",
        )
        .run(this.at, input.scope, input.agentId);
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions(id,scope,agent_id,generation,capability_hash,state,runtime_state,created_at) VALUES(?,?,?,?,?,'active','unavailable',?)",
      )
      .run(
        id,
        input.scope,
        input.agentId,
        generation,
        secretHash(capability),
        this.at,
      );
    if (input.worktree) {
      requireText(input.worktree.root, "worktree root", 4096);
      requireText(input.worktree.repository, "repository root", 4096);
      this.db
        .prepare(
          "UPDATE sessions SET worktree_root=?,repository_root=? WHERE id=?",
        )
        .run(input.worktree.root, input.worktree.repository, id);
    }
    this.change("session.opened", id, { agentId: input.agentId, generation });
    return {
      scope: input.scope,
      actor: input.agentId,
      sessionId: id,
      generation,
    };
  }
  observe(
    payload: Extract<SessionCommand, { type: "session.observe" }>["payload"],
  ) {
    const context = this.context();
    if (
      payload.runtime !== undefined &&
      !["available", "busy", "unavailable"].includes(payload.runtime)
    )
      throw new CoordinationError("invalid_input", "Invalid runtime state");
    if (
      (payload.transport !== undefined &&
        typeof payload.transport !== "boolean") ||
      (payload.progress !== undefined && typeof payload.progress !== "boolean")
    )
      throw new CoordinationError(
        "invalid_input",
        "Observation flags must be booleans",
      );
    if (payload.label !== undefined) {
      requireText(payload.label, "label", 1024);
      this.db
        .prepare("UPDATE agents SET label=? WHERE scope=? AND id=?")
        .run(payload.label, context.scope, context.actor);
    }
    this.db
      .prepare(
        "UPDATE sessions SET transport_at=CASE WHEN ? THEN ? ELSE transport_at END,runtime_state=COALESCE(?,runtime_state),runtime_at=CASE WHEN ? THEN ? ELSE runtime_at END,progress_at=CASE WHEN ? THEN ? ELSE progress_at END WHERE id=?",
      )
      .run(
        payload.transport ? 1 : 0,
        this.at,
        payload.runtime ?? null,
        payload.runtime !== undefined ? 1 : 0,
        this.at,
        payload.progress ? 1 : 0,
        this.at,
        context.sessionId,
      );
    this.change("session.observed", context.sessionId, {
      transport: payload.transport ?? false,
      runtime: payload.runtime ?? null,
      progress: payload.progress ?? false,
    });
    return { ...readSession(this.db, context.scope, context.sessionId)! };
  }
  end(state: "suspended" | "closed") {
    const context = this.context();
    this.db
      .prepare(
        "UPDATE sessions SET state=?,ended_at=?,runtime_state='unavailable' WHERE id=?",
      )
      .run(state, this.at, context.sessionId);
    this.change(`session.${state}`, context.sessionId, {
      generation: context.generation,
    });
    return { sessionId: context.sessionId, state };
  }
  private context(): SessionContext {
    if (!this.command.sessionId || !this.command.generation)
      throw new CoordinationError(
        "session_required",
        "This operation requires an enrolled session",
      );
    const context = this.command as SessionContext;
    validateSession(this.db, context);
    return context;
  }
}
