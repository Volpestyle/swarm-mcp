import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { db } from "./db";
import * as context from "./context";
import * as events from "./events";
import * as kv from "./kv";
import * as messages from "./messages";
import { file as filepath } from "./paths";
import * as planner from "./planner";
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

const REGISTER_PROMPT = `You are now registered with the swarm and should operate in autonomous mode.

Rehydrate first: poll_messages, list_tasks, list_instances, and any role-specific KV keys you rely on.
When idle, use wait_for_activity as the loop. React to changes immediately.
Only stop when the overall goal is complete or the user explicitly tells you to stop.`;

function missing() {
  return {
    content: [
      { type: "text" as const, text: "Not registered. Call register first." },
    ],
  };
}

function registerContent(reg: registry.Instance) {
  const content = [
    { type: "text" as const, text: JSON.stringify(reg) },
    { type: "text" as const, text: REGISTER_PROMPT },
  ];
  const roleBootstrap = prompts.roleBootstrap(planner.extractRole(reg.label));
  if (roleBootstrap) {
    content.push({ type: "text" as const, text: roleBootstrap });
  }
  return content;
}

function respond(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function respondJson(value: unknown) {
  return respond(JSON.stringify(value, null, 2));
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

type ToolShape = Record<string, z.ZodTypeAny>;

function registeredTool<Shape extends ToolShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown> | unknown,
) {
  server.tool(
    name,
    description,
    shape,
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      if (!instance) return missing();
      return handler(args);
    }) as any,
  );
}

const taskTypeSchema = z.enum(tasks.TASK_TYPES);
const taskStatusSchema = z.enum(tasks.TASK_STATUSES);
const taskCreateShape = {
  type: taskTypeSchema.describe("Type of task"),
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
} satisfies ToolShape;

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
  events.cleanup();
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
      return { content: registerContent(instance) };
    }

    // When launched from swarm-ui, the UI pre-creates an instance row in
    // `~/.swarm-mcp/swarm.db` (with adopted=0) and injects its id via
    // SWARM_MCP_INSTANCE_ID. `registry.register` will adopt the existing row
    // and flip `adopted=1` instead of creating a duplicate.
    const preassignedId = process.env.SWARM_MCP_INSTANCE_ID?.trim() || undefined;
    instance = registry.register(directory, label, scope, file_root, preassignedId);
    startInstanceTimers();

    return { content: registerContent(instance) };
  },
);

function startInstanceTimers() {
  if (!instance) return;
  lastMsgId = getMaxMsgId();
  lastTaskUpdate = getMaxTaskUpdate();
  lastInstancesVersion = getInstancesVersion();
  lastKvUpdate = getMaxKvUpdate();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);

  heartbeatTimer = setInterval(() => {
    if (instance) registry.heartbeat(instance.id);
  }, 10_000);

  notifyTimer = setInterval(() => {
    void poll();
  }, 5_000);
}

/**
 * When swarm-ui spawns the host process (claude/codex/opencode), it
 * pre-creates an instance row with adopted=0 and injects its id via
 * SWARM_MCP_INSTANCE_ID. The row stays as "ADOPTING" in the UI until this
 * server adopts it — but MCP clients only call the `register` tool on
 * demand, not at startup, so we auto-adopt here so the pill flips to
 * adopted as soon as the MCP server boots, not whenever the user first
 * prompts the agent to use swarm tools.
 *
 * Directory/scope/label come from env vars also injected by swarm-ui, with
 * a fallback to `process.cwd()` (the PTY cwd) so manual invocations with
 * only SWARM_MCP_INSTANCE_ID still work.
 */
function tryAutoAdopt() {
  const preassignedId = process.env.SWARM_MCP_INSTANCE_ID?.trim();
  if (!preassignedId || instance) return;

  const directory = process.env.SWARM_MCP_DIRECTORY?.trim() || process.cwd();
  const envScope = process.env.SWARM_MCP_SCOPE?.trim() || undefined;
  const envLabel = process.env.SWARM_MCP_LABEL?.trim() || undefined;
  const envFileRoot = process.env.SWARM_MCP_FILE_ROOT?.trim() || undefined;

  try {
    instance = registry.register(
      directory,
      envLabel,
      envScope,
      envFileRoot,
      preassignedId,
    );
    startInstanceTimers();
  } catch (err) {
    console.error("[swarm-mcp] auto-adopt failed:", err);
  }
}

tryAutoAdopt();

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

    return respond(
      `Removed instance ${label} (${instance_id}). Tasks released, locks cleared.`,
    );
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

registeredTool(
  "send_message",
  "Send a message to a specific instance by ID.",
  {
    recipient: z.string().describe("The instance ID to send the message to"),
    content: z.string().describe("The message content"),
  },
  async ({ recipient, content }) => {
    const current = instance!;

    const target = registry.get(recipient);
    if (!target || target.scope !== current.scope) {
      return {
        content: [
          {
            type: "text",
            text: `Instance ${recipient} is not active in this scope`,
          },
        ],
      };
    }

    if (target.id === current.id) {
      return {
        content: [{ type: "text", text: "Cannot send a message to yourself" }],
      };
    }

    messages.send(current.id, current.scope, recipient, content);
    return respond(`Message sent to ${recipient}`);
  },
);

registeredTool(
  "prompt_peer",
  "Send a durable swarm message to another instance, then best-effort wake its herdr pane if it published identity/herdr/<instance_id>.",
  {
    recipient: z.string().describe("Target swarm instance id"),
    message: z.string().describe("Instruction to send through swarm"),
    task_id: z.string().optional().describe("Optional related swarm task id"),
    nudge: z.boolean().optional().default(true).describe("Whether to wake the target herdr pane"),
    force: z.boolean().optional().default(false).describe("Wake even when the target pane is working"),
  },
  async ({ recipient, message, task_id, nudge, force }) => {
    const current = instance!;
    const target = registry.get(recipient);
    if (!target || target.scope !== current.scope) {
      return respondJson({ error: `Instance ${recipient} is not active in this scope` });
    }
    if (target.id === current.id) {
      return respondJson({ error: "Cannot prompt yourself" });
    }

    const durable = task_id ? `[task:${task_id}] ${message}` : message;
    messages.send(current.id, current.scope, target.id, durable);

    const result: Record<string, unknown> = {
      message_sent: true,
      recipient: target.id,
      nudged: false,
    };
    if (!nudge) {
      result.nudge_skipped = "nudge=false";
      return respondJson(result);
    }

    const identityRow = kv.get(current.scope, `identity/herdr/${target.id}`);
    if (!identityRow) {
      result.nudge_skipped = "no herdr identity is published for that instance";
      return respondJson(result);
    }

    let identity: Record<string, unknown>;
    try {
      const parsed = JSON.parse(identityRow.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("identity is not an object");
      }
      identity = parsed as Record<string, unknown>;
    } catch {
      result.nudge_skipped = "published herdr identity is not valid JSON";
      return respondJson(result);
    }

    const paneId = identity.pane_id;
    if (typeof paneId !== "string" || !paneId) {
      result.nudge_skipped = "published herdr identity has no pane_id";
      return respondJson(result);
    }

    const env = { ...process.env };
    if (typeof identity.socket_path === "string" && identity.socket_path) {
      env.HERDR_SOCKET_PATH = identity.socket_path;
    }
    const getProc = spawnSync("herdr", ["pane", "get", paneId], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    result.pane_id = paneId;
    if (getProc.error || getProc.status !== 0) {
      result.nudge_skipped =
        getProc.error?.message ||
        getProc.stderr?.trim() ||
        getProc.stdout?.trim() ||
        "herdr pane get failed";
      return respondJson(result);
    }

    let status = "unknown";
    try {
      const payload = JSON.parse(getProc.stdout || "{}");
      const pane = payload?.result?.pane;
      if (pane && typeof pane.agent_status === "string") status = pane.agent_status;
    } catch {
      status = "unknown";
    }
    result.agent_status = status;
    if (!["idle", "blocked", "done", "unknown"].includes(status) && !force) {
      result.nudge_skipped = `target pane is ${status}; pass force=true to inject anyway`;
      return respondJson(result);
    }

    const wakePrompt = `A peer sent you a swarm message${task_id ? ` for task ${task_id}` : ""}. Call the swarm poll_messages tool, handle the message, and report back through swarm-mcp.`;
    const runProc = spawnSync("herdr", ["pane", "run", paneId, wakePrompt], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    if (runProc.error || runProc.status !== 0) {
      result.nudge_error =
        runProc.error?.message ||
        runProc.stderr?.trim() ||
        runProc.stdout?.trim() ||
        "herdr pane run failed";
    } else {
      result.nudged = true;
    }
    return respondJson(result);
  },
);

registeredTool(
  "broadcast",
  "Send a message to all other active instances in this swarm scope.",
  { content: z.string().describe("The message content to broadcast") },
  async ({ content }) => {
    const current = instance!;
    const count = messages.broadcast(current.id, current.scope, content);
    return respond(`Broadcast sent to ${count} instance(s)`);
  },
);

registeredTool(
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
    const current = instance!;
    return respondJson(messages.poll(current.id, current.scope, limit));
  },
);

registeredTool(
  "request_task",
  "Create a task for another instance, or leave it open for any instance in this scope.",
  taskCreateShape,
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
    const current = instance!;

    if (assignee) {
      const target = registry.get(assignee);
      if (!target || target.scope !== current.scope) {
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

    const result = tasks.request(current.id, current.scope, type, title, {
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
    if (assignee && !result.existing && assignee !== current.id) {
      const statusNote =
        result.status !== "claimed"
          ? ` (currently ${result.status} — will be claimable when ready)`
          : "";
      messages.send(
        current.id,
        current.scope,
        assignee,
        `[auto] New ${type} task assigned to you: "${title}" (task_id: ${result.id})${statusNote}. Claim it with claim_task if not auto-claimed.`,
      );
    }

    return respondJson({
      task_id: result.id,
      status: result.status,
      ...(result.existing ? { existing: true } : {}),
    });
  },
);

registeredTool(
  "request_task_batch",
  "Create multiple tasks atomically in a single transaction. Supports $N references (1-indexed) for dependencies between tasks in the batch. Rolls back entirely on validation failure.",
  {
    tasks: z
      .array(
        z.object(taskCreateShape),
      )
      .min(1)
      .max(50)
      .describe("Array of task specifications. $N references are 1-indexed positional refs within this array."),
  },
  async ({ tasks: taskSpecs }) => {
    const current = instance!;

    // Resolve file paths
    const resolved = taskSpecs.map((spec) => ({
      ...spec,
      files: spec.files?.map((f) => resolveFileInput(f)),
    }));

    const result = tasks.requestBatch(
      current.id,
      current.scope,
      resolved,
      (assigneeId) => {
        const target = registry.get(assigneeId);
        return !!target && target.scope === current.scope;
      },
    );

    if ("error" in result) {
      return respondJson(result);
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
      if (assignee !== current.id) {
        messages.send(
          current.id,
          current.scope,
          assignee,
          `[auto] ${taskList.length} task(s) assigned to you: ${taskList.join(", ")}. Claim open tasks with claim_task.`,
        );
      }
    }

    return respondJson(result);
  },
);

registeredTool(
  "claim_task",
  "Start work on a task: assigns it to you (if open) and transitions to in_progress in one call. Works on open+unassigned tasks and on tasks pre-assigned to you (status=claimed).",
  {
    task_id: z.string().describe("The task ID to claim"),
    ignore_unread_messages: z
      .boolean()
      .optional()
      .describe(
        "Set true only when intentionally claiming despite unread messages. Default false blocks claiming until poll_messages is called.",
      ),
  },
  async ({ task_id, ignore_unread_messages }) => {
    const current = instance!;
    return respondJson(
      tasks.claim(task_id, current.scope, current.id, {
        ignoreUnreadMessages: ignore_unread_messages,
      }),
    );
  },
);

registeredTool(
  "update_task",
  "Move a claimed/in_progress task to a terminal status (done, failed, cancelled). claim_task already transitions to in_progress, so this is the single completion call. Auto-releases this instance's locks on the task's files.",
  {
    task_id: z.string().describe("The task ID"),
    status: z.enum(["done", "failed", "cancelled"]).describe("Terminal status"),
    result: z.string().optional().describe("Result or summary of work done"),
  },
  async ({ task_id, status, result }) => {
    const current = instance!;
    const next = tasks.update(
      task_id,
      current.scope,
      current.id,
      status,
      result,
    );

    // Auto-notify the requester when a task reaches a terminal state
    if ("ok" in next && (status === "done" || status === "failed")) {
      const task = tasks.get(task_id, current.scope);
      if (task && typeof task.requester === "string" && task.requester !== current.id) {
        messages.send(
          current.id,
          current.scope,
          task.requester,
          `[auto] Task "${task.title}" (${task_id}) is now ${status}.${result ? ` Result: ${result}` : ""}`,
        );
      }
    }

    return respondJson(next);
  },
);

registeredTool(
  "approve_task",
  "Approve a task in approval_required status. Transitions to open/claimed (or blocked if deps unmet).",
  { task_id: z.string().describe("The task ID to approve") },
  async ({ task_id }) => {
    const current = instance!;
    const result = tasks.approve(task_id, current.scope);

    // Auto-notify the assignee if task became claimed
    if ("ok" in result && result.status === "claimed") {
      const task = tasks.get(task_id, current.scope);
      if (
        task &&
        typeof task.assignee === "string" &&
        task.assignee !== current.id
      ) {
        messages.send(
          current.id,
          current.scope,
          task.assignee,
          `[auto] Task "${task.title}" (${task_id}) has been approved and is now claimed by you.`,
        );
      }
    }

    return respondJson(result);
  },
);

registeredTool(
  "get_task",
  "Get full details of a specific task in this swarm scope.",
  { task_id: z.string().describe("The task ID") },
  async ({ task_id }) => {
    const current = instance!;
    const task = tasks.get(task_id, current.scope);
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    return respondJson(task);
  },
);

registeredTool(
  "list_tasks",
  "List tasks in this swarm scope, optionally filtered by status, assignee, or requester.",
  {
    status: taskStatusSchema.optional(),
    assignee: z.string().optional().describe("Filter by assignee instance ID"),
    requester: z
      .string()
      .optional()
      .describe("Filter by requester instance ID"),
  },
  async ({ status, assignee, requester }) => {
    const current = instance!;
    return respondJson(
      tasks.list(current.scope, { status, assignee, requester }),
    );
  },
);

registeredTool(
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
    const current = instance!;
    const id = context.annotate(
      current.id,
      current.scope,
      resolveFileInput(file),
      type,
      content,
    );
    return respondJson({ annotation_id: id });
  },
);

registeredTool(
  "lock_file",
  "Acquire an edit lock on a file and read existing peer annotations in one call. Returns the new lock id plus any non-lock annotations on the file. Locks held by this instance are auto-released when its task reaches a terminal state via update_task.",
  {
    file: z.string().describe("File path to lock"),
    reason: z.string().optional().describe("Why you're locking it"),
  },
  async ({ file, reason }) => {
    const current = instance!;
    const path = resolveFileInput(file);
    const result = context.lock(
      current.id,
      current.scope,
      path,
      reason ?? "actively editing",
    );
    return respondJson(result);
  },
);

registeredTool(
  "unlock_file",
  "Release a file lock early. Locks are auto-released on terminal update_task, so call this only when you finish a file before the task as a whole.",
  { file: z.string().describe("File path to unlock") },
  async ({ file }) => {
    const current = instance!;
    context.clearLocks(current.id, current.scope, resolveFileInput(file));
    return respond(`Unlocked ${file}`);
  },
);

registeredTool(
  "search_context",
  "Search all shared annotations in this scope by file path or content.",
  {
    query: z.string().describe("Search term (matches file paths and content)"),
  },
  async ({ query }) => {
    return respondJson(context.search(instance!.scope, query));
  },
);

registeredTool(
  "kv_get",
  "Get a value from the shared key-value store for this scope.",
  { key: z.string().describe("The key to look up") },
  async ({ key }) => {
    const row = kv.get(instance!.scope, key);
    if (!row)
      return { content: [{ type: "text", text: `Key \"${key}\" not found` }] };
    return respondJson(row);
  },
);

registeredTool(
  "kv_set",
  "Set a value in the shared key-value store for this scope.",
  {
    key: z.string().describe("The key to set"),
    value: z
      .string()
      .describe("The value to store (use JSON for complex data)"),
  },
  async ({ key, value }) => {
    kv.set(instance!.scope, key, value, instance!.id);
    return respond(`Set \"${key}\"`);
  },
);

registeredTool(
  "kv_append",
  "Atomically append a value to a JSON array in the KV store. Creates the key with [value] if it doesn't exist. If the existing value is not an array, wraps it in one first.",
  {
    key: z.string().describe("The key to append to"),
    value: z
      .string()
      .describe("The value to append (must be valid JSON)"),
  },
  async ({ key, value }) => {
    try {
      JSON.parse(value);
    } catch {
      return {
        content: [{ type: "text", text: "Value must be valid JSON" }],
      };
    }
    const length = kv.append(instance!.scope, key, value, instance!.id);
    return respond(`Appended to \"${key}\" (${length} items)`);
  },
);

registeredTool(
  "kv_delete",
  "Delete a key from the shared key-value store for this scope.",
  { key: z.string().describe("The key to delete") },
  async ({ key }) => {
    kv.del(instance!.scope, key, instance!.id);
    return respond(`Deleted \"${key}\"`);
  },
);

registeredTool(
  "kv_list",
  "List keys in the shared key-value store for this scope, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional key prefix to filter by"),
  },
  async ({ prefix }) => {
    return respondJson(kv.keys(instance!.scope, prefix));
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
      return respond(JSON.stringify(result, null, 2));
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

        return respond(JSON.stringify(result, null, 2));
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout with no changes
    return respond(
      JSON.stringify({
        changes: [],
        timeout: true,
        message: "No new activity within timeout.",
      }),
    );
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
