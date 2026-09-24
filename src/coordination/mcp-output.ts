import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const receipt = z.object({
  value: object,
  cursor: z.number(),
  replayed: z.boolean(),
});
const page = z.object({ items: z.array(object), cursor: z.number() });
const dispatch = z.looseObject({
  status: z.string(),
  taskId: z.string().optional(),
  reasons: z.array(z.string()).optional(),
});
const task = z.looseObject({
  taskId: z.string(),
  scope: z.string(),
  title: z.string(),
  status: z.string(),
  version: z.number(),
  contract: object.nullable(),
  dependencies: z.array(z.string()),
  owner: z
    .object({
      actor: z.string(),
      attemptId: z.string(),
      fence: z.number(),
      leaseUntil: z.number(),
      progressAt: z.number().nullable(),
      progressDeadline: z.number(),
      active: z.boolean(),
    })
    .nullable(),
  result: z.unknown(),
  retention: z.enum(["retained", "expired"]),
});
const shared = z.looseObject({
  key: z.string(),
  version: z.number(),
  status: z.enum(["live", "missing", "expired", "deleted"]),
  value: z.unknown(),
});
const dataSchemas = {
  swarm_sync: z.union([
    page,
    z.object({
      scope: z.string(),
      actor: z.string(),
      compatibility: object,
      dispatchConfigReload: z.boolean().optional(),
      recipientGeneration: z.boolean().optional(),
      messageSessionIdentity: z.boolean().optional(),
      eventCursor: z.number(),
      tasks: page,
      inbox: z.array(z.object({ state: z.string(), count: z.number() })),
    }),
  ]),
  swarm_find: z.union([page, task]),
  swarm_assign: z.union([receipt, dispatch]),
  swarm_task: z.union([receipt, dispatch]),
  swarm_send: receipt,
  swarm_inbox: receipt,
  swarm_wait: z.object({
    taskId: z.string(),
    uri: z.string(),
    waitState: z.enum(["terminal", "timeout", "interrupted"]),
    task: z.looseObject({
      id: z.string(),
      status: z.string(),
      version: z.number(),
    }),
  }),
  swarm_context: z.union([receipt, shared]),
  swarm_evidence: z.union([receipt, z.looseObject({ status: z.string(), nextOffset: z.number().optional() })]),
} as const;

export type ToolName = keyof typeof dataSchemas;
export function outputSchema(name?: ToolName) {
  // Some clients validate structured errors too; retain their useful diagnosis.
  return z.union([
    z.object({ data: name ? dataSchemas[name] : object }),
    z.object({ error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }) }),
  ]);
}
