import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CoordinationError } from "./errors";
import type { Operation } from "./ipc";

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
const output = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .nullable(),
});
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
      instructions:
        "Use swarm_sync to resume. Assign work with a stable command ID; retry uncertain mutations with the same ID. Fetch leases messages; acknowledge only after processing. Task ownership requires the returned attempt ID and fence. Wait timeouts never cancel work.",
      cacheHints: {
        "tools/list": { ttlMs: 60000, cacheScope: "private" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );
  function tool<S extends z.ZodRawShape>(
    name: string,
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
        outputSchema: output,
        annotations: {
          readOnlyHint: readOnly,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args, ctx) => {
        try {
          const data = await run(args, ctx.mcpReq.signal);
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
                  ? error.message
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
            ? { op: "watch", cursor: a.cursor, timeoutMs: a.waitMs }
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
  return server;
}
