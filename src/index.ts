import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "./db";
import * as context from "./context";
import * as kv from "./kv";
import * as messages from "./messages";
import { file as filepath } from "./paths";
import * as registry from "./registry";
import * as tasks from "./tasks";

let instance: registry.Instance | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let notifyTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgId = 0;
let lastTaskUpdate = 0;
let lastInstancesVersion = "";

const server = new McpServer({
  name: "swarm",
  version: "1.0.0",
});

function missing() {
  return {
    content: [
      { type: "text" as const, text: "Not registered. Call register first." },
    ],
  };
}

function resource<T>(text: T, uri: string) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(text, null, 2),
      },
    ],
  };
}

function getMaxMsgId() {
  if (!instance) return 0;
  const row = db
    .query(
      "SELECT MAX(id) as max FROM messages WHERE scope = ? AND recipient = ? AND read = 0",
    )
    .get(instance.scope, instance.id) as { max: number | null };
  return row.max ?? 0;
}

function getMaxTaskUpdate() {
  if (!instance) return 0;
  const row = db
    .query("SELECT MAX(changed_at) as max FROM tasks WHERE scope = ?")
    .get(instance.scope) as {
    max: number | null;
  };
  return row.max ?? 0;
}

function getInstancesVersion() {
  if (!instance) return "";
  const row = db
    .query(
      "SELECT COUNT(*) as count, COALESCE(MAX(registered_at), 0) as max FROM instances WHERE scope = ?",
    )
    .get(instance.scope) as { count: number; max: number };
  return `${row.count}:${row.max}`;
}

async function poll() {
  if (!instance) return;

  try {
    const msgId = getMaxMsgId();
    if (msgId > lastMsgId) {
      lastMsgId = msgId;
      await server.server.sendResourceUpdated({ uri: "swarm://inbox" });
    }

    const taskUpdate = getMaxTaskUpdate();
    if (taskUpdate > lastTaskUpdate) {
      lastTaskUpdate = taskUpdate;
      await server.server.sendResourceUpdated({ uri: "swarm://tasks" });
    }

    const instancesVersion = getInstancesVersion();
    if (instancesVersion !== lastInstancesVersion) {
      lastInstancesVersion = instancesVersion;
      await server.server.sendResourceUpdated({ uri: "swarm://instances" });
    }
  } catch {
    return;
  }
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  if (instance) registry.deregister(instance.id);
  instance = null;
  heartbeatTimer = null;
  notifyTimer = null;
  tasks.cleanup();
  context.cleanup();
}

server.resource(
  "inbox",
  "swarm://inbox",
  {
    description:
      "Unread messages for this instance. Auto-updates when new messages arrive.",
  },
  async () => {
    if (!instance) return resource([], "swarm://inbox");
    return resource(
      messages.peek(instance.id, instance.scope),
      "swarm://inbox",
    );
  },
);

server.resource(
  "tasks",
  "swarm://tasks",
  { description: "Open and active tasks in this swarm scope." },
  async () => {
    if (!instance)
      return resource(
        { open: [], claimed: [], in_progress: [] },
        "swarm://tasks",
      );

    return resource(
      {
        open: tasks.list(instance.scope, { status: "open" }),
        claimed: tasks.list(instance.scope, { status: "claimed" }),
        in_progress: tasks.list(instance.scope, { status: "in_progress" }),
      },
      "swarm://tasks",
    );
  },
);

server.resource(
  "instances",
  "swarm://instances",
  { description: "All active instances in this swarm scope." },
  async () => {
    if (!instance) return resource([], "swarm://instances");
    return resource(registry.list(instance.scope), "swarm://instances");
  },
);

server.resource(
  "context-for-file",
  new ResourceTemplate("swarm://context{?file}", { list: undefined }),
  {
    description:
      "Shared annotations and locks for a specific file in this swarm scope.",
  },
  async (uri, { file }) => {
    if (!instance) return resource([], uri.href);
    return resource(
      context.lookup(
        instance.scope,
        filepath(instance.directory, file as string),
      ),
      uri.href,
    );
  },
);

server.tool(
  "register",
  "Register this opencode instance with the swarm. Call this first before using other tools.",
  {
    directory: z
      .string()
      .describe("The project directory this instance is working in"),
    label: z
      .string()
      .optional()
      .describe("Optional friendly label for this instance"),
    scope: z
      .string()
      .optional()
      .describe(
        "Optional shared swarm scope. Defaults to the detected git root.",
      ),
  },
  async ({ directory, label, scope }) => {
    if (instance) {
      return { content: [{ type: "text", text: JSON.stringify(instance) }] };
    }

    instance = registry.register(directory, label, scope);
    lastMsgId = getMaxMsgId();
    lastTaskUpdate = getMaxTaskUpdate();
    lastInstancesVersion = getInstancesVersion();

    heartbeatTimer = setInterval(() => {
      if (instance) registry.heartbeat(instance.id);
    }, 10_000);

    notifyTimer = setInterval(() => {
      void poll();
    }, 5_000);

    return { content: [{ type: "text", text: JSON.stringify(instance) }] };
  },
);

server.tool(
  "list_instances",
  "List all currently active opencode instances in this swarm scope.",
  {},
  async () => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(registry.list(instance.scope), null, 2),
        },
      ],
    };
  },
);

server.tool(
  "whoami",
  "Get this instance's swarm ID and registration info.",
  {},
  async () => {
    if (!instance) return missing();
    return {
      content: [{ type: "text", text: JSON.stringify(instance, null, 2) }],
    };
  },
);

server.tool(
  "send_message",
  "Send a message to a specific instance by ID.",
  {
    recipient: z.string().describe("The instance ID to send the message to"),
    content: z.string().describe("The message content"),
  },
  async ({ recipient, content }) => {
    if (!instance) return missing();

    const target = registry.get(recipient);
    if (!target || target.scope !== instance.scope) {
      return {
        content: [
          {
            type: "text",
            text: `Instance ${recipient} is not active in this scope`,
          },
        ],
      };
    }

    if (target.id === instance.id) {
      return {
        content: [{ type: "text", text: "Cannot send a message to yourself" }],
      };
    }

    messages.send(instance.id, instance.scope, recipient, content);
    return {
      content: [{ type: "text", text: `Message sent to ${recipient}` }],
    };
  },
);

server.tool(
  "broadcast",
  "Send a message to all other active instances in this swarm scope.",
  { content: z.string().describe("The message content to broadcast") },
  async ({ content }) => {
    if (!instance) return missing();
    const count = messages.broadcast(instance.id, instance.scope, content);
    return {
      content: [
        { type: "text", text: `Broadcast sent to ${count} instance(s)` },
      ],
    };
  },
);

server.tool(
  "poll_messages",
  "Check for new incoming messages. Returns unread messages and marks them as read.",
  {
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .default(50)
      .describe("Max messages to return"),
  },
  async ({ limit }) => {
    if (!instance) return missing();
    const rows = messages.poll(instance.id, instance.scope, limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "request_task",
  "Create a task for another instance, or leave it open for any instance in this scope.",
  {
    type: z
      .enum(["review", "implement", "fix", "test", "research", "other"])
      .describe("Type of task"),
    title: z.string().describe("Short title for the task"),
    description: z
      .string()
      .optional()
      .describe("Detailed description of what needs to be done"),
    files: z.array(z.string()).optional().describe("Relevant file paths"),
    assignee: z
      .string()
      .optional()
      .describe("Specific instance ID to assign to, or omit for any taker"),
  },
  async ({ type, title, description, files, assignee }) => {
    if (!instance) return missing();

    if (assignee) {
      const target = registry.get(assignee);
      if (!target || target.scope !== instance.scope) {
        return {
          content: [
            {
              type: "text",
              text: `Instance ${assignee} is not active in this scope`,
            },
          ],
        };
      }
    }

    const taskId = tasks.request(
      instance.id,
      instance.scope,
      type,
      title,
      description,
      files?.map((item) => filepath(instance!.directory, item)),
      assignee,
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: taskId,
            status: assignee ? "claimed" : "open",
          }),
        },
      ],
    };
  },
);

server.tool(
  "claim_task",
  "Claim an open task to work on it.",
  { task_id: z.string().describe("The task ID to claim") },
  async ({ task_id }) => {
    if (!instance) return missing();
    const result = tasks.claim(task_id, instance.scope, instance.id);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "update_task",
  "Update a task's status and optionally attach a result.",
  {
    task_id: z.string().describe("The task ID"),
    status: z
      .enum(["in_progress", "done", "failed", "cancelled"])
      .describe("New status"),
    result: z.string().optional().describe("Result or summary of work done"),
  },
  async ({ task_id, status, result }) => {
    if (!instance) return missing();
    const next = tasks.update(
      task_id,
      instance.scope,
      instance.id,
      status,
      result,
    );
    return { content: [{ type: "text", text: JSON.stringify(next) }] };
  },
);

server.tool(
  "get_task",
  "Get full details of a specific task in this swarm scope.",
  { task_id: z.string().describe("The task ID") },
  async ({ task_id }) => {
    if (!instance) return missing();
    const task = tasks.get(task_id, instance.scope);
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  "list_tasks",
  "List tasks in this swarm scope, optionally filtered by status, assignee, or requester.",
  {
    status: z
      .enum(["open", "claimed", "in_progress", "done", "failed", "cancelled"])
      .optional(),
    assignee: z.string().optional().describe("Filter by assignee instance ID"),
    requester: z
      .string()
      .optional()
      .describe("Filter by requester instance ID"),
  },
  async ({ status, assignee, requester }) => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            tasks.list(instance.scope, { status, assignee, requester }),
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "annotate",
  "Share a finding, warning, or note about a file with all instances in this scope.",
  {
    file: z.string().describe("File path this annotation is about"),
    type: z
      .enum(["finding", "warning", "note", "bug", "todo"])
      .describe("Type of annotation"),
    content: z.string().describe("The annotation content"),
  },
  async ({ file, type, content }) => {
    if (!instance) return missing();
    const id = context.annotate(
      instance.id,
      instance.scope,
      filepath(instance.directory, file),
      type,
      content,
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ annotation_id: id }) }],
    };
  },
);

server.tool(
  "lock_file",
  "Announce that you are actively working on a file. Other instances should avoid editing it.",
  {
    file: z.string().describe("File path to lock"),
    reason: z.string().optional().describe("Why you're locking it"),
  },
  async ({ file, reason }) => {
    if (!instance) return missing();
    const path = filepath(instance.directory, file);
    const result = context.lock(
      instance.id,
      instance.scope,
      path,
      reason ?? "actively editing",
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "unlock_file",
  "Release a file lock so other instances can edit it.",
  { file: z.string().describe("File path to unlock") },
  async ({ file }) => {
    if (!instance) return missing();
    context.clearLocks(
      instance.id,
      instance.scope,
      filepath(instance.directory, file),
    );
    return { content: [{ type: "text", text: `Unlocked ${file}` }] };
  },
);

server.tool(
  "check_file",
  "Check if a file has any annotations, locks, or warnings from other instances in this scope.",
  { file: z.string().describe("File path to check") },
  async ({ file }) => {
    if (!instance) return missing();
    const rows = context.lookup(
      instance.scope,
      filepath(instance.directory, file),
    );
    if (!rows.length)
      return {
        content: [{ type: "text", text: "No annotations for this file" }],
      };
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.tool(
  "search_context",
  "Search all shared annotations in this scope by file path or content.",
  {
    query: z.string().describe("Search term (matches file paths and content)"),
  },
  async ({ query }) => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(context.search(instance.scope, query), null, 2),
        },
      ],
    };
  },
);

server.tool(
  "kv_get",
  "Get a value from the shared key-value store for this scope.",
  { key: z.string().describe("The key to look up") },
  async ({ key }) => {
    if (!instance) return missing();
    const row = kv.get(instance.scope, key);
    if (!row)
      return { content: [{ type: "text", text: `Key \"${key}\" not found` }] };
    return { content: [{ type: "text", text: JSON.stringify(row) }] };
  },
);

server.tool(
  "kv_set",
  "Set a value in the shared key-value store for this scope.",
  {
    key: z.string().describe("The key to set"),
    value: z
      .string()
      .describe("The value to store (use JSON for complex data)"),
  },
  async ({ key, value }) => {
    if (!instance) return missing();
    kv.set(instance.scope, key, value);
    return { content: [{ type: "text", text: `Set \"${key}\"` }] };
  },
);

server.tool(
  "kv_delete",
  "Delete a key from the shared key-value store for this scope.",
  { key: z.string().describe("The key to delete") },
  async ({ key }) => {
    if (!instance) return missing();
    kv.del(instance.scope, key);
    return { content: [{ type: "text", text: `Deleted \"${key}\"` }] };
  },
);

server.tool(
  "kv_list",
  "List keys in the shared key-value store for this scope, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional key prefix to filter by"),
  },
  async ({ prefix }) => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(kv.keys(instance.scope, prefix), null, 2),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
  await server.connect(transport);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
