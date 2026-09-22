import { createServer, createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  CoordinationCore,
  type ActorContext,
  type CoreCommand,
  type DispatchRequest,
} from "./core";
import { CoordinationError, requireText } from "./errors";
import type { ArtifactImport, FindingFilter } from "./evidence";
import type { PeerFilter, TaskFilter } from "./queries";
import type { Enrollment } from "./sessions";
import type { DiagnosticFilter } from "./diagnostics";

const MAX_FRAME_BYTES = 65536;
export type Operation =
  | { op: "enroll"; input: Enrollment }
  | { op: "bootstrap" }
  | { op: "inspect"; filter?: DiagnosticFilter }
  | { op: "peers"; filter?: PeerFilter }
  | { op: "tasks"; filter?: TaskFilter }
  | { op: "command"; command: CoreCommand }
  | { op: "dispatch"; input: DispatchRequest }
  | { op: "artifact_import"; input: ArtifactImport }
  | { op: "artifact"; artifactId: string }
  | { op: "artifact_read"; artifactId: string; offset?: number; limit?: number }
  | { op: "artifacts"; cursor?: number; limit?: number }
  | { op: "findings"; filter?: FindingFilter }
  | { op: "task"; taskId: string }
  | { op: "task_detail"; taskId: string }
  | { op: "task_wait"; taskId: string; timeoutMs: number }
  | { op: "attempts"; taskId: string }
  | { op: "reservations"; limit?: number }
  | { op: "kv"; key: string }
  | { op: "kv_list"; prefix?: string; cursor?: string; limit?: number }
  | { op: "kv_history"; key: string; cursor?: number; limit?: number }
  | { op: "inbox"; cursor?: number; limit?: number; activeOnly?: boolean }
  | { op: "message_status"; messageId: string }
  | { op: "events"; cursor: number; limit?: number }
  | { op: "watch"; cursor: number; timeoutMs: number; limit?: number };

export function localEndpoint(databasePath: string): string {
  const path = resolve(databasePath);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? path.toLowerCase() : path)
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\swarm-mcp-${key}`
    : join(dirname(path), `swarm-${key}.sock`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The owner supplies capability validation. Ordinary operations never accept
 * actor/scope overrides. Enrollment requires separately configured launcher
 * authority; no default allow-all policy exists. */
export async function serveCoordination(options: {
  endpoint: string;
  core: CoordinationCore;
  authorize: (capability: string) => ActorContext;
  /** Optional launcher-only authority. This callback must authenticate a
   * distinct launcher credential before accepting any enrollment fields. */
  enroll?: (capability: string, input: unknown) => unknown;
  maxPending?: number;
}) {
  if (process.platform === "win32" && typeof Bun !== "undefined") {
    throw new CoordinationError(
      "unsupported_runtime",
      "Run the Windows coordination owner with Node; Bun 1.3.11 crashes on duplicate named-pipe binding",
    );
  }
  const sockets = new Set<Socket>();
  let pending = 0;
  let closing = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    const inflight = new Set<string>();
    const disconnected = new AbortController();
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      disconnected.abort();
      sockets.delete(socket);
    });
    const respond = (response: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
    };
    const handle = async (raw: unknown) => {
      const id = record(raw) && typeof raw.id === "string" ? raw.id : "";
      let counted = false;
      try {
        requireText(id, "request id", 128);
        if (!record(raw))
          throw new CoordinationError("invalid_input", "Invalid request");
        requireText(raw.capability, "capability", 512);
        if (inflight.has(id))
          throw new CoordinationError(
            "duplicate_request",
            "Request ID is already pending",
          );
        if (pending >= (options.maxPending ?? 256) || inflight.size >= 16)
          throw new CoordinationError(
            "overloaded",
            "Coordinator request capacity reached; retry with the same command ID",
          );
        inflight.add(id);
        pending++;
        counted = true;
        if (raw.op === "enroll") {
          if (!options.enroll)
            throw new CoordinationError(
              "forbidden",
              "Launcher enrollment is not configured",
            );
          const result = await options.enroll(raw.capability, raw.input);
          respond({ id, result });
          return;
        }
        const actor = options.authorize(raw.capability);
        requireText(actor.scope, "authorized scope");
        requireText(actor.actor, "authorized actor");
        let result: unknown;
        switch (raw.op) {
          case "inspect":
            if (raw.filter !== undefined && !record(raw.filter))
              throw new CoordinationError(
                "invalid_input",
                "Filter must be an object",
              );
            result = {
              ...options.core.inspect(
                actor,
                raw.filter as DiagnosticFilter | undefined,
              ),
              protocol: {
                modern: "2026-07-28",
                legacy: (await import("@modelcontextprotocol/server"))
                  .SUPPORTED_PROTOCOL_VERSIONS,
              },
            };
            break;
          case "bootstrap":
            result = options.core.bootstrap(actor);
            break;
          case "peers":
          case "tasks":
            if (raw.filter !== undefined && !record(raw.filter))
              throw new CoordinationError(
                "invalid_input",
                "Filter must be an object",
              );
            result =
              raw.op === "peers"
                ? options.core.peers(
                    actor,
                    raw.filter as PeerFilter | undefined,
                  )
                : options.core.taskSummaries(
                    actor,
                    raw.filter as TaskFilter | undefined,
                  );
            break;
          case "artifact_import":
            if (!record(raw.input))
              throw new CoordinationError(
                "invalid_input",
                "Invalid artifact import",
              );
            result = await options.core.importArtifact(
              actor,
              raw.input as unknown as ArtifactImport,
            );
            break;
          case "artifact":
            requireText(raw.artifactId, "artifact ID");
            result = await options.core.artifact(actor, raw.artifactId);
            break;
          case "artifact_read":
            requireText(raw.artifactId, "artifact ID");
            result = await options.core.readArtifact(
              actor,
              raw.artifactId,
              raw.offset as number | undefined,
              raw.limit as number | undefined,
            );
            break;
          case "artifacts":
            result = await options.core.artifacts(
              actor,
              raw.cursor as number | undefined,
              raw.limit as number | undefined,
            );
            break;
          case "findings":
            if (raw.filter !== undefined && !record(raw.filter))
              throw new CoordinationError(
                "invalid_input",
                "Invalid findings filter",
              );
            result = await options.core.findings(
              actor,
              raw.filter as FindingFilter | undefined,
            );
            break;
          case "command":
            if (!record(raw.command) || !record(raw.command.payload))
              throw new CoordinationError("invalid_input", "Invalid command");
            result = options.core.command(
              actor,
              raw.command as unknown as CoreCommand,
            );
            break;
          case "dispatch":
            if (!record(raw.input))
              throw new CoordinationError(
                "invalid_input",
                "Invalid dispatch request",
              );
            result = await options.core.dispatch(
              actor,
              raw.input as unknown as DispatchRequest,
            );
            break;
          case "task_wait":
            requireText(raw.taskId, "taskId");
            result = await options.core.waitForTask(
              actor,
              raw.taskId,
              raw.timeoutMs as number,
              disconnected.signal,
            );
            break;
          case "task":
            requireText(raw.taskId, "task ID");
            result = options.core.task(actor, raw.taskId);
            break;
          case "task_detail":
            requireText(raw.taskId, "taskId");
            result = options.core.taskDetail(actor, raw.taskId);
            break;
          case "attempts":
            requireText(raw.taskId, "task ID");
            result = options.core.attempts(actor, raw.taskId);
            break;
          case "reservations":
            result = options.core.reservations(
              actor,
              raw.limit as number | undefined,
            );
            break;
          case "kv":
            requireText(raw.key, "key");
            result = options.core.shared(actor, raw.key);
            break;
          case "kv_list":
            result = options.core.sharedList(
              actor,
              raw.prefix as string | undefined,
              raw.cursor as string | undefined,
              raw.limit as number | undefined,
            );
            break;
          case "kv_history":
            requireText(raw.key, "key");
            result = options.core.sharedHistory(
              actor,
              raw.key,
              raw.cursor as number | undefined,
              raw.limit as number | undefined,
            );
            break;
          case "events":
            result = options.core.events(
              actor,
              raw.cursor as number,
              raw.limit as number | undefined,
            );
            break;
          case "inbox":
            result = options.core.inbox(
              actor,
              raw.cursor as number | undefined,
              raw.limit as number | undefined,
              raw.activeOnly as boolean | undefined,
            );
            break;
          case "message_status":
            requireText(raw.messageId, "message ID");
            result = options.core.messageStatus(actor, raw.messageId);
            break;
          case "watch":
            result = await options.core.waitForEvents(
              actor,
              raw.cursor as number,
              raw.timeoutMs as number,
              disconnected.signal,
              raw.limit as number | undefined,
            );
            break;
          default:
            throw new CoordinationError("invalid_input", "Unknown operation");
        }
        respond({ id, result });
      } catch (error) {
        respond({
          id,
          error: {
            code: error instanceof CoordinationError ? error.code : "internal",
            message:
              error instanceof CoordinationError
                ? error.message
                : "Coordinator operation failed",
          },
        });
      } finally {
        if (counted) {
          inflight.delete(id);
          pending--;
        }
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      // The limit is per frame, so coalesced valid requests are allowed.
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        try {
          void handle(JSON.parse(frame));
        } catch {
          respond({
            id: "",
            error: { code: "invalid_json", message: "Invalid JSON frame" },
          });
        }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(options.endpoint, () => {
      server.off("error", failed);
      resolve();
    });
  });
  return {
    endpoint: options.endpoint,
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export class CoordinationClient {
  private sequence = 0;
  private buffer = "";
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(
    private readonly socket: Socket,
    private readonly capability: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(frame);
          const wait = this.pending.get(response.id);
          if (!wait) continue;
          this.pending.delete(response.id);
          clearTimeout(wait.timer);
          if (response.error)
            wait.reject(
              new CoordinationError(
                response.error.code,
                response.error.message,
              ),
            );
          else wait.resolve(response.result);
        } catch {
          this.fail(
            new CoordinationError(
              "invalid_response",
              "Invalid coordinator response",
            ),
          );
          socket.destroy();
        }
      }
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) socket.destroy();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(
        new CoordinationError(
          "disconnected",
          "Coordinator disconnected; replay mutations with their original command IDs",
        ),
      ),
    );
  }

  static async connect(endpoint: string, capability: string) {
    requireText(capability, "capability", 512);
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new CoordinationClient(socket, capability);
  }

  request(operation: Operation): Promise<unknown> {
    if (this.socket.destroyed)
      return Promise.reject(
        new CoordinationError(
          "disconnected",
          "Coordinator connection is closed",
        ),
      );
    if (this.pending.size >= 16)
      return Promise.reject(
        new CoordinationError(
          "overloaded",
          "Client has too many pending requests",
        ),
      );
    const id = String(++this.sequence);
    const frame =
      JSON.stringify({ ...operation, id, capability: this.capability }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
      return Promise.reject(
        new CoordinationError("payload_too_large", "IPC frame exceeds 64 KiB"),
      );
    return new Promise((resolve, reject) => {
      const timeout =
        operation.op === "watch" || operation.op === "task_wait"
          ? Math.min(operation.timeoutMs, 30000) + 1000
          : 10000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CoordinationError(
            "timeout",
            "Request timed out; replay mutations with the original command ID",
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame);
    });
  }

  private fail(error: Error) {
    for (const wait of this.pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.socket.destroy();
  }
}
