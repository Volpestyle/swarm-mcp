import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CoordinationError } from "./errors";
import type { Operation } from "./ipc";
import type { Json } from "./store";
import { boundedJson, MCP_DATA_BYTES } from "./payload-limits";
import { outputSchema, type CompactToolName } from "./mcp-output";
const subscriptions = new WeakMap<McpServer, Set<string>>();
const observableResources = new Set([
  "swarm://inbox",
  "swarm://tasks",
  "swarm://context",
  "swarm://findings",
]);

export async function notifyCoordinatorResource(
  server: McpServer,
  uri: string,
) {
  if (
    server.server.getNegotiatedProtocolVersion() !== "2026-07-28" &&
    !subscriptions.get(server)?.has(uri)
  )
    return;
  await server.server.sendResourceUpdated({ uri });
}

export type CoordinatorRequest = (
  operation: Operation,
  signal?: AbortSignal,
) => Promise<unknown>;
const text = z.string().min(1).max(1024);
const id = z.string().min(1).max(128);
const count = z.number().int().min(1).max(20).default(10);
const cursor = z.number().int().min(0).default(0);
const contract = z
  .object({
    objective: z.string().min(1).max(4096),
    worktree: text,
    acceptanceCriteria: z.array(text).min(1).max(20),
    expectedArtifacts: z.array(text).max(20),
    constraints: z.array(text).max(20),
  })
  .strict();
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new CoordinationError(
      "invalid_input",
      `${name} is required for this action`,
    );
  return value;
}

export function createCoordinatorMcp(request: CoordinatorRequest) {
  const server = new McpServer(
    { name: "swarm", version: "2.0.0" },
    {
      capabilities: { resources: { subscribe: true } },
      instructions:
        "Use swarm_sync to resume. Assign work with a stable command ID; retry uncertain mutations with the same ID. Fetch leases messages; acknowledge only after processing. Task ownership requires the returned attempt ID and fence. Wait timeouts never cancel work.",
      cacheHints: {
        "tools/list": { ttlMs: 60000, cacheScope: "private" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );
  const subscribed = new Set<string>();
  subscriptions.set(server, subscribed);
  server.server.setRequestHandler("resources/subscribe", async ({ params }) => {
    if (!observableResources.has(params.uri))
      throw new CoordinationError("not_found", "Unknown subscribable resource");
    subscribed.add(params.uri);
    return {};
  });
  server.server.setRequestHandler(
    "resources/unsubscribe",
    async ({ params }) => {
      subscribed.delete(params.uri);
      return {};
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: CompactToolName,
    description: string,
    shape: S,
    readOnly: boolean,
    run: (
      args: z.infer<z.ZodObject<S>>,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.object(shape).strict(),
        outputSchema: outputSchema(name),
        annotations: {
          readOnlyHint: readOnly,
          idempotentHint: true,
          destructiveHint: [
            "swarm_task",
            "swarm_context",
            "swarm_inbox",
          ].includes(name),
          openWorldHint: false,
        },
      },
      async (args, ctx) => {
        try {
          const data = await run(args, ctx.mcpReq.signal);
          boundedJson(data ?? null, MCP_DATA_BYTES, "Tool result");
          const structuredContent = {
            ok: true,
            data: data ?? null,
            error: null,
          };
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent),
              },
            ],
            isError: false,
          };
        } catch (error) {
          const code =
            error instanceof CoordinationError ? error.code : "internal_error";
          const structuredContent = {
            ok: false,
            data: null,
            error: {
              code,
              message:
                error instanceof Error
                  ? error.message.slice(0, 1024)
                  : "Coordinator request failed",
              retryable: ["disconnected", "timeout", "overloaded"].includes(
                code,
              ),
            },
          };
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  tool(
    "swarm_sync",
    "Bootstrap once; resume with an event cursor for targeted deltas.",
    {
      cursor: z.number().int().min(0).optional(),
      waitMs: z.number().int().min(0).max(30000).default(0),
    },
    true,
    (a, signal) =>
      request(
        a.cursor === undefined
          ? { op: "bootstrap" }
          : a.waitMs
            ? { op: "watch", cursor: a.cursor, timeoutMs: a.waitMs, limit: 20 }
            : { op: "events", cursor: a.cursor, limit: 20 },
        signal,
      ),
  );
  tool(
    "swarm_find",
    "Find scoped peers or task summaries; use taskId for details.",
    {
      kind: z.enum(["peers", "tasks", "task"]),
      taskId: id.optional(),
      role: text.optional(),
      owner: id.optional(),
      status: text.optional(),
      cursor,
      limit: count,
    },
    true,
    (a) => {
      if (a.kind === "task")
        return request({
          op: "task_detail",
          taskId: required(a.taskId, "taskId"),
        });
      return request(
        a.kind === "peers"
          ? {
              op: "peers",
              filter: { cursor: a.cursor, limit: a.limit, role: a.role },
            }
          : {
              op: "tasks",
              filter: {
                cursor: a.cursor,
                limit: a.limit,
                owner: a.owner,
                status: a.status,
              },
            },
      );
    },
  );
  tool(
    "swarm_assign",
    "Create durable work asynchronously. Reuse commandId on retry; wait separately with the returned task ID.",
    {
      commandId: id,
      title: text,
      contract,
      dependencies: z.array(id).max(100).default([]),
    },
    false,
    (a) =>
      request({
        op: "command",
        command: {
          id: a.commandId,
          type: "task.create",
          payload: {
            title: a.title,
            contract: a.contract,
            dependencies: a.dependencies,
          },
        },
      }),
  );
  tool(
    "swarm_task",
    "Claim, renew, report progress, finish, cancel or recover work. Finish requires evidence and limitations.",
    {
      commandId: id,
      action: z.enum([
        "claim",
        "renew",
        "progress",
        "finish",
        "cancel",
        "retry",
        "recover",
      ]),
      taskId: id,
      expectedVersion: z.number().int().positive().optional(),
      attemptId: id.optional(),
      fence: z.number().int().positive().optional(),
      note: text.optional(),
      outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
      report: z
        .object({
          summary: text,
          evidence: z.array(text).min(1).max(20),
          limitations: z.array(text).max(20),
        })
        .optional(),
    },
    false,
    (a) => {
      const base = { id: a.commandId, payload: { taskId: a.taskId } };
      if (a.action === "recover")
        return request({
          op: "command",
          command: { ...base, type: "task.recover" },
        });
      if (a.action === "claim" || a.action === "cancel" || a.action === "retry")
        return request({
          op: "command",
          command: {
            id: a.commandId,
            type: `task.${a.action}`,
            payload: {
              taskId: a.taskId,
              expectedVersion: required(a.expectedVersion, "expectedVersion"),
            },
          },
        });
      const ref = {
        taskId: a.taskId,
        attemptId: required(a.attemptId, "attemptId"),
        fence: required(a.fence, "fence"),
      };
      if (a.action === "renew")
        return request({
          op: "command",
          command: { id: a.commandId, type: "task.renew", payload: ref },
        });
      if (a.action === "progress")
        return request({
          op: "command",
          command: {
            id: a.commandId,
            type: "task.progress",
            payload: { ...ref, note: required(a.note, "note") },
          },
        });
      return request({
        op: "command",
        command: {
          id: a.commandId,
          type: "task.finish",
          payload: {
            ...ref,
            outcome: required(a.outcome, "outcome"),
            result: required(a.report, "report"),
            reason: a.note,
          },
        },
      });
    },
  );
  tool(
    "swarm_send",
    "Send a question, blocker, decision request or completion notice. Work assignment uses swarm_assign.",
    {
      commandId: id,
      recipient: id,
      kind: z.enum([
        "question",
        "blocker",
        "decision_request",
        "completion_notice",
      ]),
      body: z.string().min(1).max(2048),
      threadId: id,
      taskId: id.optional(),
    },
    false,
    (a) =>
      request({
        op: "command",
        command: {
          id: a.commandId,
          type: "message.send",
          payload: {
            recipient: a.recipient,
            kind: a.kind,
            body: a.body,
            threadId: a.threadId,
            taskId: a.taskId,
          },
        },
      }),
  );
  tool(
    "swarm_inbox",
    "Fetch leases one message. Ack only after processing; reject with a reason for retry.",
    {
      commandId: id,
      action: z.enum(["fetch", "ack", "reject"]),
      consumer: id.optional(),
      messageId: id.optional(),
      leaseToken: id.optional(),
      reason: text.optional(),
    },
    false,
    (a) => {
      if (a.action === "fetch")
        return request({
          op: "command",
          command: {
            id: a.commandId,
            type: "inbox.fetch",
            payload: { consumer: required(a.consumer, "consumer"), limit: 1 },
          },
        });
      const ref = {
        messageId: required(a.messageId, "messageId"),
        leaseToken: required(a.leaseToken, "leaseToken"),
      };
      return request({
        op: "command",
        command:
          a.action === "ack"
            ? { id: a.commandId, type: "inbox.ack", payload: ref }
            : {
                id: a.commandId,
                type: "inbox.reject",
                payload: { ...ref, reason: required(a.reason, "reason") },
              },
      });
    },
  );
  tool(
    "swarm_wait",
    "Wait for a task's terminal state. Timeout returns the same resumable reference without cancelling work.",
    {
      taskId: id,
      timeoutMs: z.number().int().min(0).max(30000).default(30000),
    },
    true,
    (a, signal) =>
      request(
        { op: "task_wait", taskId: a.taskId, timeoutMs: a.timeoutMs },
        signal,
      ),
  );
  tool(
    "swarm_context",
    "Versioned shared state: get, set with expectedVersion, atomic append, or delete. Keep values small; link artifacts.",
    {
      action: z.enum(["get", "set", "append", "delete"]),
      key: text,
      commandId: id.optional(),
      expectedVersion: z.number().int().min(0).optional(),
      value: z.unknown().optional(),
    },
    false,
    (a) => {
      if (a.action === "get") return request({ op: "kv", key: a.key });
      const commandId = required(a.commandId, "commandId");
      if (a.action === "delete")
        return request({
          op: "command",
          command: {
            id: commandId,
            type: "kv.delete",
            payload: {
              key: a.key,
              expectedVersion: required(a.expectedVersion, "expectedVersion"),
            },
          },
        });
      const value = required(a.value, "value") as Json;
      return request({
        op: "command",
        command:
          a.action === "set"
            ? {
                id: commandId,
                type: "kv.set",
                payload: {
                  key: a.key,
                  value,
                  expectedVersion: required(
                    a.expectedVersion,
                    "expectedVersion",
                  ),
                },
              }
            : {
                id: commandId,
                type: "kv.append",
                payload: {
                  key: a.key,
                  value,
                  expectedVersion: a.expectedVersion,
                },
              },
      });
    },
  );
  tool(
    "swarm_evidence",
    "Capture a completed worktree file or record a result, decision or annotation with provenance. Read bytes through the returned artifact URI.",
    {
      commandId: id,
      action: z.enum(["capture", "record"]),
      summary: text,
      path: text.optional(),
      mediaType: text.optional(),
      kind: z.enum(["result", "decision", "annotation"]).optional(),
      revision: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
        .optional(),
      files: z.array(text).max(100).default([]),
      verification: text.optional(),
      artifactIds: z.array(id).max(20).default([]),
      taskId: id.optional(),
      attemptId: id.optional(),
    },
    false,
    (a) =>
      a.action === "capture"
        ? request({
            op: "artifact_import",
            input: {
              id: a.commandId,
              path: required(a.path, "path"),
              summary: a.summary,
              mediaType: a.mediaType,
            },
          })
        : request({
            op: "command",
            command: {
              id: a.commandId,
              type: "finding.record",
              payload: {
                kind: required(a.kind, "kind"),
                summary: a.summary,
                revision: required(a.revision, "revision"),
                files: a.files,
                verification: required(a.verification, "verification"),
                artifactIds: a.artifactIds,
                taskId: a.taskId,
                attemptId: a.attemptId,
              },
            },
          }),
  );
  const jsonResource = async (uri: URL, operation: Operation) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: boundedJson(
          await request(operation),
          MCP_DATA_BYTES,
          "Resource result",
        ),
      },
    ],
  });
  const numeric = (uri: URL, name: string) => {
    const value = uri.searchParams.get(name);
    if (value === null) return 0;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new CoordinationError("invalid_input", `Invalid ${name}`);
    return Number(value);
  };
  server.registerResource(
    "inbox",
    "swarm://inbox",
    {
      description:
        "Delivery summaries; reading does not acknowledge processing.",
    },
    (uri) => jsonResource(uri, { op: "inbox", limit: 1 }),
  );
  server.registerResource(
    "tasks",
    "swarm://tasks",
    { description: "First page of scoped task summaries." },
    (uri) => jsonResource(uri, { op: "tasks", filter: { limit: 10 } }),
  );
  server.registerResource(
    "task-detail",
    new ResourceTemplate("swarm://tasks/{taskId}", { list: undefined }),
    {
      description:
        "Read the current task contract, ownership and retained result.",
    },
    (uri, variables) =>
      jsonResource(uri, {
        op: "task_detail",
        taskId: String(variables.taskId),
      }),
  );
  server.registerResource(
    "shared-context",
    new ResourceTemplate("swarm://context{?key}", {
      list: undefined,
    }),
    {
      description:
        "Read a shared key or page key summaries; values retain versions.",
    },
    (uri) => {
      const key = uri.searchParams.get("key");
      return jsonResource(
        uri,
        key !== null
          ? { op: "kv", key }
          : {
              op: "kv_list",
              prefix: uri.searchParams.get("prefix") ?? "",
              cursor: uri.searchParams.get("cursor") ?? "",
              limit: 5,
            },
      );
    },
  );
  server.registerResource(
    "findings",
    new ResourceTemplate("swarm://findings{?filter}", {
      list: undefined,
    }),
    {
      description:
        "Page retained findings with provenance, annotation freshness and artifact references.",
    },
    (uri) => {
      const filter = z
        .object({
          taskId: id.optional(),
          file: text.optional(),
          currentRevision: text.optional(),
          cursor: cursor.optional(),
        })
        .strict()
        .parse(JSON.parse(uri.searchParams.get("filter") ?? "{}"));
      return jsonResource(uri, {
        op: "findings",
        filter: {
          ...filter,
          limit: 1,
        },
      });
    },
  );
  const readArtifact = async (
    uri: URL,
    variables: Record<string, string | string[]>,
  ) => {
    const artifactId = String(variables.artifactId);
    const metadata = (await request({ op: "artifact", artifactId })) as {
      mediaType?: string;
      bytes?: number;
    };
    const page = (await request({
      op: "artifact_read",
      artifactId,
      offset: numeric(uri, "offset"),
      limit: 16384,
    })) as { status: string; data: string | null; nextOffset?: number };
    const nextUri =
      page.nextOffset !== undefined &&
      metadata.bytes !== undefined &&
      page.nextOffset < metadata.bytes &&
      page.status === "available"
        ? `swarm://artifacts/${artifactId}?offset=${page.nextOffset}`
        : null;
    return {
      contents: [
        ...(page.data === null
          ? []
          : [
              {
                uri: uri.href,
                mimeType: metadata.mediaType ?? "application/octet-stream",
                blob: page.data,
              },
            ]),
        {
          uri: uri.href + "#page",
          mimeType: "application/json",
          text: JSON.stringify({
            ...metadata,
            status: page.status,
            nextOffset: page.nextOffset,
            nextUri,
          }),
        },
      ],
    };
  };
  for (const [name, template] of [
    ["artifact-page", "swarm://artifacts/{artifactId}{?offset}"],
    ["artifact", "swarm://artifacts/{artifactId}"],
  ])
    server.registerResource(
      name!,
      new ResourceTemplate(template!, { list: undefined }),
      {
        description:
          "Read 16 KiB of verified artifact bytes; metadata gives nextUri or unavailable status.",
      },
      readArtifact,
    );
  server.registerResource(
    "context-list",
    "swarm://context",
    { description: "First page of shared context." },
    (uri) => jsonResource(uri, { op: "kv_list", limit: 5 }),
  );
  server.registerResource(
    "context-page",
    new ResourceTemplate("swarm://context{?cursor}", { list: undefined }),
    { description: "Next page using the previous key cursor." },
    (uri) =>
      jsonResource(uri, {
        op: "kv_list",
        cursor: uri.searchParams.get("cursor") ?? "",
        limit: 5,
      }),
  );
  server.registerResource(
    "finding-list",
    "swarm://findings",
    {
      description:
        "First retained finding. Filtered pages use a JSON-encoded filter parameter.",
    },
    (uri) => jsonResource(uri, { op: "findings", filter: { limit: 1 } }),
  );
  return server;
}
