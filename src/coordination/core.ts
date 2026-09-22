import { CoordinationError, requireText } from "./errors";
import { CoordinationStore, type CommandResult, type Json } from "./store";
import type { InboxCommand } from "./inbox";
import type { SessionCommand } from "./sessions";
import type { TaskCommand } from "./tasks";
import type { ReservationCommand, Resource } from "./reservations";
import { canonicalPath, mapWorktreeFile } from "./worktrees";
import type { SharedContextCommand } from "./shared-context";
import type { PeerFilter, TaskFilter } from "./queries";
import {
  expiry,
  type ArtifactImport,
  type EvidenceCommand,
  type FindingFilter,
} from "./evidence";

// Trusted application context. The local service supplies this after validating
// its session capability; transports must never treat a caller's label as auth.
export interface ActorContext {
  scope: string;
  actor: string;
  sessionId?: string;
  generation?: number;
}
export type CoreCommand =
  | InboxCommand
  | SessionCommand
  | TaskCommand
  | SharedContextCommand
  | EvidenceCommand
  | ReservationCommand;

export class CoordinationCore {
  constructor(private readonly store: CoordinationStore) {}
  bootstrap(context: ActorContext) {
    this.store.assertContext(context);
    return this.store.bootstrap(context.scope, context.actor);
  }
  peers(context: ActorContext, filter?: PeerFilter) {
    this.store.assertContext(context);
    return this.store.peers(context.scope, filter);
  }
  taskSummaries(context: ActorContext, filter?: TaskFilter) {
    this.store.assertContext(context);
    return this.store.taskSummaries(context.scope, filter);
  }

  command(context: ActorContext, command: CoreCommand): CommandResult<Json> {
    let resources: Resource[] = [];
    if (command.type === "reservation.acquire") {
      const worktree = this.store.worktree(context);
      if (command.payload.kind === "file") {
        if (
          !Array.isArray(command.payload.paths) ||
          !command.payload.paths.length ||
          command.payload.paths.length > 100
        )
          throw new CoordinationError(
            "invalid_input",
            "File reservations require 1..100 paths",
          );
        resources = command.payload.paths.map((path) => ({
          kind: "file",
          ...mapWorktreeFile(worktree, path),
        }));
      } else if (command.payload.kind === "integration") {
        const repository = canonicalPath(worktree.repository);
        resources = [
          {
            kind: "integration",
            physical: repository,
            repository,
            worktree: canonicalPath(worktree.root),
            logical: "integration",
          },
        ];
      } else
        throw new CoordinationError(
          "invalid_input",
          "Unknown reservation kind",
        );
    }
    return this.store.execute(
      {
        id: command.id,
        type: command.type,
        payload:
          command.type === "reservation.acquire"
            ? { ...command.payload, resources }
            : command.payload,
        ...context,
      },
      (tx) => {
        switch (command.type) {
          case "finding.record":
            return tx.evidence.record(command.payload);
          case "retention.set":
            return tx.evidence.retention(command.payload);
          case "kv.set":
            return tx.shared.set(command.payload);
          case "kv.append":
            return tx.shared.append(command.payload);
          case "kv.delete":
            return tx.shared.delete(command.payload);
          case "reservation.acquire":
            return tx.reservations.acquire(command.payload, resources);
          case "reservation.renew":
            return tx.reservations.renew(command.payload);
          case "reservation.release":
            return tx.reservations.release(command.payload);
          case "reservation.check":
            return tx.reservations.check(command.payload);
          case "reservation.sweep":
            return tx.reservations.sweep();
          case "session.observe":
            return tx.sessions.observe(command.payload);
          case "session.suspend":
            return tx.sessions.end("suspended");
          case "session.close":
            return tx.sessions.end("closed");
          case "message.send":
            return tx.inbox.send(
              command.payload,
              [command.payload.recipient],
              "direct",
            );
          case "message.announce":
            return tx.inbox.send(
              command.payload,
              command.payload.recipients,
              "announcement",
            );
          case "inbox.fetch":
            return tx.inbox.fetch(command.payload);
          case "inbox.ack":
            return tx.inbox.acknowledge(command.payload);
          case "inbox.reject":
            return tx.inbox.reject(command.payload);
          case "inbox.sweep":
            return tx.inbox.sweep();
          case "task.create":
            return tx.tasks.create(command.payload);
          case "task.claim":
            return tx.tasks.claim(command.payload);
          case "task.renew":
            return tx.tasks.renew(command.payload);
          case "task.progress":
            return tx.tasks.progress(command.payload);
          case "task.finish":
            return tx.tasks.finish(command.payload);
          case "task.cancel":
            return tx.tasks.cancel(command.payload);
          case "task.retry":
            return tx.tasks.retry(command.payload);
          case "task.recover":
            return tx.tasks.recover(command.payload);
          default:
            throw new CoordinationError(
              "unknown_command",
              "Unknown coordination command",
            );
        }
      },
    );
  }

  task(context: ActorContext, id: string) {
    this.store.assertContext(context);
    return this.store.task(context.scope, id);
  }
  async importArtifact(context: ActorContext, input: ArtifactImport) {
    const command = {
      ...context,
      id: input.id,
      type: "artifact.import",
      payload: { ...input },
    };
    const cached = this.store.replay(command);
    if (cached) return cached;
    requireText(input.summary, "summary", 2048);
    if (input.mediaType !== undefined)
      requireText(input.mediaType, "mediaType", 128);
    expiry(this.store.now(), input.ttlMs);
    const source = mapWorktreeFile(this.store.worktree(context), input.path);
    const captured = await this.store.artifactFiles.capture(
      context.scope,
      source.physical,
    );
    return this.store.execute(command, (tx) =>
      tx.evidence.artifact(input, captured, source.logical),
    );
  }
  async artifact(context: ActorContext, id: string) {
    this.store.assertContext(context);
    const row = this.store.artifact(context.scope, id);
    if (!row) return { artifactId: id, status: "missing_reference" };
    const physical = await this.store.artifactFiles.inspect(context.scope, row);
    this.store.assertContext(context);
    const current = this.store.artifact(context.scope, id)!;
    const status =
      current.expires_at !== null && current.expires_at <= this.store.now()
        ? "expired"
        : physical;
    return {
      artifactId: id,
      uri: `swarm://artifacts/${id}`,
      status,
      digest: current.digest,
      bytes: current.bytes,
      summary: current.summary,
      mediaType: current.media_type,
      author: current.author,
      sourcePath: current.source_path,
      createdAt: current.created_at,
      expiresAt: current.expires_at,
    };
  }
  async artifacts(context: ActorContext, cursor = 0, limit = 50) {
    this.store.assertContext(context);
    const rows = this.store.artifacts(context.scope, cursor, limit);
    return {
      items: await Promise.all(
        rows.map((row) => this.artifact(context, row.id)),
      ),
      cursor: rows.at(-1)?.seq ?? cursor,
    };
  }
  async readArtifact(
    context: ActorContext,
    id: string,
    offset = 0,
    limit = 32768,
  ) {
    this.store.assertContext(context);
    const row = this.store.artifact(context.scope, id);
    if (!row)
      return { artifactId: id, status: "missing_reference", data: null };
    if (row.expires_at !== null && row.expires_at <= this.store.now())
      return { artifactId: id, status: "expired", data: null };
    const result = await this.store.artifactFiles.read(
      context.scope,
      row,
      offset,
      limit,
    );
    this.store.assertContext(context);
    const current = this.store.artifact(context.scope, id)!;
    if (current.expires_at !== null && current.expires_at <= this.store.now())
      return { artifactId: id, status: "expired", data: null };
    return { artifactId: id, ...result };
  }
  async findings(context: ActorContext, filter: FindingFilter = {}) {
    this.store.assertContext(context);
    const result = this.store.findings(context.scope, filter);
    const refs = [...new Set(result.items.flatMap((item) => item.artifactIds))];
    const metadata = new Map<
      string,
      Awaited<ReturnType<CoordinationCore["artifact"]>>
    >();
    for (let i = 0; i < refs.length; i += 20)
      await Promise.all(
        refs.slice(i, i + 20).map(async (id) => {
          metadata.set(id, await this.artifact(context, id));
        }),
      );
    this.store.assertContext(context);
    return {
      items: result.items.map((item) => ({
        ...item,
        artifacts: item.artifactIds.map((id) => metadata.get(id)!),
      })),
      cursor: result.cursor,
    };
  }

  shared(context: ActorContext, key: string) {
    this.store.assertContext(context);
    return this.store.shared(context.scope, key);
  }
  sharedList(
    context: ActorContext,
    prefix?: string,
    cursor?: string,
    limit?: number,
  ) {
    this.store.assertContext(context);
    return this.store.sharedList(context.scope, prefix, cursor, limit);
  }
  sharedHistory(
    context: ActorContext,
    key: string,
    cursor?: number,
    limit?: number,
  ) {
    this.store.assertContext(context);
    return this.store.sharedHistory(context.scope, key, cursor, limit);
  }

  reservations(context: ActorContext, limit?: number) {
    this.store.assertContext(context);
    return this.store.reservations(context.scope, limit);
  }

  attempts(context: ActorContext, taskId: string) {
    this.store.assertContext(context);
    return this.store.attempts(context.scope, taskId);
  }
  inbox(context: ActorContext, cursor = 0, limit = 50) {
    this.store.assertContext(context);
    return this.store.inbox(context.scope, context.actor, cursor, limit);
  }
  messageStatus(context: ActorContext, id: string) {
    this.store.assertContext(context);
    return this.store.messageStatus(context.scope, context.actor, id);
  }
  events(context: ActorContext, cursor = 0, limit = 100) {
    this.store.assertContext(context);
    return this.store.events(context.scope, cursor, limit);
  }

  waitForEvents(
    context: ActorContext,
    cursor: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new CoordinationError(
        "invalid_input",
        "Wait must be between 1 and 30000 milliseconds",
      );
    this.events(context, cursor); // Validate before installing any listener.
    return new Promise<ReturnType<CoordinationCore["events"]>>(
      (resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe = () => {};
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else {
            try {
              resolve(this.events(context, cursor));
            } catch (failure) {
              reject(failure);
            }
          }
        };
        const abort = () =>
          finish(new CoordinationError("aborted", "Event wait cancelled"));
        unsubscribe = this.store.subscribe(() => {
          try {
            if (this.events(context, cursor).items.length) finish();
          } catch (error) {
            finish(error as Error);
          }
        });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(), timeoutMs);
        if (signal?.aborted) abort();
        else if (this.events(context, cursor).items.length) finish();
      },
    );
  }
}
