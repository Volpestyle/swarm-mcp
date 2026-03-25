import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as registry from "./registry";
import * as messages from "./messages";
import * as tasks from "./tasks";
import * as context from "./context";
import * as kv from "./kv";
import { db } from "./db";

let instanceId: string | null = null;
let heartbeatTimer: Timer | null = null;
let notifyTimer: Timer | null = null;
let lastMsgId = 0;
let lastTaskUpdate = 0;

const server = new McpServer({
  name: "swarm",
  version: "0.2.0",
});

// ──────────────────────────────────────
//  Resources
// ──────────────────────────────────────

server.resource(
  "inbox",
  "swarm://inbox",
  {
    description:
      "Unread messages for this instance. Auto-updates when new messages arrive.",
  },
  async () => {
    if (!instanceId) {
      return {
        contents: [
          { uri: "swarm://inbox", mimeType: "application/json", text: "[]" },
        ],
      };
    }
    const msgs = messages.peek(instanceId);
    return {
      contents: [
        {
          uri: "swarm://inbox",
          mimeType: "application/json",
          text: JSON.stringify(msgs, null, 2),
        },
      ],
    };
  },
);

server.resource(
  "tasks",
  "swarm://tasks",
  { description: "Open and claimed tasks in the swarm." },
  async () => {
    const open = tasks.list({ status: "open" });
    const claimed = tasks.list({ status: "claimed" });
    const progress = tasks.list({ status: "in_progress" });
    return {
      contents: [
        {
          uri: "swarm://tasks",
          mimeType: "application/json",
          text: JSON.stringify(
            { open, claimed, in_progress: progress },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.resource(
  "instances",
  "swarm://instances",
  { description: "All active instances in the swarm." },
  async () => {
    const list = registry.list();
    return {
      contents: [
        {
          uri: "swarm://instances",
          mimeType: "application/json",
          text: JSON.stringify(list, null, 2),
        },
      ],
    };
  },
);

server.resource(
  "context-for-file",
  new ResourceTemplate("swarm://context/{file}", { list: undefined }),
  { description: "Shared annotations/findings for a specific file." },
  async (uri, { file }) => {
    const entries = context.lookup(file as string);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(entries, null, 2),
        },
      ],
    };
  },
);

// ──────────────────────────────────────
//  Tools: Instance Registry
// ──────────────────────────────────────

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
  },
  async ({ directory, label }) => {
    if (instanceId) {
      return {
        content: [
          { type: "text", text: `Already registered as ${instanceId}` },
        ],
      };
    }

    instanceId = registry.register(directory, label);

    // snapshot current state so we only notify on NEW items
    lastMsgId = getMaxMsgId();
    lastTaskUpdate = getMaxTaskUpdate();

    // heartbeat every 10s
    heartbeatTimer = setInterval(() => {
      if (instanceId) registry.heartbeat(instanceId);
    }, 10_000);

    // notification poller every 5s
    notifyTimer = setInterval(poll, 5_000);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: instanceId, directory, label }),
        },
      ],
    };
  },
);

server.tool(
  "list_instances",
  "List all currently active opencode instances in the swarm.",
  {},
  async () => {
    return {
      content: [
        { type: "text", text: JSON.stringify(registry.list(), null, 2) },
      ],
    };
  },
);

server.tool(
  "whoami",
  "Get this instance's swarm ID and registration info.",
  {},
  async () => {
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    return {
      content: [{ type: "text", text: JSON.stringify({ id: instanceId }) }],
    };
  },
);

// ──────────────────────────────────────
//  Tools: Messaging
// ──────────────────────────────────────

server.tool(
  "send_message",
  "Send a message to a specific instance by ID.",
  {
    recipient: z.string().describe("The instance ID to send the message to"),
    content: z.string().describe("The message content"),
  },
  async ({ recipient, content }) => {
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    messages.send(instanceId, recipient, content);
    return {
      content: [{ type: "text", text: `Message sent to ${recipient}` }],
    };
  },
);

server.tool(
  "broadcast",
  "Send a message to ALL other instances in the swarm.",
  { content: z.string().describe("The message content to broadcast") },
  async ({ content }) => {
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    messages.broadcast(instanceId, content);
    return { content: [{ type: "text", text: "Broadcast sent" }] };
  },
);

server.tool(
  "poll_messages",
  "Check for new incoming messages. Returns unread messages and marks them as read.",
  {
    limit: z.number().optional().default(50).describe("Max messages to return"),
  },
  async ({ limit }) => {
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    const msgs = messages.poll(instanceId, limit);
    return { content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }] };
  },
);

// ──────────────────────────────────────
//  Tools: Task Delegation
// ──────────────────────────────────────

server.tool(
  "request_task",
  "Create a task for another instance (or any available instance) to pick up.",
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
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    const id = tasks.request(
      instanceId,
      type,
      title,
      description,
      files,
      assignee,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: id,
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
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    const result = tasks.claim(task_id, instanceId);
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
    tasks.update(task_id, status, result);
    return { content: [{ type: "text", text: `Task ${task_id} → ${status}` }] };
  },
);

server.tool(
  "get_task",
  "Get full details of a specific task.",
  { task_id: z.string().describe("The task ID") },
  async ({ task_id }) => {
    const t = tasks.get(task_id);
    if (!t) return { content: [{ type: "text", text: "Task not found" }] };
    return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }] };
  },
);

server.tool(
  "list_tasks",
  "List tasks, optionally filtered by status, assignee, or requester.",
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
    const list = tasks.list({ status, assignee, requester });
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  },
);

// ──────────────────────────────────────
//  Tools: Shared Context
// ──────────────────────────────────────

server.tool(
  "annotate",
  "Share a finding, warning, or note about a file with all instances.",
  {
    file: z.string().describe("File path this annotation is about"),
    type: z
      .enum(["finding", "warning", "lock", "note", "bug", "todo"])
      .describe("Type of annotation"),
    content: z.string().describe("The annotation content"),
  },
  async ({ file, type, content }) => {
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    const id = context.annotate(instanceId, file, type, content);
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
    if (!instanceId)
      return {
        content: [
          { type: "text", text: "Not registered. Call register first." },
        ],
      };
    const id = context.annotate(
      instanceId,
      file,
      "lock",
      reason ?? "actively editing",
    );
    return { content: [{ type: "text", text: `Locked ${file}` }] };
  },
);

server.tool(
  "unlock_file",
  "Release a file lock so other instances can edit it.",
  { file: z.string().describe("File path to unlock") },
  async ({ file }) => {
    const locks = context
      .lookup(file)
      .filter((r: any) => r.type === "lock" && r.instance_id === instanceId);
    for (const lock of locks) context.remove((lock as any).id);
    return { content: [{ type: "text", text: `Unlocked ${file}` }] };
  },
);

server.tool(
  "check_file",
  "Check if a file has any annotations, locks, or warnings from other instances.",
  { file: z.string().describe("File path to check") },
  async ({ file }) => {
    const entries = context.lookup(file);
    if (entries.length === 0)
      return {
        content: [{ type: "text", text: "No annotations for this file" }],
      };
    return {
      content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
    };
  },
);

server.tool(
  "search_context",
  "Search all shared annotations by file path or content.",
  {
    query: z.string().describe("Search term (matches file paths and content)"),
  },
  async ({ query }) => {
    const results = context.search(query);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ──────────────────────────────────────
//  Tools: Shared Key-Value Store
// ──────────────────────────────────────

server.tool(
  "kv_get",
  "Get a value from the shared key-value store.",
  { key: z.string().describe("The key to look up") },
  async ({ key }) => {
    const row = kv.get(key);
    if (!row)
      return { content: [{ type: "text", text: `Key "${key}" not found` }] };
    return { content: [{ type: "text", text: JSON.stringify(row) }] };
  },
);

server.tool(
  "kv_set",
  "Set a value in the shared key-value store. Visible to all instances.",
  {
    key: z.string().describe("The key to set"),
    value: z
      .string()
      .describe("The value to store (use JSON for complex data)"),
  },
  async ({ key, value }) => {
    kv.set(key, value);
    return { content: [{ type: "text", text: `Set "${key}"` }] };
  },
);

server.tool(
  "kv_delete",
  "Delete a key from the shared key-value store.",
  { key: z.string().describe("The key to delete") },
  async ({ key }) => {
    kv.del(key);
    return { content: [{ type: "text", text: `Deleted "${key}"` }] };
  },
);

server.tool(
  "kv_list",
  "List keys in the shared key-value store, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional key prefix to filter by"),
  },
  async ({ prefix }) => {
    const rows = kv.keys(prefix);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

// ──────────────────────────────────────
//  Background Notification Poller
// ──────────────────────────────────────

function getMaxMsgId(): number {
  const row = db.query("SELECT MAX(id) as max FROM messages").get() as {
    max: number | null;
  };
  return row?.max ?? 0;
}

function getMaxTaskUpdate(): number {
  const row = db.query("SELECT MAX(updated_at) as max FROM tasks").get() as {
    max: number | null;
  };
  return row?.max ?? 0;
}

async function poll() {
  if (!instanceId) return;

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
  } catch {
    // client may not support notifications — ignore
  }
}

// ──────────────────────────────────────
//  Lifecycle
// ──────────────────────────────────────

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  if (instanceId) registry.deregister(instanceId);
  instanceId = null;
  tasks.cleanup();
  context.cleanup();
}

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
