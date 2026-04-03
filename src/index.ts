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
import * as prompts from "./prompts";
import * as registry from "./registry";
import * as tasks from "./tasks";

let instance: registry.Instance | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let notifyTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgId = 0;
let lastTaskUpdate = 0;
let lastInstancesVersion = "";
let lastKvUpdate = 0;

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

function prompt(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function resolveFileInput(file: string) {
  if (!instance) return filepath("", file);
  return filepath(instance.directory, file, {
    fileRoot: instance.file_root,
    root: instance.root,
  });
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

function getMaxKvUpdate() {
  if (!instance) return 0;
  return kv.version(instance.scope);
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
        {
          open: [],
          claimed: [],
          in_progress: [],
          blocked: [],
          approval_required: [],
          done: [],
          failed: [],
          cancelled: [],
        },
        "swarm://tasks",
      );

    return resource(tasks.snapshot(instance.scope), "swarm://tasks");
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
      context.lookup(instance.scope, resolveFileInput(file as string)),
      uri.href,
    );
  },
);

server.registerPrompt(
  "setup",
  {
    title: "Swarm Setup",
    description:
      "Register this agent session and inspect current swarm state.",
  },
  async () => prompt(prompts.setup()),
);

server.registerPrompt(
  "protocol",
  {
    title: "Swarm Protocol",
    description:
      "Apply the recommended cross-agent coordination workflow for this session.",
  },
  async () => prompt(prompts.protocol()),
);

server.tool(
  "register",
  "Register this agent session with the swarm. Call this first before using other tools.",
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
    file_root: z
      .string()
      .optional()
      .describe(
        "Optional canonical base directory for resolving relative file paths. Useful when multiple worktrees should share one logical file tree.",
      ),
  },
  async ({ directory, label, scope, file_root }) => {
    if (instance) {
      return { content: [{ type: "text", text: JSON.stringify(instance) }] };
    }

    instance = registry.register(directory, label, scope, file_root);
    lastMsgId = getMaxMsgId();
    lastTaskUpdate = getMaxTaskUpdate();
    lastInstancesVersion = getInstancesVersion();
    lastKvUpdate = getMaxKvUpdate();

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
  "List all currently active agent sessions in this swarm scope.",
  {
    label_contains: z
      .string()
      .optional()
      .describe(
        "Filter instances whose label contains this substring (e.g. 'role:implementer')",
      ),
  },
  async ({ label_contains }) => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            registry.list(instance.scope, label_contains),
            null,
            2,
          ),
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
  "remove_instance",
  "Forcefully remove another instance from the swarm. Releases its tasks and locks.",
  {
    instance_id: z.string().describe("The instance ID to remove"),
  },
  async ({ instance_id }) => {
    if (!instance) return missing();

    if (instance_id === instance.id) {
      return {
        content: [
          {
            type: "text",
            text: "Cannot remove yourself. Use deregister instead.",
          },
        ],
      };
    }

    const target = registry.get(instance_id);
    if (!target || target.scope !== instance.scope) {
      return {
        content: [
          {
            type: "text",
            text: `Instance ${instance_id} not found in this scope`,
          },
        ],
      };
    }

    const label = target.label ?? target.id;
    registry.deregister(instance_id);

    // Notify remaining instances
    messages.broadcast(
      instance.id,
      instance.scope,
      `[auto] Instance ${label} (${instance_id}) was removed by ${instance.label ?? instance.id}. Its tasks and locks have been released.`,
    );

    return {
      content: [
        {
          type: "text",
          text: `Removed instance ${label} (${instance_id}). Tasks released, locks cleared.`,
        },
      ],
    };
  },
);

server.tool(
  "deregister",
  "Remove this instance from the swarm and clean up its tasks and locks.",
  {},
  async () => {
    if (!instance) return missing();

    const id = instance.id;
    cleanup();

    return {
      content: [
        {
          type: "text",
          text: `Deregistered instance ${id}. Tasks released, locks cleared.`,
        },
      ],
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
    priority: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe(
        "Priority level. Higher = more urgent. Default 0. Agents claim highest-priority open tasks first.",
      ),
    depends_on: z
      .array(z.string())
      .optional()
      .describe(
        "Task IDs this task depends on. Task stays blocked until all dependencies reach done.",
      ),
    idempotency_key: z
      .string()
      .optional()
      .describe(
        "Unique key to prevent duplicate task creation. If a task with this key exists, returns the existing task.",
      ),
    parent_task_id: z
      .string()
      .optional()
      .describe("Optional parent task ID for tree-structured work tracking."),
    approval_required: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, task starts in approval_required status and must be approved before work begins.",
      ),
  },
  async ({
    type,
    title,
    description,
    files,
    assignee,
    priority,
    depends_on,
    idempotency_key,
    parent_task_id,
    approval_required,
  }) => {
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

    const result = tasks.request(instance.id, instance.scope, type, title, {
      description,
      files: files?.map((item) => resolveFileInput(item)),
      assignee,
      priority,
      depends_on,
      idempotency_key,
      parent_task_id,
      approval_required,
    });

    if ("error" in result) {
      return { content: [{ type: "text", text: result.error }] };
    }

    // Auto-notify only for newly-created tasks assigned to another session.
    if (assignee && !result.existing && assignee !== instance.id) {
      const statusNote =
        result.status !== "claimed"
          ? ` (currently ${result.status} — will be claimable when ready)`
          : "";
      messages.send(
        instance.id,
        instance.scope,
        assignee,
        `[auto] New ${type} task assigned to you: "${title}" (task_id: ${result.id})${statusNote}. Claim it with claim_task if not auto-claimed.`,
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: result.id,
            status: result.status,
            ...(result.existing ? { existing: true } : {}),
          }),
        },
      ],
    };
  },
);

server.tool(
  "request_task_batch",
  "Create multiple tasks atomically in a single transaction. Supports $N references (1-indexed) for dependencies between tasks in the batch. Rolls back entirely on validation failure.",
  {
    tasks: z
      .array(
        z.object({
          type: z
            .enum(["review", "implement", "fix", "test", "research", "other"])
            .describe("Type of task"),
          title: z.string().describe("Short title for the task"),
          description: z
            .string()
            .optional()
            .describe("Detailed description"),
          files: z.array(z.string()).optional().describe("Relevant file paths"),
          assignee: z.string().optional().describe("Instance ID to assign to"),
          priority: z.number().int().optional().default(0).describe("Priority level"),
          depends_on: z
            .array(z.string())
            .optional()
            .describe(
              "Task IDs or $N refs (1-indexed, no forward refs). Example: [\"$1\", \"$2\"] depends on the 1st and 2nd tasks in this batch.",
            ),
          idempotency_key: z
            .string()
            .optional()
            .describe("Prevents duplicate creation on retry"),
          parent_task_id: z
            .string()
            .optional()
            .describe("Parent task ID or $N ref"),
          approval_required: z
            .boolean()
            .optional()
            .default(false)
            .describe("If true, task requires approval before work begins"),
        }),
      )
      .min(1)
      .max(50)
      .describe("Array of task specifications. $N references are 1-indexed positional refs within this array."),
  },
  async ({ tasks: taskSpecs }) => {
    if (!instance) return missing();

    // Resolve file paths
    const resolved = taskSpecs.map((spec) => ({
      ...spec,
      files: spec.files?.map((f) => resolveFileInput(f)),
    }));

    const result = tasks.requestBatch(
      instance.id,
      instance.scope,
      resolved,
      (assigneeId) => {
        const target = registry.get(assigneeId);
        return !!target && target.scope === instance!.scope;
      },
    );

    if ("error" in result) {
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    // Send auto-notifications grouped by assignee
    const notifs = new Map<string, string[]>();
    for (let i = 0; i < taskSpecs.length; i++) {
      const spec = taskSpecs[i];
      const taskResult = result.tasks[i];
      if (spec.assignee && taskResult.new) {
        const list = notifs.get(spec.assignee) ?? [];
        const statusNote =
          taskResult.status !== "claimed"
            ? ` (${taskResult.status})`
            : "";
        list.push(`"${spec.title}" (${spec.type}, task_id: ${taskResult.id})${statusNote}`);
        notifs.set(spec.assignee, list);
      }
    }
    for (const [assignee, taskList] of notifs) {
      if (assignee !== instance.id) {
        messages.send(
          instance.id,
          instance.scope,
          assignee,
          `[auto] ${taskList.length} task(s) assigned to you: ${taskList.join(", ")}. Claim open tasks with claim_task.`,
        );
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

    // Auto-notify the requester when a task reaches a terminal state
    if ("ok" in next && (status === "done" || status === "failed")) {
      const task = tasks.get(task_id, instance.scope);
      if (task && typeof task.requester === "string" && task.requester !== instance.id) {
        messages.send(
          instance.id,
          instance.scope,
          task.requester,
          `[auto] Task "${task.title}" (${task_id}) is now ${status}.${result ? ` Result: ${result}` : ""}`,
        );
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(next) }] };
  },
);

server.tool(
  "approve_task",
  "Approve a task in approval_required status. Transitions to open/claimed (or blocked if deps unmet).",
  { task_id: z.string().describe("The task ID to approve") },
  async ({ task_id }) => {
    if (!instance) return missing();
    const result = tasks.approve(task_id, instance.scope);

    // Auto-notify the assignee if task became claimed
    if ("ok" in result && result.status === "claimed") {
      const task = tasks.get(task_id, instance.scope);
      if (
        task &&
        typeof task.assignee === "string" &&
        task.assignee !== instance.id
      ) {
        messages.send(
          instance.id,
          instance.scope,
          task.assignee,
          `[auto] Task "${task.title}" (${task_id}) has been approved and is now claimed by you.`,
        );
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
      .enum(["open", "claimed", "in_progress", "done", "failed", "cancelled", "blocked", "approval_required"])
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
      resolveFileInput(file),
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
    const path = resolveFileInput(file);
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
    context.clearLocks(instance.id, instance.scope, resolveFileInput(file));
    return { content: [{ type: "text", text: `Unlocked ${file}` }] };
  },
);

server.tool(
  "check_file",
  "Check if a file has any annotations, locks, or warnings from other instances in this scope.",
  { file: z.string().describe("File path to check") },
  async ({ file }) => {
    if (!instance) return missing();
    const rows = context.lookup(instance.scope, resolveFileInput(file));
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
  "kv_append",
  "Atomically append a value to a JSON array in the KV store. Creates the key with [value] if it doesn't exist. If the existing value is not an array, wraps it in one first.",
  {
    key: z.string().describe("The key to append to"),
    value: z
      .string()
      .describe("The value to append (must be valid JSON)"),
  },
  async ({ key, value }) => {
    if (!instance) return missing();
    try {
      JSON.parse(value);
    } catch {
      return {
        content: [{ type: "text", text: "Value must be valid JSON" }],
      };
    }
    const length = kv.append(instance.scope, key, value);
    return {
      content: [
        { type: "text", text: `Appended to \"${key}\" (${length} items)` },
      ],
    };
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

server.tool(
  "wait_for_activity",
  "Block until new swarm activity arrives (messages, task changes, KV changes, or instance changes), then return what changed. Use this as your idle loop to stay autonomous without user prompting. Returns immediately if there is already unread activity.",
  {
    timeout_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe(
        "Max seconds to wait before returning (even if nothing changed). Default 0 means wait indefinitely.",
      ),
  },
  async ({ timeout_seconds }) => {
    if (!instance) return missing();

    // Check for already-unread messages before snapshotting — return
    // immediately so auto-notifications that arrived before this call
    // are not missed.
    const existing = messages.peek(instance.id, instance.scope, 50);
    if (existing.length > 0) {
      const result: Record<string, unknown> = {
        changes: ["new_messages"],
        messages: messages.poll(instance!.id, instance!.scope, 50),
        tasks: tasks.snapshot(instance!.scope),
      };
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    const startMsgId = getMaxMsgId();
    const startTaskUpdate = getMaxTaskUpdate();
    const startInstancesVersion = getInstancesVersion();
    const startKvUpdate = getMaxKvUpdate();

    const deadline = timeout_seconds > 0 ? Date.now() + timeout_seconds * 1000 : 0;
    const pollInterval = 2000; // check every 2 seconds

    while (deadline === 0 || Date.now() < deadline) {
      const currentMsgId = getMaxMsgId();
      const currentTaskUpdate = getMaxTaskUpdate();
      const currentInstancesVersion = getInstancesVersion();
      const currentKvUpdate = getMaxKvUpdate();

      const changes: string[] = [];
      if (currentMsgId > startMsgId) changes.push("new_messages");
      if (currentTaskUpdate > startTaskUpdate) changes.push("task_updates");
      if (currentInstancesVersion !== startInstancesVersion)
        changes.push("instance_changes");
      if (currentKvUpdate > startKvUpdate) changes.push("kv_updates");

      if (changes.length > 0) {
        // Collect the actual updates to return
        const result: Record<string, unknown> = { changes };

        if (changes.includes("new_messages")) {
          result.messages = messages.poll(instance!.id, instance!.scope, 50);
        }
        if (changes.includes("task_updates")) {
          result.tasks = tasks.snapshot(instance!.scope);
        }
        if (changes.includes("instance_changes")) {
          result.instances = registry.list(instance!.scope);
        }

        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout with no changes
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            changes: [],
            timeout: true,
            message:
              "No new activity within timeout. Call wait_for_activity again to keep waiting.",
          }),
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
