import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const receipt = z.object({
  value: object,
  cursor: z.number(),
  replayed: z.boolean(),
});
const page = z.object({ items: z.array(object), cursor: z.number() });
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
      eventCursor: z.number(),
      tasks: page,
      inbox: z.array(z.object({ state: z.string(), count: z.number() })),
    }),
  ]),
  swarm_find: z.union([page, task]),
  swarm_assign: receipt,
  swarm_task: receipt,
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
  swarm_evidence: receipt,
} as const;

export type CompactToolName = keyof typeof dataSchemas;
export function outputSchema(name: CompactToolName) {
  // MCP isError is authoritative; this schema describes successful results.
  return z.object({ data: dataSchemas[name] });
}
